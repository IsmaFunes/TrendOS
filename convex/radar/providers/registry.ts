/**
 * Trend Radar source registry.
 * Fail-closed: sources without credentials are reported disabled, never mocked.
 * MVP default: meta_ad_library only (no Gemini/SerpAPI in the hot path).
 */

import type { DataSource } from "../validators";

export type SourceRole = "discovery" | "attention" | "commerce" | "sourcing";

export type SourceDefinition = {
  id: DataSource;
  role: SourceRole;
  /** Env keys that must be present for this source to be usable in live jobs. */
  requiredEnv?: string[];
  /** Alternative: any of these env groups unlocks the source. */
  anyEnvGroup?: string[][];
};

const SOURCE_CATALOG: SourceDefinition[] = [
  {
    id: "meta_ad_library",
    role: "attention",
  },
  {
    id: "google_trends",
    role: "discovery",
    requiredEnv: ["SERPAPI_API_KEY"],
  },
  {
    id: "gemini_research",
    role: "attention",
    requiredEnv: ["GEMINI_API_KEY"],
  },
  {
    id: "google_ads",
    role: "attention",
    requiredEnv: ["GEMINI_API_KEY"],
  },
  {
    id: "manual_social",
    role: "attention",
  },
  {
    id: "tiktok",
    role: "attention",
  },
  {
    id: "instagram",
    role: "attention",
  },
  {
    id: "youtube",
    role: "attention",
  },
  {
    id: "mercadolibre",
    role: "commerce",
    anyEnvGroup: [
      ["MERCADOLIBRE_ACCESS_TOKEN"],
      [
        "MERCADOLIBRE_CLIENT_ID",
        "MERCADOLIBRE_CLIENT_SECRET",
        "MERCADOLIBRE_REFRESH_TOKEN",
      ],
    ],
  },
  {
    id: "aliexpress",
    role: "commerce",
    anyEnvGroup: [
      ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET", "ALIEXPRESS_ACCESS_TOKEN"],
    ],
  },
  {
    id: "made_in_china",
    role: "sourcing",
  },
  {
    id: "alibaba",
    role: "sourcing",
  },
  {
    id: "wholesale",
    role: "sourcing",
  },
];

/** MVP: Meta Ad Library scrape only — no paid Gemini/SerpAPI by default. */
const DEFAULT_SOURCES = "meta_ad_library";

function envPresent(key: string): boolean {
  const v = process.env[key];
  return typeof v === "string" && v.trim().length > 0;
}

function isSourceConfigured(def: SourceDefinition): boolean {
  if (def.anyEnvGroup && def.anyEnvGroup.length > 0) {
    return def.anyEnvGroup.some((group) => group.every((k) => envPresent(k)));
  }
  if (!def.requiredEnv || def.requiredEnv.length === 0) return true;
  return def.requiredEnv.every((k) => envPresent(k));
}

export function parseEnabledSourceIds(
  raw: string | undefined,
): DataSource[] {
  const value = (raw ?? process.env.TREND_RADAR_SOURCES ?? DEFAULT_SOURCES)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set(SOURCE_CATALOG.map((s) => s.id));
  return value.filter((id): id is DataSource => known.has(id as DataSource));
}

export type ResolvedSource = SourceDefinition & {
  enabled: boolean;
  configured: boolean;
  usable: boolean;
  missingEnv: string[];
};

function missingEnvFor(def: SourceDefinition): string[] {
  if (def.anyEnvGroup && def.anyEnvGroup.length > 0) {
    if (isSourceConfigured(def)) return [];
    return def.anyEnvGroup[0] ?? [];
  }
  if (!def.requiredEnv) return [];
  return def.requiredEnv.filter((k) => !envPresent(k));
}

export function resolveSources(
  enabledIds?: DataSource[],
): ResolvedSource[] {
  const enabled = new Set(enabledIds ?? parseEnabledSourceIds(undefined));
  return SOURCE_CATALOG.map((def) => {
    const isEnabled = enabled.has(def.id);
    const configured = isSourceConfigured(def);
    return {
      ...def,
      enabled: isEnabled,
      configured,
      usable: isEnabled && configured,
      missingEnv: missingEnvFor(def),
    };
  });
}

export function usableSources(role?: SourceRole): ResolvedSource[] {
  return resolveSources().filter(
    (s) => s.usable && (role === undefined || s.role === role),
  );
}

export function expectedSourceCount(): number {
  return usableSources().length;
}

export function expectedRoleCount(): number {
  return new Set(usableSources().map((s) => s.role)).size;
}

export function requireUsableSource(id: DataSource): ResolvedSource {
  const found = resolveSources().find((s) => s.id === id);
  if (!found) {
    throw new Error(`Unknown source: ${id}`);
  }
  if (!found.enabled) {
    throw new Error(`Source ${id} is not enabled in TREND_RADAR_SOURCES`);
  }
  if (!found.configured) {
    const need =
      found.requiredEnv?.join(", ") ??
      found.anyEnvGroup?.map((g) => g.join("+")).join(" | ") ??
      "credentials";
    throw new Error(`Source ${id} missing credentials (${need})`);
  }
  return found;
}

export function roleForSource(source: DataSource): SourceRole | null {
  const def = SOURCE_CATALOG.find((s) => s.id === source);
  if (def) return def.role;
  // Historical agent tags
  switch (source) {
    case "trends_agent":
      return "discovery";
    case "discovery_agent":
    case "google_ads":
    case "gemini_research":
      return "attention";
    case "commerce_agent":
      return "commerce";
    case "sourcing_agent":
      return "sourcing";
    default:
      return null;
  }
}

export function requireGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error("GEMINI_API_KEY is required for this source");
  }
  return key;
}

export function requireSerpApiTrends(): string {
  const provider = process.env.GOOGLE_TRENDS_PROVIDER?.trim().toLowerCase();
  if (provider === "mock") {
    throw new Error("GOOGLE_TRENDS_PROVIDER=mock is not allowed");
  }
  const key =
    process.env.SERPAPI_API_KEY?.trim() ||
    process.env.GOOGLE_TRENDS_API_KEY?.trim();
  if (!key) {
    throw new Error("SERPAPI_API_KEY is required for Google Trends");
  }
  return key;
}
