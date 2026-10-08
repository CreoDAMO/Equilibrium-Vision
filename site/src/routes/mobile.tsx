import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useNetwork } from "@/lib/network-context";
import { useWallet } from "@/lib/wallet-context";
import { admitExecution, openWithdrawal, settleEthWithdrawal, settleWithdrawal } from "@/lib/chain-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Stat } from "@/components/stat";
import { formatAmount, formatSci, truncateHash } from "@/lib/format";
import { independentVerify, type IndependentReport } from "@/protocol/light";
import { participation, type DeviceResources } from "@/protocol/membranes";
import { signWithdraw } from "@/protocol/authority";
import type { BlockRecord } from "@/protocol/types";

export const Route = createFileRoute("/mobile")({ component: MobilePage });

const COOL: DeviceResources = { thermalC: 31, battery: 0.86 };
const HOT: DeviceResources = { thermalC: 46, battery: 0.12 };

const PIPELINE = [
  { name: "continuity", label: "Chain continuity", why: "prev_hash matches the real tip" },
  { name: "timestamp", label: "Timestamp sanity", why: "monotonic, not more than 2h in the future" },
  { name: "residual-recompute", label: "Residual re-verify", why: "one joint evaluation, no nonce search" },
  { name: "merkle", label: "Merkle recompute", why: "tx hashes → root" },
  { name: "header-hash", label: "Header commitment", why: "binds merkle, state root, nonce, residual, pressure" },
  { name: "signatures", label: "Optional BFT / sigs", why: "Ed25519 on included txs; quorum is not required to advance" },
] as const;

function MobilePage() {
  const { network, snap } = useNetwork();
  const { wallet, create, importMnemonic, send, balance, nonce } = useWallet();
  const qc = useQueryClient();
  const [phrase, setPhrase] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("1000");
  const [fee, setFee] = useState("100");
  const [destination, setDestination] = useState("p2pkh:" + "cd".repeat(20));
  const [ethDestination, setEthDestination] = useState("eth:" + "cd".repeat(20));
  const [ethAsset, setEthAsset] = useState("eth");
  const [headerRlp, setHeaderRlp] = useState("");
  const [ethBlock, setEthBlock] = useState("");
  const [receiptRlp, setReceiptRlp] = useState("");
  const [receiptProof, setReceiptProof] = useState("");
  const [txRlp, setTxRlp] = useState("");
  const [txProof, setTxProof] = useState("");
  const [txIndex, setTxIndex] = useState("0");
  const [logIndex, setLogIndex] = useState("0");
  const [withdrawAmount, setWithdrawAmount] = useState("1000");
  const [withdrawNonce, setWithdrawNonce] = useState("0");
  const [rawTx, setRawTx] = useState("");
  const [vout, setVout] = useState("0");
  const [headerHash, setHeaderHash] = useState("");
  const [merkle, setMerkle] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const resources = hot ? HOT : COOL;
  const policy = participation(resources);

  const blocks = snap?.recentBlocks ?? [];
  const hash = selected ?? blocks[0]?.hash ?? null;
  const idx = blocks.findIndex((b) => b.hash === hash);
  const block: BlockRecord | undefined = idx >= 0 ? blocks[idx] : undefined;
  const prev = idx >= 0 ? (blocks[idx + 1] ?? null) : null;
  const mine = wallet ? `equilibrium://wallet?address=${wallet.address}` : "";
  const pending = (snap?.mempool ?? []).filter((t) => t.from === wallet?.address || t.to === wallet?.address);
  const confirmed = (snap?.recentTxs ?? []).filter(
    (t) => (t.from === wallet?.address || t.to === wallet?.address) && t.blockHeight != null,
  );
  const mineWithdrawals = (snap?.withdrawals ?? []).filter((w) => w.sender === wallet?.address);
  const chainId = snap?.params.chainId ?? (network === "mainnet" ? 1 : 2);

  async function stageWithdrawal(foreignNetwork: "btc" | "eth", asset: string, dest = destination) {
    if (!wallet) return;
    const value = Number(withdrawAmount);
    const n = Number(withdrawNonce);
    if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(n) || n < 0) {
      toast.error("Amount and nonce must be whole numbers");
      return;
    }
    const proof = signWithdraw(wallet, {
      chainId,
      amount: value,
      network: foreignNetwork,
      asset,
      destination: dest.trim().toLowerCase(),
      nonce: n,
    });
    const res = await openWithdrawal({
      data: {
        network,
        amount: value,
        foreignNetwork,
        asset,
        destination: dest.trim().toLowerCase(),
        nonce: n,
        publicKey: proof.publicKey,
        signature: proof.signature,
      },
    });
    if (res.ok) {
      toast.success(foreignNetwork === "btc" ? "Lock queued. The next block debits this address." : "Ethereum lock queued. The receipt is still required.");
      await qc.invalidateQueries({ queryKey: ["snapshot", network] });
    } else toast.error(res.error ?? "Refused");
  }

  const report: IndependentReport | null = useMemo(() => {
    if (!snap || !block) return null;
    if (policy === "defer") return null;
    return independentVerify(block, prev, snap.params);
  }, [snap, block, prev, policy]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Mobile body</h1>
        <p className="mt-2 max-w-2xl text-muted">
          This phone holds the wallet. The miner address is that address. The key is not
          sent to the solver. A transfer moves EQU to another EQU address. A withdrawal
          is a different signature: it leaves when a Bitcoin output matches the lock, or when an
          Ethereum receipt matches an admitted execution header.
        </p>
      </header>

      {!wallet ? (
        <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
          <h2 className="font-display text-xl">Wallet on this device</h2>
          <p className="text-sm text-muted">Same phrase as the wallet page. Path m/44'/600'/0'/0'/0'.</p>
          <Button
            onClick={() => {
              const created = create();
              setPhrase(created.mnemonic);
              toast.success("Phrase created. It stays in this browser.");
            }}
          >
            Create wallet
          </Button>
          {phrase ? <pre className="whitespace-pre-wrap rounded-lg bg-bg-elevated p-4 font-mono text-sm">{phrase}</pre> : null}
          <Input placeholder="Import phrase" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} />
          <Button
            variant="secondary"
            onClick={() => {
              try {
                importMnemonic(mnemonic);
                toast.success("Wallet restored");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Invalid phrase");
              }
            }}
          >
            Import phrase
          </Button>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Balance" value={formatAmount(balance)} hint="canonical account" />
            <Stat label="Nonce" value={nonce} hint={network} />
          </div>
          <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
            <p className="text-xs uppercase tracking-[0.2em] text-subtle">Address · miner</p>
            <p className="break-all font-mono text-sm">{wallet.address}</p>
            <p className="break-all font-mono text-xs text-muted">{mine}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(mine);
                  toast.success("Solver link copied. The key is not in it.");
                }}
              >
                Copy solver link
              </Button>
              <Link className="inline-flex min-h-11 items-center text-sm text-accent" to="/wallet">
                Wallet page
              </Link>
            </div>
          </div>
          <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
            <h2 className="font-display text-xl">Send EQU</h2>
            <p className="text-sm text-muted">
              Signed here, checked as a canonical transfer, then queued. Another chain does not receive it.
            </p>
            <Input placeholder="Recipient address" value={to} onChange={(e) => setTo(e.target.value)} />
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
            <Input value={fee} onChange={(e) => setFee(e.target.value)} />
            <Button
              onClick={async () => {
                const res = await send(to, Number(amount), Number(fee));
                if (res.ok) toast.success("Signed and queued");
                else toast.error(res.error ?? "Refused");
              }}
            >
              Sign and send
            </Button>
          </div>
          <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-2">
            <h2 className="font-display text-xl">This address</h2>
            {pending.length === 0 && confirmed.length === 0 ? (
              <p className="text-sm text-muted">No pending or recent transfer for this address.</p>
            ) : null}
            {pending.map((t) => (
              <p key={t.hash} className="font-mono text-xs text-muted">
                pending {truncateHash(t.hash, 8)} · {formatAmount(t.amount)}
              </p>
            ))}
            {confirmed.slice(0, 5).map((t) => (
              <p key={t.hash} className="font-mono text-xs text-muted">
                confirmed #{t.blockHeight} · {formatAmount(t.amount)}
              </p>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
        <Badge tone={mineWithdrawals.some((w) => w.status === "settled") ? "ok" : "warn"}>
          {mineWithdrawals.some((w) => w.status === "settled") ? "output settled" : "leaves on a proven output"}
        </Badge>
        <p className="text-sm text-muted">
          A transfer pays another EQU address. A withdrawal locks EQU in an escrow this key cannot spend.
          Bitcoin settles when an output's destination and amount match the lock and that transaction
          sits in an admitted header. Ethereum settles when a receipt — and, for native ETH, the transaction —
          is proven against an admitted execution header's trie roots. That header is not an EQU beacon,
          and Ethereum's sync committee is not verified. The first execution header is only a structural
          bootstrap. Settled EQU is not credited on this ledger.
          If the proof does not arrive within {snap?.params.withdrawalTimeout ?? 10} blocks, the same amount returns
          to this address. A lock against a header hash is not this withdrawal.
        </p>
        {wallet ? (
          <>
            <Input value={destination} onChange={(e) => setDestination(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <Input value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} />
              <Input value={withdrawNonce} onChange={(e) => setWithdrawNonce(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void stageWithdrawal("btc", "btc")}>Sign and lock</Button>
            </div>
            {mineWithdrawals.length === 0 ? <p className="text-sm text-muted">No withdrawal for this address.</p> : null}
            {mineWithdrawals.map((w) => (
              <p key={w.id} className="break-all font-mono text-xs text-muted">
                {w.status} · {formatAmount(w.amount)} · {w.destination} · expiry {w.expiryHeight}
                {w.effectLocator ? ` · ${truncateHash(w.effectLocator, 8)}` : ""}
              </p>
            ))}
            <h2 className="font-display text-xl">Settle a Bitcoin output</h2>
            <p className="text-sm text-muted">
              Paste the raw transaction. The chain reads the output. It does not trust a destination typed here.
              The header must already be in this chain.
            </p>
            <Input placeholder="Withdrawal id" value={mineWithdrawals.find((w) => w.status === "locked")?.id ?? ""} readOnly />
            <textarea
              className="min-h-24 w-full rounded-md bg-bg-elevated p-3 font-mono text-xs"
              placeholder="Raw transaction hex"
              value={rawTx}
              onChange={(e) => setRawTx(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input value={vout} onChange={(e) => setVout(e.target.value)} />
              <Input placeholder="Header hash" value={headerHash} onChange={(e) => setHeaderHash(e.target.value)} />
            </div>
            <Input placeholder="Merkle siblings, comma separated" value={merkle} onChange={(e) => setMerkle(e.target.value)} />
            <Button
              variant="secondary"
              onClick={async () => {
                const id = mineWithdrawals.find((w) => w.status === "locked")?.id;
                if (!id) {
                  toast.error("No locked withdrawal");
                  return;
                }
                const res = await settleWithdrawal({
                  data: {
                    network,
                    id,
                    rawTx,
                    vout: Number(vout),
                    headerHash,
                    merkle: merkle.split(",").map((item) => item.trim()).filter(Boolean),
                  },
                });
                if (res.ok) {
                  toast.success("Settle queued. The next block checks the output.");
                  await qc.invalidateQueries({ queryKey: ["snapshot", network] });
                } else toast.error(res.error ?? "Refused");
              }}
            >
              Submit Bitcoin proof
            </Button>
            <h2 className="font-display text-xl">Ethereum execution proof</h2>
            <p className="text-sm text-muted">
              Destination is eth: plus 20 bytes. Asset is eth, or the token address on a Transfer log.
              Paste the execution header RLP. Its hash is keccak256 of that RLP. An EQU beacon bodyRoot is not the receipts root.
            </p>
            <Input value={ethDestination} onChange={(e) => setEthDestination(e.target.value)} />
            <Input value={ethAsset} onChange={(e) => setEthAsset(e.target.value)} />
            <Button variant="secondary" onClick={() => void stageWithdrawal("eth", ethAsset.trim().toLowerCase(), ethDestination)}>
              Sign Ethereum lock
            </Button>
            <textarea
              className="min-h-24 w-full rounded-md bg-bg-elevated p-3 font-mono text-xs"
              placeholder="Execution header RLP"
              value={headerRlp}
              onChange={(e) => setHeaderRlp(e.target.value)}
            />
            <Button
              variant="secondary"
              onClick={async () => {
                const res = await admitExecution({ data: { network, headerRlp } });
                if (res.ok) {
                  toast.success("Execution header queued. The sync committee is not checked.");
                  await qc.invalidateQueries({ queryKey: ["snapshot", network] });
                } else toast.error(res.error ?? "Refused");
              }}
            >
              Admit execution header
            </Button>
            <Input placeholder="Execution block hash" value={ethBlock} onChange={(e) => setEthBlock(e.target.value)} />
            <textarea
              className="min-h-24 w-full rounded-md bg-bg-elevated p-3 font-mono text-xs"
              placeholder="Receipt RLP"
              value={receiptRlp}
              onChange={(e) => setReceiptRlp(e.target.value)}
            />
            <textarea
              className="min-h-20 w-full rounded-md bg-bg-elevated p-3 font-mono text-xs"
              placeholder="Receipt proof nodes, comma separated"
              value={receiptProof}
              onChange={(e) => setReceiptProof(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input value={txIndex} onChange={(e) => setTxIndex(e.target.value)} />
              <Input value={logIndex} onChange={(e) => setLogIndex(e.target.value)} />
            </div>
            <textarea
              className="min-h-20 w-full rounded-md bg-bg-elevated p-3 font-mono text-xs"
              placeholder="Native ETH only: transaction RLP"
              value={txRlp}
              onChange={(e) => setTxRlp(e.target.value)}
            />
            <textarea
              className="min-h-20 w-full rounded-md bg-bg-elevated p-3 font-mono text-xs"
              placeholder="Native ETH only: transaction proof"
              value={txProof}
              onChange={(e) => setTxProof(e.target.value)}
            />
            <Button
              variant="secondary"
              onClick={async () => {
                const id = mineWithdrawals.find((w) => w.status === "locked" && w.network === "eth")?.id;
                if (!id) {
                  toast.error("No locked Ethereum withdrawal");
                  return;
                }
                const res = await settleEthWithdrawal({
                  data: {
                    network,
                    id,
                    blockHash: ethBlock,
                    txIndex: Number(txIndex),
                    receiptRlp,
                    receiptProof: receiptProof.split(",").map((item) => item.trim()).filter(Boolean),
                    logIndex: Number(logIndex),
                    txRlp,
                    txProof: txProof.split(",").map((item) => item.trim()).filter(Boolean),
                  },
                });
                if (res.ok) {
                  toast.success("Ethereum settle queued. The next block checks the receipt.");
                  await qc.invalidateQueries({ queryKey: ["snapshot", network] });
                } else toast.error(res.error ?? "Refused");
              }}
            >
              Submit Ethereum proof
            </Button>
          </>
        ) : null}
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Light tip" value={block ? `#${block.height}` : "—"} hint={block ? truncateHash(block.hash, 6) : ""} />
        <Stat label="Discovery cost" value={block?.solverIterations ?? "—"} hint="kernel nonce iters" />
        <Stat label="Verify cost" value={policy === "defer" ? "deferred" : 1} hint="evals in this body" />
        <Stat
          label="Agreement"
          value={policy === "defer" ? "—" : report?.agree ? "yes" : "no"}
          hint={policy === "defer" ? "device is waiting" : report ? formatSci(report.localResidual) : "waiting"}
        />
      </div>

      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-subtle">Light header packet</p>
            <h2 className="mt-1 font-display text-xl">What this body actually receives</h2>
          </div>
          <Button variant={policy === "defer" ? "secondary" : "ghost"} onClick={() => setHot((v) => !v)}>
            {policy === "defer" ? "Device hot — waiting" : `${policy} · ${resources.thermalC}°C`}
          </Button>
        </div>
        {block ? (
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
            <Row k="Hash" v={truncateHash(block.hash, 10)} />
            <Row k="Height" v={String(block.height)} />
            <Row k="Prev" v={truncateHash(block.prevHash, 10)} />
            <Row k="State root" v={truncateHash(block.stateRoot, 10)} />
            <Row k="Merkle" v={truncateHash(block.merkleRoot, 10)} />
            <Row k="Nonce" v={String(block.nonce)} />
            <Row k="Committed P" v={block.committedPressure.toFixed(3)} />
            <Row k="Claimed R" v={formatSci(block.residual)} />
          </dl>
        ) : (
          <p className="mt-4 text-sm text-muted">Waiting for a tip.</p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {blocks.slice(0, 8).map((b) => (
            <button
              key={b.hash}
              type="button"
              onClick={() => setSelected(b.hash)}
              className="min-h-11 rounded-md bg-bg-elevated px-3 font-mono text-xs shadow-[var(--shadow-border)]"
            >
              #{b.height}
            </button>
          ))}
        </div>
      </div>

      {policy === "defer" ? (
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <Badge tone="warn">deferred</Badge>
          <p className="mt-3 max-w-xl text-sm text-muted">
            This device is too hot or too low to verify. Deferral is not acceptance.
            The header stays unchecked. Temperature is not written into Ω.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {PIPELINE.map((step) => {
            const check = report?.checks.find((c) => c.name === step.name);
            return (
              <div key={step.name} className="flex items-start justify-between gap-4 rounded-lg bg-surface px-4 py-3 shadow-[var(--shadow-border)]">
                <div>
                  <div className="text-sm">{step.label}</div>
                  <div className="text-xs text-muted">{check?.detail ?? step.why}</div>
                </div>
                <Badge tone={!check ? "muted" : check.ok ? "ok" : "danger"}>
                  {!check ? "—" : check.ok ? "pass" : "fail"}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}
