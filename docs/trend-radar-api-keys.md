# TrendOS — API keys (MVP Argentina)

Variables de Convex van en el **Convex dashboard** (`npx convex env set`).

## Happy path (obligatorio)

| Variable | Dónde | Para qué |
|---|---|---|
| Clerk keys | `.env.local` + Convex `CLERK_JWT_ISSUER_DOMAIN` | Auth |
| `META_ADS_INGEST_SECRET` | Convex + worker env | Ingest del scraper |
| `CONVEX_URL` / `NEXT_PUBLIC_CONVEX_URL` | Worker / Next | Cliente |

```bash
npx convex env set META_ADS_INGEST_SECRET "poné-un-secreto-largo"
npx convex env set TREND_RADAR_SOURCES "meta_ad_library"
```

## Scraper (por nicho)

Al completar onboarding se crea/reusa un **nicho** y un job de scrape. El worker:

```bash
# Procesa la cola de nichos pendientes (default)
META_ADS_INGEST_SECRET=... CONVEX_URL=https://....convex.cloud \
  npm run scrape:meta-ads

# Force re-scrape aunque el nicho ya esté ready
npm run scrape:meta-ads -- --force
npm run scrape:meta-ads -- --force-niche "<nicheId>"

# Debug de un término suelto
npm run scrape:meta-ads -- --term "termo" --limit 30 --no-queue

# Seed local (sin nicho, o con --niche-id <id>)
npm run scrape:meta-ads:seed
```

Proxy opcional: `META_ADS_PROXY_SERVER=http://user:pass@host:port`

## Gemini (personalización)

| Variable | Dónde | Para qué |
|---|---|---|
| `GEMINI_API_KEY` | Convex env | Expande términos de scrape del nicho + rankea/filtra ads por tienda |

```bash
npx convex env set GEMINI_API_KEY "..."
```

Sin key: el scrape usa solo keywords del usuario; el feed ordena por fecha (sin ranking AI).

## Opcional

| Variable | Nota |
|---|---|
| `SERPAPI_API_KEY` | No se llama en el path caliente |
| Mercado Libre | Solo si más adelante enriquecés comercio |

`TREND_RADAR_SOURCES` default = `meta_ad_library`.
