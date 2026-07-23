# TrendOS

Intelligence de tendencias para sellers de e-commerce en LATAM.

**MVP:** Trends — productos muy vendidos + keywords, score 0–1, refresh cada 8h.

## Stack

- Next.js (App Router) + Vercel
- Convex (DB, crons, actions)
- Clerk (auth)
- Mercado Libre API (best sellers + trends)
- SerpAPI (Google Trends, opcional)
- Gemini (web buzz + match a ML + explicaciones, opcional)

## Setup local

```bash
npm install
cp .env.example .env.local
# Completar Clerk + Convex (+ ML/SerpAPI/Gemini opcionales)

npx convex dev   # en una terminal
npm run dev      # en otra
```

### Clerk + Convex

1. Creá una app en [Clerk](https://dashboard.clerk.com).
2. En Clerk → JWT Templates → New → **Convex**.
3. En Convex Dashboard → Settings → Environment Variables:
   - `CLERK_JWT_ISSUER_DOMAIN` = `https://YOUR_INSTANCE.clerk.accounts.dev`
4. Copiá `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` y `CLERK_SECRET_KEY` a `.env.local`.

### Mercado Libre

Sin credenciales, la ingestión usa **datos demo** para que el dashboard funcione.

Con credenciales (Convex env):

- `MERCADOLIBRE_ACCESS_TOKEN` **o**
- `MERCADOLIBRE_CLIENT_ID` + `MERCADOLIBRE_CLIENT_SECRET` + `MERCADOLIBRE_REFRESH_TOKEN`

### Primeros datos

Desde la UI: **Trends → Actualizar ahora**.

O por CLI:

```bash
npx convex run categories:seed
npx convex run internal/ingestion:runAll '{"siteId":"MLA"}'
```

## Scripts

| Script | Descripción |
|---|---|
| `npm run dev` | Next.js |
| `npm run convex:dev` | Convex watcher |
| `npm run build` | Build producción |
| `npm run lint` | ESLint |

## Deploy (Vercel)

1. Push a GitHub (cuando quieras publicar).
2. Importá el repo en Vercel.
3. Configurá las env vars de `.env.example`.
4. En Convex: `npx convex deploy` (producción) y linkeá `NEXT_PUBLIC_CONVEX_URL`.

## Planes (preparado)

- `users.plan`: `free` | `pro`
- `users.refreshIntervalHours`: default `8` (PRO más rápido en el futuro)
- Cron global MVP: cada 8 horas (`convex/crons.ts`)
