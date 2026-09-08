"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";

/**
 * Grid picker over the fixed niche catalog (convex/radar/niches.ts
 * listActive) — replaces the old typed-keyword niche step. Single-select
 * when maxSelect is 1 (free plan); otherwise multi-select up to maxSelect
 * (pro plan).
 */
export function NichePicker({
  selected,
  onChange,
  maxSelect,
}: {
  selected: Id<"radarNiches">[];
  onChange: (next: Id<"radarNiches">[]) => void;
  maxSelect: number;
}) {
  const niches = useQuery(api.radar.niches.listActive);

  function toggle(id: Id<"radarNiches">) {
    if (selected.includes(id)) {
      onChange(selected.filter((n) => n !== id));
      return;
    }
    if (maxSelect === 1) {
      onChange([id]);
      return;
    }
    if (selected.length >= maxSelect) return;
    onChange([...selected, id]);
  }

  if (niches === undefined) {
    return <p className="text-sm text-muted-foreground">Cargando nichos…</p>;
  }

  if (niches.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Todavía no hay nichos disponibles.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {niches.map((niche) => {
        const isSelected = selected.includes(niche._id);
        const disabled = !isSelected && selected.length >= maxSelect;
        return (
          <button
            key={niche._id}
            type="button"
            disabled={disabled}
            onClick={() => toggle(niche._id)}
            className={cn(
              "rounded-md border-[1.5px] px-4 py-3 text-left text-sm transition-colors",
              isSelected
                ? "border-primary bg-primary/12 text-accent-100"
                : disabled
                  ? "cursor-not-allowed border-border/60 bg-transparent text-neutral-600"
                  : "border-border bg-transparent text-neutral-300 hover:border-neutral-500",
            )}
          >
            <div className="font-medium">{niche.label}</div>
            {niche.description && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {niche.description}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
