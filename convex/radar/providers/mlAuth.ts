/**
 * Resolve Mercado Libre access token (direct or refresh).
 * Shared by radar collectors — never invents credentials.
 */

export async function resolveMercadoLibreAccessToken(): Promise<string> {
  const direct = process.env.MERCADOLIBRE_ACCESS_TOKEN;
  if (direct?.trim()) return direct.trim();

  const clientId = process.env.MERCADOLIBRE_CLIENT_ID;
  const clientSecret = process.env.MERCADOLIBRE_CLIENT_SECRET;
  const refreshToken = process.env.MERCADOLIBRE_REFRESH_TOKEN;
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
    throw new Error(`ML token refresh failed: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("ML token refresh returned no access_token");
  }
  return json.access_token;
}
