import { afterEach, describe, expect, it, vi } from "vitest";
import { searchMercadoLibreViaShopping } from "../providers/serpapiShopping";

describe("searchMercadoLibreViaShopping", () => {
  const prevKey = process.env.SERPAPI_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.SERPAPI_API_KEY;
    else process.env.SERPAPI_API_KEY = prevKey;
  });

  function mockFetch(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }),
    );
  }

  it("fails closed without SERPAPI_API_KEY", async () => {
    delete process.env.SERPAPI_API_KEY;
    await expect(searchMercadoLibreViaShopping("termo")).rejects.toThrow(
      /SERPAPI_API_KEY/,
    );
  });

  it("keeps only Mercado Libre-sourced results with a real price", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    mockFetch({
      shopping_results: [
        {
          position: 1,
          title: "Termo Acero Inoxidable 1L",
          product_id: "123",
          product_link: "https://google.com/shopping/product/123",
          source: "mercadolibre.com.ar",
          extracted_price: 28000,
          thumbnail: "https://example.com/thumb.jpg",
        },
        {
          position: 2,
          title: "Termo Frávega",
          source: "Frávega",
          extracted_price: 31000,
        },
        {
          position: 3,
          title: "Termo sin precio",
          source: "Mercado Libre",
        },
      ],
    });

    const result = await searchMercadoLibreViaShopping("termo acero inoxidable 1l");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      source: "google_shopping",
      title: "Termo Acero Inoxidable 1L",
      price: 28000,
      currency: "ARS",
    });
  });

  it("returns an error entry instead of throwing on a fetch failure", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      }),
    );

    const result = await searchMercadoLibreViaShopping("termo", {
      timeoutMs: 500,
      maxAttempts: 1,
    });
    expect(result.items).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
