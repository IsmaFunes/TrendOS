/**
 * Seasonality scoring based on configurable events (not hardcoded dates in callers).
 */

export type SeasonalEvent = {
  name: string;
  slug: string;
  country: string;
  month: number; // 1–12
  dayStart?: number;
  dayEnd?: number;
  windowDays: number;
  intensity: number; // 0–1
  isActive: boolean;
};

/**
 * Returns 0–1 seasonality intensity for a given date and country.
 */
export function seasonalityAt(
  events: SeasonalEvent[],
  atMs: number,
  country: string,
): { score: number; matchedEvents: string[] } {
  const date = new Date(atMs);
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const matched: string[] = [];
  let maxIntensity = 0;

  for (const event of events) {
    if (!event.isActive) continue;
    if (event.country !== country && event.country !== "*") continue;

    const inMonth = event.month === month;
    if (!inMonth) continue;

    if (event.dayStart != null && event.dayEnd != null) {
      const inWindow =
        day >= event.dayStart - event.windowDays &&
        day <= event.dayEnd + event.windowDays;
      if (!inWindow) continue;
    } else {
      // Whole-month events (e.g. summer / winter labels).
      // Still apply intensity at reduced strength outside a mid-month focus.
    }

    matched.push(event.name);
    maxIntensity = Math.max(maxIntensity, event.intensity);
  }

  return { score: maxIntensity, matchedEvents: matched };
}

export const DEFAULT_AR_SEASONAL_EVENTS: Omit<
  SeasonalEvent,
  "isActive"
>[] = [
  {
    name: "Navidad",
    slug: "navidad",
    country: "AR",
    month: 12,
    dayStart: 15,
    dayEnd: 25,
    windowDays: 10,
    intensity: 0.9,
  },
  {
    name: "Día de la Madre",
    slug: "dia-madre",
    country: "AR",
    month: 10,
    dayStart: 15,
    dayEnd: 21,
    windowDays: 7,
    intensity: 0.75,
  },
  {
    name: "Día del Padre",
    slug: "dia-padre",
    country: "AR",
    month: 6,
    dayStart: 15,
    dayEnd: 21,
    windowDays: 7,
    intensity: 0.7,
  },
  {
    name: "Inicio de clases",
    slug: "inicio-clases",
    country: "AR",
    month: 3,
    dayStart: 1,
    dayEnd: 15,
    windowDays: 5,
    intensity: 0.65,
  },
  {
    name: "Verano",
    slug: "verano",
    country: "AR",
    month: 1,
    windowDays: 15,
    intensity: 0.45,
  },
  {
    name: "Invierno",
    slug: "invierno",
    country: "AR",
    month: 7,
    windowDays: 15,
    intensity: 0.4,
  },
  {
    name: "Hot Sale",
    slug: "hot-sale",
    country: "AR",
    month: 5,
    dayStart: 10,
    dayEnd: 20,
    windowDays: 3,
    intensity: 0.8,
  },
  {
    name: "Cyber Monday",
    slug: "cyber-monday",
    country: "AR",
    month: 11,
    dayStart: 1,
    dayEnd: 10,
    windowDays: 3,
    intensity: 0.85,
  },
];
