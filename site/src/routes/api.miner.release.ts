import { createFileRoute } from "@tanstack/react-router";
import { MINER_RELEASE } from "@/protocol/miner-release";

export const Route = createFileRoute("/api/miner/release")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify(MINER_RELEASE), {
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          },
        }),
    },
  },
});
