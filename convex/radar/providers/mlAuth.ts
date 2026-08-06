/**
 * Resolve Mercado Libre access token (direct or refresh).
 * Shared by radar collectors — never invents credentials.
 *
 * Mercado Libre's refresh_token is single-use: every refresh call returns
 * a NEW refresh_token and invalidates the old one. A static env var alone
 * therefore only works for the very first call ever made — after that,
 * the previously-issued token is dead. To survive across calls, the
 * current (access, refresh) pair is cached in `radarMercadoLibreToken`
 * (see ../mlToken.ts) and only the very first bootstrap falls back to
 * MERCADOLIBRE_REFRESH_TOKEN from the environment.
 */

import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";

/** Refresh a bit before the real expiry to absorb clock skew / request latency. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;
/** Mercado Libre access tokens are valid 6h; used only if the API omits expires_in. */
const DEFAULT_EXPIRES_IN_SECONDS = 6 * 60 * 60;

export async function resolveMercadoLibreAccessToken(
  ctx: ActionCtx,
): Promise<string> {
  const direct = process.env.MERCADOLIBRE_ACCESS_TOKEN;
  if (direct?.trim()) return direct.trim();

  const clientId = process.env.MERCADOLIBRE_CLIENT_ID;
  const clientSecret = process.env.MERCADOLIBRE_CLIENT_SECRET;
  const envRefreshToken = process.env.MERCADOLIBRE_REFRESH_TOKEN;

  const cached = await ctx.runQuery(internal.radar.mlToken.getCachedToken, {});
  const now = Date.now();
  if (cached && cached.accessTokenExpiresAt - EXPIRY_SAFETY_MARGIN_MS > now) {
    return cached.accessToken;
  }

  // First-ever call bootstraps from the env var; every call after that
  // uses the rotated refresh_token the cache already holds.
  const refreshToken = cached?.refreshToken ?? envRefreshToken;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Mercado Libre credentials missing. Set MERCADOLIBRE_ACCESS_TOKEN or CLIENT_ID+CLIENT_SECRET+REFRESH_TOKEN",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `ML token refresh failed: HTTP ${res.status} ${text.slice(0, 120)}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("ML token refresh returned no access_token");
  }

  const expiresInMs =
    (json.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
  await ctx.runMutation(internal.radar.mlToken.saveToken, {
    accessToken: json.access_token,
    accessTokenExpiresAt: now + expiresInMs,
    // Fall back to the old refresh token only if ML somehow didn't rotate it.
    refreshToken: json.refresh_token ?? refreshToken,
  });

  return json.access_token;
}
