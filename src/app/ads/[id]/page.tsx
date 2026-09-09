"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { AppShell } from "@/components/AppShell";
import { AdCreative } from "@/components/AdCreative";
import { InvestigatePanel } from "@/components/InvestigatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCompactNumber } from "@/lib/utils";

export default function AdDetailPage() {
  const params = useParams();
  const adId = params.id as Id<"radarAds">;
  const ad = useQuery(api.radar.metaAds.getAd, { adId });

  return (
    <AppShell>
      <Button
        variant="ghost"
        className="-ml-2.5 mb-4"
        render={<Link href="/ads" />}
      >
        <ArrowLeft className="size-3.5" />
        Volver al Explorador
      </Button>

      {ad === undefined && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card className="aspect-[4/5] w-full animate-pulse overflow-hidden bg-surface-2 p-0" />
          <div className="flex flex-col gap-3">
            <div className="h-7 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="flex gap-1.5">
              <div className="h-5 w-20 animate-pulse rounded-md bg-surface-2" />
              <div className="h-5 w-24 animate-pulse rounded-md bg-surface-2" />
            </div>
            <div className="mt-3 h-4 w-full animate-pulse rounded bg-surface-2" />
            <div className="h-4 w-full animate-pulse rounded bg-surface-2" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      )}

      {ad === null && (
        <p className="mt-6 text-muted-foreground">
          No encontramos este anuncio.
        </p>
      )}

      {ad && (
        <article className="grid gap-6 md:grid-cols-2">
          <Card className="overflow-hidden p-0">
            <AdCreative
              imageUrl={ad.mediaUrls[0]}
              videoUrl={ad.videoUrl}
              controls
              className="aspect-[4/5] w-full"
            />
          </Card>
          <div>
            <h1 className="text-2xl">{ad.pageName}</h1>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge variant={ad.isActive ? "default" : "secondary"}>
                {ad.isActive ? "Activo" : "Inactivo"}
              </Badge>
              {ad.activeDays != null && ad.activeDays > 0 && (
                <Badge variant="outline">{ad.activeDays} días activos</Badge>
              )}
              {ad.advertiserActiveAdCount != null &&
                ad.advertiserActiveAdCount > 0 && (
                  <Badge variant="outline">
                    {ad.advertiserActiveAdCount} anuncios activos
                  </Badge>
                )}
              {ad.platforms.map((p) => (
                <Badge key={p} variant="outline">
                  {p}
                </Badge>
              ))}
            </div>

            {ad.storeQualityLabel && (
              <p className="mt-3 text-sm text-primary">{ad.storeQualityLabel}</p>
            )}

            {ad.body && (
              <p className="mt-5 whitespace-pre-wrap text-foreground">
                {ad.body}
              </p>
            )}
            {ad.cta && (
              <p className="mt-3 text-sm text-muted-foreground">
                CTA: <span className="text-foreground">{ad.cta}</span>
              </p>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              {ad.destinationUrl && (
                <Button render={<a href={ad.destinationUrl} target="_blank" rel="noreferrer" />}>
                  Ver destino
                  <ExternalLink className="size-3.5" />
                </Button>
              )}
              {ad.snapshotUrl && (
                <Button
                  variant="secondary"
                  render={<a href={ad.snapshotUrl} target="_blank" rel="noreferrer" />}
                >
                  Ver en Meta
                  <ExternalLink className="size-3.5" />
                </Button>
              )}
            </div>

            {ad.searchTerm && (
              <p className="mt-6 text-xs text-muted-foreground">
                Encontrado con: {ad.searchTerm}
              </p>
            )}
          </div>
        </article>
      )}

      {ad && (
        <Card className="mt-6 p-5">
          <h2 className="text-base font-medium">Sobre esta tienda</h2>
          {ad.pageIsDeleted && (
            <p className="mt-2 text-sm text-destructive">
              La página de Facebook de este anunciante fue eliminada — puede
              que ya no esté vendiendo.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {ad.pageProfilePictureUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- external Meta CDN avatar, not worth Next/Image config for a small profile pic
              <img
                src={ad.pageProfilePictureUrl}
                alt=""
                className="size-12 shrink-0 rounded-full border border-border"
              />
            )}
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {ad.pageLikeCount != null && ad.pageLikeCount > 0 && (
                  <Badge variant="secondary">
                    {formatCompactNumber(ad.pageLikeCount)} me gusta en
                    Facebook
                  </Badge>
                )}
                {ad.pageCategories?.map((c) => (
                  <Badge key={c} variant="outline">
                    {c}
                  </Badge>
                ))}
              </div>
              {ad.storeQualityLabel && (
                <p className="text-sm text-primary">{ad.storeQualityLabel}</p>
              )}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            {ad.pageProfileUri && (
              <Button
                variant="secondary"
                render={<a href={ad.pageProfileUri} target="_blank" rel="noreferrer" />}
              >
                Ver página de Facebook
                <ExternalLink className="size-3.5" />
              </Button>
            )}
          </div>
          {ad.collationCount != null && ad.collationCount > 1 && (
            <p className="mt-4 text-xs text-muted-foreground">
              Meta está probando {ad.collationCount} variantes de este anuncio
              — señal de que la tienda está optimizando su inversión en esta
              pauta.
            </p>
          )}
        </Card>
      )}

      {ad && <InvestigatePanel adId={ad._id} />}
    </AppShell>
  );
}
