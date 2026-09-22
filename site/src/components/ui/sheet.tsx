import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export function SheetContent({
  className,
  children,
  side = "left",
  title,
}: {
  className?: string;
  children: ReactNode;
  side?: "left" | "right";
  title: string;
}) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70 data-[state=open]:animate-in data-[state=closed]:animate-out" />
      <Dialog.Content
        className={cn(
          "fixed z-50 flex h-full w-[min(100%,20rem)] flex-col bg-bg-elevated p-4 shadow-[var(--shadow-border)]",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          side === "left" ? "inset-y-0 left-0" : "inset-y-0 right-0",
          className,
        )}
      >
        <div className="mb-4 flex items-center justify-between">
          <Dialog.Title className="font-display text-lg">{title}</Dialog.Title>
          <Dialog.Close className="flex size-11 items-center justify-center rounded-md hover:bg-surface">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}
