import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { TOP_N } from "./limits";

const SITE_TO_GEO: Record<string, string> = {
  MLA: "AR",
  MLB: "BR",
  MLM: "MX",
  MLC: "CL",
  MCO: "CO",
};

const GEMINI_MODEL = "gemini-3.6-flash";
const MAX_WEB_PRODUCTS = TOP_N;

const discoveredProductValidator = v.object({
  webProductName: v.string(),
  webBuzz: v.number(),
  signals: v.array(v.string()),
  sources: v.array(v.string()),
  rationale: v.string(),
});

const discoverResultValidator = v.object({
  products: v.array(discoveredProductValidator),
  searchNotes: v.string(),
});

export type DiscoveredWebProduct = {
  webProductName: string;
  webBuzz: number;
  signals: string[];
  sources: string[];
  rationale: string;
};

export type DiscoverWebTrendsResult = {
  products: DiscoveredWebProduct[];
  searchNotes: string;
};

export const explainTrend = internalAction({
  args: {
    title: v.string(),
    entityType: v.union(v.literal("product"), v.literal("keyword")),
    categoryName: v.string(),
    trendScore: v.number(),
    mlPosition: v.optional(v.number()),
    mlBucket: v.optional(v.string()),
    googleInterest: v.optional(v.number()),
    webBuzz: v.optional(v.number()),
    siteId: v.string(),
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const fallback = buildFallback(args);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return fallback;

    try {
      const prompt = `Analista e-commerce LATAM. 1 oración en español, por qué está en tendencia. No inventes números.

${args.entityType}: ${args.title}
cat=${args.categoryName} site=${args.siteId} score=${args.trendScore.toFixed(2)}
mlPos=${args.mlPosition ?? "-"} bucket=${args.mlBucket ?? "-"} gTrends=${args.googleInterest ?? "-"} webBuzz=${args.webBuzz ?? "-"}`;

      const text = await callGeminiText(apiKey, prompt);
      return text || fallback;
    } catch (error) {
      console.error("Gemini explain failed", error);
      return fallback;
    }
  },
});

const trendsEvidenceValidator = v.object({
  query: v.string(),
  kind: v.union(v.literal("rising"), v.literal("top")),
  interest: v.number(),
});

const mlProductEvidenceValidator = v.object({
  title: v.string(),
  position: v.number(),
  price: v.optional(v.number()),
});

const mlKeywordEvidenceValidator = v.object({
  keyword: v.string(),
  bucket: v.string(),
});

/**
 * Cross Google Trends + Mercado Libre (+ optional web search) and DECIDE
 * which concrete products to recommend. Sources may disagree — Gemini arbitrates.
 */
export const discoverWebTrends = internalAction({
  args: {
    categoryName: v.string(),
    siteId: v.string(),
    nicheKeywords: v.optional(v.array(v.string())),
    businessDescription: v.optional(v.string()),
    trendsSeed: v.optional(v.string()),
    trendsRelated: v.optional(v.array(trendsEvidenceValidator)),
    mlProducts: v.optional(v.array(mlProductEvidenceValidator)),
    mlKeywords: v.optional(v.array(mlKeywordEvidenceValidator)),
  },
  returns: discoverResultValidator,
  handler: async (_ctx, args): Promise<DiscoverWebTrendsResult> => {
    const empty: DiscoverWebTrendsResult = {
      products: [],
      searchNotes: "Sin decisión (API key ausente o error).",
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return empty;

    const geo = SITE_TO_GEO[args.siteId] ?? "AR";
    const keywords = (args.nicheKeywords ?? [])
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 3);
    const desc = (args.businessDescription ?? "").trim().slice(0, 200);

    const trendsLines = (args.trendsRelated ?? [])
      .slice(0, 16)
      .map(
        (t) =>
          `- [${t.kind}] "${t.query}" interest~${Math.round(t.interest)}`,
      )
      .join("\n");
    const mlProductLines = (args.mlProducts ?? [])
      .slice(0, 12)
      .map(
        (p) =>
          `- #${p.position} ${p.title}${p.price !== undefined ? ` $${p.price}` : ""}`,
      )
      .join("\n");
    const mlKwLines = (args.mlKeywords ?? [])
      .slice(0, 10)
      .map((k) => `- ${k.keyword} (${k.bucket})`)
      .join("\n");

    const prompt = `Sos el árbitro de tendencias e-commerce/dropshipping LATAM.
País=${geo} (${args.siteId}). Categoría="${args.categoryName}".
Nicho del seller: keywords=[${keywords.join(", ") || "-"}] negocio="${desc || "-"}".
Seed Google Trends: "${args.trendsSeed ?? keywords[0] ?? "-"}".

EVIDENCIA A (Google Trends related — puede ser queries, no productos):
${trendsLines || "(vacío)"}

EVIDENCIA B (Mercado Libre best sellers / keywords de la categoría — puede irse de tema):
Productos:
${mlProductLines || "(vacío o filtrado)"}
Keywords ML:
${mlKwLines || "(vacío)"}

TAREA: Cruzá las señales. Pueden no coincidir. Decidí hasta ${MAX_WEB_PRODUCTS} productos CONCRETOS (marca+modelo) del NICHO del seller, buenos para revender online.
- Preferí lo apoyado por 2+ fuentes (gtrends/ml/web).
- Si ML trae ruido fuera de nicho, ignorálo.
- Si Trends solo trae queries, usá Google Search para bajar a productos concretos.
- No inventes productos. Excluí fuera de nicho.

Respondé SOLO JSON válido (sin markdown):
{"products":[{"n":"Marca Modelo","b":85,"sig":["gtrends","ml"],"w":"por qué breve"}],"notes":"cómo cruzaste"}
Reglas: b=0-100 confianza; sig⊆gtrends|ml|web; w≤12 palabras; Exactamente JSON parseable.`;

    try {
      const { text, finishReason } = await callGeminiWithSearch(apiKey, prompt);
      console.log(
        `[gemini] crossDecide chars=${text.length} finishReason=${finishReason ?? "n/a"} preview=${JSON.stringify(text.slice(0, 180))}`,
      );

      const parsed = parseDiscoverJson(text);
      if (!parsed || parsed.products.length === 0) {
        console.error(
          "Gemini crossDecide JSON parse failed",
          `finishReason=${finishReason}`,
          text.slice(0, 800),
        );
        return {
          products: [],
          searchNotes:
            finishReason === "MAX_TOKENS"
              ? "Respuesta truncada (MAX_TOKENS); reintentá."
              : "Respuesta de Gemini no parseable como JSON.",
        };
      }

      console.log(
        `[gemini] crossDecide parsed=${parsed.products.length} notes=${parsed.searchNotes}`,
      );
      return {
        products: parsed.products.slice(0, MAX_WEB_PRODUCTS),
        searchNotes: parsed.searchNotes,
      };
    } catch (error) {
      console.error("Gemini crossDecide failed", error);
      return empty;
    }
  },
});

async function callGeminiText(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 512,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      }),
    },
  );

  if (!res.ok) {
    console.error("Gemini HTTP error", res.status, await res.text());
    return "";
  }

  const json = (await res.json()) as GeminiGenerateResponse;
  return extractText(json).text;
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
          // Thinking was eating the 1024 token budget and truncating JSON mid-string.
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      }),
    },
  );

  if (!res.ok) {
    console.error("Gemini search HTTP error", res.status, await res.text());
    return { text: "" };
  }

  const json = (await res.json()) as GeminiGenerateResponse;
  return extractText(json);
}

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

function parseDiscoverJson(text: string): DiscoverWebTrendsResult | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const tryParse = (raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };

  let data = tryParse(cleaned);
  if (!data) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      data = tryParse(cleaned.slice(start, end + 1));
    }
  }

  // Repair truncated payloads: close open strings/arrays/objects, then parse.
  if (!data) {
    data = tryParse(repairTruncatedJson(cleaned));
  }

  let products: DiscoveredWebProduct[] = [];
  let searchNotes = "";

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const list = Array.isArray(obj.products) ? obj.products : [];
    products = list
      .map(normalizeDiscovered)
      .filter((p): p is DiscoveredWebProduct => p !== null);
    searchNotes =
      typeof obj.notes === "string"
        ? obj.notes
        : typeof obj.searchNotes === "string"
          ? obj.searchNotes
          : "";
  }

  // Last resort: scrape complete-ish objects / n+b pairs from truncated text
  if (products.length === 0) {
    products = extractProductsFromPartialText(cleaned);
    if (products.length > 0) {
      searchNotes = searchNotes || "Recuperado desde JSON parcial truncado.";
    }
  }

  if (products.length === 0) return null;
  return { products, searchNotes };
}

function repairTruncatedJson(raw: string): string {
  let s = raw.trim();
  const start = s.indexOf("{");
  if (start < 0) return s;
  s = s.slice(start);

  // If cut mid-string, close the quote
  const quotes = (s.match(/"/g) ?? []).length;
  if (quotes % 2 === 1) s += '"';

  // Drop trailing incomplete key/value junk after last complete value
  s = s.replace(/,\s*"[^"]*$/, "");
  s = s.replace(/,\s*$/, "");

  const opens = (s.match(/\[/g) ?? []).length;
  const closes = (s.match(/\]/g) ?? []).length;
  for (let i = 0; i < opens - closes; i++) s += "]";

  const openBraces = (s.match(/\{/g) ?? []).length;
  const closeBraces = (s.match(/\}/g) ?? []).length;
  for (let i = 0; i < openBraces - closeBraces; i++) s += "}";

  return s;
}

function extractProductsFromPartialText(text: string): DiscoveredWebProduct[] {
  const found: DiscoveredWebProduct[] = [];

  // Full mini-objects when present
  const objectRe =
    /\{\s*"n"\s*:\s*"([^"]+)"\s*,\s*"b"\s*:\s*(\d{1,3})(?:\s*,\s*"w"\s*:\s*"([^"]*)")?/g;
  for (const m of text.matchAll(objectRe)) {
    const name = m[1]?.trim();
    const buzz = Number(m[2]);
    if (!name || Number.isNaN(buzz)) continue;
    found.push({
      webProductName: name,
      webBuzz: Math.min(100, Math.max(0, buzz)),
      signals: [],
      sources: [],
      rationale: m[3]?.trim() ?? "",
    });
  }

  return found;
}

function normalizeDiscovered(raw: unknown): DiscoveredWebProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name =
    typeof o.n === "string"
      ? o.n
      : typeof o.webProductName === "string"
        ? o.webProductName
        : null;
  if (!name?.trim()) return null;
  const webBuzz = clampNumber(o.b ?? o.webBuzz, 0, 100);
  if (webBuzz === null) return null;
  const sources = asStringArray(o.s ?? o.sources).filter((u) =>
    u.startsWith("http"),
  );
  const rationale =
    typeof o.w === "string"
      ? o.w
      : typeof o.rationale === "string"
        ? o.rationale
        : "";
  const sig = asStringArray(o.sig ?? o.signals)
    .map((s) => s.toLowerCase())
    .filter((s) => s === "gtrends" || s === "ml" || s === "web")
    .slice(0, 3);

  return {
    webProductName: name.trim(),
    webBuzz,
    signals: sig,
    sources: sources.slice(0, 2),
    rationale: rationale.slice(0, 160),
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function buildFallback(args: {
  title: string;
  entityType: "product" | "keyword";
  categoryName: string;
  trendScore: number;
  mlPosition?: number;
  mlBucket?: string;
  googleInterest?: number;
  webBuzz?: number;
}): string {
  const bits: string[] = [];
  if (args.webBuzz !== undefined) {
    bits.push(`web buzz ~${Math.round(args.webBuzz)}`);
  }
  if (args.mlPosition !== undefined) {
    bits.push(`top ${args.mlPosition} en best sellers de Mercado Libre`);
  }
  if (args.mlBucket) {
    bits.push(`keyword en bucket ${args.mlBucket}`);
  }
  if (args.googleInterest !== undefined) {
    bits.push(`interés Google Trends ~${args.googleInterest}`);
  }
  if (bits.length === 0) {
    return `${args.title} aparece con score ${args.trendScore.toFixed(2)} en ${args.categoryName}.`;
  }
  return `${args.title} destaca en ${args.categoryName}: ${bits.join("; ")}.`;
}
