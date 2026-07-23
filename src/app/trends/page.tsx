"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

type Tab = "products" | "keywords";

export default function TrendsPage() {
  const router = useRouter();
  const user = useQuery(api.users.me);
  const categories = useQuery(api.categories.listForUser);
  const latestRun = useQuery(api.trends.latestRun, {});
  const triggerIngestion = useMutation(api.ingestion.triggerIngestion);
  const [tab, setTab] = useState<Tab>("products");
  const [categoryId, setCategoryId] = useState<Id<"categories"> | "all">(
    "all",
  );
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const [updatedAtClient] = useState(() => Date.now());

  const filter =
    categoryId === "all" ? {} : { categoryId: categoryId as Id<"categories"> };

  const products = useQuery(api.trends.productsForUser, filter);
  const keywords = useQuery(api.trends.keywordsForUser, filter);

  const runFinishedAfterQueue =
    queuedAt !== null &&
    latestRun != null &&
    latestRun.status !== "running" &&
    latestRun.startedAt >= queuedAt;

  const isUpdating =
    latestRun?.status === "running" ||
    (queuedAt !== null && !runFinishedAfterQueue);

  useEffect(() => {
    if (user === null) return;
    if (user && !user.onboardingComplete) {
      router.replace("/onboarding");
    }
  }, [user, router]);

  const updatedLabel = useMemo(() => {
    if (isUpdating) return "Actualizando trends…";
    if (!latestRun?.finishedAt && !latestRun?.startedAt) {
      return "Sin corridas todavía";
    }
    const ts = latestRun.finishedAt ?? latestRun.startedAt;
    const hours = Math.max(
      0,
      Math.round((updatedAtClient - ts) / 3_600_000),
    );
    if (hours === 0) return "Actualizado hace minutos";
    return `Actualizado hace ${hours}h · plan ${user?.plan ?? "free"} (${user?.refreshIntervalHours ?? 8}h)`;
  }, [latestRun, user, updatedAtClient, isUpdating]);

  async function refresh() {
    setQueuedAt(Date.now());
    try {
      await triggerIngestion({ siteId: user?.siteId ?? "MLA" });
    } catch {
      setQueuedAt(null);
    }
  }

  if (user === undefined || categories === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted">
        Cargando Trends…
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/" className="font-display text-xl text-accent">
            TrendOS
          </Link>
          <p className="mt-1 text-sm text-muted">{updatedLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/tienda"
            className="rounded-md border border-border px-3 py-2 text-sm"
          >
            Mi tienda
          </Link>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isUpdating}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            {isUpdating ? (
              <>
                <Spinner />
                Actualizando…
              </>
            ) : (
              "Actualizar ahora"
            )}
          </button>
          <UserButton />
        </div>
      </header>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl md:text-4xl">Trends</h1>
          <p className="mt-1 text-muted">
            Top 10 para tu nicho · e‑commerce / dropshipping · score 0–1
          </p>
        </div>
        <div className="flex gap-2">
          <TabButton active={tab === "products"} onClick={() => setTab("products")}>
            Productos
          </TabButton>
          <TabButton active={tab === "keywords"} onClick={() => setTab("keywords")}>
            Keywords
          </TabButton>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <FilterChip
          active={categoryId === "all"}
          onClick={() => setCategoryId("all")}
        >
          Todas
        </FilterChip>
        {categories.map((c) => (
          <FilterChip
            key={c._id}
            active={categoryId === c._id}
            onClick={() => setCategoryId(c._id)}
          >
            {c.name}
          </FilterChip>
        ))}
      </div>

      {isUpdating ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 flex items-center gap-3 rounded-md border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent"
        >
          <Spinner />
          <span>
            Actualización en curso
            {latestRun?.status === "running"
              ? " (Gemini + ML + Trends)…"
              : " (encolada)…"}{" "}
            El listado se refresca solo al terminar.
          </span>
        </div>
      ) : null}
      {!isUpdating && latestRun?.status === "failed" ? (
        <p className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          Última corrida falló: {latestRun.error ?? "error desconocido"}
        </p>
      ) : null}

      <div className={isUpdating ? "pointer-events-none opacity-60" : undefined}>
        {tab === "products" ? (
          <ProductList items={products} />
        ) : (
          <KeywordList items={keywords} />
        )}
      </div>
    </main>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-4 py-2 text-sm ${
        active ? "bg-accent text-background" : "border border-border"
      }`}
    >
      {children}
    </button>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm ${
        active ? "border-accent text-accent" : "border-border text-muted"
      }`}
    >
      {children}
    </button>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-sm text-accent">{score.toFixed(2)}</span>
    </div>
  );
}

function ProductList({
  items,
}: {
  items:
    | Array<{
        snapshotId: string;
        trendScore: number;
        mlPosition?: number;
        googleInterest?: number;
        webBuzz?: number;
        webMatchConfidence?: number;
        webSources?: string[];
        explainedBy?: string;
        categoryName: string;
        product: {
          title: string;
          image?: string;
          price?: number;
          currency?: string;
          permalink?: string;
          mlId: string;
        };
      }>
    | undefined;
}) {
  if (items === undefined) {
    return <p className="text-muted">Cargando productos…</p>;
  }
  if (items.length === 0) {
    return (
      <EmptyState message="Todavía no hay productos para tu nicho. Tocá “Actualizar ahora” o editá Mi tienda (keywords + descripción)." />
    );
  }

  return (
    <ul className="divide-y divide-border border-y border-border">
      {items.map((row) => (
        <li
          key={row.snapshotId}
          className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2 text-xs text-muted">
              {row.product.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={row.product.image}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                "ML"
              )}
            </div>
            <div className="min-w-0">
              <a
                href={row.product.permalink ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="block truncate font-medium hover:text-accent"
              >
                {row.product.title}
              </a>
              <p className="mt-1 text-sm text-muted">
                {row.categoryName}
                {row.mlPosition !== undefined
                  ? ` · #${row.mlPosition} best seller`
                  : ""}
                {row.product.price !== undefined
                  ? ` · ${row.product.currency ?? ""} ${row.product.price.toLocaleString("es-AR")}`
                  : ""}
              </p>
              {row.explainedBy ? (
                <p className="mt-2 max-w-2xl text-sm text-muted">
                  {row.explainedBy}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {row.webBuzz !== undefined ? (
                  <SourceBadge>
                    Web buzz {Math.round(row.webBuzz)}
                  </SourceBadge>
                ) : null}
                {row.mlPosition !== undefined ? (
                  <SourceBadge>Mercado Libre #{row.mlPosition}</SourceBadge>
                ) : row.product.mlId.startsWith("WEB-") ? (
                  <SourceBadge>Solo web</SourceBadge>
                ) : (
                  <SourceBadge>Mercado Libre</SourceBadge>
                )}
                {row.googleInterest !== undefined ? (
                  <SourceBadge>Google Trends {row.googleInterest}</SourceBadge>
                ) : null}
                {row.webMatchConfidence !== undefined &&
                row.mlPosition !== undefined ? (
                  <SourceBadge>
                    Match ML {Math.round(row.webMatchConfidence * 100)}%
                  </SourceBadge>
                ) : null}
              </div>
              {row.webSources && row.webSources.length > 0 ? (
                <p className="mt-1 truncate text-xs text-muted">
                  Fuentes:{" "}
                  {row.webSources.slice(0, 2).map((url, i) => (
                    <span key={url}>
                      {i > 0 ? " · " : null}
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-accent"
                      >
                        {hostnameOf(url)}
                      </a>
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
          </div>
          <ScoreBadge score={row.trendScore} />
        </li>
      ))}
    </ul>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 32);
  }
}

function KeywordList({
  items,
}: {
  items:
    | Array<{
        snapshotId: string;
        trendScore: number;
        mlBucket?: string;
        googleInterest?: number;
        explainedBy?: string;
        categoryName: string;
        keyword: { keyword: string };
      }>
    | undefined;
}) {
  if (items === undefined) {
    return <p className="text-muted">Cargando keywords…</p>;
  }
  if (items.length === 0) {
    return (
      <EmptyState message="Todavía no hay keywords para tu nicho. Tocá “Actualizar ahora” para generar el primer snapshot." />
    );
  }

  return (
    <ul className="divide-y divide-border border-y border-border">
      {items.map((row) => (
        <li
          key={row.snapshotId}
          className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="font-medium">{row.keyword.keyword}</p>
            <p className="mt-1 text-sm text-muted">
              {row.categoryName}
              {row.mlBucket ? ` · ${row.mlBucket.replaceAll("_", " ")}` : ""}
            </p>
            {row.explainedBy ? (
              <p className="mt-2 max-w-2xl text-sm text-muted">
                {row.explainedBy}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <SourceBadge>ML Trends</SourceBadge>
              {row.googleInterest !== undefined ? (
                <SourceBadge>Google Trends {row.googleInterest}</SourceBadge>
              ) : null}
            </div>
          </div>
          <ScoreBadge score={row.trendScore} />
        </li>
      ))}
    </ul>
  );
}

function SourceBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
      {children}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-surface/50 px-6 py-16 text-center text-muted">
      {message}
    </div>
  );
}
