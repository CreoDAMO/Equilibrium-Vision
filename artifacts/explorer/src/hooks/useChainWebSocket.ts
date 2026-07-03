import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetChainStatusQueryKey,
  getGetChainStatsQueryKey,
  getListBlocksQueryKey,
  getGetMempoolQueryKey,
} from "@workspace/api-client-react";

// ── Event types (mirrors ws-server.ts) ───────────────────────────────────────

type WsEvent =
  | { type: "connected" }
  | { type: "ping" }
  | { type: "new_block"; data: { height: number; hash: string; txCount: number; residual: number } }
  | { type: "mempool_update"; data: { size: number; pressure: number } };

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Opens a WebSocket connection to /ws and invalidates React Query caches
 * when the server broadcasts new_block or mempool_update events.
 *
 * Call this once at the app root (e.g. App.tsx) so all pages share a single
 * connection. Pages keep their refetchInterval as a fallback for when the
 * WebSocket is unavailable.
 */
export function useChainWebSocket(): void {
  const queryClient = useQueryClient();
  const wsRef      = useRef<WebSocket | null>(null);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted  = useRef(false);

  useEffect(() => {
    unmounted.current = false;

    function connect() {
      if (unmounted.current) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/ws`;
      const ws  = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(event.data) as WsEvent;

          if (msg.type === "new_block") {
            // Invalidate all chain-level queries so pages refresh immediately
            void queryClient.invalidateQueries({ queryKey: getGetChainStatusQueryKey() });
            void queryClient.invalidateQueries({ queryKey: getGetChainStatsQueryKey() });
            void queryClient.invalidateQueries({ queryKey: getListBlocksQueryKey() });
            void queryClient.invalidateQueries({ queryKey: getGetMempoolQueryKey() });
          } else if (msg.type === "mempool_update") {
            void queryClient.invalidateQueries({ queryKey: getGetMempoolQueryKey() });
            void queryClient.invalidateQueries({ queryKey: getGetChainStatusQueryKey() });
          }
        } catch {
          // Ignore malformed frames
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!unmounted.current) {
          // Exponential-ish back-off capped at 10 s
          timerRef.current = setTimeout(connect, 3_000);
        }
      };

      ws.onerror = () => {
        // onclose fires after onerror — let it handle reconnect
        ws.close();
      };
    }

    connect();

    return () => {
      unmounted.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [queryClient]);
}
