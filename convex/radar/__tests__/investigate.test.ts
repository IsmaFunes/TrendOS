import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHeuristicProductSignal,
  capSuppliersByCountry,
  computeInvestigationScore,
  computeProfitEstimate,
  isRelevantSupplierTitle,
  parseExtractedProductSignal,
  rankMlMatches,
  rankSimilarAds,
  scoreStoreQuality,
  verifyUrlContent,
  type SimilarAdCandidate,
  type SupplierOffer,
} from "../investigate";
import type { ExternalProduct } from "../contracts";
import type { Id } from "../../_generated/dataModel";

function adId(n: number): Id<"radarAds"> {
  return `ad_${n}` as unknown as Id<"radarAds">;
}

describe("buildHeuristicProductSignal", () => {
  it("distills ad copy into a short, capitalized product name", () => {
    const { productName, searchQuery } = buildHeuristicProductSignal(
      "Termos Pampa",
      "🔥 OFERTA! Termo acero inoxidable 1L envío gratis a todo el país cuotas sin interés",
    );
    expect(searchQuery).toContain("termo");
    expect(searchQuery).not.toContain("gratis");
    expect(searchQuery).not.toContain("oferta");
    expect(productName.length).toBeGreaterThan(0);
  });

  it("falls back to the page name when body is empty", () => {
    const { searchQuery } = buildHeuristicProductSignal("Mate Imperial Store", "");
    expect(searchQuery.length).toBeGreaterThan(0);
  });
});

describe("scoreStoreQuality", () => {
  it("scores a brand-new, storeless advertiser low", () => {
    const { score, label } = scoreStoreQuality({
      hasStore: false,
      activeAdCount: 0,
      totalAdCount: 0,
      adActiveDays: 0,
    });
    expect(score).toBeLessThan(0.45);
    expect(label).toBe("Señales limitadas");
  });

  it("scores a long-running store with many ads high", () => {
    const { score, label } = scoreStoreQuality({
      hasStore: true,
      platform: "tiendanube",
      activeAdCount: 25,
      totalAdCount: 150,
      adActiveDays: 90,
    });
    expect(score).toBeGreaterThanOrEqual(0.7);
    expect(label).toBe("Tienda consolidada");
  });

  it("never exceeds 1", () => {
    const { score } = scoreStoreQuality({
      hasStore: true,
      platform: "shopify",
      activeAdCount: 1000,
      totalAdCount: 5000,
      adActiveDays: 5000,
    });
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("rankSimilarAds", () => {
  const base: SimilarAdCandidate = {
    adId: adId(1),
    pageName: "Termos Pampa",
    body: "Termo acero inoxidable 1L",
    activeDays: 30,
    storeQualityScore: 0.6,
    storeQualityLabel: "Tienda activa",
  };

  it("drops candidates with weak text similarity", () => {
    const unrelated: SimilarAdCandidate = {
      ...base,
      adId: adId(2),
      pageName: "Zapatillas Runner",
      body: "Zapatillas running livianas para maraton",
    };
    const ranked = rankSimilarAds("termo acero inoxidable", [unrelated]);
    expect(ranked).toHaveLength(0);
  });

  it("ranks a strong text match above a weaker one and caps at the limit", () => {
    const strong: SimilarAdCandidate = { ...base, adId: adId(3) };
    const weak: SimilarAdCandidate = {
      ...base,
      adId: adId(4),
      body: "Termo acero para mates y termos varios accesorios",
      activeDays: 5,
      storeQualityScore: 0.2,
    };
    const ranked = rankSimilarAds("termo acero inoxidable 1l", [weak, strong], 1);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.adId).toBe(strong.adId);
  });

  it("never lets a weaker-but-more-credible match outrank a clearly stronger one", () => {
    // Both bodies clear the relevance floor (proven by the test above), but
    // "strong" matches the query much more closely than "weak" does. Before
    // the fix, giving "weak" a big store + long-running ad could still let
    // it out-rank "strong" via the weighted formula — now match strength
    // decides first, credibility only breaks near-ties.
    const strongButNewStore: SimilarAdCandidate = {
      ...base,
      adId: adId(5),
      body: "Termo acero inoxidable 1L",
      activeDays: 1,
      storeQualityScore: 0.1,
      storeQualityLabel: "Señales limitadas",
    };
    const weakButBigStore: SimilarAdCandidate = {
      ...base,
      adId: adId(6),
      body: "Termo acero para mates y termos varios accesorios",
      activeDays: 90,
      storeQualityScore: 0.95,
      storeQualityLabel: "Tienda consolidada",
    };
    const ranked = rankSimilarAds("termo acero inoxidable 1l", [
      weakButBigStore,
      strongButNewStore,
    ]);
    expect(ranked[0]!.adId).toBe(strongButNewStore.adId);
  });

  it("strips the body field and rounds matchScore", () => {
    const ranked = rankSimilarAds("termo acero inoxidable", [base]);
    expect(ranked[0]).not.toHaveProperty("body");
    expect(Number.isFinite(ranked[0]!.matchScore)).toBe(true);
  });
});

describe("rankMlMatches", () => {
  function item(overrides: Partial<ExternalProduct>): ExternalProduct {
    return {
      externalId: "MLA1",
      source: "mercadolibre",
      title: "Termo Acero Inoxidable 1L",
      ...overrides,
    };
  }

  it("returns an empty list with a warning when there are no items", () => {
    const { matches, warning } = rankMlMatches("termo acero inoxidable", []);
    expect(matches).toHaveLength(0);
    expect(warning).toBeTruthy();
  });

  it("badges the strongest match as best_match and keeps others as alternatives", () => {
    const { matches, warning } = rankMlMatches("termo acero inoxidable 1l", [
      item({ externalId: "A", title: "Termo Acero Inoxidable 1L", soldQuantity: 50 }),
      item({ externalId: "B", title: "Mochila urbana antirrobo", soldQuantity: 500 }),
    ]);
    expect(matches[0]!.externalId).toBe("A");
    expect(matches[0]!.badge).toBe("best_match");
    expect(matches.some((m) => m.badge === "alternative")).toBe(true);
    expect(warning).toBeUndefined();
  });

  it("warns when even the top match is weak", () => {
    const { warning } = rankMlMatches("termo acero inoxidable 1l", [
      item({ externalId: "C", title: "Funda para celular" }),
    ]);
    expect(warning).toBeTruthy();
  });

  it("carries the item's source through so the UI can flag web-search fallback results", () => {
    const { matches } = rankMlMatches("termo acero inoxidable 1l", [
      item({ externalId: "D", source: "gemini_research" }),
    ]);
    expect(matches[0]!.source).toBe("gemini_research");
  });
});

describe("computeInvestigationScore", () => {
  it("scores a well-corroborated, high-demand, on-niche product as strong", () => {
    const { score, classification } = computeInvestigationScore({
      targetActiveDays: 60,
      targetStoreQuality: 0.8,
      similarAdCount: 3,
      bestMlMatchScore: 0.6,
      bestMlSoldQuantity: 400,
      mlMatchCount: 3,
      suppliersFound: 3,
      sourcingMargin: 0.45,
      nicheFitScore: 1,
    });
    expect(score).toBeGreaterThanOrEqual(6.5);
    expect(classification).toBe("strong");
  });

  it("scores a thin-evidence, off-niche product as weak", () => {
    const { score, classification } = computeInvestigationScore({
      targetActiveDays: 0,
      targetStoreQuality: 0.1,
      similarAdCount: 0,
      bestMlMatchScore: 0,
      bestMlSoldQuantity: undefined,
      mlMatchCount: 0,
      suppliersFound: 0,
      sourcingMargin: null,
      nicheFitScore: 0,
    });
    expect(score).toBeLessThan(4);
    expect(classification).toBe("weak");
  });

  it("always stays within [0, 10]", () => {
    const { score } = computeInvestigationScore({
      targetActiveDays: 10_000,
      targetStoreQuality: 5,
      similarAdCount: 100,
      bestMlMatchScore: 5,
      bestMlSoldQuantity: 1_000_000,
      mlMatchCount: 50,
      suppliersFound: 50,
      sourcingMargin: 5,
      nicheFitScore: 5,
    });
    expect(score).toBeLessThanOrEqual(10);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe("computeProfitEstimate", () => {
  it("returns undefined when there are no suppliers", () => {
    expect(
      computeProfitEstimate({ suppliers: [], estimatedSalePrice: 10_000 }),
    ).toBeUndefined();
  });

  it("computes a direct margin for an ARS-priced local supplier", () => {
    const suppliers: SupplierOffer[] = [
      {
        title: "Termo Acero Inoxidable 1L",
        country: "AR",
        isImport: false,
        unitPrice: 8_000,
        currency: "ARS",
        source: "gemini_research",
      },
    ];
    const profit = computeProfitEstimate({
      suppliers,
      estimatedSalePrice: 15_000,
    });
    expect(profit?.estimatedProfit).not.toBeNull();
    expect(profit?.estimatedMargin).toBeGreaterThan(0);
    expect(profit?.bestSupplierCountry).toBe("AR");
  });

  it("converts a USD supplier when a blue-dollar FX rate is available", () => {
    const suppliers: SupplierOffer[] = [
      {
        title: "Stainless Steel Thermos 1L",
        country: "CN",
        isImport: true,
        unitPrice: 5,
        currency: "USD",
        source: "alibaba",
      },
    ];
    const profit = computeProfitEstimate({
      suppliers,
      estimatedSalePrice: 15_000,
      fxUsdArs: { rate: 1000, source: "blue (dolarapi.com)" },
    });
    expect(profit?.estimatedMargin).not.toBeUndefined();
    expect(profit?.estimatedProfit).toBeCloseTo(15_000 - 5_000 - 15_000 * 0.13, 0);
    expect(profit?.fxRateUsed).toBe(1000);
    expect(profit?.fxRateSource).toBe("blue (dolarapi.com)");
  });

  it("skips the margin (but keeps the raw price) when currency can't be converted", () => {
    const suppliers: SupplierOffer[] = [
      {
        title: "Stainless Steel Thermos 1L",
        country: "CN",
        isImport: true,
        unitPrice: 5,
        currency: "USD",
        source: "alibaba",
      },
    ];
    const profit = computeProfitEstimate({ suppliers, estimatedSalePrice: 15_000 });
    expect(profit?.estimatedMargin).toBeUndefined();
    expect(profit?.bestSupplierPrice).toBe(5);
    expect(profit?.note).toBeTruthy();
  });

  it("skips the margin when there is no ML reference price", () => {
    const suppliers: SupplierOffer[] = [
      {
        title: "Termo Acero Inoxidable 1L",
        country: "AR",
        isImport: false,
        unitPrice: 8_000,
        currency: "ARS",
        source: "gemini_research",
      },
    ];
    const profit = computeProfitEstimate({ suppliers, estimatedSalePrice: null });
    expect(profit?.estimatedMargin).toBeUndefined();
    expect(profit?.bestSupplierPrice).toBe(8_000);
  });
});

describe("capSuppliersByCountry", () => {
  it("caps per-country and overall totals, keeping the cheapest first", () => {
    const suppliers: SupplierOffer[] = [
      { title: "Thermos A", country: "CN", isImport: true, unitPrice: 9, currency: "USD", source: "alibaba" },
      { title: "Thermos B", country: "CN", isImport: true, unitPrice: 3, currency: "USD", source: "made_in_china" },
      { title: "Thermos C", country: "CN", isImport: true, unitPrice: 6, currency: "USD", source: "made_in_china" },
      { title: "Termo D", country: "AR", isImport: false, unitPrice: 8_000, currency: "ARS", source: "gemini_research" },
      { title: "Termo E", country: "BR", isImport: true, unitPrice: 20, currency: "BRL", source: "gemini_research" },
    ];
    const capped = capSuppliersByCountry(suppliers, 2, 3);
    expect(capped).toHaveLength(3);
    expect(capped.filter((s) => s.country === "CN")).toHaveLength(2);
    expect(capped[0]!.unitPrice).toBe(3);
  });
});

describe("isRelevantSupplierTitle", () => {
  it("keeps a title that overlaps with the query", () => {
    expect(
      isRelevantSupplierTitle(
        "stainless steel thermos 1l",
        "2024 New Design Stainless Steel Vacuum Flask Thermos Bottle 1000ml Wholesale",
      ),
    ).toBe(true);
  });

  it("drops a title from a different, unrelated product", () => {
    expect(
      isRelevantSupplierTitle("stainless steel thermos 1l", "Wireless Bluetooth Earbuds Case"),
    ).toBe(false);
  });
});

describe("verifyUrlContent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(response: { ok: boolean; text: string }) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: response.ok,
        text: () => Promise.resolve(response.text),
      }),
    );
  }

  it("rejects a claimed listing whose real page is unrelated content (the Santa Claus case)", async () => {
    mockFetch({
      ok: true,
      text: "<html><title>Papá Noel decorativo con luces</title>Figura navideña de 40cm...</html>",
    });
    const ok = await verifyUrlContent(
      "https://www.mercadolibre.com.ar/some-item/p/MLA123",
      "Kit entrenamiento gimnasio en casa fitness",
    );
    expect(ok).toBe(false);
  });

  it("accepts a page whose content actually matches the claimed title", async () => {
    mockFetch({
      ok: true,
      text: "<html><title>Colchoneta para entrenar en casa - Yoga Mat</title>Colchoneta antideslizante para entrenar en casa...</html>",
    });
    const ok = await verifyUrlContent(
      "https://articulo.mercadolibre.com.ar/some-item",
      "Colchoneta para entrenar en casa",
    );
    expect(ok).toBe(true);
  });

  it("rejects a non-200 response", async () => {
    mockFetch({ ok: false, text: "" });
    const ok = await verifyUrlContent("https://articulo.mercadolibre.com.ar/gone", "Termo acero");
    expect(ok).toBe(false);
  });

  it("rejects a dead/delisted page even if it happens to return 200", async () => {
    mockFetch({ ok: true, text: "<html>Publicación pausada por el vendedor</html>" });
    const ok = await verifyUrlContent("https://articulo.mercadolibre.com.ar/paused", "Termo acero");
    expect(ok).toBe(false);
  });
});

describe("parseExtractedProductSignal", () => {
  it("extracts productName/searchQuery/attributes for a physical product", () => {
    const signal = parseExtractedProductSignal(
      JSON.stringify({
        isPhysicalProduct: true,
        productName: "Colchoneta antideslizante para entrenar",
        category: "fitness",
        attributes: ["antideslizante", "TPE", "1cm"],
        searchQuery: "colchoneta antideslizante entrenar",
        englishQuery: "non-slip exercise mat",
      }),
    );
    expect(signal?.isPhysicalProduct).toBe(true);
    expect(signal?.productName).toContain("Colchoneta");
    expect(signal?.attributes).toEqual(["antideslizante", "TPE", "1cm"]);
    expect(signal?.searchQuery.length).toBeGreaterThan(0);
  });

  it("flags a training-program ad as not a physical product instead of forcing a match", () => {
    const signal = parseExtractedProductSignal(
      JSON.stringify({
        isPhysicalProduct: false,
        notAProductReason: "programa de entrenamiento online",
      }),
    );
    expect(signal?.isPhysicalProduct).toBe(false);
    expect(signal?.notAProductReason).toBe("programa de entrenamiento online");
    expect(signal?.searchQuery).toBe("");
  });

  it("defaults to a generic reason when the model omits it", () => {
    const signal = parseExtractedProductSignal(
      JSON.stringify({ isPhysicalProduct: false }),
    );
    expect(signal?.notAProductReason).toBeTruthy();
  });

  it("returns null on unparseable JSON", () => {
    expect(parseExtractedProductSignal("not json")).toBeNull();
  });

  it("returns null when a physical product is missing productName or searchQuery", () => {
    expect(
      parseExtractedProductSignal(
        JSON.stringify({ isPhysicalProduct: true, productName: "", searchQuery: "" }),
      ),
    ).toBeNull();
  });
});
