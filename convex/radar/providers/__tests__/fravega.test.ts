import { describe, expect, it } from "vitest";
import { parseFravegaItem, parseFravegaSearchHtml } from "../fravega";

function apolloItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "ExtendedItem",
    id: "5a301db61400006300499d68",
    title: "Termotanque a Gas Escorial 80Lt",
    slug: "termotanque-a-gas-escorial-80lt",
    brand: { __typename: "Brand", name: "Escorial" },
    skus: { __typename: "ItemSkuSearchResponse", results: [{ code: "94742" }] },
    images: ["931442122deea71a5c7c65c25036cdbc.jpg"],
    listPrice: { amounts: [{ min: 379299, max: 379299 }] },
    salePrice: { amounts: [{ min: 329999, max: 329999 }] },
    ...overrides,
  };
}

function nextDataHtml(items: unknown[]): string {
  const payload = {
    props: {
      pageProps: {
        __APOLLO_STATE__: {
          ROOT_QUERY: {
            'items({"filtering":{"keywords":{"query":"termo"}}})': {
              __typename: "ItemSearchResponse",
              total: items.length,
              'results({"buckets":[{"offset":0}],"size":15})': items,
            },
          },
        },
      },
    },
  };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
}

describe("parseFravegaItem", () => {
  it("parses a real-shaped Apollo item into an ExternalProduct", () => {
    const result = parseFravegaItem(apolloItem());
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Termotanque a Gas Escorial 80Lt");
    expect(result!.externalUrl).toBe(
      "https://www.fravega.com/p/termotanque-a-gas-escorial-80lt-94742/",
    );
    expect(result!.price).toBe(329999);
    expect(result!.currency).toBe("ARS");
    expect(result!.sellerName).toBe("Escorial");
    expect(result!.source).toBe("retailer_scrape");
  });

  it("falls back to listPrice when there's no active sale", () => {
    const result = parseFravegaItem(apolloItem({ salePrice: undefined }));
    expect(result!.price).toBe(379299);
  });

  it("drops an item missing a usable price", () => {
    const result = parseFravegaItem(
      apolloItem({ salePrice: undefined, listPrice: undefined }),
    );
    expect(result).toBeNull();
  });

  it("drops an item missing required identity fields", () => {
    expect(parseFravegaItem(apolloItem({ slug: undefined }))).toBeNull();
    expect(parseFravegaItem(apolloItem({ title: "" }))).toBeNull();
    expect(parseFravegaItem(apolloItem({ id: undefined }))).toBeNull();
  });
});

describe("parseFravegaSearchHtml", () => {
  it("extracts real listings from a __NEXT_DATA__ page", () => {
    const html = nextDataHtml([apolloItem()]);
    const results = parseFravegaSearchHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Termotanque a Gas Escorial 80Lt");
  });

  it("returns an empty list when the page has no __NEXT_DATA__ script", () => {
    expect(parseFravegaSearchHtml("<html><body>nope</body></html>")).toEqual([]);
  });

  it("returns an empty list when __NEXT_DATA__ isn't valid JSON", () => {
    const html =
      '<html><script id="__NEXT_DATA__" type="application/json">{not json</script></html>';
    expect(parseFravegaSearchHtml(html)).toEqual([]);
  });

  it("skips malformed items instead of failing the whole page", () => {
    const html = nextDataHtml([apolloItem(), { garbage: true }]);
    expect(parseFravegaSearchHtml(html)).toHaveLength(1);
  });
});
