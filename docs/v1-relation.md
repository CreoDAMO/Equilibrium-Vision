# Version-1 relation

The proof target is a faithful proof of the production relation. It is not a proof of a stronger security claim.

The current identifier is `faithful-v1.1`. `faithful-v1` remains the earlier descriptor, and its bytes stay pinned. A change to either descriptor fails the pin unless the identifier changes with it.

| Decision | Outcome | Claimed | Not claimed |
| --- | --- | --- | --- |
| Couplings | RETAIN-WITH-DISCLAIMER | five finite fields, each at least zero | an upper bound, and finiteness of every residual product |
| Bitcoin headers | RETAIN-WITH-DISCLAIMER | 80 bytes, extension, and the header's own target | canonical Bitcoin membership |
| Ethereum beacon, first committee | RETAIN-WITH-DISCLAIMER | the transition admits that committee into the state | that the committee is Ethereum's |
| Ethereum beacon, later headers | RETAIN-WITH-DISCLAIMER | the header is checked against the committee already in the state | that the committee is Ethereum's |
| Ethereum execution | RETAIN-WITH-DISCLAIMER | structure and parent continuity | a finalized execution block |
| Models | RETAIN-WITH-DISCLAIMER | the registry commitment | that the model ran |
| Settlements | RETAIN-WITH-DISCLAIMER | the local release rule | that the foreign payment occurred |

Withdrawals are not settlements. A withdrawal still checks the foreign header that is already in the state. That check does not become a claim that the header is canonical.

The statement field `v1` is `faithful-v1.1`. A statement with any other value is refused. Workstream 1 opens this statement. The pin is not the proof.
