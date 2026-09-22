/** Bodies under lib/ in CreoDAMO/Equilibrium-Vision. Live means this runtime executes them. */

export interface LibraryBody {
  path: string;
  title: string;
  live: boolean;
  note: string;
}

export const LIBRARY: LibraryBody[] = [
  {
    path: "lib/coinomics",
    title: "Coinomics",
    live: true,
    note: "Reward curve, quality multiplier, and slash fractions (5% double-sign, 1% downtime) are the law this kernel uses.",
  },
  {
    path: "lib/db",
    title: "Drizzle schema",
    live: false,
    note: "Source schema for blocks, validators, DEX, SMT, zkML. This site persists its own unowned tables, not that Drizzle client.",
  },
  {
    path: "lib/api-spec",
    title: "OpenAPI",
    live: false,
    note: "The Replit API contract. /api/light is the packet this runtime actually serves. The generated client is not mounted.",
  },
  {
    path: "lib/api-zod",
    title: "Zod types",
    live: false,
    note: "Generated from OpenAPI. Not imported. Disagreement with this kernel is evidence, not a silent redefinition.",
  },
  {
    path: "lib/api-client-react",
    title: "React client",
    live: false,
    note: "Generated fetch client for the old API server. The site calls its own server functions.",
  },
  {
    path: "lib/sdk",
    title: "SDK",
    live: false,
    note: "Source package. Wallet signing here is the in-browser Ed25519 path, not that package.",
  },
];
