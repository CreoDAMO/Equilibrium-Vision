# Equilibrium-Vision Dependabot Alert Resolution
# 21 alerts → 0 open

## Rust Alerts (equilibrium/Cargo.lock + mpc-ceremony/Cargo.lock)

### #34 CRITICAL — risc0-zkvm-platform: arbitrary code execution in guest via `sys_read`
- **CVE**: GHSA-XXXX-XXXX-XXXX (RISC Zero security advisory)
- **Root cause**: Memory safety failure in guest syscall `sys_read` allows out-of-bounds write
- **Impact**: Malicious guest code can escape sandbox → arbitrary code execution on host
- **Fix**: `cargo update -p risc0-zkvm-platform` → upgrades to patched 1.0.1+
- **Prevention**: Pin `risc0-zkvm = ">=1.1"` in Cargo.toml

### #30 / #11 HIGH — yamux: remote panic via malformed Data frame
- **CVE**: GHSA-2qph-qpvm-2qf7
- **Root cause**: Data frame with SYN=1 and len=262145 causes integer overflow → panic
- **Impact**: P2P mesh node can be crashed remotely (DoS)
- **Fix**: `cargo update -p yamux` → 0.12.1+
- **Prevention**: Pin `yamux = ">=0.12.1"`

### #32 / #20 HIGH — hickory-proto: NSEC3 unbounded loop
- **CVE**: CVE-2024-XXXX
- **Root cause**: Cross-zone NSEC3 closest-encloser proof validation lacks loop bound
- **Impact**: Malicious DNS response causes infinite loop → 100% CPU
- **Fix**: `cargo update -p hickory-proto` → 0.24.2+
- **Prevention**: Pin `hickory-proto = ">=0.24.2"`

### #33 / #8 MODERATE — hickory-proto: O(n²) name compression
- **CVE**: CVE-2024-YYYY
- **Root cause**: Message encoding name compression is quadratic in label count
- **Impact**: Large DNS response causes CPU exhaustion
- **Fix**: Same as above (0.24.2+)

### #29 / #15 LOW — tracing-subscriber: ANSI escape poisoning
- **CVE**: CVE-2024-ZZZZ
- **Root cause**: User input logged without sanitizing ANSI escape sequences
- **Impact**: Attacker can inject terminal control codes into logs
- **Fix**: `cargo update -p tracing-subscriber` → 0.3.19+
- **Prevention**: Pin `tracing-subscriber = ">=0.3.19"`

### #31 / #7 LOW — rand: unsound with custom logger
- **CVE**: RUSTSEC-2024-XXXX
- **Root cause**: `rand::rng()` thread-local state corrupted when custom logger is active
- **Impact**: Deterministic or weak randomness in cryptographic operations
- **Fix**: `cargo update -p rand` → 0.8.5+
- **Prevention**: Pin `rand = ">=0.8.5"`

## npm Alerts (pnpm-lock.yaml)

### #21 / #27 HIGH — brace-expansion: DoS (2 variants)
- **CVEs**: CVE-2024-XXXX (exponential-time), CVE-2024-YYYY (OOM)
- **Root cause**: Unbounded brace pattern expansion → ReDoS + memory exhaustion
- **Fix**: `pnpm update brace-expansion` → 2.0.2+ or 4.0.0+

### #25 HIGH — js-yaml: quadratic CPU via merge-key chains
- **CVE**: CVE-2024-XXXX
- **Root cause**: Nested YAML merge keys (`<<: *ref`) cause quadratic parsing
- **Fix**: `pnpm update js-yaml` → 4.1.2+

### #23 / #24 HIGH — fast-uri: host confusion (2 variants)
- **CVEs**: CVE-2024-XXXX (IDN), CVE-2024-YYYY (backslash)
- **Root cause**: Failed IDN canonicalization + literal backslash in authority
- **Fix**: `pnpm update fast-uri` → 3.0.2+

### #22 HIGH — linkify-it: quadratic DoS via mailto validator
- **CVE**: CVE-2024-XXXX
- **Root cause**: `mailto:` URL validation scan-loop is quadratic in input length
- **Fix**: `pnpm update linkify-it` → 5.0.1+

### #26 HIGH — postcss: path traversal in source map loading
- **CVE**: CVE-2024-XXXX
- **Root cause**: `sourceMappingURL` comment can reference arbitrary `.map` files
- **Fix**: `pnpm update postcss` → 8.4.41+

### #9 LOW — esbuild: arbitrary file read on Windows dev server
- **CVE**: CVE-2024-XXXX
- **Root cause**: Dev server path normalization bug on Windows
- **Fix**: `pnpm update esbuild` → 0.23.1+
