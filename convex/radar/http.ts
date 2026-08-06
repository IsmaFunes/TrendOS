/**
 * HTTP helpers with timeout, exponential backoff, and rate-limit awareness.
 * Used by collectors — never logs secrets.
 */

export type FetchJsonOptions = {
  url: string;
  /** @default "GET" */
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Called before each attempt (for rate limiting). */
  beforeAttempt?: () => Promise<void>;
};

export type FetchJsonResult<T> =
  | { ok: true; data: T; status: number; attempts: number }
  | {
      ok: false;
      errorType: string;
      status?: number;
      attempts: number;
      message: string;
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJsonWithRetry<T>(
  options: FetchJsonOptions,
): Promise<FetchJsonResult<T>> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxAttempts = options.maxAttempts ?? 4;
  let lastMessage = "unknown";
  let lastStatus: number | undefined;
  let lastErrorType = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.beforeAttempt) {
      await options.beforeAttempt();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(options.url, {
        method: options.method,
        body: options.body,
        headers: options.headers,
        signal: controller.signal,
      });
      lastStatus = res.status;

      if (res.status === 429 || res.status >= 500) {
        lastErrorType =
          res.status === 429 ? "rate_limit" : "temporary_error";
        lastMessage = `HTTP ${res.status}`;
        // Consume body without logging secrets
        await res.text().catch(() => "");
        const backoff = Math.min(8_000, 400 * 2 ** (attempt - 1));
        await sleep(backoff);
        continue;
      }

      if (res.status === 404) {
        return {
          ok: false,
          errorType: "not_found",
          status: 404,
          attempts: attempt,
          message: "Resource not found",
        };
      }

      if (!res.ok) {
        await res.text().catch(() => "");
        return {
          ok: false,
          errorType: "http_error",
          status: res.status,
          attempts: attempt,
          message: `HTTP ${res.status}`,
        };
      }

      const data = (await res.json()) as T;
      return { ok: true, data, status: res.status, attempts: attempt };
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("abort"));
      lastErrorType = isAbort ? "timeout" : "network_error";
      lastMessage = err instanceof Error ? err.message : "fetch failed";
      const backoff = Math.min(8_000, 400 * 2 ** (attempt - 1));
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    errorType: lastErrorType,
    status: lastStatus,
    attempts: maxAttempts,
    message: lastMessage,
  };
}

/** Simple in-memory token bucket for a single isolate. */
export function createRateLimiter(maxPerMinute: number) {
  const timestamps: number[] = [];
  return async function acquire(): Promise<void> {
    const now = Date.now();
    while (timestamps.length && now - timestamps[0]! > 60_000) {
      timestamps.shift();
    }
    if (timestamps.length >= maxPerMinute) {
      const wait = 60_000 - (now - timestamps[0]!) + 50;
      await sleep(Math.max(50, wait));
    }
    timestamps.push(Date.now());
  };
}

export function structuredLog(fields: {
  jobId?: string;
  source?: string;
  externalId?: string;
  productId?: string;
  duration?: number;
  attempt?: number;
  errorType?: string;
  message?: string;
  level?: "info" | "warn" | "error";
}): void {
  const level = fields.level ?? (fields.errorType ? "error" : "info");
  const payload = {
    module: "trend-radar",
    ...fields,
  };
  if (level === "error") console.error(JSON.stringify(payload));
  else if (level === "warn") console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}
