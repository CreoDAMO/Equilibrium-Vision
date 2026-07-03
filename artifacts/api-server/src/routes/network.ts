import { Router } from "express";
import { chainState } from "../chain/index.js";

const router = Router();

router.get("/gossip", (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? 50), 100);
  const type = req.query["type"] as string | undefined;
  const events = type
    ? chainState.gossipLog.filter(e => e.type === type)
    : chainState.gossipLog;
  res.json({
    count: events.length,
    events: events.slice(0, limit),
  });
});

router.get("/sync/status", (_req, res) => {
  const peers = chainState.peers;
  const synced = peers.filter(p => p.connected && p.height >= chainState.height).length;
  const behind = peers.filter(p => p.connected && p.height < chainState.height).length;
  res.json({
    localHeight: chainState.height,
    finalizedHeight: chainState.finalizedHeight,
    peers: {
      total: peers.length,
      connected: peers.filter(p => p.connected).length,
      synced,
      behind,
    },
    isSynced: true,
  });
});

router.get("/sync/headers", (req, res) => {
  const from = Number(req.query["from"] ?? 0);
  const to = Number(req.query["to"] ?? Math.min(from + 100, chainState.height));
  const limit = Math.min(to - from + 1, 200);
  const actualTo = from + limit - 1;

  if (isNaN(from) || isNaN(to) || from < 0 || to < from) {
    res.status(400).json({ error: "Invalid from/to range" });
    return;
  }

  const headers = chainState.getHeadersRange(from, actualTo);
  res.json({
    from,
    to: actualTo,
    count: headers.length,
    headers,
  });
});

router.get("/chain/finality", (_req, res) => {
  const latest = chainState.finalityRounds.get(chainState.height);
  const recentRounds = [];
  for (let h = Math.max(0, chainState.height - 5); h <= chainState.height; h++) {
    const r = chainState.finalityRounds.get(h);
    if (r) recentRounds.push(r);
  }
  res.json({
    finalizedHeight: chainState.finalizedHeight,
    latestHeight: chainState.height,
    lag: chainState.height - chainState.finalizedHeight,
    latestRound: latest ?? null,
    recentRounds,
  });
});

export default router;
