import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** "23630" -> "23,6 mil"; used for Facebook page like counts. */
export function formatCompactNumber(n: number): string {
  return new Intl.NumberFormat("es-AR", { notation: "compact" }).format(n)
}
