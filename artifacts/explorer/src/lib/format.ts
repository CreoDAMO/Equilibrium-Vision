export function truncateHash(hash: string): string {
  if (!hash || hash.length < 14) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

export function formatAmount(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(amount);
}

export function timeAgo(timestamp: number): string {
  // Block timestamps are Unix seconds; Date.now() is milliseconds.
  const seconds = Math.floor((Date.now() - timestamp * 1000) / 1000);
  if (seconds < 0) return "just now";
  let interval = seconds / 31536000;
  if (interval >= 1) return Math.floor(interval) + "y ago";
  interval = seconds / 2592000;
  if (interval >= 1) return Math.floor(interval) + "mo ago";
  interval = seconds / 86400;
  if (interval >= 1) return Math.floor(interval) + "d ago";
  interval = seconds / 3600;
  if (interval >= 1) return Math.floor(interval) + "h ago";
  interval = seconds / 60;
  if (interval >= 1) return Math.floor(interval) + "m ago";
  return Math.floor(seconds) + "s ago";
}

/** Format a small float in human-readable scientific notation (e.g. 1.0 × 10⁻⁸). */
export function formatScientific(n: number, sigFigs = 3): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  // Use fixed notation for "normal" range
  if (abs >= 0.001 && abs < 1_000_000) {
    const decimals = Math.max(0, sigFigs - Math.floor(Math.log10(abs)) - 1);
    return n.toFixed(Math.min(decimals, 9));
  }
  const exp = Math.floor(Math.log10(abs));
  const mantissa = (n / Math.pow(10, exp)).toFixed(sigFigs - 1);
  const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
  const expStr = String(Math.abs(exp))
    .split("")
    .map((d) => SUP[Number(d)])
    .join("");
  return exp < 0
    ? `${mantissa} × 10⁻${expStr}`
    : `${mantissa} × 10${expStr}`;
}

/** Format a large integer with compact suffix (1 000 → 1K, 1 000 000 → 1M). */
export function formatCompact(n: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}
