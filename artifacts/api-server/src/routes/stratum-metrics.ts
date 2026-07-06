import { Router } from "express";
import { getRunningStratumServer } from "../lib/stratum-server.js";

const router = Router();

function gauge(name: string, help: string, value: number, labels: Record<string, string> = {}): string {
  const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");
  const metric = labelStr ? `${name}{${labelStr}}` : name;
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${metric} ${value}\n`;
}

function counter(name: string, help: string, value: number, labels: Record<string, string> = {}): string {
  const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");
  const metric = labelStr ? `${name}{${labelStr}}` : name;
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${metric} ${value}\n`;
}

// GET /metrics/stratum — Prometheus-format abuse-pattern metrics for the
// Stratum mining pool: per-IP connection counts and rejection counters for
// rate-limiting, duplicate shares, and the per-IP connection cap. Lets an
// operator watch for a single source hammering the pool in real time.
router.get("/metrics/stratum", (_req, res) => {
  const stratum = getRunningStratumServer();

  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");

  if (!stratum) {
    // Stratum pool is disabled (STRATUM_PORT unset) — report zeroed totals
    // rather than 404, so scrapers configured against this endpoint don't
    // flap between "up" and "target down" as the pool is toggled.
    res.send(
      gauge("equilibrium_stratum_enabled", "Whether the Stratum mining pool is enabled", 0),
    );
    return;
  }

  const m = stratum.getMetrics();
  const lines: string[] = [];

  lines.push(gauge("equilibrium_stratum_enabled", "Whether the Stratum mining pool is enabled", 1));
  lines.push(gauge("equilibrium_stratum_active_connections", "Current open Stratum TCP connections", m.activeConnections));
  lines.push(gauge("equilibrium_stratum_active_sessions", "Current tracked Stratum miner sessions", m.activeSessions));

  for (const [ip, count] of Object.entries(m.connectionsByIp)) {
    lines.push(gauge("equilibrium_stratum_connections_by_ip", "Open connections from a single remote address", count, { remote_ip: ip }));
  }

  lines.push(counter("equilibrium_stratum_rate_limit_rejections_total", "Total shares rejected for exceeding the per-IP rate limit", m.rateLimitRejectionsTotal));
  for (const [ip, count] of Object.entries(m.rateLimitRejectionsByIp)) {
    lines.push(counter("equilibrium_stratum_rate_limit_rejections_by_ip", "Rate-limit rejections from a single remote address", count, { remote_ip: ip }));
  }

  lines.push(counter("equilibrium_stratum_duplicate_share_rejections_total", "Total shares rejected as duplicates", m.duplicateShareRejectionsTotal));
  for (const [ip, count] of Object.entries(m.duplicateShareRejectionsByIp)) {
    lines.push(counter("equilibrium_stratum_duplicate_share_rejections_by_ip", "Duplicate-share rejections from a single remote address", count, { remote_ip: ip }));
  }

  lines.push(counter("equilibrium_stratum_connection_cap_rejections_total", "Total TCP connections rejected for exceeding the per-IP connection cap", m.connectionCapRejectionsTotal));
  for (const [ip, count] of Object.entries(m.connectionCapRejectionsByIp)) {
    lines.push(counter("equilibrium_stratum_connection_cap_rejections_by_ip", "Connection-cap rejections from a single remote address", count, { remote_ip: ip }));
  }

  res.send(lines.join("\n"));
});

export default router;
