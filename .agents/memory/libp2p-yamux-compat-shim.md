---
name: libp2p-yamux compat shim
description: Why yamux 0.12.1 stays in the Cargo.lock even after upgrading libp2p, and why it's not a live CVE for us
---

libp2p-yamux (0.46+) is a migration shim that deliberately vendors both `yamux 0.12.1`
(aliased `yamux012`) and `yamux 0.13.x` (aliased `yamux013`) in a single crate.

**The rule**: `Config::default()` routes through yamux 0.13.x (patched).
yamux 0.12.x is only activated if the caller uses custom config methods like
`set_max_num_streams()`.

**Our code path**: `equilibrium/src/p2p.rs` uses `.multiplex(yamux::Config::default())` —
so all connections use yamux 0.13.x. The CVE (panic on crafted inbound Data|SYN frame)
is not reachable.

**Why yamux 0.12.1 stays in the lock**: It's an intentional dep of libp2p-yamux itself.
No upgrade of libp2p will remove it; the libp2p project owns this decision.

**What we did**: Upgraded libp2p from 0.53 → 0.56 (latest). This is the right call for
general upstream security coverage even though it doesn't eliminate the shim dep.

**If a scanner flags it**: Document that `Config::default()` selects the 0.13.x path
(cite the test `config_set_switches_to_v012` in libp2p-yamux source) and that our
p2p.rs does not call any custom config methods.
