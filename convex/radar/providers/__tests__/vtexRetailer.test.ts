import { describe, expect, it } from "vitest";
import { parseVtexProduct, type VtexRetailer } from "../vtexRetailer";

const RETAILER: VtexRetailer = { name: "OnCity", domain: "www.oncity.com" };

function vtexProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: "1524",
    productName: "Termotanque Electrico Escorial 90 L",
    brand: "Escorial",
    link: "/termotanque-electrico-escorial-90-l-136072/p",
    priceRange: { sellingPrice: { highPrice: 323999, lowPrice: 323999 } },
    items: [
      {
        images: [
          { imageUrl: "https://aremsaprod.vtexassets.com/arquivos/ids/1252858/136072_01.jpg" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("parseVtexProduct", () => {
  it("parses a real-shaped VTEX intelligent-search product", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = parseVtexProduct(vtexProduct() as any, RETAILER);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Termotanque Electrico Escorial 90 L");
    expect(result!.externalUrl).toBe(
      "https://www.oncity.com/termotanque-electrico-escorial-90-l-136072/p",
    );
    expect(result!.price).toBe(323999);
    expect(result!.currency).toBe("ARS");
    expect(result!.sellerName).toBe("Escorial");
    expect(result!.source).toBe("retailer_scrape");
    expect(result!.externalId).toBe("www.oncity.com:1524");
  });

  it("namespaces externalId by domain so ids from different retailers can't collide", () => {
    const other: VtexRetailer = { name: "OtroStore", domain: "www.otrostore.com" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = parseVtexProduct(vtexProduct() as any, other);
    expect(result!.externalId).toBe("www.otrostore.com:1524");
  });

  it("falls back to the retailer name when the product has no brand", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = parseVtexProduct(vtexProduct({ brand: undefined }) as any, RETAILER);
    expect(result!.sellerName).toBe("OnCity");
  });

  it("keeps an absolute link untouched instead of double-prefixing the domain", () => {
    const result = parseVtexProduct(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vtexProduct({ link: "https://www.oncity.com/already-absolute/p" }) as any,
      RETAILER,
    );
    expect(result!.externalUrl).toBe("https://www.oncity.com/already-absolute/p");
  });

  it("drops a product missing a usable price", () => {
    const result = parseVtexProduct(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vtexProduct({ priceRange: { sellingPrice: {} } }) as any,
      RETAILER,
    );
    expect(result).toBeNull();
  });

  it("drops a product missing required identity fields", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseVtexProduct(vtexProduct({ link: undefined }) as any, RETAILER)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseVtexProduct(vtexProduct({ productId: undefined }) as any, RETAILER)).toBeNull();
  });
});
