/** Same encoding as the kernel's wasmLeafOf. Empty storage is the string "none". */
export function wasmLeafOf(entries: Iterable<[string, string]>): string {
  const list = [...entries];
  if (!list.length) return "none";
  return list
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}
