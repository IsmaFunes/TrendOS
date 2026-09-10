import { describe, expect, it } from "vitest";
import { parseRetailerListingsJson, parseSupplierJson } from "../geminiResearch";

function offer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    country: "AR",
    title: "Almohada bebé ergonómica x50 unidades",
    supplier: "Distribuidora Test",
    price: 1200,
    currency: "ARS",
    moq: 50,
    url: "https://distribuidoratest.com.ar/mayorista/almohada-bebe",
    ...overrides,
  };
}

describe("parseSupplierJson", () => {
  it("parses a well-formed wholesale offer", () => {
    const result = parseSupplierJson(JSON.stringify({ suppliers: [offer()] }));
    expect(result).toHaveLength(1);
    expect(result![0]!.moq).toBe(50);
  });

  it("rejects a Mercado Libre listing even if otherwise well-formed", () => {
    const result = parseSupplierJson(
      JSON.stringify({
        suppliers: [
          offer({ url: "https://articulo.mercadolibre.com.ar/MLA-123-almohada" }),
        ],
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("rejects Mercado Shops and Mercado Livre (Brazil) the same way", () => {
    const result = parseSupplierJson(
      JSON.stringify({
        suppliers: [
          offer({ url: "https://mitienda.mercadoshops.com.ar/producto" }),
          offer({ url: "https://produto.mercadolivre.com.br/item" }),
        ],
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("still drops offers missing required fields", () => {
    const result = parseSupplierJson(
      JSON.stringify({ suppliers: [offer({ price: undefined })] }),
    );
    expect(result).toHaveLength(0);
  });
});

function retailerListing(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: "Aire acondicionado split frío/calor 3000w",
    url: "https://www.fravega.com/p/aires-acondicionados/split/aire-acondicionado-abc123/",
    price: 349999,
    retailer: "Fravega",
    ...overrides,
  };
}

describe("parseRetailerListingsJson", () => {
  it("parses a well-formed retailer listing", () => {
    const result = parseRetailerListingsJson(
      JSON.stringify({ listings: [retailerListing()] }),
    );
    expect(result).toHaveLength(1);
    expect(result![0]!.retailerName).toBe("Fravega");
  });

  it("rejects a listing whose URL doesn't belong to the claimed retailer's domain", () => {
    const result = parseRetailerListingsJson(
      JSON.stringify({
        listings: [
          retailerListing({
            retailer: "Fravega",
            url: "https://www.oncity.com/producto/abc123",
          }),
        ],
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("rejects a retailer name outside the known allowlist", () => {
    const result = parseRetailerListingsJson(
      JSON.stringify({
        listings: [
          retailerListing({
            retailer: "Tienda Random Inventada",
            url: "https://tiendarandom.com/producto/abc123",
          }),
        ],
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("still drops listings missing required fields", () => {
    const result = parseRetailerListingsJson(
      JSON.stringify({ listings: [retailerListing({ price: undefined })] }),
    );
    expect(result).toHaveLength(0);
  });
});
