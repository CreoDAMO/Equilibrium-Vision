# Version-1 relation

The proof target is a faithful proof of the production relation. It is not a proof of a stronger security claim.

| Decision | Outcome | Claimed | Not claimed |
| --- | --- | --- | --- |
| Couplings | RETAIN-WITH-DISCLAIMER | five finite fields, each at least zero | an upper bound, and finiteness of every residual product |
| Bitcoin headers | RETAIN-WITH-DISCLAIMER | 80 bytes, extension, and the header's own target | canonical Bitcoin membership |
| Ethereum beacon | RETAIN-WITH-DISCLAIMER | the committee already in the state | Ethereum's canonical sync committee |
| Ethereum execution | RETAIN-WITH-DISCLAIMER | structure and parent continuity | a finalized execution block |
| Models | RETAIN-WITH-DISCLAIMER | the registry commitment | that the model ran |
| Settlements | RETAIN-WITH-DISCLAIMER | the local release rule | that the foreign payment occurred |

Withdrawals are not settlements. A withdrawal still checks the foreign header that is already in the state. That check does not become a claim that the header is canonical.

The statement field `v1` is `faithful-v1`. A statement with any other value is refused. Workstream 1 is this relation. It is not a second one.
