import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg bg-bg-elevated p-4 shadow-[var(--shadow-border)]", className)}>
      <div className="text-xs uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-2 font-mono text-xl tabular text-fg">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}
