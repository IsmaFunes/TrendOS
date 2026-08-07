/**
 * Product name normalization for Trend Radar matching.
 * Pure functions — unit-testable, no Convex deps.
 */

const COMMERCIAL_NOISE = new Set([
  "oferta",
  "nuevo",
  "nueva",
  "envio",
  "gratis",
  "mas",
  "vendido",
  "original",
  "imperdible",
  "promo",
  "promocion",
  "cuotas",
  "oficial",
  "garantia",
  "stock",
  "disponible",
  "envio gratis",
  "mas vendido",
]);

const STOP_WORDS = new Set([
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
  "por",
  "sin",
]);

/** Common synonym groups (first token is preferred). */
const SYNONYM_MAP: Record<string, string> = {
  aspiradora: "aspiradora",
  vacuum: "aspiradora",
  "car vacuum": "aspiradora",
  inalambrica: "inalambrica",
  wireless: "inalambrica",
  cordless: "inalambrica",
  usb: "usb",
  portatil: "portatil",
  portable: "portatil",
  auto: "auto",
  coche: "auto",
  carro: "auto",
  car: "auto",
  cargador: "cargador",
  charger: "cargador",
  auriculares: "auriculares",
  headphones: "auriculares",
  earbuds: "auriculares",
};

const UNIT_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/\b(\d+)\s*mAh\b/gi, "$1mah"],
  [/\b(\d+)\s*w\b/gi, "$1w"],
  [/\b(\d+)\s*v\b/gi, "$1v"],
  [/\b(\d+)\s*kg\b/gi, "$1kg"],
  [/\b(\d+)\s*g\b/gi, "$1g"],
  [/\b(\d+)\s*ml\b/gi, "$1ml"],
  [/\b(\d+)\s*l\b/gi, "$1l"],
  [/\b(\d+)\s*cm\b/gi, "$1cm"],
  [/\b(\d+)\s*mm\b/gi, "$1mm"],
  [/\b(\d+)\s*pulgadas?\b/gi, '$1"'],
  [/\b(\d+)\s*inch(?:es)?\b/gi, '$1"'],
];

export function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

export function normalizeUnits(text: string): string {
  let out = text;
  for (const [pattern, replacement] of UNIT_NORMALIZATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function normalizeProductText(name: string): string {
  let text = name.toLowerCase().trim();
  text = stripAccents(text);
  text = normalizeUnits(text);
  text = text.replace(/[^a-z0-9\s"]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export function tokenizeProductName(name: string): string[] {
  const normalized = normalizeProductText(name);
  const tokens: string[] = [];
  for (const raw of normalized.split(" ")) {
    if (!raw || raw.length < 2) continue;
    if (STOP_WORDS.has(raw)) continue;
    if (COMMERCIAL_NOISE.has(raw)) continue;
    const synonym = SYNONYM_MAP[raw] ?? raw;
    if (COMMERCIAL_NOISE.has(synonym)) continue;
    tokens.push(synonym);
  }
  return tokens;
}

/** Drops pure-digit tokens (ad-copy price/quantity noise like "45"/"000"
 *  from "$45.000") — unit-suffixed tokens ("1l", "45cm") are alnum and
 *  already unaffected. */
export function stripNumericNoiseTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !/^\d+$/.test(t));
}

export function normalizeAlias(alias: string): string {
  return tokenizeProductName(alias).join(" ");
}

export function slugifyProductName(name: string): string {
  const slug = normalizeAlias(name).replace(/\s+/g, "-").slice(0, 80);
  return slug || "producto";
}

export type BrandModelGuess = {
  brand?: string;
  model?: string;
  residualTokens: string[];
};

const KNOWN_BRANDS = new Set([
  "xiaomi",
  "samsung",
  "apple",
  "sony",
  "lg",
  "philips",
  "bosch",
  "makita",
  "dewalt",
  "baseus",
  "anker",
  "jbl",
  "logitech",
  "hp",
  "lenovo",
  "dell",
]);

/**
 * Lightweight brand/model detection — not authoritative.
 * Prefer structured API fields when available.
 */
export function detectBrandModel(name: string): BrandModelGuess {
  const tokens = tokenizeProductName(name);
  let brand: string | undefined;
  const residual: string[] = [];
  for (const t of tokens) {
    if (!brand && KNOWN_BRANDS.has(t)) {
      brand = t;
      continue;
    }
    residual.push(t);
  }
  // Model heuristic: alphanumeric token with a digit after brand.
  let model: string | undefined;
  const remaining: string[] = [];
  for (const t of residual) {
    if (!model && /\d/.test(t) && /[a-z]/.test(t)) {
      model = t;
      continue;
    }
    remaining.push(t);
  }
  return { brand, model, residualTokens: remaining };
}

export function comparableTokens(name: string): Set<string> {
  return new Set(tokenizeProductName(name));
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function textSimilarity(a: string, b: string): number {
  const na = normalizeAlias(a);
  const nb = normalizeAlias(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return Math.min(0.95, 0.7 + (shorter / longer) * 0.25);
  }
  return jaccardSimilarity(comparableTokens(a), comparableTokens(b));
}
