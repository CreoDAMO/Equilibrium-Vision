export function truncateHash(hash: string, size = 8): string {
  if (!hash) return "—";
  if (hash.length <= size * 2 + 1) return hash;
  return `${hash.slice(0, size)}…${hash.slice(-size)}`;
}

export function formatAmount(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}

export function formatSci(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  return n.toExponential(digits);
}

export function timeAgo(ts: number): string {
  const s = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - s);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatTime(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString().replace(".000", "");
}
