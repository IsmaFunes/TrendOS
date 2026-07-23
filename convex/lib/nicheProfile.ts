import { normalizeProductName } from "../productMatch";

export const MAX_NICHE_KEYWORDS = 3;
export const MAX_DESCRIPTION_LENGTH = 200;
/** Drop ML/web candidates below this niche relevance. */
export const NICHE_RELEVANCE_MIN = 0.15;

const STOP = new Set([
  "de",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "y",
  "con",
  "para",
  "en",
  "del",
  "al",
  "the",
  "a",
  "and",
  "or",
  "for",
  "with",
  "vendo",
  "vende",
  "revendo",
  "revende",
  "tienda",
  "productos",
  "producto",
  "tipo",
]);

export type NicheInput = {
  keywords?: string[] | undefined;
  description?: string | undefined;
};

/** Light ES plural variants: mates↔mate, termos↔termo. */
function stemVariants(token: string): string[] {
  const t = token.trim();
  if (t.length < 2) return [];
  const out = new Set<string>([t]);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) {
    out.add(t.slice(0, -1));
  }
  if (t.length >= 3 && !t.endsWith("s")) {
    out.add(`${t}s`);
  }
  return [...out];
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of normalizeProductName(text).split(" ")) {
    if (t.length < 2 || STOP.has(t)) continue;
    for (const v of stemVariants(t)) out.add(v);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Trim, dedupe, max 3, drop empties. */
export function normalizeNicheKeywords(
  keywords: string[] | undefined,
): string[] {
  if (!keywords?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const trimmed = raw.trim().replace(/\s+/g, " ");
    if (!trimmed) continue;
    const key = normalizeProductName(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed.slice(0, 48));
    if (out.length >= MAX_NICHE_KEYWORDS) break;
  }
  return out;
}

export function clampNicheDescription(
  description: string | undefined,
): string | undefined {
  if (description === undefined) return undefined;
  const trimmed = description.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_DESCRIPTION_LENGTH);
}

export function hasNicheSignal(input: NicheInput): boolean {
  const keywords = normalizeNicheKeywords(input.keywords);
  const description = clampNicheDescription(input.description);
  return keywords.length > 0 || description !== undefined;
}

/**
 * Stable fingerprint for cache sharing across users with the same niche.
 * Empty niche → "" (baseline; not used for personalized research).
 */
export function computeNicheKey(input: NicheInput): string {
  const keywords = normalizeNicheKeywords(input.keywords)
    .map((k) => normalizeProductName(k))
    .filter(Boolean)
    .sort();
  const description = clampNicheDescription(input.description);
  const descNorm = description ? normalizeProductName(description) : "";
  if (keywords.length === 0 && !descNorm) return "";

  const payload = `${keywords.join("|")}::${descNorm}`;
  return simpleHash(payload);
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function nicheTokenSet(input: NicheInput): Set<string> {
  const keywords = normalizeNicheKeywords(input.keywords);
  const description = clampNicheDescription(input.description);
  const set = new Set<string>();
  for (const kw of keywords) {
    for (const t of tokens(kw)) set.add(t);
    const full = normalizeProductName(kw);
    if (full) {
      for (const v of stemVariants(full)) set.add(v);
    }
  }
  if (description) {
    for (const t of tokens(description)) set.add(t);
  }
  return set;
}

function keywordHitsTitle(keyword: string, titleNorm: string): boolean {
  const kwNorm = normalizeProductName(keyword);
  if (!kwNorm || kwNorm.length < 3) return false;
  for (const variant of stemVariants(kwNorm)) {
    if (variant.length >= 3 && titleNorm.includes(variant)) return true;
  }
  // Multi-word keyword: any significant token hit is enough
  for (const t of tokens(keyword)) {
    if (t.length >= 3 && titleNorm.includes(t)) return true;
  }
  return false;
}

/**
 * Relevance of a product/keyword title to the store niche (0–1).
 * Handles ES plurals (mates↔mate) and keyword substring hits.
 */
export function nicheRelevance(title: string, input: NicheInput): number {
  const niche = nicheTokenSet(input);
  if (niche.size === 0) return 1;

  const titleNorm = normalizeProductName(title);
  if (!titleNorm) return 0;

  const keywords = normalizeNicheKeywords(input.keywords);
  for (const kw of keywords) {
    if (keywordHitsTitle(kw, titleNorm)) return 1;
  }

  // Description-only niches: any stemmed niche token appearing in the title
  for (const t of niche) {
    if (t.length >= 3 && titleNorm.includes(t)) return 0.85;
  }

  const titleTokens = tokens(title);
  const jac = jaccard(titleTokens, niche);
  let hit = 0;
  for (const t of titleTokens) {
    if (niche.has(t)) hit += 1;
  }
  const coverage =
    titleTokens.size === 0
      ? 0
      : hit / Math.min(titleTokens.size, Math.max(niche.size, 1));
  return Math.max(jac, coverage);
}

export function passesNicheFilter(title: string, input: NicheInput): boolean {
  if (!hasNicheSignal(input)) return true;
  return nicheRelevance(title, input) >= NICHE_RELEVANCE_MIN;
}
