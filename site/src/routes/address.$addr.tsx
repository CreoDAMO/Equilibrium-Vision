import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getAccount } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { formatAmount, truncateHash } from "@/lib/format";
import { Stat } from "@/components/stat";

export const Route = createFileRoute("/address/$addr")({ component: AddressPage });

function AddressPage() {
  const { addr } = Route.useParams();
  const { network } = useNetwork();
  const { data } = useQuery({
    queryKey: ["account", network, addr],
    queryFn: () => getAccount({ data: { network, address: addr } }),
  });
  if (!data) return <p className="text-muted">Loading account…</p>;
  return (
    <div className="space-y-6">
      <h1 className="break-all font-mono text-lg">{data.address}</h1>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Balance" value={formatAmount(data.balance)} />
        <Stat label="Nonce" value={data.nonce} />
      </div>
      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl">Activity</h2>
        <ul className="mt-3 divide-y divide-border">
          {data.txs.length === 0 ? (
            <li className="py-3 text-sm text-muted">No transactions yet.</li>
          ) : (
            data.txs.map((t) => (
              <li key={t.hash} className="flex justify-between py-3 text-sm">
                <Link className="font-mono text-accent" to="/tx/$hash" params={{ hash: t.hash }}>
                  {truncateHash(t.hash)}
                </Link>
                <span className="font-mono text-muted">
                  {t.from === data.address ? "−" : "+"}
                  {formatAmount(t.amount)}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
