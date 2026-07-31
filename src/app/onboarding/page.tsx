"use client";

import { useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

type BusinessGoal =
  | "start_ecommerce"
  | "create_store"
  | "add_products"
  | "grow_sales"
  | "browse_ads";

const GOALS: { id: BusinessGoal; title: string; subtitle: string }[] = [
  {
    id: "start_ecommerce",
    title: "Empezar con ecommerce",
    subtitle: "Todavía no vendo online",
  },
  {
    id: "create_store",
    title: "Crear una tienda",
    subtitle: "Tienda Nube o Shopify (pronto)",
  },
  {
    id: "add_products",
    title: "Agregar productos a mi tienda",
    subtitle: "Ya tengo una tienda armada",
  },
  {
    id: "grow_sales",
    title: "Vender más",
    subtitle: "Busco productos que funcionen mejor",
  },
  {
    id: "browse_ads",
    title: "Solo ver anuncios",
    subtitle: "Quiero inspirarme con lo que se anuncia",
  },
];

const CHANNELS = [
  "Mercado Libre",
  "Tienda Nube",
  "Shopify",
  "Tienda propia",
  "Instagram",
  "WhatsApp",
];

const MAX_KEYWORDS = 5;
const MAX_EXCLUSIONS = 10;

export default function OnboardingPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const user = useQuery(api.users.me);
  const ensureUser = useMutation(api.users.ensureUser);
  const completeOnboarding = useMutation(api.users.completeOnboarding);

  const [step, setStep] = useState(1);
  const [goal, setGoal] = useState<BusinessGoal | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [storeUrl, setStoreUrl] = useState("");
  const [nicheKeywords, setNicheKeywords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [excludedKeywords, setExcludedKeywords] = useState<string[]>([]);
  const [excludeDraft, setExcludeDraft] = useState("");
  const [showExclusions, setShowExclusions] = useState(false);
  const [hasWarehouseStorage, setHasWarehouseStorage] = useState<
    boolean | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    if (authLoading || !isAuthenticated || bootstrapped) return;
    void (async () => {
      try {
        await ensureUser({});
        setBootstrapped(true);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "No se pudo iniciar la sesión",
        );
      }
    })();
  }, [authLoading, isAuthenticated, bootstrapped, ensureUser]);

  useEffect(() => {
    if (user?.onboardingComplete) {
      router.replace("/ads");
    }
  }, [user, router]);

  function toggleChannel(ch: string) {
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch],
    );
  }

  function addKeyword() {
    const value = keywordDraft.trim().replace(/\s+/g, " ");
    if (!value || nicheKeywords.length >= MAX_KEYWORDS) return;
    if (nicheKeywords.some((k) => k.toLowerCase() === value.toLowerCase())) {
      setKeywordDraft("");
      return;
    }
    setNicheKeywords((prev) => [...prev, value]);
    setKeywordDraft("");
  }

  function addExclusion() {
    const value = excludeDraft.trim().replace(/\s+/g, " ");
    if (!value || excludedKeywords.length >= MAX_EXCLUSIONS) return;
    if (
      excludedKeywords.some((k) => k.toLowerCase() === value.toLowerCase())
    ) {
      setExcludeDraft("");
      return;
    }
    setExcludedKeywords((prev) => [...prev, value]);
    setExcludeDraft("");
  }

  const needsLogistics =
    goal !== null && goal !== "browse_ads" && goal !== "create_store";
  const needsStoreUrl =
    goal === "add_products" ||
    channels.includes("Tienda Nube") ||
    channels.includes("Shopify") ||
    channels.includes("Tienda propia");

  async function finish() {
    if (!goal) return;
    setSaving(true);
    setError(null);
    try {
      await completeOnboarding({
        goal,
        channels: channels.length ? channels : undefined,
        existingStoreUrl: storeUrl.trim() || undefined,
        nicheKeywords,
        excludedKeywords: excludedKeywords.length
          ? excludedKeywords
          : undefined,
        hasWarehouseStorage:
          needsLogistics && hasWarehouseStorage !== null
            ? hasWarehouseStorage
            : undefined,
      });
      router.push("/ads");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || user === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center p-8 text-muted">
        Cargando…
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-4 px-6">
        <h1 className="font-display text-2xl">Entrá para continuar</h1>
        <Link href="/sign-in" className="rounded-lg bg-accent px-4 py-3 text-center text-white">
          Iniciar sesión
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col px-6 py-8">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/" className="font-display text-lg">
          TrendOS
        </Link>
        <UserButton />
      </div>

      <p className="mb-2 text-sm text-muted">Paso {step} de {needsLogistics ? 5 : 4}</p>

      {step === 1 && (
        <section className="flex flex-1 flex-col">
          <h1 className="font-display text-3xl text-foreground">
            Empezamos en Argentina
          </h1>
          <p className="mt-3 text-muted">
            Por ahora solo buscamos anuncios y productos para el mercado
            argentino.
          </p>
          <button
            type="button"
            onClick={() => setStep(2)}
            className="mt-10 rounded-lg bg-accent px-6 py-3 text-base font-medium text-white"
          >
            Continuar
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="flex flex-1 flex-col">
          <h1 className="font-display text-3xl">¿Qué querés hacer?</h1>
          <div className="mt-6 flex flex-col gap-2">
            {GOALS.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  setGoal(g.id);
                  setStep(3);
                }}
                className={`rounded-xl border px-4 py-4 text-left transition ${
                  goal === g.id
                    ? "border-accent bg-surface"
                    : "border-border bg-surface hover:border-foreground/30"
                }`}
              >
                <div className="font-medium">{g.title}</div>
                <div className="text-sm text-muted">{g.subtitle}</div>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStep(1)}
            className="mt-6 text-sm text-muted"
          >
            Atrás
          </button>
        </section>
      )}

      {step === 3 && (
        <section className="flex flex-1 flex-col">
          <h1 className="font-display text-3xl">¿Por dónde vendés?</h1>
          <p className="mt-2 text-muted">Podés elegir más de uno.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {CHANNELS.map((ch) => {
              const on = channels.includes(ch);
              return (
                <button
                  key={ch}
                  type="button"
                  onClick={() => toggleChannel(ch)}
                  className={`rounded-full px-4 py-2 text-sm ${
                    on
                      ? "bg-accent text-white"
                      : "border border-border bg-surface text-foreground"
                  }`}
                >
                  {ch}
                </button>
              );
            })}
          </div>
          {needsStoreUrl && (
            <label className="mt-6 block">
              <span className="text-sm text-muted">Link de tu tienda (opcional)</span>
              <input
                value={storeUrl}
                onChange={(e) => setStoreUrl(e.target.value)}
                placeholder="https://…"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>
          )}
          <div className="mt-10 flex gap-3">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-lg border border-border px-4 py-3 text-sm"
            >
              Atrás
            </button>
            <button
              type="button"
              onClick={() => setStep(4)}
              className="rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white"
            >
              Continuar
            </button>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="flex flex-1 flex-col">
          <h1 className="font-display text-3xl">
            ¿Qué tipo de productos te interesan?
          </h1>
          <p className="mt-2 text-muted">
            Escribí palabras clave (ej. cocina, mascotas, fitness).
          </p>
          <div className="mt-6 flex gap-2">
            <input
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addKeyword();
                }
              }}
              placeholder="Agregar keyword"
              className="flex-1 rounded-lg border border-border bg-surface px-3 py-2"
            />
            <button
              type="button"
              onClick={addKeyword}
              className="rounded-lg border border-border px-4 py-2 text-sm"
            >
              Agregar
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {nicheKeywords.map((kw) => (
              <button
                key={kw}
                type="button"
                onClick={() =>
                  setNicheKeywords((prev) => prev.filter((k) => k !== kw))
                }
                className="rounded-full bg-surface-2 px-3 py-1 text-sm"
              >
                {kw} ×
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowExclusions((v) => !v)}
            className="mt-6 text-left text-sm text-muted underline"
          >
            {showExclusions ? "Ocultar" : "No quiero vender…"}
          </button>
          {showExclusions && (
            <div className="mt-2">
              <div className="flex gap-2">
                <input
                  value={excludeDraft}
                  onChange={(e) => setExcludeDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addExclusion();
                    }
                  }}
                  placeholder="ej. suplementos"
                  className="flex-1 rounded-lg border border-border bg-surface px-3 py-2"
                />
                <button
                  type="button"
                  onClick={addExclusion}
                  className="rounded-lg border border-border px-4 py-2 text-sm"
                >
                  Agregar
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {excludedKeywords.map((kw) => (
                  <button
                    key={kw}
                    type="button"
                    onClick={() =>
                      setExcludedKeywords((prev) =>
                        prev.filter((k) => k !== kw),
                      )
                    }
                    className="rounded-full bg-surface-2 px-3 py-1 text-sm"
                  >
                    {kw} ×
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="mt-4 text-sm text-danger">{error}</p>}

          <div className="mt-10 flex gap-3">
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-lg border border-border px-4 py-3 text-sm"
            >
              Atrás
            </button>
            {needsLogistics ? (
              <button
                type="button"
                onClick={() => {
                  if (nicheKeywords.length === 0) {
                    setError("Agregá al menos una keyword");
                    return;
                  }
                  setError(null);
                  setStep(5);
                }}
                className="rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white"
              >
                Continuar
              </button>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  if (
                    goal !== "browse_ads" &&
                    nicheKeywords.length === 0
                  ) {
                    setError("Agregá al menos una keyword");
                    return;
                  }
                  void finish();
                }}
                className="rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white disabled:opacity-60"
              >
                {saving ? "Guardando…" : "Ver anuncios"}
              </button>
            )}
          </div>
        </section>
      )}

      {step === 5 && needsLogistics && (
        <section className="flex flex-1 flex-col">
          <h1 className="font-display text-3xl">
            ¿Tenés lugar para guardar stock?
          </h1>
          <p className="mt-2 text-muted">Opcional — nos ayuda a filtrar mejor.</p>
          <div className="mt-6 flex flex-col gap-2">
            {(
              [
                [true, "Sí"],
                [false, "No / dropshipping"],
              ] as const
            ).map(([val, label]) => (
              <button
                key={String(val)}
                type="button"
                onClick={() => setHasWarehouseStorage(val)}
                className={`rounded-xl border px-4 py-4 text-left ${
                  hasWarehouseStorage === val
                    ? "border-accent bg-surface"
                    : "border-border bg-surface"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {error && <p className="mt-4 text-sm text-danger">{error}</p>}
          <div className="mt-10 flex gap-3">
            <button
              type="button"
              onClick={() => setStep(4)}
              className="rounded-lg border border-border px-4 py-3 text-sm"
            >
              Atrás
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void finish()}
              className="rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white disabled:opacity-60"
            >
              {saving ? "Guardando…" : "Ver anuncios"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
