/**
 * Heuristic gates so AR niche feeds don't fill with apps / foreign-language noise.
 */

const APP_DESTINATION_RE =
  /(^|\.)(play\.google\.com|apps\.apple\.com|itunes\.apple\.com|appgallery\.huawei\.com|apkpure\.com|aptoide\.com|microsoft\.com\/.*(store|apps))/i;

const APP_COPY_RE =
  /\b(google play|app store|descargá la app|descarga la app|download the app|install now|disponible en play|get it on google)\b/i;

/** Common English ad/copy markers (fitness, apps, general EN creatives). */
const EN_MARKERS =
  /\b(you're|you are|you will|workout|treadmill|shadowboxing|download|free shipping|shop now|limited time|click here|subscribe|watch now|episode|drama short)\b/i;

/** Italian / other Romance noise that shows up in Ad Library for loose queries. */
const IT_MARKERS =
  /\b(perché|perche|macchina cnc|fresatrice|acquista ora|spedizione gratuita|solo oggi|clicca qui|offerta lampo)\b/i;

/** Rioplatense / AR ecommerce Spanish signals. */
const ES_MARKERS =
  /\b(env[ií]o|cuotas|gratis|argentina|compr[aá]|llev[aá]|tienda|oferta|pesos|mercadolibre|tiendanube|bombilla|matero|materos|termo|termos|mate)\b/i;

/** Lowercase + strip accents, for accent-insensitive substring matching. */
export function normalizeForSubstringMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function normalizeWords(text: string): string[] {
  const norm = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  return norm.split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * ES plural variants. Spanish pluralizes differently depending on the last
 * letter: vowel-ending words just add "s" (mate→mates, termo→termos), but
 * consonant-ending words add "es" (sartén→sartenes, color→colores,
 * reloj→relojes) — a real product word like "sarten" was previously only
 * ever stemmed to "sartens", which never matches how sellers actually write
 * "sartenes" in ad copy, silently rejecting otherwise-relevant ads.
 */
function stemWord(word: string): string[] {
  const variants = new Set<string>([word]);
  const endsInVowel = /[aeiou]$/.test(word);
  if (word.length > 3 && word.endsWith("es") && !endsInVowel) {
    variants.add(word.slice(0, -2)); // sartenes -> sarten
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("es") && !word.endsWith("ss")) {
    variants.add(word.slice(0, -1)); // termos -> termo
  }
  if (word.length >= 3 && !word.endsWith("s")) {
    variants.add(endsInVowel ? `${word}s` : `${word}es`); // termo -> termos, sarten -> sartenes
  }
  return [...variants];
}

function creativeWordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeWords(text)) {
    if (w.length >= 2) out.add(w);
  }
  return out;
}

/**
 * True when every significant (>=3 char) word of `keyword` is present as a
 * whole word (allowing ES plural variants) in `hay`. Single-word keywords
 * still need a single whole-word hit; multi-word keywords/scrapeTerms need
 * every word present, mirroring Meta's own keyword_unordered AND semantics
 * instead of matching on any one word alone.
 */
function keywordPhraseMatches(keyword: string, hay: Set<string>): boolean {
  const words = normalizeWords(keyword).filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  return words.every((w) => stemWord(w).some((variant) => hay.has(variant)));
}

/**
 * Whole-word, phrase-aware overlap between `text` and any of `keywords`.
 * Deliberately NOT a substring check — "tomate" must not match keyword
 * "mate" just because one contains the other as a run of characters.
 */
export function hasNicheKeywordOverlap(
  text: string,
  keywords: string[],
): boolean {
  if (keywords.length === 0) return true;
  const hay = creativeWordSet(text);
  return keywords.some((kw) => keywordPhraseMatches(kw, hay));
}

export function isAppOrInstallAd(input: {
  destinationUrl?: string;
  pageName?: string;
  body?: string;
}): boolean {
  const dest = input.destinationUrl ?? "";
  if (APP_DESTINATION_RE.test(dest)) return true;
  const blob = `${input.pageName ?? ""} ${input.body ?? ""} ${dest}`;
  if (APP_COPY_RE.test(blob)) return true;
  if (/play\.google\.com/i.test(blob) || /apps\.apple\.com/i.test(blob)) {
    return true;
  }
  return false;
}

/**
 * True when copy looks clearly foreign (EN/IT) for an AR Spanish niche,
 * unless niche keywords already appear in the creative.
 */
export function isForeignLanguageNoise(
  text: string,
  keywords: string[],
): boolean {
  if (hasNicheKeywordOverlap(text, keywords)) return false;
  const hasEs = ES_MARKERS.test(text);
  const hasEn = EN_MARKERS.test(text);
  const hasIt = IT_MARKERS.test(text);
  if ((hasEn || hasIt) && !hasEs) return true;
  // Heavy EN even with weak ES crumbs
  if (hasEn && !hasEs) return true;
  return false;
}

export type NicheAdGateInput = {
  pageName: string;
  body?: string;
  destinationUrl?: string;
  searchTerm?: string;
  mediaUrls: string[];
};

/**
 * Gate for linking into a niche + showing in the feed.
 * Requires displayable creative, not an app install, Spanish/niche-fit.
 */
export function passesNicheAdGate(
  ad: NicheAdGateInput,
  nicheKeywords: string[],
): boolean {
  if (!ad.mediaUrls.some((u) => /^https?:\/\//i.test(u))) return false;
  const body = ad.body?.trim();
  if (!body || /\{\{\s*[\w.]+\s*\}\}/.test(body)) return false;
  if (!ad.pageName.trim() || ad.pageName === "Unknown page") return false;
  if (isAppOrInstallAd(ad)) return false;

  // Do NOT use searchTerm for fit: Meta often returns off-niche ads for a query.
  const creative = `${ad.pageName} ${body} ${ad.destinationUrl ?? ""}`;
  if (isForeignLanguageNoise(creative, nicheKeywords)) return false;

  // Require niche tokens in the creative itself (page/body/dest).
  if (
    nicheKeywords.length > 0 &&
    !hasNicheKeywordOverlap(creative, nicheKeywords)
  ) {
    return false;
  }

  return true;
}
