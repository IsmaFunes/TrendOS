/** Shared labels / formatters for product UI (legacy radar screens). */

export function classificationLabel(c: string): string {
  switch (c) {
    case "EMERGING":
      return "En alza";
    case "CONFIRMED":
      return "Confirmado";
    case "SATURATING":
      return "Saturando";
    case "FALSE_SIGNAL":
      return "Señal débil";
    case "SEASONAL":
      return "Estacional";
    case "INSUFFICIENT_DATA":
      return "Pocos datos";
    default:
      return c;
  }
}

export function classificationTone(c: string): string {
  switch (c) {
    case "EMERGING":
      return "text-accent";
    case "CONFIRMED":
      return "text-foreground";
    case "SATURATING":
    case "FALSE_SIGNAL":
      return "text-danger";
    default:
      return "text-muted";
  }
}

export function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: n >= 100 ? 0 : 2,
  }).format(n);
}

export function formatMarginPct(margin: number | null | undefined): string {
  if (margin == null || !Number.isFinite(margin)) return "—";
  return `${Math.round(margin * 100)}%`;
}
