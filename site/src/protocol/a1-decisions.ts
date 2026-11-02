/**
 * A1 decisions at the site and API-server canonical transition.
 * This is not a proof of that transition, and it is not a global census.
 */

export const A1_COMPOSITION_TARGET = "site-and-api-server" as const;

export const A1_RESIDUALS = [
  "startup and recovery routes outside the inspected caller census",
  "external integrations",
  "staking-contract wasm slash, a separate state boundary",
] as const;

export const A1_DC9_2 = {
  scope: A1_COMPOSITION_TARGET,
  status: "closed-at-declared-scope",
  residuals: A1_RESIDUALS,
} as const;

export type A1Effect = "BIND-effect";

export const A1_DC2 = [
  {
    id: "DC-2a",
    op: "wasm init",
    decision: "BIND-effect",
    trust: "the first 40-hex caller is stored as owner, and canonical evidence carries no signature",
  },
  {
    id: "DC-2b",
    op: "wasm pause",
    decision: "BIND-effect",
    trust: "pause stores paused=1 only when the caller is the stored owner, and canonical evidence carries no signature",
  },
  {
    id: "DC-2c",
    op: "wasm unpause",
    decision: "BIND-effect",
    trust: "unpause stores paused=0 only when the caller is the stored owner, and it is not the pause effect",
  },
  {
    id: "DC-2d",
    op: "stake claim",
    decision: "BIND-effect",
    trust: "the named address is credited its accumulated rewards, and canonical evidence carries no signature",
  },
  {
    id: "DC-2e",
    op: "stake propose",
    decision: "BIND-effect",
    trust: "a proposer in the prestate power map is debited a deposit, and canonical evidence carries no signature",
  },
  {
    id: "DC-2f",
    op: "stake vote",
    decision: "BIND-effect",
    trust: "tally power is the prestate snapshot of that voter, and canonical evidence carries no signature",
  },
] as const satisfies readonly { id: string; op: string; decision: A1Effect; trust: string }[];

/** Lock and release are not the withdrawal settlement. */
export const A1_DC6 = [
  { id: "DC-6a-lock", family: "btc-settlement" },
  { id: "DC-6a-release", family: "btc-settlement" },
  { id: "DC-6b-lock", family: "eth-beacon-settlement" },
  { id: "DC-6b-release", family: "eth-beacon-settlement" },
] as const;

export const A1_NOT_DC6_RELEASE = ["DC-6c-btc-withdrawal", "DC-6d-eth-native", "DC-6d-erc20"] as const;
