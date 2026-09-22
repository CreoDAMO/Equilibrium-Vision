import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { truncateHash } from "@/lib/format";
import { cn } from "@/lib/utils";

export function HashLink({
  kind,
  value,
  className,
}: {
  kind: "block" | "tx" | "address";
  value: string;
  className?: string;
}) {
  const cls = cn("font-mono text-sm text-accent hover:underline underline-offset-4", className);
  if (kind === "block") {
    return (
      <Link to="/blocks/$hash" params={{ hash: value }} className={cls}>
        {truncateHash(value)}
      </Link>
    );
  }
  if (kind === "tx") {
    return (
      <Link to="/tx/$hash" params={{ hash: value }} className={cls}>
        {truncateHash(value)}
      </Link>
    );
  }
  return (
    <Link to="/address/$addr" params={{ addr: value }} className={cls}>
      {truncateHash(value)}
    </Link>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-sm tabular", className)}>{children}</span>;
}
