"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  useAction,
  useConvexAuth,
  useMutation,
  useQuery,
} from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import { AppShell } from "@/components/AppShell";
import { AdCreative } from "@/components/AdCreative";
import { SignInButton } from "@clerk/nextjs";

type SortMode = "personalized" | "recent" | "active_days";

export default function AdsPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const user = useQuery(api.users.me);
  const ensureMyNiche = useMutation(api.radar.niches.ensureMyNiche);
  const refreshRanking = useAction(api.radar.geminiAds.refreshMyAdRanking);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("personalized");
  const [nicheReady, setNicheReady] = useState(false);
  const [rankingBusy, setRankingBusy] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!isAuthenticated || !user?.onboardingComplete) return;
    let cancelled = false;
    void (async () => {
      try {
        await ensureMyNiche({});
      } catch {
        /* profile may lack keywords */
      } finally {
        if (!cancelled) setNicheReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.onboardingComplete, ensureMyNiche]);

  const feedState = useQuery(
    api.radar.metaAds.getAdsFeedState,
    isAuthenticated && user?.onboardingComplete && nicheReady ? {} : "skip",
  );

  const rankingState = useQuery(
    api.radar.adRanking.getMyRankingState,
    isAuthenticated &&
      user?.onboardingComplete &&
      nicheReady &&
      feedState?.status === "ready"
      ? { now }
      : "skip",
  );

  useEffect(() => {
    if (!isAuthenticated || !nicheReady) return;
    if (feedState?.status !== "ready") return;
    if (!rankingState) return;
    if (rankingState.status !== "missing" && rankingState.status !== "stale") {
      return;
    }
    let cancelled = false;
    setRankingBusy(true);
    void (async () => {
      try {
        // Force rebuild so stricter Gemini drop rules apply after code updates.
        await refreshRanking({ force: rankingState.status === "stale" });
      } catch {
        /* Gemini optional */
      } finally {
        if (!cancelled) setRankingBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isAuthenticated,
    nicheReady,
    feedState?.status,
    rankingState?.status,
    refreshRanking,
  ]);

  const ads = useQuery(
    api.radar.metaAds.listAdsForUser,
    isAuthenticated && user?.onboardingComplete && nicheReady
      ? { search: search || undefined, sort, limit: 48, now }
      : "skip",
  );

  const emptyMessage = useMemo(() => {
    if (ads === undefined || feedState === undefined) return null;
    if (ads.length > 0) return null;
    switch (feedState.status) {
      case "no_niche":
        return "Completá tus keywords de nicho para ver anuncios a medida.";
      case "pending_scrape":
      case "scraping":
        return feedState.nicheLabel
          ? `Buscando anuncios para “${feedState.nicheLabel}”…`
          : "Buscando anuncios para tu nicho…";
      case "empty":
        return "Todavía no encontramos anuncios para tu nicho. Probá otras keywords.";
      default:
        return "Todavía no hay anuncios para tu nicho.";
    }
  }, [ads, feedState]);

  if (isLoading || user === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted">
        Cargando…
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-4 px-6">
        <h1 className="font-display text-2xl">Entrá para ver anuncios</h1>
        <SignInButton mode="modal">
          <button className="rounded-lg bg-accent px-4 py-3 text-white">
            Iniciar sesión
          </button>
        </SignInButton>
      </main>
    );
  }

  if (!user || !user.onboardingComplete) {
    router.replace("/onboarding");
    return (
      <main className="flex flex-1 items-center justify-center text-muted">
        Te llevamos al inicio…
      </main>
    );
  }

  return (
    <AppShell>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl text-foreground">Anuncios</h1>
          <p className="mt-1 text-sm text-muted">
            {feedState?.nicheLabel
              ? `Nicho: ${feedState.nicheLabel}`
              : "Personalizados para tu tienda"}
            {rankingBusy
              ? " · Ordenando para vos…"
              : rankingState?.status === "fresh"
                ? " · Ordenados para tu tienda"
                : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar…"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="personalized">Para vos</option>
            <option value="recent">Más recientes</option>
            <option value="active_days">Más días activos</option>
          </select>
        </div>
      </div>

      {(ads === undefined || !nicheReady) && (
        <p className="text-muted">Buscando anuncios para vos…</p>
      )}

      {emptyMessage && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-foreground">{emptyMessage}</p>
          <p className="mt-2 text-sm text-muted">
            {feedState?.status === "pending_scrape" ||
            feedState?.status === "scraping"
              ? "En unos minutos vas a ver anuncios de tu categoría."
              : "Podés ajustar tus keywords en Mi tienda."}
          </p>
        </div>
      )}

      {ads && ads.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ads.map((ad) => (
            <Link
              key={ad._id}
              href={`/ads/${ad._id}`}
              className="overflow-hidden rounded-xl border border-border bg-surface transition hover:border-foreground/25"
            >
              <AdCreative
                imageUrl={ad.mediaUrls[0]}
                videoUrl={ad.videoUrl}
                className="aspect-[4/5] w-full"
              />
              <div className="p-3">
                <div className="truncate text-sm font-medium">{ad.pageName}</div>
                <p className="mt-1 line-clamp-2 text-sm text-muted">
                  {ad.body || "Sin texto"}
                </p>
                {ad.rankReason && sort === "personalized" && (
                  <p className="mt-1 line-clamp-1 text-xs text-accent">
                    {ad.rankReason}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted">
                  {ad.isActive ? "Activo" : "Inactivo"}
                  {ad.activeDays != null && ad.activeDays > 0
                    ? ` · ${ad.activeDays} días`
                    : ""}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
