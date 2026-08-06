"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AdCreative } from "./AdCreative";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

type InvestigatePanelProps = {
  adId: Id<"radarAds">;
};

function formatArs(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatMoney(
  value: number | undefined,
  currency: string | undefined,
): string {
  if (value == null) return "—";
  if (currency === "ARS") return formatArs(value) ?? `$${value}`;
  return `${currency ?? ""} ${value.toLocaleString("es-AR")}`.trim();
}

const COUNTRY_LABEL: Record<string, string> = {
  AR: "🇦🇷 Argentina",
  CN: "🇨🇳 China",
  BR: "🇧🇷 Brasil",
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const CLASSIFICATION_LABEL: Record<string, { label: string; variant: BadgeVariant }> = {
  strong: { label: "Buena oportunidad", variant: "default" },
  moderate: { label: "A evaluar", variant: "secondary" },
  weak: { label: "Bajo potencial", variant: "destructive" },
};

const ML_BADGE_LABEL: Record<string, { label: string; variant: BadgeVariant }> = {
  best_match: { label: "Mejor match", variant: "default" },
  match: { label: "Coincidencia", variant: "secondary" },
  alternative: { label: "Alternativa", variant: "outline" },
};

export function InvestigatePanel({ adId }: InvestigatePanelProps) {
  const investigation = useQuery(api.radar.investigate.getMyInvestigation, { adId });
  const runInvestigate = useAction(api.radar.investigate.investigateAd);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const handleInvestigate = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const result = await runInvestigate({ adId });
      if (result.status !== "ready") {
        setRunError(result.errorMessage ?? "No pudimos completar la investigación.");
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setRunning(false);
    }
  };

  const isStale = investigation != null && investigation.expiresAt < now;

  return (
    <section className="mt-10 border-t border-border pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2>Investigar</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Anuncios similares, coincidencias en MercadoLibre y proveedores para este producto.
          </p>
        </div>
        <Button onClick={() => void handleInvestigate()} disabled={running}>
          {running ? (
            <RefreshCw className="size-3.5 animate-spin" />
          ) : (
            <Search className="size-3.5" />
          )}
          {running ? "Investigando…" : investigation ? "Volver a investigar" : "Investigar"}
        </Button>
      </div>

      {runError && <p className="mt-3 text-sm text-destructive">{runError}</p>}

      {running && !investigation && (
        <p className="mt-4 text-sm text-muted-foreground">
          Buscando anuncios similares, MercadoLibre y proveedores…
        </p>
      )}

      {investigation && (
        <div className="mt-6 space-y-8">
          {isStale && (
            <p className="text-xs text-muted-foreground">
              Este resultado tiene más de 7 días — probá &ldquo;Volver a investigar&rdquo; para actualizarlo.
            </p>
          )}

          {/* Score + profit */}
          <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
            <Card className="items-center justify-center gap-1 p-6 text-center sm:w-44">
              <span className="text-4xl font-medium text-foreground">
                {investigation.score.toFixed(1)}
                <span className="text-lg text-muted-foreground">/10</span>
              </span>
              <Badge
                variant={CLASSIFICATION_LABEL[investigation.classification]?.variant ?? "secondary"}
                className="mt-1"
              >
                {CLASSIFICATION_LABEL[investigation.classification]?.label ?? investigation.classification}
              </Badge>
              <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                {investigation.productQuery}
              </p>
            </Card>

            <Card className="p-5">
              <h3 className="text-sm font-medium">Ganancia estimada</h3>
              {investigation.profit ? (
                <div className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Costo proveedor</p>
                    <p className="font-medium">
                      {formatMoney(investigation.profit.bestSupplierPrice, investigation.profit.bestSupplierCurrency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Precio venta (ML)</p>
                    <p className="font-medium">
                      {investigation.profit.estimatedSalePrice != null
                        ? formatArs(investigation.profit.estimatedSalePrice)
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Ganancia estimada</p>
                    <p className="font-medium">
                      {investigation.profit.estimatedProfit != null
                        ? formatArs(investigation.profit.estimatedProfit)
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Margen</p>
                    <p className="font-medium">
                      {investigation.profit.estimatedMargin != null
                        ? `${(investigation.profit.estimatedMargin * 100).toFixed(0)}%`
                        : "—"}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No encontramos proveedores para estimar ganancia.
                </p>
              )}
              {investigation.profit?.fxRateUsed != null && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Dólar {investigation.profit.fxRateSource ?? "estimado"}:{" "}
                  {formatArs(investigation.profit.fxRateUsed)}
                </p>
              )}
              {investigation.profit?.note && (
                <p className="mt-1 text-xs text-muted-foreground">{investigation.profit.note}</p>
              )}
            </Card>
          </div>

          {/* Similar Meta ads */}
          <div>
            <h3 className="text-sm font-medium">Anuncios similares en Meta</h3>
            {investigation.similarAds.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No encontramos otros anuncios de este producto todavía.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
                {investigation.similarAds.map((sa) => (
                  <Card key={sa.adId} className="gap-0 overflow-hidden p-0">
                    <AdCreative
                      imageUrl={sa.imageUrl}
                      videoUrl={sa.videoUrl}
                      className="aspect-[4/5] w-full"
                    />
                    <div className="flex flex-col gap-1.5 p-3">
                      <span className="truncate text-[13px] font-medium">{sa.pageName}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {sa.activeDays > 0 && (
                          <Badge variant="outline" className="text-[10.5px]">
                            {sa.activeDays} días activo
                          </Badge>
                        )}
                        <Badge variant="secondary" className="text-[10.5px]">
                          {sa.storeQualityLabel}
                        </Badge>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* MercadoLibre matches */}
          <div>
            <h3 className="text-sm font-medium">En MercadoLibre</h3>
            {investigation.mlMatches.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No encontramos publicaciones en MercadoLibre para este producto.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                {investigation.mlMatches.map((m) => {
                  const badge = ML_BADGE_LABEL[m.badge] ?? ML_BADGE_LABEL.alternative!;
                  return (
                    <Card key={m.externalId} className="gap-0 overflow-hidden p-0">
                      <div className="flex aspect-square items-center justify-center bg-muted">
                        {m.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.imageUrl} alt="" className="h-full w-full object-contain" />
                        ) : (
                          <span className="text-xs text-muted-foreground">Sin imagen</span>
                        )}
                      </div>
                      <div className="flex flex-1 flex-col gap-1.5 p-3">
                        <Badge variant={badge.variant} className="w-fit">
                          {badge.label}
                        </Badge>
                        <p className="line-clamp-2 text-[13px] font-medium">{m.title}</p>
                        <p className="text-[13px] text-foreground">
                          {formatMoney(m.price, m.currency)}
                        </p>
                        {m.soldQuantity != null && m.soldQuantity > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {m.soldQuantity} vendidos
                          </p>
                        )}
                        {m.permalink && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-1 w-fit"
                            render={<a href={m.permalink} target="_blank" rel="noreferrer" />}
                          >
                            Ver publicación
                            <ExternalLink className="size-3" />
                          </Button>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Suppliers */}
          <div>
            <h3 className="text-sm font-medium">Proveedores</h3>
            {investigation.suppliers.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No encontramos proveedores verificables para este producto.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {investigation.suppliers.map((s, idx) => (
                  <Card
                    key={`${s.source}_${idx}`}
                    className="flex-row flex-wrap items-center justify-between gap-2 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{COUNTRY_LABEL[s.country] ?? s.country}</Badge>
                      <Badge variant={s.isImport ? "secondary" : "default"}>
                        {s.isImport ? "Importado" : "Nacional"}
                      </Badge>
                      <span className="text-sm font-medium">
                        {formatMoney(s.unitPrice, s.currency)}
                      </span>
                      {s.moq != null && (
                        <span className="text-xs text-muted-foreground">MOQ {s.moq}</span>
                      )}
                      {s.leadTimeDays != null && (
                        <span className="text-xs text-muted-foreground">
                          {s.leadTimeDays}d entrega
                        </span>
                      )}
                      {s.supplierName && (
                        <span className="text-xs text-muted-foreground">{s.supplierName}</span>
                      )}
                    </div>
                    {s.url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        render={<a href={s.url} target="_blank" rel="noreferrer" />}
                      >
                        Ver oferta
                        <ExternalLink className="size-3" />
                      </Button>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>

          {investigation.warnings.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {investigation.warnings.map((w, idx) => (
                <li key={idx}>· {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
