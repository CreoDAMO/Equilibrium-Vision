import React from "react";
import { useRoute, useLocation } from "wouter";
import { useGetBlock, useGetTransaction } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { Box, ArrowRightLeft, Search } from "lucide-react";
import { truncateHash } from "@/lib/format";

export default function SearchPage() {
  const [, params] = useRoute("/search/:query");
  const query = (params?.query || "").toLowerCase();
  const [, setLocation] = useLocation();

  const isValidHash = /^[0-9a-f]{64}$/.test(query);

  // Try block and tx in parallel; retry: false so a 404 doesn't spin-retry
  const { data: block, isLoading: blockLoading, isError: blockError } = useGetBlock(
    query,
    { query: { retry: false, enabled: isValidHash } },
  );
  const { data: tx, isLoading: txLoading, isError: txError } = useGetTransaction(
    query,
    { query: { retry: false, enabled: isValidHash } },
  );

  const loading = isValidHash && (blockLoading || txLoading);
  const blockFound = isValidHash && !blockLoading && !blockError && !!block;
  const txFound = isValidHash && !txLoading && !txError && !!tx;

  // Compute redirect target before the effect so deps are value-stable
  const blockTarget = blockFound && block ? `/blocks/${block.hash}` : null;
  const txTarget = txFound && tx ? `/tx/${tx.hash}` : null;

  // Auto-redirect once we know there is exactly one match
  React.useEffect(() => {
    if (loading) return;
    if (blockTarget && !txTarget) setLocation(blockTarget);
    else if (txTarget && !blockTarget) setLocation(txTarget);
  }, [loading, blockTarget, txTarget, setLocation]);

  // Invalid hash format — show before the loading check
  if (!isValidHash) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <Search className="w-12 h-12 text-muted-foreground/40" />
        <h2 className="text-xl font-semibold">Invalid search query</h2>
        <p className="text-muted-foreground max-w-sm">
          <span className="font-mono text-sm bg-muted px-1 rounded">{truncateHash(query) || "(empty)"}</span>{" "}
          is not a valid block hash or transaction hash. Use the search bar with a 64-char hex hash, a block height, or a 40-char wallet address.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <p className="text-muted-foreground">
          Searching for{" "}
          <span className="font-mono text-sm bg-muted px-1 rounded">{truncateHash(query)}</span>…
        </p>
      </div>
    );
  }

  if (!blockFound && !txFound) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <Search className="w-12 h-12 text-muted-foreground/40" />
        <h2 className="text-xl font-semibold">Nothing found</h2>
        <p className="text-muted-foreground max-w-sm">
          No block or transaction matched{" "}
          <span className="font-mono text-sm bg-muted px-1 rounded">{truncateHash(query)}</span>.
          Try a block height (number) or a 40-char wallet address instead.
        </p>
      </div>
    );
  }

  // Both matched (collision — rare but possible): let the user pick
  return (
    <div className="space-y-4 max-w-lg mx-auto py-12">
      <h2 className="text-xl font-semibold">Multiple matches</h2>
      <p className="text-muted-foreground text-sm">
        This hash matches more than one object. Select one to continue:
      </p>
      {blockFound && block && (
        <Link href={`/blocks/${block.hash}`}>
          <Card className="hover:border-primary cursor-pointer transition-colors">
            <CardContent className="flex items-center gap-4 p-4">
              <Box className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">Block #{block.height}</p>
                <p className="text-xs text-muted-foreground font-mono truncate">{block.hash}</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}
      {txFound && tx && (
        <Link href={`/tx/${tx.hash}`}>
          <Card className="hover:border-primary cursor-pointer transition-colors">
            <CardContent className="flex items-center gap-4 p-4">
              <ArrowRightLeft className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">Transaction</p>
                <p className="text-xs text-muted-foreground font-mono truncate">{tx.hash}</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}
    </div>
  );
}
