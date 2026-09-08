# TrendOS data layer

Infra de datos detrás del explorador de anuncios. El producto UI ya no es “agents”.

## Tablas clave

- `radarNiches` — catálogo fijo y curado de nichos (slug, label, `scrapeTermsByCountry`), sembrado por `convex/admin/seedNicheCatalog.ts`. Ya no son buckets dinámicos por usuario.
- `radarNicheAds` / `radarNicheAdRelevance` — ads vinculados a cada nicho y el pase de relevancia (Gemini) compartido por ese nicho.
- `radarAds` / `radarAdvertisers` / `radarStores` — índice Meta multi-país (AR, US, BR, MX, ES)
- `businessProfiles` — onboarding (goal, channels, `nicheIds`: hasta 1 nicho en plan Free, hasta 3 en Pro)
- `radarProducts` + listings/snapshots — legado de matching/scoring (conservado, no es el path UI MVP)

## Fuentes

Default `TREND_RADAR_SOURCES=meta_ad_library`.

Gemini se usa para: (a) localizar los términos base de cada nicho a cada país objetivo, una sola vez al sembrar el catálogo; (b) el pase de relevancia compartido por nicho. SerpAPI/agents siguen apagados en el happy path.

## Jobs

Un cron diario (`convex/radar/niches.ts` `enqueueDailyScrapeJobs`) crea un job por cada (nicho activo, país) sin job en curso — no hay más trigger por usuario. El scrape en sí corre en `scripts/meta-ad-scraper/` (Playwright), disparado por el workflow de GitHub Actions (`.github/workflows/scrape-meta-ads.yml`), que sondea la cola cada 15 min.

## UI

- `/onboarding` — perfil + elegir nicho del catálogo fijo (sin keywords tipeadas)
- `/tienda` — editar nicho(s), categorías y datos del negocio
- `/ads` — grid de anuncios ya pre-scrapeados para el/los nicho(s) elegidos
- `/ads/[id]` — detalle + investigación on-demand (ML/proveedores, AR-específico)
