export type MlCatalogItem = {
  mlId: string;
  title: string;
  position: number;
};

export type WebDiscoveryItem = {
  webProductName: string;
  webBuzz: number;
  signals: string[];
  sources: string[];
  rationale: string;
};

export type LinkedWebProduct = WebDiscoveryItem & {
  mlId?: string;
  mlTitle?: string;
  matchConfidence: number;
};

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
]);

export function normalizeProductName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function webProductKey(name: string): string {
  const slug = normalizeProductName(name).replace(/\s+/g, "-").slice(0, 64);
  return `WEB-${slug || "unknown"}`;
}

function tokens(name: string): Set<string> {
  const out = new Set<string>();
  for (const t of normalizeProductName(name).split(" ")) {
    if (t.length < 2 || STOP.has(t)) continue;
    out.add(t);
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

/**
 * Local title match (no LLM). Returns confidence 0–1.
 */
export function matchConfidence(webName: string, mlTitle: string): number {
  const a = normalizeProductName(webName);
  const b = normalizeProductName(mlTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return Math.min(0.95, 0.7 + (shorter / longer) * 0.25);
  }
  const jac = jaccard(tokens(webName), tokens(mlTitle));
  if (jac >= 0.5) return Math.min(0.92, 0.55 + jac * 0.4);
  if (jac >= 0.35) return 0.45 + jac * 0.3;
  return jac;
}

/**
 * Attach each web discovery to at most one ML item (best unused match ≥ threshold).
 */
export function linkWebToMlCatalog(
  webProducts: WebDiscoveryItem[],
  mlCatalog: MlCatalogItem[],
  minConfidence = 0.55,
): LinkedWebProduct[] {
  const usedMl = new Set<string>();
  const ranked = [...webProducts].sort((a, b) => b.webBuzz - a.webBuzz);

  return ranked.map((web) => {
    let best: { ml: MlCatalogItem; conf: number } | null = null;
    for (const ml of mlCatalog) {
      if (usedMl.has(ml.mlId)) continue;
      const conf = matchConfidence(web.webProductName, ml.title);
      if (!best || conf > best.conf) best = { ml, conf };
    }
    if (best && best.conf >= minConfidence) {
      usedMl.add(best.ml.mlId);
      return {
        ...web,
        mlId: best.ml.mlId,
        mlTitle: best.ml.title,
        matchConfidence: best.conf,
      };
    }
    return { ...web, matchConfidence: best?.conf ?? 0 };
  });
}
