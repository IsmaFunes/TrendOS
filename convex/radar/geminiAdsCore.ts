/**
 * Pure helpers for Gemini ad personalization (no Convex / Node deps).
 */

/** Same model family as geminiResearch (2.5-flash is 404 for new keys). */
export const GEMINI_ADS_MODEL = "gemini-3.6-flash";
export const AD_RANKING_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_ADS_TO_RANK = 60;
/** Bump to invalidate cached rankings when gate/prompt rules change. */
export const RANKING_RULES_VERSION = "v2-strict-niche";

export type ProfileForAds = {
  businessName: string;
  description?: string;
  nicheKeywords?: string[];
  excludedKeywords?: string[];
  goal?: string;
  notes?: string;
  channels?: string[];
};

export function profileFingerprint(profile: ProfileForAds): string {
  const raw = JSON.stringify({
    v: RANKING_RULES_VERSION,
    n: profile.businessName.trim().toLowerCase(),
    d: (profile.description ?? "").trim().toLowerCase(),
    k: [...(profile.nicheKeywords ?? [])].map((x) => x.toLowerCase()).sort(),
    e: [...(profile.excludedKeywords ?? [])].map((x) => x.toLowerCase()).sort(),
    g: profile.goal ?? "",
    c: [...(profile.channels ?? [])].map((x) => x.toLowerCase()).sort(),
    notes: (profile.notes ?? "").trim().toLowerCase().slice(0, 200),
  });
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `p${(h >>> 0).toString(16)}`;
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
  return [...new Set(out)].slice(0, 8);
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

export function buildScrapeTermsPrompt(input: {
  keywords: string[];
  description?: string;
  label?: string;
}): string {
  return `Sos un especialista en Meta Ad Library para ecommerce en Argentina.
Dado el nicho de una tienda, sugerí términos de búsqueda cortos (2-5 palabras) en español rioplatense para encontrar anuncios comerciales relevantes.

Nicho keywords: ${JSON.stringify(input.keywords)}
Descripción: ${input.description?.trim() || "(sin descripción)"}
Label: ${input.label ?? ""}

Reglas:
- Máximo 8 términos
- Solo nombres/variantes de PRODUCTO o categoría (ej. "mate imperial", "bombilla alpaca")
- PROHIBIDO incluir ganchos de oferta: "envío gratis", "cuotas sin interés", "2x1", "promo", "oferta", "gratis"
- Evitá términos genéricos vacíos
- No inventes marcas irrelevantes

Respondé SOLO JSON:
{"terms":["..."]}`;
}

export function buildRankingPrompt(input: {
  profile: ProfileForAds;
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
Solo dejá anuncios del MISMO rubro de producto que la tienda. Ante la duda, DROPEÁ.

Perfil de tienda:
${JSON.stringify({
  name: input.profile.businessName,
  description: input.profile.description ?? "",
  keywords: input.profile.nicheKeywords ?? [],
  excluded: input.profile.excludedKeywords ?? [],
  goal: input.profile.goal ?? "",
  channels: input.profile.channels ?? [],
  notes: (input.profile.notes ?? "").slice(0, 240),
})}

Anuncios candidatos:
${JSON.stringify(adsJson)}

DROP obligatorio si:
- App / Play Store / App Store / series / drama / juegos
- Copy principalmente en inglés, italiano u otro idioma (no español rioplatense)
- Otro rubro (fitness, CNC, moda, fintech, etc.) aunque el searchTerm diga el nicho
- Placeholders {{product.*}} o creativo vacío

KEEP solo si el producto/oferta encaja claramente con keywords/descripción.
score 0-100, reason corto en español.

Respondé SOLO JSON:
{"keep":[{"id":"...","score":0,"reason":"..."}],"drop":[{"id":"...","reason":"..."}]}`;
}
