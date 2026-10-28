# DR-1 — network parameters are frozen

Checkpoint this decision lands on: after `88e0928`.

The census at `88e0928` is unchanged. It is a same-author negative over named finality fields. It is not independent verification, and accepting it would not make it independent. This decision does not rewrite that evidence.

What was selected:

- Harness: the one writer, `unbond.run.ts`, no longer assigns `NETWORKS.mainnet.unbondingPeriod`. `unbondMatureAt(0, 99)` is the arithmetic. The live period stays 10.
- Mechanism: `Object.freeze` on each network object and on the `NETWORKS` record. A write throws. This is the object, not a list of field names.
- Independence standard: not accepted as a substitute for the freeze. The four census boundaries and the old mutation still attach to the census. They do not attach to the freeze.

`paramsOf` returns that frozen object. A consumer that needs a different period uses a different object. It does not write this one.
