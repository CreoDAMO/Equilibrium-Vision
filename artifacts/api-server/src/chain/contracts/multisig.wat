;; ── Native WASM M-of-N Multisig Contract ─────────────────────────────────────
;;
;; Replaces the single ADMIN_KEY secret with an on-chain, threshold-signed
;; approval gate for privileged admin operations (e.g. validator slashing).
;;
;; Design (Gnosis-Safe-style, adapted to this VM's numeric call ABI):
;;   - Owners are identified by ADDRESS (40 lowercase hex chars, ASCII —
;;     matches Equilibrium's canonical `sha256(raw pubkey bytes)[..40]`
;;     address derivation used by wallet/transactions). Only addresses are
;;     stored on-chain; public keys and signatures are supplied fresh with
;;     every `approve` call and never persisted, so no key material lives in
;;     contract storage.
;;   - `verify_owner_sig` (host import) derives the address from the supplied
;;     public key, checks it matches the claimed owner slot, and verifies the
;;     Ed25519 signature — all in one call.
;;   - Approvals are tracked per-proposal as an i32 bitmask (bit i = owner i
;;     has approved), so a threshold check is a single `i32.popcnt`.
;;   - The signed message binds the contract's own address (via `self_address`)
;;     and the proposal id, preventing replay across proposals or across other
;;     multisig instances signed by the same owner key.
;;   - Proposal *semantics* (what action a given id represents — e.g. "slash
;;     validator X for reason Y") are tracked off-chain by the caller (route
;;     handler); this contract is purely the on-chain authorization gate:
;;     "has proposal #N collected >= threshold owner approvals?"
;;
;; Call ABI: call(methodId, argsPtr, argsLen) -> i32
;;   0 = init(threshold: i32)
;;       -> 1 on success, -1 if already initialized
;;   1 = addOwner(address: 40 ASCII bytes / 10 i32 words)
;;       -> assigned owner index (>= 0), -1 if already finalized, -2 if at
;;          the 31-owner cap
;;   2 = finalize()
;;       -> 1 on success, -1 if threshold > owner count or threshold < 1
;;   3 = propose()
;;       -> new proposal id (>= 0), -1 if not yet finalized
;;   4 = approve(proposalId: i32, ownerIndex: i32, pubkey: 32 bytes / 8 words,
;;               signature: 64 bytes / 16 words)
;;       -> 2 = threshold now met, 1 = approved but still pending,
;;          0 = invalid signature, -1 = not finalized, -2 = unknown proposal,
;;          -3 = already fully approved, -4 = unknown owner index
;;   5 = isApproved(proposalId: i32)
;;       -> 1 if threshold has been met, 0 otherwise (including unknown ids)
;;
;; Storage (all plain-ASCII decimal/hex-free strings, safe for UTF-8 storage
;; round-trip): meta_owners, meta_threshold, meta_finalized, meta_next,
;; owner_<i>, appr_<id>, done_<id>.

(module
  (import "env" "storage_get" (func $storage_get (param i32 i32 i32) (result i32)))
  (import "env" "storage_set" (func $storage_set (param i32 i32 i32 i32)))
  (import "env" "verify_owner_sig" (func $verify_owner_sig (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  (import "env" "self_address" (func $self_address (param i32) (result i32)))

  (memory (export "memory") 2)

  ;; ── static string literals ──────────────────────────────────────────────
  (data (i32.const 0)   "owner_")           ;; OWNER_PFX   len=6
  (data (i32.const 16)  "meta_owners")      ;; META_OWNERS len=11
  (data (i32.const 32)  "meta_threshold")   ;; META_THRESH len=14
  (data (i32.const 48)  "meta_finalized")   ;; META_FINAL  len=14
  (data (i32.const 64)  "meta_next")        ;; META_NEXT   len=9
  (data (i32.const 80)  "appr_")            ;; APPR_PFX    len=5
  (data (i32.const 96)  "done_")            ;; DONE_PFX    len=5
  (data (i32.const 112) "equilibrium-multisig-approve:") ;; MSG_PFX len=29
  (data (i32.const 144) ":")                ;; COLON       len=1

  ;; ── scratch buffers ─────────────────────────────────────────────────────
  ;; KEYBUF   256..320   dynamic storage-key strings
  ;; VALBUF   320..384   decimal value strings / address read buffer
  ;; MSGBUF   384..512   approve() signed-message construction
  ;; SELFADDR 512..576   this contract's own address
  ;; ITOA_TMP 576..640   itoa reversal scratch
  (global $heap (mut i32) (i32.const 8192))

  (func $alloc (export "alloc") (param $size i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $heap))
    (global.set $heap (i32.add (global.get $heap) (local.get $size)))
    (local.get $p))

  ;; itoa: unsigned decimal, writes digits at $dst, returns length
  (func $itoa (param $val i32) (param $dst i32) (result i32)
    (local $n i32) (local $len i32) (local $i i32) (local $j i32)
    (local.set $n (local.get $val))
    (if (i32.eqz (local.get $n))
      (then
        (i32.store8 (local.get $dst) (i32.const 48))
        (return (i32.const 1))))
    (local.set $len (i32.const 0))
    (block $doneRev
      (loop $loopRev
        (br_if $doneRev (i32.eqz (local.get $n)))
        (i32.store8 (i32.add (i32.const 576) (local.get $len))
          (i32.add (i32.rem_u (local.get $n) (i32.const 10)) (i32.const 48)))
        (local.set $n (i32.div_u (local.get $n) (i32.const 10)))
        (local.set $len (i32.add (local.get $len) (i32.const 1)))
        (br $loopRev)))
    (local.set $i (i32.const 0))
    (block $doneFlip
      (loop $loopFlip
        (br_if $doneFlip (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $j (i32.sub (i32.sub (local.get $len) (i32.const 1)) (local.get $i)))
        (i32.store8 (i32.add (local.get $dst) (local.get $i))
          (i32.load8_u (i32.add (i32.const 576) (local.get $j))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loopFlip)))
    (local.get $len))

  ;; atoi: parse $len decimal digits at $ptr
  (func $atoi (param $ptr i32) (param $len i32) (result i32)
    (local $i i32) (local $n i32)
    (local.set $i (i32.const 0)) (local.set $n (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $n (i32.add (i32.mul (local.get $n) (i32.const 10))
          (i32.sub (i32.load8_u (i32.add (local.get $ptr) (local.get $i))) (i32.const 48))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $n))

  ;; get a stored integer, defaulting to 0 if unset
  (func $get_int (param $keyPtr i32) (param $keyLen i32) (result i32)
    (local $vlen i32)
    (local.set $vlen (call $storage_get (local.get $keyPtr) (local.get $keyLen) (i32.const 320)))
    (if (result i32) (i32.eqz (local.get $vlen))
      (then (i32.const 0))
      (else (call $atoi (i32.const 320) (local.get $vlen)))))

  (func $set_int (param $keyPtr i32) (param $keyLen i32) (param $val i32)
    (local $vlen i32)
    (local.set $vlen (call $itoa (local.get $val) (i32.const 320)))
    (call $storage_set (local.get $keyPtr) (local.get $keyLen) (i32.const 320) (local.get $vlen)))

  ;; build "owner_<i>" in KEYBUF (256), return length
  (func $owner_key (param $i i32) (result i32)
    (local $n i32)
    (memory.copy (i32.const 256) (i32.const 0) (i32.const 6))
    (local.set $n (call $itoa (local.get $i) (i32.const 262)))
    (i32.add (i32.const 6) (local.get $n)))

  ;; build "appr_<id>" in KEYBUF (256), return length
  (func $appr_key (param $id i32) (result i32)
    (local $n i32)
    (memory.copy (i32.const 256) (i32.const 80) (i32.const 5))
    (local.set $n (call $itoa (local.get $id) (i32.const 261)))
    (i32.add (i32.const 5) (local.get $n)))

  ;; build "done_<id>" in KEYBUF (256), return length
  (func $done_key (param $id i32) (result i32)
    (local $n i32)
    (memory.copy (i32.const 256) (i32.const 96) (i32.const 5))
    (local.set $n (call $itoa (local.get $id) (i32.const 261)))
    (i32.add (i32.const 5) (local.get $n)))

  (func $is_finalized (result i32)
    (call $get_int (i32.const 48) (i32.const 14)))

  (func $method_init (param $argsPtr i32) (result i32)
    (local $existing i32)
    (local.set $existing (call $storage_get (i32.const 16) (i32.const 11) (i32.const 320)))
    (if (i32.ne (local.get $existing) (i32.const 0))
      (then (return (i32.const -1))))
    (call $set_int (i32.const 16) (i32.const 11) (i32.const 0))
    (call $set_int (i32.const 32) (i32.const 14) (i32.load (local.get $argsPtr)))
    (call $set_int (i32.const 48) (i32.const 14) (i32.const 0))
    (call $set_int (i32.const 64) (i32.const 9) (i32.const 0))
    (i32.const 1))

  (func $method_add_owner (param $argsPtr i32) (result i32)
    (local $n i32) (local $klen i32)
    (if (i32.ne (call $is_finalized) (i32.const 0))
      (then (return (i32.const -1))))
    (local.set $n (call $get_int (i32.const 16) (i32.const 11)))
    (if (i32.ge_s (local.get $n) (i32.const 31))
      (then (return (i32.const -2))))
    (local.set $klen (call $owner_key (local.get $n)))
    (call $storage_set (i32.const 256) (local.get $klen) (local.get $argsPtr) (i32.const 40))
    (call $set_int (i32.const 16) (i32.const 11) (i32.add (local.get $n) (i32.const 1)))
    (local.get $n))

  (func $method_finalize (result i32)
    (local $n i32) (local $th i32)
    (local.set $n (call $get_int (i32.const 16) (i32.const 11)))
    (local.set $th (call $get_int (i32.const 32) (i32.const 14)))
    (if (i32.or (i32.lt_s (local.get $th) (i32.const 1)) (i32.lt_s (local.get $n) (local.get $th)))
      (then (return (i32.const -1))))
    (call $set_int (i32.const 48) (i32.const 14) (i32.const 1))
    (i32.const 1))

  (func $method_propose (result i32)
    (local $id i32) (local $klen i32)
    (if (i32.eqz (call $is_finalized))
      (then (return (i32.const -1))))
    (local.set $id (call $get_int (i32.const 64) (i32.const 9)))
    (call $set_int (i32.const 64) (i32.const 9) (i32.add (local.get $id) (i32.const 1)))
    (local.set $klen (call $appr_key (local.get $id)))
    (call $set_int (i32.const 256) (local.get $klen) (i32.const 0))
    (local.set $klen (call $done_key (local.get $id)))
    (call $set_int (i32.const 256) (local.get $klen) (i32.const 0))
    (local.get $id))

  ;; approve(proposalId, ownerIndex, pubkey[32B], sig[64B])
  ;; args layout: +0 proposalId, +4 ownerIndex, +8 pubkey(32B), +40 sig(64B)
  (func $method_approve (param $argsPtr i32) (result i32)
    (local $id i32) (local $ownerIdx i32) (local $next i32) (local $n i32)
    (local $klen i32) (local $alen i32) (local $selfLen i32) (local $msgLen i32)
    (local $plen i32) (local $done i32) (local $bm i32) (local $bit i32) (local $th i32) (local $ok i32)
    (if (i32.eqz (call $is_finalized))
      (then (return (i32.const -1))))
    (local.set $id (i32.load (local.get $argsPtr)))
    (local.set $ownerIdx (i32.load (i32.add (local.get $argsPtr) (i32.const 4))))
    (local.set $next (call $get_int (i32.const 64) (i32.const 9)))
    (if (i32.or (i32.lt_s (local.get $id) (i32.const 0)) (i32.ge_s (local.get $id) (local.get $next)))
      (then (return (i32.const -2))))
    (local.set $klen (call $done_key (local.get $id)))
    (local.set $done (call $get_int (i32.const 256) (local.get $klen)))
    (if (i32.ne (local.get $done) (i32.const 0))
      (then (return (i32.const -3))))
    (local.set $n (call $get_int (i32.const 16) (i32.const 11)))
    (if (i32.or (i32.lt_s (local.get $ownerIdx) (i32.const 0)) (i32.ge_s (local.get $ownerIdx) (local.get $n)))
      (then (return (i32.const -4))))
    ;; look up owner address into VALBUF (320)
    (local.set $klen (call $owner_key (local.get $ownerIdx)))
    (local.set $alen (call $storage_get (i32.const 256) (local.get $klen) (i32.const 320)))
    ;; build signed message: MSG_PFX(29) + selfAddress + ":" + decimal(id)
    (memory.copy (i32.const 384) (i32.const 112) (i32.const 29))
    (local.set $selfLen (call $self_address (i32.const 512)))
    (memory.copy (i32.add (i32.const 384) (i32.const 29)) (i32.const 512) (local.get $selfLen))
    (i32.store8 (i32.add (i32.const 384) (i32.add (i32.const 29) (local.get $selfLen))) (i32.const 58)) ;; ':'
    (local.set $plen (call $itoa (local.get $id)
      (i32.add (i32.const 384) (i32.add (i32.const 30) (local.get $selfLen)))))
    (local.set $msgLen (i32.add (i32.add (i32.const 30) (local.get $selfLen)) (local.get $plen)))
    ;; verify_owner_sig(msg,msgLen, sig,64, pubkey,32, addr,alen)
    (local.set $ok (call $verify_owner_sig
      (i32.const 384) (local.get $msgLen)
      (i32.add (local.get $argsPtr) (i32.const 40)) (i32.const 64)
      (i32.add (local.get $argsPtr) (i32.const 8)) (i32.const 32)
      (i32.const 320) (local.get $alen)))
    (if (i32.eqz (local.get $ok))
      (then (return (i32.const 0))))
    ;; record approval bit
    (local.set $klen (call $appr_key (local.get $id)))
    (local.set $bm (call $get_int (i32.const 256) (local.get $klen)))
    (local.set $bit (i32.shl (i32.const 1) (local.get $ownerIdx)))
    (local.set $bm (i32.or (local.get $bm) (local.get $bit)))
    (call $set_int (i32.const 256) (local.get $klen) (local.get $bm))
    (local.set $th (call $get_int (i32.const 32) (i32.const 14)))
    (if (i32.ge_s (i32.popcnt (local.get $bm)) (local.get $th))
      (then
        (local.set $klen (call $done_key (local.get $id)))
        (call $set_int (i32.const 256) (local.get $klen) (i32.const 1))
        (return (i32.const 2))))
    (i32.const 1))

  (func $method_is_approved (param $argsPtr i32) (result i32)
    (local $id i32) (local $klen i32)
    (local.set $id (i32.load (local.get $argsPtr)))
    (local.set $klen (call $done_key (local.get $id)))
    (call $get_int (i32.const 256) (local.get $klen)))

  (func $call (export "call") (param $methodId i32) (param $argsPtr i32) (param $argsLen i32) (result i32)
    (if (i32.eq (local.get $methodId) (i32.const 0)) (then (return (call $method_init (local.get $argsPtr)))))
    (if (i32.eq (local.get $methodId) (i32.const 1)) (then (return (call $method_add_owner (local.get $argsPtr)))))
    (if (i32.eq (local.get $methodId) (i32.const 2)) (then (return (call $method_finalize))))
    (if (i32.eq (local.get $methodId) (i32.const 3)) (then (return (call $method_propose))))
    (if (i32.eq (local.get $methodId) (i32.const 4)) (then (return (call $method_approve (local.get $argsPtr)))))
    (if (i32.eq (local.get $methodId) (i32.const 5)) (then (return (call $method_is_approved (local.get $argsPtr)))))
    (i32.const -99))
)
