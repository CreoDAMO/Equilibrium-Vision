# Workstream 1

`faithful_v1` is a Groth16 circuit. It proves the next height, a timestamp that does not move backwards, the liquid credit, and a residual strictly under the threshold. It accepts only the pinned `faithful-v1.1` identifier.

Predecessor, carried state, and header are public inputs. Each limb is constrained to 128 bits and is named in a constraint. The verifying-key coefficient for every public input is tested not to be the identity. Those three values are still not computed from a predecessor state.

The setup seed `0xFA17_0001` is a development seed. The verifying key it produces is pinned by `fd66c1dcc648e5b10d8fe2c26481737e8815aff32e30fd735b602e5c23f4d7e8`. That pin is not a production ceremony.

It is not a proof of `applySuccessor`. `verifyTransitionProof` still rejects every proof. The adoption flag stays off.
