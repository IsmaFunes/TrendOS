# TrendOS

Encontrá productos que ya se están anunciando en Meta en **Argentina**.

**MVP:** onboarding simple + explorador de anuncios (scrape Ad Library AR).

Producto: [`docs/product-context.md`](docs/product-context.md) · Keys: [`docs/trend-radar-api-keys.md`](docs/trend-radar-api-keys.md)

## Stack

- Next.js (App Router)
- Convex (DB + ingest)
- Clerk (auth)
- Playwright worker (Meta Ad Library scrape)

## Setup local

```bash
npm install
cp .env.example .env.local
# Completar Clerk + Convex + META_ADS_INGEST_SECRET

npx convex dev   # terminal 1
npm run dev      # terminal 2
```

### Clerk + Convex

1. App en [Clerk](https://dashboard.clerk.com) → JWT template **Convex**.
2. Convex env: `CLERK_JWT_ISSUER_DOMAIN`
3. `.env.local`: `NEXT_PUBLIC_CLERK_*` + `CLERK_SECRET_KEY` + `NEXT_PUBLIC_CONVEX_URL`

### Primeros datos

1. Login → onboarding
2. Seed de anuncios de prueba:

```bash
npx convex env set META_ADS_INGEST_SECRET "dev-secret"
META_ADS_INGEST_SECRET=dev-secret CONVEX_URL="$NEXT_PUBLIC_CONVEX_URL" \
  npm run scrape:meta-ads:seed
```

3. Abrí `/ads`

Scrape real (AR):

```bash
npm run scrape:meta-ads -- --term "envio gratis" --limit 30
```

## Scripts

| Script | Descripción |
|---|---|
| `npm run dev` | Next.js |
| `npm run convex:dev` | Convex watcher |
| `npm run scrape:meta-ads` | Scraper Playwright AR |
| `npm run scrape:meta-ads:seed` | Ingest sample ads |
| `npm run typecheck` | TypeScript |
| `npm test` | Vitest |

## Deploy (Vercel)

Clerk + `NEXT_PUBLIC_CONVEX_URL`. Secrets de scrape en Convex Dashboard (no Gemini/SerpAPI obligatorios).
