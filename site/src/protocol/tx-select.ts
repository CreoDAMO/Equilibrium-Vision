/**
 * The only order in which a block may apply transactions.
 * Highest fee among txs whose nonce is the account's next nonce.
 * A higher fee does not jump a missing nonce.
 * Equal fees break on the tx hash.
 */
export type SelectableTx = {
  hash: string;
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
};

export function selectSuccessorTxs<T extends SelectableTx>(
  balanceOf: (addr: string) => number,
  nonceOf: (addr: string) => number,
  txs: readonly T[],
  limit: number,
  releasesTo: (tx: T) => boolean = () => true,
): T[] {
  const spent = new Map<string, number>();
  const received = new Map<string, number>();
  const usedNonce = new Map<string, number>();
  const used = new Set<string>();
  const chosen: T[] = [];
  while (chosen.length < limit) {
    let best: T | null = null;
    for (const tx of txs) {
      if (used.has(tx.hash)) continue;
      if (!Number.isSafeInteger(tx.amount) || !Number.isSafeInteger(tx.fee) || tx.amount <= 0 || tx.fee < 0) continue;
      const nonce = nonceOf(tx.from) + (usedNonce.get(tx.from) ?? 0);
      if (tx.nonce !== nonce) continue;
      const balance = balanceOf(tx.from) + (received.get(tx.from) ?? 0) - (spent.get(tx.from) ?? 0);
      if (balance < tx.amount + tx.fee) continue;
      if (!best || tx.fee > best.fee || (tx.fee === best.fee && tx.hash < best.hash)) best = tx;
    }
    if (!best) break;
    used.add(best.hash);
    spent.set(best.from, (spent.get(best.from) ?? 0) + best.amount + best.fee);
    usedNonce.set(best.from, (usedNonce.get(best.from) ?? 0) + 1);
    if (releasesTo(best)) received.set(best.to, (received.get(best.to) ?? 0) + best.amount);
    chosen.push(best);
  }
  return chosen;
}
