import { createFileRoute } from "@tanstack/react-router";

/**
 * The phone posts here. This host does not install that block.
 * Naming the network is required so a later admission path cannot guess it.
 */
export const Route = createFileRoute("/api/blocks/submit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        let bodyNetwork = "";
        try {
          const body = (await request.json()) as { network?: unknown };
          if (typeof body.network === "string") bodyNetwork = body.network;
        } catch {
          bodyNetwork = "";
        }
        const named = url.searchParams.get("network") || bodyNetwork;
        const network = named === "mainnet" ? "mainnet" : named === "testnet" ? "testnet" : "";
        if (!network) {
          return Response.json(
            { accepted: false, error: "network must be mainnet or testnet" },
            { status: 400, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } },
          );
        }
        return Response.json(
          {
            accepted: false,
            network,
            chainId: network === "mainnet" ? 1 : 2,
            error: "this host does not adopt an external block",
          },
          { status: 422, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } },
        );
      },
    },
  },
});
