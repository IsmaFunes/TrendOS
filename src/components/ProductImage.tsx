"use client";

import { useState } from "react";

type Props = {
  name: string;
  sourceUrl?: string | null;
  imageHint?: string | null;
  className?: string;
  /** Larger hero treatment on detail pages. */
  size?: "card" | "hero";
};

export function ProductImage({
  name,
  sourceUrl,
  imageHint,
  className = "",
  size = "card",
}: Props) {
  const [failed, setFailed] = useState(false);

  const params = new URLSearchParams();
  if (sourceUrl) params.set("url", sourceUrl);
  if (imageHint) params.set("hint", imageHint);
  const src =
    !failed && (sourceUrl || imageHint)
      ? `/api/product-image?${params.toString()}`
      : null;

  const height = size === "hero" ? "aspect-[4/3] sm:aspect-[16/10]" : "aspect-square";

  if (!src) {
    return (
      <div
        className={`${height} w-full bg-gradient-to-br from-surface-2 via-surface to-background ${className}`}
        aria-hidden
      >
        <div className="flex h-full items-end p-3">
          <span className="line-clamp-2 font-display text-sm text-muted/80">
            {name}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`${height} relative w-full overflow-hidden bg-surface-2 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background/50 via-transparent to-transparent" />
    </div>
  );
}
