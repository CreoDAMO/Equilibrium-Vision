import { createFileRoute } from "@tanstack/react-router";
import { EMBEDDED_WASM } from "@/protocol/deployment";

export const Route = createFileRoute("/api/light")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const network = url.searchParams.get("network") === "mainnet" ? "mainnet" : "testnet";
        const { getNode } = await import("@/lib/node.server");
        const node = await getNode(network);
        const tip = node.tip;
        const prev = tip && tip.height > 0 ? node.getBlock(String(tip.height - 1)) ?? null : null;
        const { independentVerify } = await import("@/protocol/light");
        const report = tip ? independentVerify(tip, prev, node.params) : null;
        const { artifactIdentity } = await import("@/protocol/artifact");
        const artifact = artifactIdentity();
        const body = {
          network,
          chainId: node.params.chainId,
          height: node.height,
          finalizedHeight: node.finalizedHeight,
          persisted: node.persisted,
          canonicalR: tip?.residual ?? null,
          territoryR: tip?.territoryResidual ?? null,
          tip: tip
            ? {
                hash: tip.hash,
                height: tip.height,
                prevHash: tip.prevHash,
                merkleRoot: tip.merkleRoot,
                stateRoot: tip.stateRoot,
                nonce: tip.nonce,
                residual: tip.residual,
                territoryResidual: tip.territoryResidual,
                committedPressure: tip.committedPressure,
                solverIterations: tip.solverIterations,
                finalized: tip.finalized,
                verified: tip.verified,
              }
            : null,
          bidirectional: report
            ? {
                claimedR: report.claimedResidual,
                inferredR: report.localResidual,
                agree: report.agree,
                discoveryIters: report.discoveryIters,
                verifyEvals: report.verifyEvals,
              }
            : null,
          checks: report?.checks ?? [],
          note: "This body names the commit the host was given, the wasm this process executes, and the normalized digest of the output directory on disk. It does not search for a nonce. It is not an APK.",
          deployment: {
            commit: process.env.RENDER_GIT_COMMIT || process.env.EQUILIBRIUM_COMMIT || null,
            node: process.version,
            wasm: EMBEDDED_WASM,
            artifact: artifact?.digest ?? null,
            artifactFiles: artifact?.files ?? null,
          },
        };
        return new Response(JSON.stringify(body), {
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
