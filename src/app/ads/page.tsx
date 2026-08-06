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
import { Search } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { AppShell } from "@/components/AppShell";
import { AdCreative } from "@/components/AdCreative";
import { SignInButton } from "@clerk/nextjs";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type SortMode = "personalized" | "recent" | "active_days";

const SORT_LABELS: Record<SortMode, string> = {
  personalized: "Para vos",
  recent: "Más recientes",
  active_days: "Más días activos",
};

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
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        Cargando…
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-4 px-6">
        <h1 className="text-2xl">Entrá para ver anuncios</h1>
        <SignInButton mode="modal">
          <Button size="lg">Iniciar sesión</Button>
        </SignInButton>
      </main>
    );
  }

  if (!user || !user.onboardingComplete) {
    router.replace("/onboarding");
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        Te llevamos al inicio…
      </main>
    );
  }

  return (
    <AppShell>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2>Explorador de Ads</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {feedState?.nicheLabel
              ? `Basado en tu nicho: ${feedState.nicheLabel}`
              : "Personalizados para tu tienda"}
            {rankingBusy
              ? " · Ordenando para vos…"
              : rankingState?.status === "fresh"
                ? " · Ordenados para tu tienda"
                : ""}
          </p>
        </div>
        {ads && ads.length > 0 && (
          <Badge variant="secondary" className="w-fit">
            {ads.length} anuncios encontrados
          </Badge>
        )}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative max-w-[340px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-[15px] -translate-y-1/2 text-neutral-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar anuncios, marcas, palabras clave…"
            className="pl-9"
          />
        </div>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">Ordenar por</span>
        <Select value={sort} onValueChange={(v) => setSort(v as SortMode)}>
          <SelectTrigger size="sm" className="w-[170px]">
            <SelectValue>{SORT_LABELS[sort]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {SORT_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(ads === undefined || !nicheReady) && (
        <p className="text-muted-foreground">Buscando anuncios para vos…</p>
      )}

      {emptyMessage && (
        <Card className="p-8 text-center">
          <p className="text-foreground">{emptyMessage}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {feedState?.status === "pending_scrape" ||
            feedState?.status === "scraping"
              ? "En unos minutos vas a ver anuncios de tu categoría."
              : "Podés ajustar tus keywords en Mi tienda."}
          </p>
        </Card>
      )}

      {ads && ads.length > 0 && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {ads.map((ad) => (
            <Link
              key={ad._id}
              href={`/ads/${ad._id}`}
              className="group block"
            >
              <Card className="gap-0 overflow-hidden p-0 transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-elev-md">
                <AdCreative
                  imageUrl={ad.mediaUrls[0]}
                  videoUrl={ad.videoUrl}
                  className="aspect-[4/5] w-full"
                />
                <div className="flex flex-col gap-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium">
                      {ad.pageName}
                    </span>
                    {ad.platforms[0] && (
                      <Badge variant="secondary" className="shrink-0">
                        {ad.platforms.join(" · ")}
                      </Badge>
                    )}
                  </div>
                  <p className="line-clamp-2 text-[13px] text-neutral-300">
                    {ad.body || "Sin texto"}
                  </p>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {ad.activeDays != null && ad.activeDays > 0 && (
                      <Badge variant="outline" className="text-[10.5px]">
                        {ad.activeDays} días activo
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-[10.5px]">
                      {ad.isActive ? "Activo" : "Inactivo"}
                    </Badge>
                  </div>
                  {ad.rankReason && sort === "personalized" && (
                    <p className="line-clamp-1 text-xs text-primary">
                      {ad.rankReason}
                    </p>
                  )}
                  <span
                    className={cn(
                      buttonVariants({ variant: "default" }),
                      "pointer-events-none mt-2 w-full",
                    )}
                  >
                    Investigar
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
