"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
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
import { cn, formatCompactNumber } from "@/lib/utils";

type SortMode = "quality" | "recent" | "active_days";

const SORT_LABELS: Record<SortMode, string> = {
  quality: "Mejor calidad",
  recent: "Más recientes",
  active_days: "Más días activos",
};

function AdCardSkeleton() {
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="aspect-[4/5] w-full animate-pulse bg-surface-2" />
      <div className="flex flex-col gap-2 p-4">
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-2" />
        <div className="h-3 w-full animate-pulse rounded bg-surface-2" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-surface-2" />
        <div className="mt-0.5 flex gap-1.5">
          <div className="h-5 w-16 animate-pulse rounded-md bg-surface-2" />
          <div className="h-5 w-14 animate-pulse rounded-md bg-surface-2" />
        </div>
        <div className="mt-2 h-8 w-full animate-pulse rounded-lg bg-surface-2" />
      </div>
    </Card>
  );
}

export default function AdsPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const user = useQuery(api.users.me);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("quality");

  const canQueryFeed = Boolean(isAuthenticated && user?.onboardingComplete);

  const feedState = useQuery(
    api.radar.metaAds.getAdsFeedState,
    canQueryFeed ? {} : "skip",
  );

  // Relevance filtering runs server-side, shared per niche, on the daily
  // scrape cadence — no per-user client-triggered Gemini call needed here
  // (see convex/radar/geminiAds.ts refreshNicheAdRelevance). A niche's
  // profile.nicheIds is validated/required at onboarding, so there's no
  // "ensure a niche exists" step to wait on before querying the feed.
  // No `limit` — the backend applies its own per-plan, per-niche cap
  // (ADS_PER_NICHE_LIMIT in convex/radar/metaAds.ts) by default.
  const ads = useQuery(
    api.radar.metaAds.listAdsForUser,
    canQueryFeed ? { search: search || undefined, sort } : "skip",
  );

  const emptyMessage = useMemo(() => {
    if (ads === undefined || feedState === undefined) return null;
    if (ads.length > 0) return null;
    switch (feedState.status) {
      case "no_niche":
        return "Elegí un nicho en Mi tienda para ver anuncios a medida.";
      case "pending_scrape":
      case "scraping":
        return feedState.nicheLabel
          ? `Buscando anuncios para “${feedState.nicheLabel}”…`
          : "Buscando anuncios para tu nicho…";
      case "relevance_pending":
        return feedState.nicheLabel
          ? `Revisando la relevancia de los anuncios de “${feedState.nicheLabel}”…`
          : "Revisando la relevancia de los anuncios de tu nicho…";
      case "empty":
        return "Todavía no encontramos anuncios para tu nicho. Probá con otro nicho.";
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
            {feedState?.status === "ready" && sort === "quality"
              ? " · Ordenados por calidad"
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

      {ads === undefined && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <AdCardSkeleton key={i} />
          ))}
        </div>
      )}

      {emptyMessage && (
        <Card className="p-8 text-center">
          <p className="text-foreground">{emptyMessage}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {feedState?.status === "pending_scrape" ||
            feedState?.status === "scraping" ||
            feedState?.status === "relevance_pending"
              ? "En unos minutos vas a ver anuncios de tu nicho."
              : "Podés cambiar de nicho en Mi tienda."}
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
                    {ad.advertiserActiveAdCount != null &&
                      ad.advertiserActiveAdCount > 0 && (
                        <Badge variant="outline" className="text-[10.5px]">
                          {ad.advertiserActiveAdCount} anuncios activos
                        </Badge>
                      )}
                    {ad.pageLikeCount != null && ad.pageLikeCount > 0 && (
                      <Badge variant="outline" className="text-[10.5px]">
                        {formatCompactNumber(ad.pageLikeCount)} me gusta
                      </Badge>
                    )}
                    {ad.pageIsDeleted && (
                      <Badge variant="destructive" className="text-[10.5px]">
                        Página eliminada
                      </Badge>
                    )}
                  </div>
                  {ad.storeQualityLabel && (
                    <p className="line-clamp-1 text-xs text-primary">
                      {ad.storeQualityLabel}
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
