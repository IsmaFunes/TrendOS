/**
 * Pure helpers for concrete product + clickable evidence gating.
 */

import { normalizeAlias } from "./normalize";

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True when the name looks like a concrete sellable product, not a bare keyword
 * or media/celebrity noise that Trends related-queries often produce.
 */
export function isConcreteProductName(
  name: string,
  seedTerm?: string,
): boolean {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length < 10) return false;
  if (seedTerm && normalizeAlias(trimmed) === normalizeAlias(seedTerm)) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  const blocked = [
    "manhwa",
    "museo",
    "huawei mate",
    "iphone",
    "samsung galaxy",
    "ferran torres",
    "me case con",
    "dragona",
  ];
  if (blocked.some((b) => lower.includes(b))) return false;
  return trimmed.split(/\s+/).length >= 2;
}

/** Stable id from a URL for evidence listings (no marketplace SKU required). */
export function evidenceExternalId(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) {
    h = (h * 31 + url.charCodeAt(i)) | 0;
  }
  return `ev_${(h >>> 0).toString(16)}_${url.length}`;
}
