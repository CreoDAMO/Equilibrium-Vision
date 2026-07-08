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
  use `python3 -c "open(...).read().hex()"` instead in build scripts.
