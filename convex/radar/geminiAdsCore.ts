/**
 * Pure helpers for Gemini ad personalization (no Convex / Node deps).
 */

/** Same model family as geminiResearch (2.5-flash is 404 for new keys). */
export const GEMINI_ADS_MODEL = "gemini-3.6-flash";
/**
 * Niche-shared relevance pass TTL. Refreshed event-driven (new ads linked)
 * rather than per user session; expiry here is only a fallback so a niche
 * that never scrapes again doesn't serve an indefinitely-stale pass.
 */
export const NICHE_AD_RELEVANCE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ADS_TO_RANK = 60;
/** Bump to invalidate cached rankings when gate/prompt rules change. */
export const RANKING_RULES_VERSION = "v2-strict-niche";

/** Gemini `responseSchema` (Schema proto — type names are uppercase). */
export const SCRAPE_TERMS_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    terms: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["terms"],
} as const;

export const RANKING_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    keep: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          score: { type: "NUMBER" },
          reason: { type: "STRING" },
        },
        required: ["id", "score"],
      },
    },
    drop: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" } },
        required: ["id"],
      },
    },
  },
  required: ["keep", "drop"],
} as const;

/**
 * Fingerprint for the niche-shared relevance pass — keyed on the niche's
 * curated gate terms (flattened across countries) and label, since this
 * pass is computed once per fixed catalog niche and shared across every
 * store that follows it.
 */
export function nicheFingerprint(input: {
  gateTerms: string[];
  label: string;
}): string {
  const raw = JSON.stringify({
    v: RANKING_RULES_VERSION,
    k: [...input.gateTerms].map((x) => x.toLowerCase()).sort(),
    l: input.label.trim().toLowerCase(),
  });
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `n${(h >>> 0).toString(16)}`;
}

export function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Empty Gemini response");
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  const aStart = trimmed.indexOf("[");
  const aEnd = trimmed.lastIndexOf("]");
  if (aStart >= 0 && aEnd > aStart) {
    return JSON.parse(trimmed.slice(aStart, aEnd + 1));
  }
  throw new Error("Could not parse Gemini JSON");
}

/** Offer hooks pollute Meta Ad Library search — keep product terms only. */
const OFFER_HOOK_TERM_RE =
  /\b(env[ií]o\s*gratis|cuotas?(?:\s+sin\s+int(?:er[eé]s)?)?|2\s*x\s*1|3\s*x\s*1|tres\s+por\s+uno|uno\s+de\s+regalo|sin\s+int(?:er[eé]s)|free\s+shipping)\b/i;

export function isOfferHookScrapeTerm(term: string): boolean {
  return OFFER_HOOK_TERM_RE.test(term.trim());
}

export function normalizeScrapeTerms(terms: unknown, fallback: string[]): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const clean = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (clean.length < 2 || clean.length > 80) return;
    if (isOfferHookScrapeTerm(clean)) return;
    out.push(clean);
  };
  if (Array.isArray(terms)) {
    for (const t of terms) {
      if (typeof t === "string") push(t);
    }
  }
  for (const t of fallback) push(t);
  return [...new Set(out)].slice(0, 10);
}

export type RankedAdRef = {
  adId: string;
  score: number;
  reason?: string;
};

export function parseRankingResponse(
  payload: unknown,
  validIds: Set<string>,
): { ranked: RankedAdRef[]; droppedAdIds: string[] } {
  if (!payload || typeof payload !== "object") {
    return { ranked: [], droppedAdIds: [] };
  }
  const obj = payload as Record<string, unknown>;
  const rankedRaw = Array.isArray(obj.keep)
    ? obj.keep
    : Array.isArray(obj.ranked)
      ? obj.ranked
      : [];
  const droppedRaw = Array.isArray(obj.drop)
    ? obj.drop
    : Array.isArray(obj.dropped)
      ? obj.dropped
      : [];

  const ranked: RankedAdRef[] = [];
  const seen = new Set<string>();
  for (const item of rankedRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : typeof row.adId === "string" ? row.adId : "";
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const scoreRaw = row.score;
    const score =
      typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
        ? Math.max(0, Math.min(100, scoreRaw))
        : 50;
    const reason =
      typeof row.reason === "string" ? row.reason.trim().slice(0, 160) : undefined;
    ranked.push({ adId: id, score, reason });
  }
  ranked.sort((a, b) => b.score - a.score);

  const droppedAdIds: string[] = [];
  for (const item of droppedRaw) {
    let id = "";
    if (typeof item === "string") id = item;
    else if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      id = typeof row.id === "string" ? row.id : typeof row.adId === "string" ? row.adId : "";
    }
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    droppedAdIds.push(id);
  }

  // Ads Gemini omitted: treat as drop (must explicitly keep)
  for (const id of validIds) {
    if (seen.has(id) || droppedAdIds.includes(id)) continue;
    droppedAdIds.push(id);
  }

  return { ranked, droppedAdIds };
}

/**
 * One-time, seed-time localization: given a niche's hand-curated base
 * (AR-Spanish) search terms, produce an equivalent term set for another
 * country's ad-library language. Not called per-scrape — niches are a
 * fixed catalog, so this only runs once when a niche is seeded/updated
 * (convex/admin/seedNicheCatalog.ts).
 */
export function buildNicheTermLocalizationPrompt(input: {
  label: string;
  description?: string;
  baseTerms: string[];
  targetCountry: string;
  targetLanguage: string;
}): string {
  return `Sos un especialista en Meta Ad Library para ecommerce.
Tenés una lista de términos de búsqueda ya validados en español rioplatense (Argentina) para un nicho de producto. Tu tarea es traducirlos/adaptarlos al idioma real que usarían anuncios de ecommerce en ${input.targetCountry} (${input.targetLanguage}) — NO una traducción literal palabra por palabra, sino cómo un vendedor de ese país escribiría el mismo producto en un anuncio.

Nicho: ${input.label}
Descripción: ${input.description?.trim() || "(sin descripción)"}
Términos base (AR): ${JSON.stringify(input.baseTerms)}
País/idioma objetivo: ${input.targetCountry} / ${input.targetLanguage}

CONTEXTO CLAVE — Meta Ad Library busca "keyword_unordered": TODAS las palabras del término deben aparecer en el texto del anuncio (en cualquier orden). Términos largos o de jerga técnica casi nunca matchean nada real.

Reglas:
- Devolvé la MISMA cantidad de términos que la lista base, uno por cada término base (mismo orden, mismo producto — solo cambia el idioma/localismo).
- 1 a 3 palabras por término (preferí 1-2). NUNCA más de 3.
- Usá el nombre de producto/jerga real que usaría un vendedor de ecommerce en ${input.targetCountry}, no una traducción académica.
- PROHIBIDO incluir ganchos de oferta: "free shipping", "frete grátis", "2x1", "sale", "oferta", "gratis", etc.
- No inventes marcas.

Respondé SOLO JSON:
{"terms":["..."]}`;
}

/**
 * Niche-shared relevance pass — curates purely on topical fit to the niche
 * itself, since the result is shared across every store in it rather than
 * scoped to any one business's profile/exclusions.
 */
export function buildNicheRelevancePrompt(input: {
  label: string;
  keywords: string[];
  ads: Array<{
    id: string;
    pageName: string;
    body: string;
    activeDays: number;
    searchTerm?: string;
    destinationUrl?: string;
  }>;
}): string {
  const adsJson = input.ads.map((a) => ({
    id: a.id,
    page: a.pageName,
    body: a.body.slice(0, 280),
    days: a.activeDays,
    term: a.searchTerm ?? "",
    dest: (a.destinationUrl ?? "").slice(0, 120),
  }));
  return `Sos un curador estricto de anuncios Meta para ecommerce en Argentina.
Solo dejá anuncios del MISMO rubro de producto que este nicho. Ante la duda, DROPEÁ.

Nicho: ${input.label}
Keywords del nicho: ${JSON.stringify(input.keywords)}

Anuncios candidatos:
${JSON.stringify(adsJson)}

DROP obligatorio si:
- App / Play Store / App Store / series / drama / juegos
- Copy principalmente en inglés, italiano u otro idioma (no español rioplatense)
- Otro rubro (fitness, CNC, moda, fintech, etc.) aunque el searchTerm diga el nicho
- Placeholders {{product.*}} o creativo vacío

KEEP solo si el producto/oferta encaja claramente con el nicho y sus keywords.
score 0-100, reason corto en español.

Respondé SOLO JSON:
{"keep":[{"id":"...","score":0,"reason":"..."}],"drop":[{"id":"...","reason":"..."}]}`;
}
