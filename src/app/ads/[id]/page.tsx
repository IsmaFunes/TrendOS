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

function formatMlPrice(value: number | undefined, currency: string | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (currency === "ARS" || !currency) {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    }).format(value);
  }
  return `${currency} ${value.toLocaleString("es-AR")}`;
}

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
        <p className="mt-6 text-muted-foreground">Cargando…</p>
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

            {ad.mlMatch && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    ad.mlMatch.badge === "best_match"
                      ? "default"
                      : ad.mlMatch.badge === "match"
                        ? "secondary"
                        : "outline"
                  }
                >
                  {formatMlPrice(ad.mlMatch.price, ad.mlMatch.currency) ??
                    "Visto en ML"}
                </Badge>
                {ad.mlMatch.permalink && (
                  <Button
                    variant="outline"
                    size="sm"
                    render={
                      <a
                        href={ad.mlMatch.permalink}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    Ver publicación
                    <ExternalLink className="size-3" />
                  </Button>
                )}
                {ad.mlMatchVerification === "unverified_single_source" && (
                  <span className="text-xs text-muted-foreground">
                    Encontrado vía búsqueda web — confirmá el precio.
                  </span>
                )}
              </div>
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

      {ad && <InvestigatePanel adId={ad._id} />}
    </AppShell>
  );
}
