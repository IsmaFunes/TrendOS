"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AdCreative } from "./AdCreative";

type InvestigatePanelProps = {
  adId: Id<"radarAds">;
};

type ChipTone = "accent" | "neutral" | "muted" | "danger" | "success";

function Chip({
  tone = "neutral",
  children,
}: {
  tone?: ChipTone;
  children: React.ReactNode;
}) {
  const toneClass: Record<ChipTone, string> = {
    accent: "bg-accent text-white",
    neutral: "border border-border bg-surface-2 text-foreground",
    muted: "border border-border text-muted",
    danger: "bg-danger/10 text-danger",
    success: "bg-emerald-600/10 text-emerald-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}

function formatArs(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatMoney(value: number | undefined, currency: string | undefined): string {
  if (value == null) return "—";
  if (currency === "ARS") return formatArs(value) ?? `$${value}`;
  return `${currency ?? ""} ${value.toLocaleString("es-AR")}`.trim();
}

const COUNTRY_LABEL: Record<string, string> = {
  AR: "🇦🇷 Argentina",
  CN: "🇨🇳 China",
  BR: "🇧🇷 Brasil",
};

const CLASSIFICATION_LABEL: Record<string, { label: string; tone: ChipTone }> = {
  strong: { label: "Buena oportunidad", tone: "success" },
  moderate: { label: "A evaluar", tone: "neutral" },
  weak: { label: "Bajo potencial", tone: "danger" },
};

const ML_BADGE_LABEL: Record<string, { label: string; tone: ChipTone }> = {
  best_match: { label: "Mejor match", tone: "accent" },
  match: { label: "Coincidencia", tone: "neutral" },
  alternative: { label: "Alternativa", tone: "muted" },
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
    <section className="mt-8 border-t border-border pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-foreground">Investigar</h2>
          <p className="mt-1 text-sm text-muted">
            Anuncios similares, coincidencias en MercadoLibre y proveedores para este producto.
          </p>
        </div>
        <button
          onClick={() => void handleInvestigate()}
          disabled={running}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {running
            ? "Investigando…"
            : investigation
              ? "Volver a investigar"
              : "Investigar"}
        </button>
      </div>

      {runError && (
        <p className="mt-3 text-sm text-danger">{runError}</p>
      )}

      {running && !investigation && (
        <p className="mt-4 text-sm text-muted">
          Buscando anuncios similares, MercadoLibre y proveedores…
        </p>
      )}

      {investigation && (
        <div className="mt-6 space-y-8">
          {isStale && (
            <p className="text-xs text-muted">
              Este resultado tiene más de 7 días — probá &ldquo;Volver a investigar&rdquo; para actualizarlo.
            </p>
          )}

          {/* Score + profit */}
          <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-surface p-4 sm:w-40">
              <span className="font-display text-4xl text-foreground">
                {investigation.score.toFixed(1)}
                <span className="text-lg text-muted">/10</span>
              </span>
              <div className="mt-2">
                <Chip tone={CLASSIFICATION_LABEL[investigation.classification]?.tone ?? "neutral"}>
                  {CLASSIFICATION_LABEL[investigation.classification]?.label ?? investigation.classification}
                </Chip>
              </div>
              <p className="mt-2 text-center text-xs text-muted">
                {investigation.productQuery}
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface p-4">
              <h3 className="text-sm font-medium text-foreground">Ganancia estimada</h3>
              {investigation.profit ? (
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div>
                    <p className="text-xs text-muted">Costo proveedor</p>
                    <p className="font-medium">
                      {formatMoney(investigation.profit.bestSupplierPrice, investigation.profit.bestSupplierCurrency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Precio venta (ML)</p>
                    <p className="font-medium">
                      {investigation.profit.estimatedSalePrice != null
                        ? formatArs(investigation.profit.estimatedSalePrice)
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Ganancia estimada</p>
                    <p className="font-medium">
                      {investigation.profit.estimatedProfit != null
                        ? formatArs(investigation.profit.estimatedProfit)
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Margen</p>
                    <p className="font-medium">
                      {investigation.profit.estimatedMargin != null
                        ? `${(investigation.profit.estimatedMargin * 100).toFixed(0)}%`
                        : "—"}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  No encontramos proveedores para estimar ganancia.
                </p>
              )}
              {investigation.profit?.fxRateUsed != null && (
                <p className="mt-3 text-xs text-muted">
                  Dólar {investigation.profit.fxRateSource ?? "estimado"}:{" "}
                  {formatArs(investigation.profit.fxRateUsed)}
                </p>
              )}
              {investigation.profit?.note && (
                <p className="mt-1 text-xs text-muted">{investigation.profit.note}</p>
              )}
            </div>
          </div>

          {/* Similar Meta ads */}
          <div>
            <h3 className="text-sm font-medium text-foreground">
              Anuncios similares en Meta
            </h3>
            {investigation.similarAds.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                No encontramos otros anuncios de este producto todavía.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {investigation.similarAds.map((sa) => (
                  <div
                    key={sa.adId}
                    className="overflow-hidden rounded-lg border border-border bg-surface"
                  >
                    <AdCreative
                      imageUrl={sa.imageUrl}
                      videoUrl={sa.videoUrl}
                      className="aspect-[4/5] w-full"
                    />
                    <div className="p-2">
                      <p className="truncate text-xs font-medium">{sa.pageName}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {sa.activeDays > 0 && (
                          <Chip tone="neutral">{sa.activeDays} días activo</Chip>
                        )}
                        <Chip tone="muted">{sa.storeQualityLabel}</Chip>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* MercadoLibre matches */}
          <div>
            <h3 className="text-sm font-medium text-foreground">En MercadoLibre</h3>
            {investigation.mlMatches.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                No encontramos publicaciones en MercadoLibre para este producto.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {investigation.mlMatches.map((m) => {
                  const badge = ML_BADGE_LABEL[m.badge] ?? ML_BADGE_LABEL.alternative!;
                  return (
                    <a
                      key={m.externalId}
                      href={m.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition hover:border-foreground/25"
                    >
                      <div className="flex aspect-square items-center justify-center bg-surface-2">
                        {m.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={m.imageUrl}
                            alt=""
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <span className="text-xs text-muted">Sin imagen</span>
                        )}
                      </div>
                      <div className="flex flex-1 flex-col gap-1 p-3">
                        <Chip tone={badge.tone}>{badge.label}</Chip>
                        <p className="line-clamp-2 text-sm font-medium">{m.title}</p>
                        <p className="text-sm text-foreground">
                          {formatMoney(m.price, m.currency)}
                        </p>
                        {m.soldQuantity != null && m.soldQuantity > 0 && (
                          <p className="text-xs text-muted">
                            {m.soldQuantity} vendidos
                          </p>
                        )}
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
          </div>

          {/* Suppliers */}
          <div>
            <h3 className="text-sm font-medium text-foreground">Proveedores</h3>
            {investigation.suppliers.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                No encontramos proveedores verificables para este producto.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {investigation.suppliers.map((s, idx) => (
                  <div
                    key={`${s.source}_${idx}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip tone="neutral">
                        {COUNTRY_LABEL[s.country] ?? s.country}
                      </Chip>
                      <Chip tone={s.isImport ? "muted" : "success"}>
                        {s.isImport ? "Importado" : "Nacional"}
                      </Chip>
                      <span className="text-sm font-medium">
                        {formatMoney(s.unitPrice, s.currency)}
                      </span>
                      {s.moq != null && (
                        <span className="text-xs text-muted">MOQ {s.moq}</span>
                      )}
                      {s.leadTimeDays != null && (
                        <span className="text-xs text-muted">
                          {s.leadTimeDays}d entrega
                        </span>
                      )}
                      {s.supplierName && (
                        <span className="text-xs text-muted">{s.supplierName}</span>
                      )}
                    </div>
                    {s.url && (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-medium text-accent hover:underline"
                      >
                        Ver oferta →
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {investigation.warnings.length > 0 && (
            <ul className="space-y-1 text-xs text-muted">
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
