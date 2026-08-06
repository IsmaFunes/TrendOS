/**
 * Live USD/ARS rate from dolarapi.com (free, no key). Used to convert a
 * China supplier's USD cost into ARS for the Investigate profit estimate.
 * Fail-soft: any network/parse error returns null — never invents a rate.
 */

import { fetchJsonWithRetry } from "../http";

const DOLAR_API_URL = "https://dolarapi.com/v1/dolares/blue";
export const DOLAR_API_SOURCE_LABEL = "blue (dolarapi.com)";

type DolarApiResponse = {
  moneda?: string;
  casa?: string;
  nombre?: string;
  compra?: number;
  venta?: number;
  fechaActualizacion?: string;
};

/**
 * "venta" is what you pay in ARS to buy 1 USD — the right side for costing
 * a USD-denominated supplier purchase, as opposed to "compra" (what a
 * dealer pays you for USD).
 */
export async function fetchBlueDolarRate(): Promise<number | null> {
  const result = await fetchJsonWithRetry<DolarApiResponse>({
    url: DOLAR_API_URL,
    timeoutMs: 6_000,
    maxAttempts: 2,
  });
  if (!result.ok) return null;
  const venta = result.data.venta;
  return typeof venta === "number" && Number.isFinite(venta) && venta > 0
    ? venta
    : null;
}
