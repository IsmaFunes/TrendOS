import { describe, expect, it } from "vitest";
import { parseSupplierJson } from "../geminiResearch";

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
