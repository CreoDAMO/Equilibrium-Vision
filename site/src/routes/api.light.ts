import { createFileRoute } from "@tanstack/react-router";
import { EMBEDDED_WASM } from "@/protocol/deployment";
import { stringifyCanonical } from "@/protocol/domain";

export const Route = createFileRoute("/api/light")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const network = url.searchParams.get("network") === "mainnet" ? "mainnet" : "testnet";
        const { getNode } = await import("@/lib/node.server");
        const { RestoreRefused } = await import("@/protocol/chain");
        const { heldRestore } = await import("@/protocol/restore-hold");
        const { dbSource } = await import("@/lib/db");
        let node;
        try {
          node = await getNode(network);
        } catch (err) {
          if (err instanceof RestoreRefused) {
            const held = heldRestore(
              network,
              err.message,
              dbSource,
              process.env.RENDER_GIT_COMMIT || process.env.EQUILIBRIUM_COMMIT || null,
            );
            return new Response(stringifyCanonical(held), {
              status: 503,
              headers: {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
                "cache-control": "no-store",
              },
            });
          }
          throw err;
        }
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
          restored: true,
          persistence: dbSource,
          canonicalR: tip?.residual ?? null,
          territoryR: tip?.territoryResidual ?? null,
          work: {
            prevHash: tip?.hash ?? "0".repeat(64),
            tipHeight: tip?.height ?? -1,
            tipTimestamp: tip?.timestamp ?? 0,
            height: (tip?.height ?? -1) + 1,
            difficulty: node.difficulty,
            mempoolPressure: node.mempoolPressure,
            cumulativeWork: Math.max(0, (tip?.height ?? -1) + 1),
            admissionTarget: node.params.residualThreshold,
            merkleRoot: "0".repeat(64),
          },
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
            ...(url.searchParams.get("manifest") === "1" ? { manifest: artifact?.lines ?? null } : {}),
          },
        };
        return new Response(stringifyCanonical(body), {
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
