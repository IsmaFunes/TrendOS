/**
 * Manual / simulated social signals provider.
 * Contract is ready for TikTok, Instagram, YouTube, Reddit adapters.
 */

import type {
  CollectResult,
  SocialSignalInput,
  SocialSignalsProvider,
} from "../contracts";
import type { DataSource } from "../validators";

const FUTURE_SOCIAL_SOURCES: DataSource[] = [
  "tiktok",
  "instagram",
  "youtube",
  "reddit",
];

export function createManualSocialSignalsProvider(): SocialSignalsProvider {
  return {
    source: "manual_social",
    async ingest(
      signals: SocialSignalInput[],
    ): Promise<CollectResult<SocialSignalInput>> {
      const items: SocialSignalInput[] = [];
      const errors: CollectResult<SocialSignalInput>["errors"] = [];

      for (const signal of signals) {
        if (!signal.productId) {
          errors.push({
            message: "productId required",
            errorType: "validation",
          });
          continue;
        }
        items.push({
          ...signal,
          source: signal.source || "manual_social",
          capturedAt: signal.capturedAt ?? Date.now(),
        });
      }

      return {
        items,
        errors,
        partial: errors.length > 0,
      };
    },
  };
}

/**
 * Stub factories for future social providers — implement APIs behind the same contract.
 */
export function createFutureSocialProviderStub(
  source: (typeof FUTURE_SOCIAL_SOURCES)[number],
): SocialSignalsProvider {
  return {
    source,
    async ingest(): Promise<CollectResult<SocialSignalInput>> {
      return {
        items: [],
        errors: [
          {
            message: `${source} provider not configured yet`,
            errorType: "not_implemented",
          },
        ],
        partial: true,
      };
    },
  };
}

export { FUTURE_SOCIAL_SOURCES };
