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
| `GEMINI_API_KEY` | Convex env | Expande términos de scrape del nicho + rankea/filtra ads por tienda + investigación por anuncio (extracción de producto, búsqueda de publicaciones ML, proveedores) |

```bash
npx convex env set GEMINI_API_KEY "..."
```

Sin key: el scrape usa solo keywords del usuario; el feed ordena por fecha (sin ranking AI); el botón "Investigar" sigue funcionando pero sin refinamiento de producto ni fallback de búsqueda web para ML/proveedores.

## Investigar (botón por anuncio)

Mercado Libre da 403 de política a la API oficial de búsqueda para apps de
terceros no verificadas — el matching de producto en ML no usa esa API, usa
dos fuentes de búsqueda real en paralelo:

| Variable | Dónde | Para qué |
|---|---|---|
| `SERPAPI_API_KEY` | Convex env | Google Shopping (AR) filtrado a resultados de mercadolibre.com.ar — precios estructurados, sin riesgo de alucinación |
| `GEMINI_API_KEY` | Convex env | Búsqueda con Google Search grounding — encuentra URLs de publicaciones ML reales |

```bash
npx convex env set SERPAPI_API_KEY "..."
```

Sin ninguna de las dos: "Investigar" corre igual pero sin matches de
Mercado Libre (ni margen estimado, que depende del precio de venta ML).

## Opcional

| Variable | Nota |
|---|---|
| `MERCADOLIBRE_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | Legacy: API oficial de ML, solo `collectProductMetrics` (precio/stock de un listing ya conocido) — el *search* de producto pasó a SerpAPI/Gemini arriba |

`TREND_RADAR_SOURCES` default = `meta_ad_library`.
