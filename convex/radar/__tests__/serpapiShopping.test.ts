import { afterEach, describe, expect, it, vi } from "vitest";
import { searchArgentinaShopping } from "../providers/serpapiShopping";

describe("searchArgentinaShopping", () => {
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
    await expect(searchArgentinaShopping("termo")).rejects.toThrow(
      /SERPAPI_API_KEY/,
    );
  });

  it("keeps results from any real retailer with a real price, not just MercadoLibre", async () => {
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
        {
          position: 4,
          title: "Termo sin fuente",
          extracted_price: 25000,
        },
      ],
    });

    const result = await searchArgentinaShopping("termo acero inoxidable 1l");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      source: "google_shopping",
      title: "Termo Acero Inoxidable 1L",
      price: 28000,
      currency: "ARS",
      sellerName: "mercadolibre.com.ar",
    });
    expect(result.items[1]).toMatchObject({
      title: "Termo Frávega",
      price: 31000,
      sellerName: "Frávega",
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

    const result = await searchArgentinaShopping("termo", {
      timeoutMs: 500,
      maxAttempts: 1,
    });
    expect(result.items).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
