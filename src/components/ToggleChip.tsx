"use client";

import { cn } from "@/lib/utils";

export function ToggleChip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full border px-4 py-2 text-sm transition-colors",
        selected
          ? "border-primary bg-primary/18 text-accent-100"
          : "border-border bg-transparent text-neutral-400 hover:border-neutral-500",
      )}
    >
      {children}
    </button>
  );
}
