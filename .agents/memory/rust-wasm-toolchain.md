---
name: Compiling Rust to wasm32-unknown-unknown in this container
description: How to get a real cargo build --target wasm32-unknown-unknown working here, and the wasm-import gotchas for hand-written no_std contracts calling into a JS host.
---

## Toolchain setup
The Nix-provided `rust-mixed` toolchain (whatever `rustc`/`cargo` resolve to by
default) only ships the `x86_64-unknown-linux-gnu` std lib — no wasm32 target.
Installing the target via a bare `rustup target add` against that toolchain
does nothing useful, because there's no rustup-managed toolchain to attach it
to.

Working recipe:
1. `installSystemDependencies({ packages: ["rustup"] })`
2. `rustup toolchain install stable --profile minimal`
3. `rustup target add wasm32-unknown-unknown --toolchain stable`
4. Use the toolchain's own binaries directly — rustup does NOT create
   `~/.cargo/bin` shims in this environment — via
   `$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/{cargo,rustc}`.

**Why:** the two toolchains (nix rust-mixed vs rustup stable) are different
rustc versions with incompatible metadata; you must use one toolchain's cargo
+ rustc consistently, not mix them.

## The "cannot allocate memory in static TLS block" crash
Rustup's prebuilt (non-Nix-patched) `rustc`/`librustc_driver-*.so` segfaults
this way when `cargo build` spawns it as a subprocess, even though invoking
`rustc` directly in the same shell works fine. Root cause is a glibc static
TLS reservation issue specific to how cargo execs its child rustc.

**Fix:** wrap `rustc` in a tiny shell script that exports
`GLIBC_TUNABLES=glibc.rtld.optional_static_tls=4000000` and
`RUST_MIN_STACK=33554432` before exec-ing the real rustc, then point cargo at
it via `RUSTC=/path/to/wrapper.sh`. Setting the env vars directly in the
calling shell before `cargo build` is NOT sufficient — cargo's subprocess
spawn doesn't reliably inherit it the same way a direct shell invocation
does. Both contracts under `contracts/*/build.sh` bake this wrapper pattern
in already; replicate it for any new Rust-to-wasm contract build script.

## Hand-written no_std contract ↔ JS host import gotchas
- `extern "C"` blocks on `wasm32-unknown-unknown` need an explicit
  `#[link(wasm_import_module = "env")]` attribute, or the compiler leaves the
  functions as unresolved native symbols instead of emitting proper wasm
  imports (silent-ish linker errors listing every host function as
  "undefined symbol").
- Do not name a host import `log` — it collides with compiler_builtins'
  libm `log` (natural logarithm) intrinsic and corrupts codegen/linking.
  Import it under a different local Rust name via `#[link_name = "log"]`
  (e.g. `host_log_raw`) while keeping the wasm import name `log` to match
  the JS host's `importObject.env.log`.
- No `xxd` binary in this container for hex-encoding the built `.wasm` —
  use `node -e "const fs=require('fs');const d=fs.readFileSync('...');fs.writeFileSync('....hex',d.toString('hex'))"` (python3 is not in PATH on Replit). CI ubuntu-latest does have python3, so the build.sh python3 call is fine for CI.

## Global allocator requirement (Rust ≥ 1.73)
All `no_std` WASM contracts that use `extern crate alloc` (i.e. use `String`, `Vec`, `format!`) **must** declare a `#[global_allocator]`. Since Rust 1.73, `wasm32-unknown-unknown` no longer ships an implicit dlmalloc allocator. Without it, rustc emits a hard error: `no global memory allocator found but one is required`.

**Fix (zero extra dependencies):** add this bump allocator module to each contract's `lib.rs` right after the `#[panic_handler]`:
```rust
mod bump_alloc {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    struct Bump { buf: UnsafeCell<[u8; 65536]>, pos: UnsafeCell<usize> }
    unsafe impl Sync for Bump {}
    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let pos = &mut *self.pos.get();
            let start = (*pos + layout.align() - 1) & !(layout.align() - 1);
            if start + layout.size() > 65536 { return core::ptr::null_mut(); }
            *pos = start + layout.size();
            (*self.buf.get()).as_mut_ptr().add(start)
        }
        unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
    }
    #[global_allocator]
    pub static ALLOC: Bump = Bump {
        buf: UnsafeCell::new([0u8; 65536]),
        pos: UnsafeCell::new(0),
    };
}
```
WASM is single-threaded so `UnsafeCell` + `unsafe impl Sync` is sound.

## Toolchain version pinning for reproducible .hex
WASM codegen is NOT byte-for-byte stable across rustc versions. Pin each contract's `rust-toolchain.toml` to a specific version (currently `1.97.0`, the stable as of 2026-07-07). CI must install that exact toolchain (`rustup toolchain install 1.97.0 --profile minimal --target wasm32-unknown-unknown`) BEFORE running the `build.sh` scripts, or the rebuilt .hex will differ from the committed one and the staleness check will fail.
