/**
 * Seeds/updates the fixed, curated niche catalog users pick from at
 * onboarding. Idempotent (matched by slug) — safe to re-run after editing
 * NICHES below to add/retire niches or tweak base terms.
 *
 * Base (AR-Spanish) terms are hand-curated; terms for every other target
 * country are localized once via Gemini (convex/radar/geminiAds.ts
 * localizeNicheTerms) — not regenerated per scrape, since niches are a
 * fixed catalog, not user-typed keywords.
 *
 *   npx convex run admin/seedNicheCatalog:seedNicheCatalog
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

type SeedNiche = {
  slug: string;
  label: string;
  description: string;
  baseTerms: string[];
};

/** Countries scraped beyond AR — see convex/radar/metaAds.ts SCRAPE_COUNTRIES. */
const TARGET_COUNTRIES: Array<{ country: string; language: string }> = [
  { country: "US", language: "en-US" },
  { country: "BR", language: "pt-BR" },
  { country: "MX", language: "es-MX" },
  { country: "ES", language: "es-ES" },
];

const NICHES: SeedNiche[] = [
  {
    slug: "mates-termos",
    label: "Mates y Termos",
    description: "Mates, termos, bombillas y accesorios para tomar mate.",
    baseTerms: ["mate", "termo", "bombilla", "yerbera", "mate imperial"],
  },
  {
    slug: "cocina-gadgets",
    label: "Gadgets de Cocina",
    description: "Electrodomésticos y accesorios chicos para cocinar.",
    baseTerms: ["freidora de aire", "batidora", "licuadora", "organizador cocina"],
  },
  {
    slug: "electrodomesticos-hogar",
    label: "Electrodomésticos del Hogar",
    description: "Electrodomésticos grandes para el hogar.",
    baseTerms: ["aspiradora", "purificador de aire", "ventilador", "calefactor"],
  },
  {
    slug: "tecnologia-accesorios",
    label: "Tecnología y Accesorios",
    description: "Accesorios de tecnología de consumo.",
    baseTerms: [
      "auriculares bluetooth",
      "cargador inalambrico",
      "funda celular",
      "smartwatch",
    ],
  },
  {
    slug: "fitness-entrenamiento",
    label: "Fitness y Entrenamiento",
    description: "Equipamiento para entrenar en casa o gimnasio.",
    baseTerms: ["mancuernas", "banda elastica", "mat yoga", "guantes gym"],
  },
  {
    slug: "belleza-skincare",
    label: "Belleza y Skincare",
    description: "Cosmética y cuidado personal.",
    baseTerms: ["serum facial", "plancha de pelo", "crema hidratante", "depiladora"],
  },
  {
    slug: "bebes-maternidad",
    label: "Bebés y Maternidad",
    description: "Productos para bebés y maternidad.",
    baseTerms: [
      "cochecito bebe",
      "monitor bebe",
      "silla auto bebe",
      "almohada lactancia",
    ],
  },
  {
    slug: "mascotas",
    label: "Mascotas",
    description: "Accesorios y productos para perros y gatos.",
    baseTerms: ["cama para perro", "arnes perro", "juguete gato", "comedero automatico"],
  },
  {
    slug: "moda-accesorios",
    label: "Moda y Accesorios",
    description: "Indumentaria y accesorios de moda.",
    baseTerms: ["mochila antirrobo", "billetera cuero", "lentes de sol", "reloj pulsera"],
  },
  {
    slug: "hogar-decoracion",
    label: "Decoración del Hogar",
    description: "Decoración y organización del hogar.",
    baseTerms: [
      "luces led",
      "cuadros decorativos",
      "organizador closet",
      "cortinas blackout",
    ],
  },
  {
    slug: "outdoor-camping",
    label: "Outdoor y Camping",
    description: "Equipamiento para camping y actividades al aire libre.",
    baseTerms: ["carpa camping", "bolsa de dormir", "linterna led", "mochila trekking"],
  },
  {
    slug: "accesorios-auto",
    label: "Accesorios para Auto",
    description: "Accesorios y organización para el auto.",
    baseTerms: ["soporte celular auto", "aspiradora auto", "cargador auto"],
  },
  {
    slug: "herramientas",
    label: "Herramientas",
    description: "Herramientas manuales y eléctricas.",
    baseTerms: ["taladro atornillador", "kit herramientas", "caja herramientas"],
  },
  {
    slug: "gaming-accesorios",
    label: "Gaming y Accesorios",
    description: "Periféricos y accesorios gamer.",
    baseTerms: ["mouse gamer", "teclado mecanico", "silla gamer", "auriculares gaming"],
  },
  {
    slug: "limpieza-organizacion",
    label: "Limpieza y Organización",
    description: "Productos de limpieza y organización del hogar.",
    baseTerms: ["robot aspiradora", "organizador ropa", "dispenser jabon"],
  },
  {
    slug: "jardin-exterior",
    label: "Jardín y Exterior",
    description: "Jardinería y mobiliario de exterior.",
    baseTerms: ["reposera", "sombrilla jardin", "parrilla portatil", "manguera jardin"],
  },
];

export const upsertNiche = internalMutation({
  args: {
    slug: v.string(),
    label: v.string(),
    description: v.string(),
    scrapeTermsByCountry: v.array(
      v.object({ country: v.string(), terms: v.array(v.string()) }),
    ),
  },
  returns: v.id("radarNiches"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("radarNiches")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        label: args.label,
        description: args.description,
        scrapeTermsByCountry: args.scrapeTermsByCountry,
        isActive: true,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("radarNiches", {
      slug: args.slug,
      label: args.label,
      description: args.description,
      scrapeTermsByCountry: args.scrapeTermsByCountry,
      adCount: 0,
      status: "pending_scrape",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const seedNicheCatalog = internalAction({
  args: {},
  returns: v.object({ upserted: v.number(), niches: v.array(v.string()) }),
  handler: async (ctx) => {
    const niches: string[] = [];
    for (const niche of NICHES) {
      const localized = await Promise.all(
        TARGET_COUNTRIES.map(async ({ country, language }) => {
          const result: { ok: boolean; terms: string[] } = await ctx.runAction(
            internal.radar.geminiAds.localizeNicheTerms,
            {
              label: niche.label,
              description: niche.description,
              baseTerms: niche.baseTerms,
              targetCountry: country,
              targetLanguage: language,
            },
          );
          return { country, terms: result.terms };
        }),
      );

      await ctx.runMutation(internal.admin.seedNicheCatalog.upsertNiche, {
        slug: niche.slug,
        label: niche.label,
        description: niche.description,
        scrapeTermsByCountry: [
          { country: "AR", terms: niche.baseTerms },
          ...localized,
        ],
      });
      niches.push(niche.slug);
    }
    return { upserted: niches.length, niches };
  },
});
