/**
 * Gemini web research for Trend Radar attention + unit economics.
 * Fail-closed without GEMINI_API_KEY — no invented buzz or invented prices
 * when search finds nothing usable (omit economics fields rather than fabricate).
 */

import { requireGeminiApiKey } from "./registry";
import { calculateMargin } from "../logistics";

const GEMINI_MODEL = "gemini-3.6-flash";

/** Minimum acceptable retail margin (profit / sale) for ecommerce candidates. */
export const MIN_RESEARCH_MARGIN = 0.28;

export type GeminiUnitEconomics = {
  /** Estimated unit buy / import / wholesale cost. */
  buyPrice: number;
  /** Estimated local retail / landing sell price. */
  sellPrice: number;
  /** ISO-ish currency for sellPrice (e.g. ARS, MXN, USD). */
  sellCurrency: string;
  /** Currency for buyPrice when different (often USD for China). */
  buyCurrency: string;
  /** Optional freight / import shipping per unit in sellCurrency. */
  shippingCost?: number;
  /** Computed profit per unit in sellCurrency terms when convertible; else null. */
  profitPerUnit: number | null;
  /** Computed margin 0–1 (profit / sell). */
  margin: number | null;
  /** Short note: where prices came from. */
  economicsNote?: string;
};

export type GeminiResearchHit = {
  productName: string;
  webBuzz: number;
  signals: string[];
  sources: string[];
  rationale: string;
  estimatedSourcingNotes?: string;
  /** Offer language seen in ads / landings (e.g. 3x1, envío gratis). */
  offerHook?: string;
  /** Pain / angle used in creatives. */
  adAngle?: string;
  /** Optional product image URL found during research (not a DB column). */
  imageUrl?: string;
  /** Buy vs sell economics — required for a strong ecommerce candidate. */
  economics?: GeminiUnitEconomics;
};

export type GeminiResearchResult = {
  products: GeminiResearchHit[];
  searchNotes: string;
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
};

function extractText(json: GeminiGenerateResponse): {
  text: string;
  finishReason?: string;
} {
  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  return { text, finishReason: candidate?.finishReason };
}

async function callGeminiWithSearch(
  apiKey: string,
  prompt: string,
): Promise<{ text: string; finishReason?: string }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GeminiGenerateResponse;
  return extractText(json);
}

/** Shared Gemini+Search call for agents (Analyst, etc.). */
export async function geminiSearchText(prompt: string): Promise<string> {
  const apiKey = requireGeminiApiKey();
  const { text, finishReason } = await callGeminiWithSearch(apiKey, prompt);
  if (!text) {
    throw new Error(
      `Gemini empty response${finishReason ? ` (${finishReason})` : ""}`,
    );
  }
  return text;
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.,-]/g, "").replace(",", ".");
    const n = Number(cleaned);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function asCurrencyCode(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^[A-Za-z]{3}$/.test(value.trim())) {
    return value.trim().toUpperCase();
  }
  return fallback;
}

function parseEconomics(
  row: Record<string, unknown>,
  defaultSellCurrency: string,
): GeminiUnitEconomics | undefined {
  const buyPrice = asPositiveNumber(
    row.buy ?? row.buyPrice ?? row.cost ?? row.purchaseCost,
  );
  // Buy is required at discovery; sell is optional until Mercado Libre validates.
  if (buyPrice == null) return undefined;

  const sellPrice =
    asPositiveNumber(
      row.sell ?? row.sellPrice ?? row.price ?? row.estimatedSalePrice,
    ) ?? 0;

  const sellCurrency = asCurrencyCode(
    row.sellCur ?? row.sellCurrency ?? row.currency,
    defaultSellCurrency,
  );
  const buyCurrency = asCurrencyCode(
    row.buyCur ?? row.buyCurrency,
    sellCurrency === "ARS" || sellCurrency === "MXN" || sellCurrency === "BRL"
      ? "USD"
      : sellCurrency,
  );
  const shippingCost =
    asPositiveNumber(row.ship ?? row.shipping ?? row.shippingCost) ?? undefined;
  const economicsNote =
    typeof row.econ === "string"
      ? row.econ.slice(0, 160)
      : typeof row.economicsNote === "string"
        ? row.economicsNote.slice(0, 160)
        : undefined;

  // Only compute margin when both prices exist in the same currency.
  const sameCurrency =
    sellPrice > 0 && buyCurrency === sellCurrency;
  const marginResult = sameCurrency
    ? calculateMargin({
        purchaseCost: buyPrice,
        shippingCost: shippingCost ?? 0,
        estimatedSalePrice: sellPrice,
      })
    : { estimatedProfit: null, estimatedMargin: null };

  return {
    buyPrice,
    sellPrice,
    sellCurrency,
    buyCurrency,
    shippingCost,
    profitPerUnit: marginResult.estimatedProfit,
    margin: marginResult.estimatedMargin,
    economicsNote,
  };
}

function parseResearchJson(
  text: string,
  defaultSellCurrency: string,
): GeminiResearchResult | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || !("products" in data)) {
    return null;
  }
  const raw = data as {
    products?: unknown;
    notes?: unknown;
  };
  if (!Array.isArray(raw.products)) return null;

  const products: GeminiResearchHit[] = [];
  for (const item of raw.products) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const name =
      typeof row.n === "string"
        ? row.n
        : typeof row.productName === "string"
          ? row.productName
          : null;
    if (!name?.trim()) continue;
    const buzzRaw = row.b ?? row.webBuzz;
    const webBuzz =
      typeof buzzRaw === "number"
        ? Math.max(0, Math.min(100, buzzRaw))
        : 50;
    const signals = Array.isArray(row.sig)
      ? row.sig.filter((s): s is string => typeof s === "string")
      : Array.isArray(row.signals)
        ? row.signals.filter((s): s is string => typeof s === "string")
        : [];
    const sources = Array.isArray(row.sources)
      ? row.sources.filter((s): s is string => typeof s === "string")
      : Array.isArray(row.u)
        ? row.u.filter((s): s is string => typeof s === "string")
        : [];
    const rationale =
      typeof row.w === "string"
        ? row.w
        : typeof row.rationale === "string"
          ? row.rationale
          : "";
    const estimatedSourcingNotes =
      typeof row.sourcing === "string"
        ? row.sourcing
        : typeof row.estimatedSourcingNotes === "string"
          ? row.estimatedSourcingNotes
          : undefined;
    const offerHook =
      typeof row.offer === "string"
        ? row.offer
        : typeof row.offerHook === "string"
          ? row.offerHook
          : undefined;
    const adAngle =
      typeof row.angle === "string"
        ? row.angle
        : typeof row.adAngle === "string"
          ? row.adAngle
          : undefined;
    const imageRaw =
      typeof row.img === "string"
        ? row.img
        : typeof row.imageUrl === "string"
          ? row.imageUrl
          : undefined;
    const imageUrl =
      imageRaw &&
      (imageRaw.startsWith("http://") || imageRaw.startsWith("https://"))
        ? imageRaw.trim().slice(0, 500)
        : undefined;
    products.push({
      productName: name.trim().slice(0, 120),
      webBuzz,
      signals,
      sources: sources.slice(0, 8),
      rationale: rationale.slice(0, 200),
      estimatedSourcingNotes: estimatedSourcingNotes?.slice(0, 240),
      offerHook: offerHook?.slice(0, 80),
      adAngle: adAngle?.slice(0, 120),
      imageUrl,
      economics: parseEconomics(row, defaultSellCurrency),
    });
  }

  return {
    products,
    searchNotes:
      typeof raw.notes === "string" ? raw.notes.slice(0, 400) : "",
  };
}

function countryCurrency(country: string): string {
  switch (country.toUpperCase()) {
    case "AR":
      return "ARS";
    case "MX":
      return "MXN";
    case "BR":
      return "BRL";
    case "CL":
      return "CLP";
    case "CO":
      return "COP";
    case "PE":
      return "PEN";
    case "UY":
      return "UYU";
    default:
      return "USD";
  }
}

function buyEconomicsPromptBlock(country: string, niche: string): string {
  return `
COMPRA BARATA (prioridad #1 en esta etapa):
Nicho del seller: ${niche}.
Para CADA producto investigá con Google Search un COSTO DE COMPRA real:
1) buy = costo unitario en Alibaba / Made-in-China / AliExpress / mayorista / importadora.
2) buyCur = moneda ISO (suele ser USD para China).
3) u = URL de la ficha de compra (OBLIGATORIA).
4) sell = solo estimación local en ${country} si la encontrás (opcional — Mercado Libre valida el sell después).
5) ship = flete estimado opcional.

REGLAS:
- Solo productos FÍSICOS que encajen en el nicho "${niche}".
- RECHAZÁ ruido semántico (si el nicho es mates: NO celulares Huawei Mate, NO manhwa, NO museos).
- RECHAZÁ flagships, réplicas, mystery boxes, commodities sin spread.
- Si no hay URL de compra + buy confiable, NO lo incluyas.
- Preferí SKUs concretos (ej. "Mate imperial acero 1L" no "mate").`.trim();
}

function jsonSchemaHint(max: number, sellCur: string): string {
  return `Respondé SOLO JSON válido (sin markdown):
{"products":[{"n":"Nombre producto concreto vendible","b":72,"sig":["web"],"u":["https://aliexpress.com/..."],"img":"https://...jpg","buy":8.5,"buyCur":"USD","sell":24900,"sellCur":"${sellCur}","ship":2,"econ":"buy Alibaba","w":"encaja en nicho","sourcing":"nota"}],"notes":"queries"}
Campos: n,u,buy,buyCur OBLIGATORIOS; sell/sellCur opcionales; img/ship opcionales; b=0-100; máximo ${max}; nada inventado.`;
}

/**
 * Niche demand research: cheap-buy candidates. Sell is provisional until ML validates.
 */
export async function researchDemandForTerm(input: {
  term: string;
  country?: string;
  nicheKeywords?: string[];
  excludedKeywords?: string[];
  maxProducts?: number;
}): Promise<GeminiResearchResult> {
  const apiKey = requireGeminiApiKey();
  const max = input.maxProducts ?? 5;
  const country = input.country ?? "AR";
  const sellCur = countryCurrency(country);
  const niche =
    input.nicheKeywords?.filter(Boolean).slice(0, 5).join(", ") || input.term;
  const excluded =
    input.excludedKeywords?.filter(Boolean).slice(0, 8).join(", ") ||
    "réplicas, mystery box, smartphones";

  const prompt = `Sos analista senior de ecommerce/importación LATAM (${country}).
Objetivo: productos del NICHO que se compren BARATO en China/mayorista y se puedan revender en ${country}.

Término / seed: "${input.term}".
Nicho: ${niche}.
Excluir: ${excluded}.

Usá Google Search. NO listes keywords: solo SKUs físicos concretos.

${buyEconomicsPromptBlock(country, niche)}

${jsonSchemaHint(max, sellCur)}`;

  const { text, finishReason } = await callGeminiWithSearch(apiKey, prompt);
  const parsed = parseResearchJson(text, sellCur);
  if (!parsed) {
    throw new Error(
      `Gemini research unparseable${finishReason ? ` (${finishReason})` : ""}`,
    );
  }
  return {
    products: parsed.products.slice(0, max),
    searchNotes: parsed.searchNotes,
  };
}

/** Default offer/copy keywords used by LATAM ecommerce ads (análisis de tienda). */
export const DEFAULT_OFFER_AD_KEYWORDS = [
  "2x1",
  "3x1",
  "dos por uno",
  "tres por uno",
  "cuotas sin interés",
  "envío gratis",
  "uno de regalo",
] as const;

/**
 * Ads-style discovery via Gemini + Google Search (NOT Meta Ad Library API).
 */
export async function researchAdsStyleProducts(input: {
  country?: string;
  nicheKeywords?: string[];
  excludedKeywords?: string[];
  offerKeywords?: string[];
  maxProducts?: number;
}): Promise<GeminiResearchResult> {
  const apiKey = requireGeminiApiKey();
  const max = input.maxProducts ?? 6;
  const country = input.country ?? "AR";
  const sellCur = countryCurrency(country);
  const niche =
    input.nicheKeywords?.filter(Boolean).slice(0, 5).join(", ") ||
    "ecommerce general";
  const excluded =
    input.excludedKeywords?.filter(Boolean).slice(0, 8).join(", ") ||
    "réplicas, mystery box";
  const offers = (
    input.offerKeywords?.length
      ? input.offerKeywords
      : [...DEFAULT_OFFER_AD_KEYWORDS]
  )
    .slice(0, 8)
    .join(", ");

  const prompt = `Sos scout de productos ganadores para ecommerce/importación en ${country}.
Método: anuncios / tiendas que YA venden (NO inventes). Usá Google Search.

Buscá productos FÍSICOS del nicho con ofertas tipo: ${offers}.
Nicho: ${niche}.
NO sugerir: ${excluded}.

Cada producto debe poder comprarse barato (China/mayorista) y venderse localmente.

${buyEconomicsPromptBlock(country, niche)}

${jsonSchemaHint(max, sellCur)}`;

  const { text, finishReason } = await callGeminiWithSearch(apiKey, prompt);
  const parsed = parseResearchJson(text, sellCur);
  if (!parsed) {
    throw new Error(
      `Gemini ads research unparseable${finishReason ? ` (${finishReason})` : ""}`,
    );
  }
  return {
    products: parsed.products.slice(0, max),
    searchNotes: parsed.searchNotes,
  };
}

/** Discovery gate: need a real buy price (sell comes from ML later). */
export function hasAcceptableBuyEconomics(hit: GeminiResearchHit): boolean {
  const e = hit.economics;
  if (!e) return false;
  return e.buyPrice > 0;
}

/** @deprecated Prefer hasAcceptableBuyEconomics at discovery; margin gated post-ML. */
export function hasAcceptableEconomics(hit: GeminiResearchHit): boolean {
  return hasAcceptableBuyEconomics(hit);
}

export type MlValidationInput = {
  productName: string;
  niche: string;
  country: string;
  buyPrice: number | null;
  buyCurrency: string | null;
  shippingCost: number | null;
  mlSellPrice: number;
  mlSoldQuantity: number | null;
  mlUrl: string | null;
  buyUrl: string | null;
};

export type MlValidationResult = {
  ok: boolean;
  reason: string;
  marginEstimate: number | null;
};

/**
 * Post-ML Gemini gate: niche fit + margin sense given buy vs ML sell/sold.
 */
export async function validateCandidateWithEvidence(
  input: MlValidationInput,
): Promise<MlValidationResult> {
  const apiKey = requireGeminiApiKey();

  if (
    input.buyPrice != null &&
    input.buyCurrency &&
    input.buyCurrency === countryCurrency(input.country)
  ) {
    const m = calculateMargin({
      purchaseCost: input.buyPrice,
      shippingCost: input.shippingCost ?? 0,
      estimatedSalePrice: input.mlSellPrice,
    });
    if (m.estimatedMargin != null && m.estimatedMargin < MIN_RESEARCH_MARGIN) {
      return {
        ok: false,
        reason: `margen ${(m.estimatedMargin * 100).toFixed(0)}% < ${Math.round(MIN_RESEARCH_MARGIN * 100)}%`,
        marginEstimate: m.estimatedMargin,
      };
    }
  }

  const prompt = `Sos auditor de candidatos ecommerce LATAM (${input.country}).
Validá si este producto tiene sentido para importar/revender.

Producto: ${input.productName}
Nicho del seller: ${input.niche}
Compra: ${input.buyPrice ?? "n/d"} ${input.buyCurrency ?? ""} (URL: ${input.buyUrl ?? "n/d"})
Flete est.: ${input.shippingCost ?? "n/d"}
Venta ML: ${input.mlSellPrice} (vendidos: ${input.mlSoldQuantity ?? "n/d"}) URL: ${input.mlUrl ?? "n/d"}

Respondé SOLO JSON:
{"ok":true,"reason":"breve","margin":0.42}
Reglas:
- ok=false si NO encaja en el nicho, es ruido semántico, margen pobre, o ML sin demanda (0 vendidos y sin sentido).
- ok=true solo si es SKU concreto del nicho, comprable barato, y venta ML competitiva con margen viable (~≥${Math.round(MIN_RESEARCH_MARGIN * 100)}% o justificá FX).
- margin = estimación 0–1 del margen (null si no se puede).
- Nada inventado: basate en los números dados.`;

  const { text } = await callGeminiWithSearch(apiKey, prompt);
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, reason: "validate_unparseable", marginEstimate: null };
  }
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as {
      ok?: unknown;
      reason?: unknown;
      margin?: unknown;
    };
    const ok = raw.ok === true;
    const reason =
      typeof raw.reason === "string"
        ? raw.reason.slice(0, 200)
        : ok
          ? "ok"
          : "rejected";
    const margin =
      typeof raw.margin === "number" && Number.isFinite(raw.margin)
        ? Math.max(0, Math.min(1, raw.margin))
        : null;
    return { ok, reason, marginEstimate: margin };
  } catch {
    return { ok: false, reason: "validate_parse_error", marginEstimate: null };
  }
}

/** Unit-test helper: parse without calling the API. */
export function parseGeminiResearchResponseForTests(
  text: string,
  defaultSellCurrency = "ARS",
): GeminiResearchResult | null {
  return parseResearchJson(text, defaultSellCurrency);
}

// ─── Investigate: supplier lookup for one concrete product ────────────

export type SupplierCandidate = {
  supplierName?: string;
  country: "AR" | "CN" | "BR";
  unitPrice: number;
  currency: string;
  moq?: number;
  leadTimeDays?: number;
  url: string;
};

function asSupplierCountry(value: unknown): "AR" | "CN" | "BR" | null {
  if (value === "AR" || value === "CN" || value === "BR") return value;
  return null;
}

function parseSupplierJson(text: string): SupplierCandidate[] | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || !("suppliers" in data)) {
    return null;
  }
  const raw = (data as { suppliers?: unknown }).suppliers;
  if (!Array.isArray(raw)) return null;

  const out: SupplierCandidate[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const country = asSupplierCountry(row.country ?? row.c);
    const url =
      typeof row.url === "string"
        ? row.url
        : typeof row.u === "string"
          ? row.u
          : null;
    const unitPrice = asPositiveNumber(row.price ?? row.p);
    // A supplier candidate without a source URL and a real price is not verifiable — drop it.
    if (!country || !url || unitPrice == null) continue;
    const currency = asCurrencyCode(
      row.currency ?? row.cur,
      country === "AR" ? "ARS" : country === "BR" ? "BRL" : "USD",
    );
    const moqRaw = row.moq ?? row.m;
    const moq =
      typeof moqRaw === "number" && Number.isFinite(moqRaw) && moqRaw > 0
        ? moqRaw
        : undefined;
    const leadRaw = row.leadTimeDays ?? row.lead;
    const leadTimeDays =
      typeof leadRaw === "number" && Number.isFinite(leadRaw) && leadRaw > 0
        ? leadRaw
        : undefined;
    const supplierName =
      typeof row.supplier === "string"
        ? row.supplier.slice(0, 80)
        : typeof row.supplierName === "string"
          ? row.supplierName.slice(0, 80)
          : undefined;
    out.push({
      supplierName,
      country,
      unitPrice,
      currency,
      moq,
      leadTimeDays,
      url: url.slice(0, 500),
    });
  }
  return out;
}

/**
 * Find real, sourced supplier offers for one concrete product across
 * Argentina (local/no import), China, and Brazil. Fail-closed without
 * GEMINI_API_KEY — never invents a price or a supplier without a URL.
 */
export async function researchSuppliersForProduct(input: {
  productName: string;
  niche?: string;
  maxPerCountry?: number;
}): Promise<SupplierCandidate[]> {
  const apiKey = requireGeminiApiKey();
  const maxPerCountry = input.maxPerCountry ?? 2;
  const niche = input.niche?.trim();

  const prompt = `Sos sourcing agent para un ecommerce en Argentina.
Producto a abastecer: "${input.productName}"${niche ? ` (nicho del seller: ${niche})` : ""}.

Usá Google Search para encontrar ofertas de compra REALES y verificables (mayoristas,
importadoras, fabricantes o marketplaces B2B) para ese producto en estos 3 países:
- AR (Argentina): mayorista/distribuidor local — el seller NO tendría que importar.
- CN (China): Alibaba / Made-in-China / fabricante directo — requiere importar.
- BR (Brasil): mayorista/distribuidor — requiere importar a Argentina.

Hasta ${maxPerCountry} ofertas por país (menos si no encontrás suficientes reales).
Cada oferta DEBE tener una URL real de la ficha/publicación y un precio unitario numérico.
NO inventes proveedores, precios ni URLs. Si no encontrás nada confiable para un país, omitilo.

Respondé SOLO JSON válido (sin markdown):
{"suppliers":[{"country":"AR","supplier":"Nombre","price":1200,"currency":"ARS","moq":10,"leadTimeDays":5,"url":"https://..."}]}
Campos obligatorios: country (AR|CN|BR), price, url. moq/leadTimeDays/currency opcionales.`;

  const { text, finishReason } = await callGeminiWithSearch(apiKey, prompt);
  const parsed = parseSupplierJson(text);
  if (!parsed) {
    throw new Error(
      `Gemini supplier research unparseable${finishReason ? ` (${finishReason})` : ""}`,
    );
  }
  return parsed;
}
