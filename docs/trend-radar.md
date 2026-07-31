# TrendOS data layer

Infra de datos detrás del explorador de anuncios. El producto UI ya no es “agents”.

## Tablas clave

- `radarAds` / `radarAdvertisers` / `radarStores` — índice Meta AR
- `businessProfiles` — onboarding (goal, channels, niche)
- `radarProducts` + listings/snapshots — legado de matching/scoring (conservado, no es el path UI MVP)

## Fuentes

Default `TREND_RADAR_SOURCES=meta_ad_library`.

Gemini / SerpAPI / agents **apagados** en el happy path.

## Jobs

`CollectMetaAds` registra intención; el scrape corre en `scripts/meta-ad-scraper/`.

## UI

- `/onboarding` — perfil AR
- `/ads` — grid de anuncios
- `/ads/[id]` — detalle
