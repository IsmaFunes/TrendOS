import { describe, expect, it } from "vitest";
import {
  hasNicheKeywordOverlap,
  isAppOrInstallAd,
  passesNicheAdGate,
} from "../adRelevance";

describe("hasNicheKeywordOverlap", () => {
  it("does not match a keyword as a substring of an unrelated word", () => {
    // "mate" must not match because it appears inside "tomate".
    expect(hasNicheKeywordOverlap("Salsa de tomate casera", ["mate"])).toBe(
      false,
    );
  });

  it("matches a whole-word single-token keyword", () => {
    expect(hasNicheKeywordOverlap("Vendemos mate y bombillas", ["mate"])).toBe(
      true,
    );
  });

  it("matches ES plural variants for vowel-ending words", () => {
    expect(hasNicheKeywordOverlap("Termos de acero inoxidable", ["termo"])).toBe(
      true,
    );
    expect(hasNicheKeywordOverlap("El mejor termo del mercado", ["termos"])).toBe(
      true,
    );
  });

  it("matches ES plural variants for consonant-ending words (sarten -> sartenes, not sartens)", () => {
    expect(
      hasNicheKeywordOverlap("Set de sartenes antiadherentes", ["sarten"]),
    ).toBe(true);
    expect(
      hasNicheKeywordOverlap("El mejor sarten del mercado", ["sartenes"]),
    ).toBe(true);
  });

  it("requires every word of a multi-word keyword to be present", () => {
    expect(
      hasNicheKeywordOverlap("Yerba mate orgánica 1kg", ["yerba mate"]),
    ).toBe(true);
    // Only one of the two words present -> should not pass.
    expect(
      hasNicheKeywordOverlap("Yerba para cebar", ["yerba mate"]),
    ).toBe(false);
  });

  it("treats an empty keyword list as a pass-through", () => {
    expect(hasNicheKeywordOverlap("cualquier cosa", [])).toBe(true);
  });
});

describe("passesNicheAdGate", () => {
  const baseAd = {
    pageName: "Termos Argentina",
    body: "Los mejores termos de acero para tu mate",
    destinationUrl: "https://termosargentina.com.ar",
    mediaUrls: ["https://example.com/img.jpg"],
  };

  it("passes a clearly on-niche ad", () => {
    expect(passesNicheAdGate(baseAd, ["termo"])).toBe(true);
  });

  it("rejects an ad whose only overlap is a substring, not a whole word", () => {
    const ad = {
      ...baseAd,
      pageName: "Salsas Caseras",
      body: "Salsa de tomate artesanal, envío gratis a todo el país",
    };
    expect(passesNicheAdGate(ad, ["mate"])).toBe(false);
  });

  it("rejects app-install ads regardless of keyword overlap", () => {
    const ad = {
      ...baseAd,
      destinationUrl: "https://play.google.com/store/apps/details?id=x",
    };
    expect(isAppOrInstallAd(ad)).toBe(true);
    expect(passesNicheAdGate(ad, ["termo"])).toBe(false);
  });
});
