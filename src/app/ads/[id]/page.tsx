"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { AppShell } from "@/components/AppShell";
import { AdCreative } from "@/components/AdCreative";
import { InvestigatePanel } from "@/components/InvestigatePanel";

export default function AdDetailPage() {
  const params = useParams();
  const adId = params.id as Id<"radarAds">;
  const ad = useQuery(api.radar.metaAds.getAd, { adId });

  return (
    <AppShell>
      <Link href="/ads" className="text-sm text-muted hover:text-foreground">
        ← Anuncios
      </Link>

      {ad === undefined && (
        <p className="mt-6 text-muted">Cargando…</p>
      )}

      {ad === null && (
        <p className="mt-6 text-muted">No encontramos este anuncio.</p>
      )}

      {ad && (
        <article className="mt-6 grid gap-6 md:grid-cols-2">
          <AdCreative
            imageUrl={ad.mediaUrls[0]}
            videoUrl={ad.videoUrl}
            controls
            className="aspect-[4/5] w-full overflow-hidden rounded-xl border border-border"
          />
          <div>
            <h1 className="font-display text-2xl">{ad.pageName}</h1>
            <p className="mt-2 text-sm text-muted">
              {ad.isActive ? "Activo" : "Inactivo"}
              {ad.activeDays != null && ad.activeDays > 0
                ? ` · ${ad.activeDays} días activos`
                : ""}
            </p>
            {ad.body && (
              <p className="mt-4 whitespace-pre-wrap text-foreground">
                {ad.body}
              </p>
            )}
            {ad.cta && (
              <p className="mt-3 text-sm text-muted">CTA: {ad.cta}</p>
            )}
            <div className="mt-6 flex flex-wrap gap-3">
              {ad.destinationUrl && (
                <a
                  href={ad.destinationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
                >
                  Ver destino
                </a>
              )}
              {ad.snapshotUrl && (
                <a
                  href={ad.snapshotUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-border bg-surface px-4 py-2 text-sm"
                >
                  Ver en Meta
                </a>
              )}
            </div>
            {ad.searchTerm && (
              <p className="mt-6 text-xs text-muted">
                Encontrado con: {ad.searchTerm}
              </p>
            )}
          </div>
        </article>
      )}

      {ad && <InvestigatePanel adId={ad._id} />}
    </AppShell>
  );
}
