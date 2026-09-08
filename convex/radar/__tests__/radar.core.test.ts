import { describe, expect, it } from "vitest";
import {
  normalizeScrapeTerms,
  parseRankingResponse,
} from "../geminiAdsCore";
import {
  isAppOrInstallAd,
  isForeignLanguageNoise,
  passesNicheAdGate,
} from "../adRelevance";
import {
  normalizeAlias,
  normalizeProductText,
  slugifyProductName,
  textSimilarity,
  tokenizeProductName,
} from "../normalize";
import { matchListingToProduct } from "../matching";
import {
  acceleration,
  growth,
  reviewsVelocity,
  salesVelocity,
  velocity,
  clampScore,
  normalizeGrowthToScore,
  periodKeyFromTs,
} from "../metrics";
import {
  classifyOpportunity,
  computeConfidence,
  computeOpportunityScore,
} from "../scoring";
import { calculateLogisticsScore, calculateMargin } from "../logistics";
import { runBacktest } from "../backtest";
import {
  computeFeaturesFromSnapshots,
  saturationFromFeatures,
} from "../features";

describe("normalize", () => {
  it("lowercases, strips accents and commercial noise", () => {
    const tokens = tokenizeProductName(
      "Mini Aspiradora AUTO Oferta Envío Gratis USB",
    );
    expect(tokens).toContain("aspiradora");
    expect(tokens).toContain("auto");
    expect(tokens).toContain("usb");
    expect(tokens).not.toContain("oferta");
    expect(tokens).not.toContain("gratis");
  });

  it("normalizes aliases for synonym grouping", () => {
    const a = normalizeAlias("aspiradora portátil USB");
    const b = normalizeAlias("aspiradora inalámbrica para coche");
    const c = normalizeAlias("car vacuum cleaner");
    expect(a).toContain("aspiradora");
    expect(b).toContain("aspiradora");
    expect(c).toContain("aspiradora");
    expect(textSimilarity(a, b)).toBeGreaterThanOrEqual(0.2);
  });

  it("slugifies product names", () => {
    expect(slugifyProductName("Mini Aspiradora Auto!")).toMatch(/aspiradora/);
  });

  it("normalizeProductText removes symbols", () => {
    expect(normalizeProductText("Foo!!! Bar")).toBe("foo bar");
  });
});

describe("matching", () => {
  const candidates = [
    {
      productId: "p1",
      canonicalName: "Mini aspiradora auto USB",
      aliases: ["aspiradora portátil USB", "car vacuum cleaner"],
      brand: "baseus",
      model: "a3",
    },
  ];

  it("matches exact alias", () => {
    const result = matchListingToProduct(
      {
        source: "mercadolibre",
        externalId: "MLA1",
        title: "aspiradora portátil USB",
      },
      candidates,
    );
    expect(result.productId).toBe("p1");
    expect(result.method).toBe("alias");
    expect(result.requiresManualReview).toBe(false);
  });

  it("queues manual review on medium similarity", () => {
    const result = matchListingToProduct(
      {
        source: "mercadolibre",
        externalId: "MLA2",
        title: "aspiradora coche usb oferta",
      },
      candidates,
    );
    expect(result.confidence).toBeGreaterThan(0.4);
    if (result.confidence < 0.85) {
      expect(
        result.requiresManualReview || result.method === "text_similarity",
      ).toBe(true);
    }
  });

  it("does not match unrelated products", () => {
    const result = matchListingToProduct(
      {
        source: "mercadolibre",
        externalId: "MLA3",
        title: "zapatillas running nike air",
      },
      candidates,
    );
    expect(result.productId).toBeUndefined();
  });
});

describe("metrics", () => {
  it("growth handles null and zero previous", () => {
    expect(growth(10, null)).toBeNull();
    expect(growth(null, 10)).toBeNull();
    expect(growth(10, 0)).toBeNull();
    expect(growth(0, 0)).toBe(0);
    expect(growth(120, 100)).toBeCloseTo(0.2);
  });

  it("velocity mirrors growth", () => {
    expect(velocity(110, 100)).toBeCloseTo(0.1);
    expect(velocity(undefined, 10)).toBeNull();
  });

  it("acceleration is difference of velocities", () => {
    expect(acceleration(0.2, 0.1)).toBeCloseTo(0.1);
    expect(acceleration(0.2, null)).toBeNull();
  });

  it("reviews and sales velocity are absolute deltas", () => {
    expect(reviewsVelocity(50, 40)).toBe(10);
    expect(reviewsVelocity(50, null)).toBeNull();
    expect(salesVelocity(200, 150)).toBe(50);
    expect(salesVelocity(null, 10)).toBeNull();
  });

  it("normalizes scores into 0–100", () => {
    expect(clampScore(150)).toBe(100);
    expect(clampScore(-10)).toBe(0);
    expect(normalizeGrowthToScore(1)).toBe(100);
    expect(normalizeGrowthToScore(null)).toBe(0);
  });
});

describe("scoring", () => {
  it("computes opportunity score with explanation", () => {
    const result = computeOpportunityScore({
      demandGrowth: 0.4,
      demandAcceleration: 0.15,
      crossSourceConfirmation: 0.66,
      demandSupplyGap: 0.3,
      salesOrReviewsVelocity: 25,
      estimatedMargin: 0.35,
      logisticsScore: 80,
      saturation: 0.1,
      seasonality: 0.05,
      regulatoryRisk: 0.05,
      dataQuality: 0.8,
      sourceCount: 3,
      historyDays: 30,
    });
    expect(result.score).toBeGreaterThan(50);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.explanation.positiveFactors.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("penalizes single source and saturation", () => {
    const low = computeOpportunityScore({
      demandGrowth: 0.5,
      demandAcceleration: 0.2,
      crossSourceConfirmation: 0.2,
      demandSupplyGap: 0.2,
      salesOrReviewsVelocity: 10,
      estimatedMargin: 0.2,
      logisticsScore: 70,
      saturation: 0.9,
      seasonality: 0.2,
      regulatoryRisk: 0.3,
      dataQuality: 0.3,
      sourceCount: 1,
      historyDays: 10,
    });
    expect(low.explanation.negativeFactors.length).toBeGreaterThan(0);
    expect(low.score).toBeLessThan(90);
  });

  it("classifies emerging / saturating / seasonal / false signal / insufficient", () => {
    expect(
      classifyOpportunity({
        score: 80,
        demandGrowth: 0.3,
        demandAcceleration: 0.1,
        saturation: 0.2,
        seasonality: 0.1,
        crossSourceConfirmation: 0.3,
        sourceCount: 2,
        historyDays: 14,
        salesOrReviewsVelocity: 5,
      }),
    ).toBe("EMERGING");

    expect(
      classifyOpportunity({
        score: 70,
        demandGrowth: 0.2,
        demandAcceleration: 0,
        saturation: 0.7,
        seasonality: 0.1,
        crossSourceConfirmation: 0.5,
        sourceCount: 2,
        historyDays: 20,
        salesOrReviewsVelocity: 5,
      }),
    ).toBe("SATURATING");

    expect(
      classifyOpportunity({
        score: 70,
        demandGrowth: 0.3,
        demandAcceleration: 0.1,
        saturation: 0.2,
        seasonality: 0.8,
        crossSourceConfirmation: 0.5,
        sourceCount: 2,
        historyDays: 20,
        salesOrReviewsVelocity: 5,
      }),
    ).toBe("SEASONAL");

    expect(
      classifyOpportunity({
        score: 60,
        demandGrowth: 0.4,
        demandAcceleration: 0.1,
        saturation: 0.1,
        seasonality: 0.1,
        crossSourceConfirmation: 0.1,
        sourceCount: 1,
        historyDays: 20,
        salesOrReviewsVelocity: -2,
      }),
    ).toBe("FALSE_SIGNAL");

    expect(
      classifyOpportunity({
        score: 50,
        demandGrowth: null,
        demandAcceleration: null,
        saturation: null,
        seasonality: null,
        crossSourceConfirmation: null,
        sourceCount: 0,
        historyDays: 2,
        salesOrReviewsVelocity: null,
      }),
    ).toBe("INSUFFICIENT_DATA");

    expect(
      classifyOpportunity({
        score: 55,
        demandGrowth: null,
        demandAcceleration: null,
        saturation: null,
        seasonality: null,
        crossSourceConfirmation: null,
        sourceCount: 1,
        historyDays: 0,
        salesOrReviewsVelocity: null,
        listingCount: 1,
        attentionBuzz: 70,
      }),
    ).toBe("EMERGING");
  });

  it("confidence rises with history and sources", () => {
    const low = computeConfidence({
      historyDays: 3,
      sourceCount: 1,
      expectedSources: 3,
      missingFieldRatio: 0.8,
      dataQuality: 0.2,
    });
    const high = computeConfidence({
      historyDays: 30,
      sourceCount: 3,
      expectedSources: 3,
      missingFieldRatio: 0.1,
      dataQuality: 0.9,
      listingCount: 10,
    });
    expect(high).toBeGreaterThan(low);
  });
});

describe("logistics and margin", () => {
  it("calculates margin and handles missing sale price", () => {
    const m = calculateMargin({
      estimatedSalePrice: 100,
      purchaseCost: 40,
      shippingCost: 10,
      taxCost: 5,
      platformFee: 10,
      packagingCost: 5,
    });
    expect(m.estimatedProfit).toBe(30);
    expect(m.estimatedMargin).toBeCloseTo(0.3);
    expect(calculateMargin({}).estimatedMargin).toBeNull();
  });

  it("penalizes heavy fragile hazardous goods", () => {
    const easy = calculateLogisticsScore({ weightKg: 0.2 });
    const hard = calculateLogisticsScore({
      weightKg: 20,
      widthCm: 80,
      heightCm: 60,
      depthCm: 40,
      fragility: 0.9,
      isHazardous: true,
      regulatoryRisk: 0.8,
    });
    expect(easy).toBeGreaterThan(hard);
  });
});

describe("snapshots idempotency helpers", () => {
  it("periodKey is stable per UTC day", () => {
    const a = periodKeyFromTs(Date.UTC(2026, 6, 23, 1));
    const b = periodKeyFromTs(Date.UTC(2026, 6, 23, 23));
    expect(a).toBe(b);
    expect(a).toBe("2026-07-23");
  });

  it("features ignore future snapshots (no leakage)", () => {
    const asOf = Date.UTC(2026, 6, 10);
    const rows = [
      {
        productId: "p",
        source: "mercadolibre" as const,
        capturedAt: asOf - 7 * 86400000,
        periodKey: "2026-07-03",
        soldQuantity: 100,
        searchInterest: 40,
      },
      {
        productId: "p",
        source: "mercadolibre" as const,
        capturedAt: asOf,
        periodKey: "2026-07-10",
        soldQuantity: 130,
        searchInterest: 55,
      },
      {
        productId: "p",
        source: "mercadolibre" as const,
        capturedAt: asOf + 7 * 86400000,
        periodKey: "2026-07-17",
        soldQuantity: 500,
        searchInterest: 99,
      },
    ];
    const features = computeFeaturesFromSnapshots(rows, 7, asOf);
    expect(features.demandGrowth).not.toBeNull();
    // Future spike must not dominate
    expect(features.demandGrowth!).toBeLessThan(2);
    expect(saturationFromFeatures(features)).toBeGreaterThanOrEqual(0);
  });

  it("separates attention vs commerce and confirms roles", () => {
    const asOf = Date.UTC(2026, 6, 20);
    const day = 86400000;
    const rows = [
      {
        productId: "p",
        source: "google_trends" as const,
        capturedAt: asOf - 7 * day,
        periodKey: "2026-07-13",
        searchInterest: 20,
      },
      {
        productId: "p",
        source: "google_trends" as const,
        capturedAt: asOf,
        periodKey: "2026-07-20",
        searchInterest: 40,
      },
      {
        productId: "p",
        source: "aliexpress" as const,
        capturedAt: asOf - 7 * day,
        periodKey: "2026-07-13",
        soldQuantity: 50,
      },
      {
        productId: "p",
        source: "aliexpress" as const,
        capturedAt: asOf,
        periodKey: "2026-07-20",
        soldQuantity: 80,
      },
      {
        productId: "p",
        source: "wholesale" as const,
        capturedAt: asOf,
        periodKey: "2026-07-20",
        price: 5,
      },
    ];
    const features = computeFeaturesFromSnapshots(rows, 7, asOf, {
      expectedSources: 3,
      expectedRoles: 3,
    });
    expect(features.attentionDemandGrowth).toBeGreaterThan(0);
    expect(features.commerceDemandGrowth).toBeGreaterThan(0);
    expect(features.confirmingRoles).toEqual(
      expect.arrayContaining(["attention", "commerce"]),
    );
    expect(features.confirmingSources).toEqual(
      expect.arrayContaining(["google_trends", "aliexpress"]),
    );
    expect(features.crossSourceConfirmation).toBeGreaterThan(0);
  });
});

describe("registry fail-closed", () => {
  it("requireSerpApiTrends rejects mock and missing key", async () => {
    const { requireSerpApiTrends } = await import("../providers/registry");
    const prevProvider = process.env.GOOGLE_TRENDS_PROVIDER;
    const prevKey = process.env.SERPAPI_API_KEY;
    const prevAlt = process.env.GOOGLE_TRENDS_API_KEY;
    try {
      process.env.GOOGLE_TRENDS_PROVIDER = "mock";
      delete process.env.SERPAPI_API_KEY;
      delete process.env.GOOGLE_TRENDS_API_KEY;
      expect(() => requireSerpApiTrends()).toThrow(/not allowed|mock/i);

      process.env.GOOGLE_TRENDS_PROVIDER = "serpapi";
      expect(() => requireSerpApiTrends()).toThrow(/SERPAPI_API_KEY/);
    } finally {
      if (prevProvider === undefined) delete process.env.GOOGLE_TRENDS_PROVIDER;
      else process.env.GOOGLE_TRENDS_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.SERPAPI_API_KEY;
      else process.env.SERPAPI_API_KEY = prevKey;
      if (prevAlt === undefined) delete process.env.GOOGLE_TRENDS_API_KEY;
      else process.env.GOOGLE_TRENDS_API_KEY = prevAlt;
    }
  });

  it("requireGeminiApiKey fails closed without key", async () => {
    const { requireGeminiApiKey } = await import("../providers/registry");
    const prev = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      expect(() => requireGeminiApiKey()).toThrow(/GEMINI_API_KEY/);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  it("default sources are meta_ad_library only (no paid APIs)", async () => {
    const { parseEnabledSourceIds, resolveSources } = await import(
      "../providers/registry"
    );
    const prev = process.env.TREND_RADAR_SOURCES;
    try {
      delete process.env.TREND_RADAR_SOURCES;
      const ids = parseEnabledSourceIds(undefined);
      expect(ids).toEqual(["meta_ad_library"]);
      expect(ids).not.toContain("aliexpress");
      expect(ids).not.toContain("google_ads");

      const meta = resolveSources().find((s) => s.id === "meta_ad_library");
      expect(meta?.usable).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TREND_RADAR_SOURCES;
      else process.env.TREND_RADAR_SOURCES = prev;
    }
  });

  it("resolveSources marks mercadolibre unusable without credentials", async () => {
    const { resolveSources } = await import("../providers/registry");
    const prev = {
      access: process.env.MERCADOLIBRE_ACCESS_TOKEN,
      id: process.env.MERCADOLIBRE_CLIENT_ID,
      secret: process.env.MERCADOLIBRE_CLIENT_SECRET,
      refresh: process.env.MERCADOLIBRE_REFRESH_TOKEN,
      sources: process.env.TREND_RADAR_SOURCES,
    };
    try {
      delete process.env.MERCADOLIBRE_ACCESS_TOKEN;
      delete process.env.MERCADOLIBRE_CLIENT_ID;
      delete process.env.MERCADOLIBRE_CLIENT_SECRET;
      delete process.env.MERCADOLIBRE_REFRESH_TOKEN;
      process.env.TREND_RADAR_SOURCES = "mercadolibre";
      const ml = resolveSources().find((s) => s.id === "mercadolibre");
      expect(ml?.enabled).toBe(true);
      expect(ml?.usable).toBe(false);
      expect(ml?.missingEnv.length).toBeGreaterThan(0);
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("MERCADOLIBRE_ACCESS_TOKEN", prev.access);
      restore("MERCADOLIBRE_CLIENT_ID", prev.id);
      restore("MERCADOLIBRE_CLIENT_SECRET", prev.secret);
      restore("MERCADOLIBRE_REFRESH_TOKEN", prev.refresh);
      restore("TREND_RADAR_SOURCES", prev.sources);
    }
  });
});

describe("china B2B light parse", () => {
  it("parses Made-in-China product anchors and JSON-LD", async () => {
    const { parseMadeInChinaHtml } = await import("../providers/chinaB2b");
    const html = `
      <script type="application/ld+json">
      {"@type":"Product","name":"USB Car Vacuum Cleaner","url":"https://www.made-in-china.com/product/usb-vac.html","offers":{"price":"4.50"}}
      </script>
      <a href="https://www.made-in-china.com/productdetail/mini-fan.html">Portable Mini Fan USB Rechargeable</a>
      <span>MOQ 10 US $ 2.10</span>
    `;
    const items = parseMadeInChinaHtml(html, 5);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((i) => /Vacuum|Fan/i.test(i.title))).toBe(true);
    expect(items.every((i) => i.source === "made_in_china")).toBe(true);
  });

  it("parses Alibaba product-detail links", async () => {
    const { parseAlibabaHtml } = await import("../providers/chinaB2b");
    const html = `
      <a href="https://www.alibaba.com/product-detail/Car-Vacuum_1600.html">Wireless Car Vacuum Cleaner Portable</a>
      US $ 3.99 Min. Order: 20
    `;
    const items = parseAlibabaHtml(html, 5);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]?.source).toBe("alibaba");
    expect(items[0]?.title).toMatch(/Vacuum/i);
  });
});

describe("gemini research parse", () => {
  it("parses compact research JSON", async () => {
    const { parseGeminiResearchResponseForTests } = await import(
      "../providers/geminiResearch"
    );
    const parsed = parseGeminiResearchResponseForTests(
      `{"products":[{"n":"Mini car vacuum USB","b":80,"sig":["tiktok","web"],"u":["https://example.com"],"w":"viral clips"}],"notes":"ok"}`,
    );
    expect(parsed?.products).toHaveLength(1);
    expect(parsed?.products[0]?.webBuzz).toBe(80);
    expect(parsed?.products[0]?.sources).toContain("https://example.com");
  });
});

describe("scoring roles", () => {
  it("exposes confirming roles and sources in explanation", () => {
    const result = computeOpportunityScore({
      demandGrowth: 0.4,
      demandAcceleration: 0.1,
      crossSourceConfirmation: 0.66,
      demandSupplyGap: 0.2,
      salesOrReviewsVelocity: 10,
      estimatedMargin: 0.3,
      logisticsScore: 70,
      saturation: 0.1,
      seasonality: 0.1,
      regulatoryRisk: 0.05,
      dataQuality: 0.8,
      sourceCount: 2,
      expectedSources: 3,
      historyDays: 21,
      confirmingRoles: ["attention", "commerce"],
      confirmingSources: ["google_trends", "aliexpress"],
      attentionDemandGrowth: 0.5,
      commerceDemandGrowth: 0.3,
    });
    expect(result.scoringVersion).toMatch(/radar-v2/);
    expect(result.explanation.confirmingRoles).toEqual([
      "attention",
      "commerce",
    ]);
    expect(result.explanation.confirmingSources).toContain("aliexpress");
    expect(result.explanation.whyRising?.some((s) => /Atención/i.test(s))).toBe(
      true,
    );
  });
});

describe("backtest", () => {
  it("evaluates without training leakage", () => {
    const result = runBacktest({
      trainingEndDate: 1000,
      predictionStartDate: 2000,
      predictionEndDate: 5000,
      targetGrowth: 0.2,
      targetWindowDays: 7,
      points: [
        {
          productId: "a",
          asOf: 2500,
          features: { demandGrowth: 0.3 },
          score: 80,
          classification: "EMERGING",
          realizedGrowth7d: 0.4,
        },
        {
          productId: "b",
          asOf: 3000,
          features: { demandGrowth: 0.1 },
          score: 40,
          classification: "INSUFFICIENT_DATA",
          realizedGrowth7d: 0.05,
        },
      ],
    });
    expect(result.sampleSize).toBe(2);
    expect(result.hitRate).toBe(0.5);
    expect(result.mode).toBe("evaluation_only");
  });
});

describe("gemini ads personalization helpers", () => {
  it("normalizes scrape terms with fallback", () => {
    expect(
      normalizeScrapeTerms(["  Termo Stanley ", "x"], ["mate"]),
    ).toEqual(["termo stanley", "mate"]);
  });

  it("strips offer-hook scrape terms", () => {
    expect(
      normalizeScrapeTerms(
        [
          "mate imperial",
          "termo envio gratis",
          "cuotas sin interes",
          "bombilla alpaca",
        ],
        ["mate envio gratis"],
      ),
    ).toEqual(["mate imperial", "bombilla alpaca"]);
  });

  it("parses ranking keep/drop and drops omitted ads", () => {
    const valid = new Set(["a1", "a2", "a3"]);
    const parsed = parseRankingResponse(
      {
        keep: [{ id: "a1", score: 90, reason: "match" }],
        drop: [{ id: "a2", reason: "off niche" }],
      },
      valid,
    );
    expect(parsed.droppedAdIds).toEqual(["a2", "a3"]);
    expect(parsed.ranked.map((r) => r.adId)).toEqual(["a1"]);
    expect(parsed.ranked[0]?.score).toBe(90);
  });
});

describe("ad relevance gate", () => {
  const mateKw = ["mate", "termo", "bombilla"];

  it("rejects Play Store / app install ads", () => {
    expect(
      isAppOrInstallAd({
        pageName: "Drama Short TV",
        body: "Watch now",
        destinationUrl: "https://play.google.com/store/apps/details?id=x",
      }),
    ).toBe(true);
  });

  it("rejects English fitness noise without niche overlap", () => {
    expect(
      isForeignLanguageNoise(
        "Tired of forcing yourself onto the treadmill? Shadowboxing is the workout",
        mateKw,
      ),
    ).toBe(true);
  });

  it("keeps Spanish matero creatives", () => {
    expect(
      passesNicheAdGate(
        {
          pageName: "Quemate.arg",
          body: "Combo matero con termo y bombilla. Envío gratis.",
          mediaUrls: ["https://example.com/a.jpg"],
          destinationUrl: "https://tienda.mitiendanube.com/combo",
        },
        mateKw,
      ),
    ).toBe(true);
  });

  it("rejects CNC Italian without niche keywords", () => {
    expect(
      passesNicheAdGate(
        {
          pageName: "CNC Shop",
          body: "Acquista ora la macchina CNC. Spedizione gratuita.",
          mediaUrls: ["https://example.com/a.jpg"],
        },
        mateKw,
      ),
    ).toBe(false);
  });
});
