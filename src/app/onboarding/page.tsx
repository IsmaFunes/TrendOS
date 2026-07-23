"use client";

import { useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

const SITES = [
  { id: "MLA", label: "Argentina" },
  { id: "MLM", label: "México" },
  { id: "MLB", label: "Brasil" },
  { id: "MLC", label: "Chile" },
  { id: "MCO", label: "Colombia" },
] as const;

const CHANNELS = ["Mercado Libre", "Tienda propia", "Instagram", "WhatsApp"];
const MAX_KEYWORDS = 3;

export default function OnboardingPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const user = useQuery(api.users.me);
  const categories = useQuery(api.categories.list);
  const ensureUser = useMutation(api.users.ensureUser);
  const seedCategories = useMutation(api.categories.seed);
  const completeOnboarding = useMutation(api.users.completeOnboarding);

  const [step, setStep] = useState(1);
  const [siteId, setSiteId] = useState("MLA");
  const [selected, setSelected] = useState<Id<"categories">[]>([]);
  const [businessName, setBusinessName] = useState("");
  const [description, setDescription] = useState("");
  const [nicheKeywords, setNicheKeywords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    if (authLoading || !isAuthenticated || bootstrapped) return;
    void (async () => {
      try {
        await ensureUser({});
        await seedCategories({});
        setBootstrapped(true);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "No se pudo inicializar la sesión de usuario",
        );
      }
    })();
  }, [authLoading, isAuthenticated, bootstrapped, ensureUser, seedCategories]);

  useEffect(() => {
    if (user?.onboardingComplete) {
      router.replace("/trends");
    }
  }, [user, router]);

  function toggleCategory(id: Id<"categories">) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function toggleChannel(ch: string) {
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((x) => x !== ch) : [...prev, ch],
    );
  }

  function addKeyword() {
    const value = keywordDraft.trim().replace(/\s+/g, " ");
    if (!value) return;
    if (nicheKeywords.length >= MAX_KEYWORDS) return;
    const exists = nicheKeywords.some(
      (k) => k.toLowerCase() === value.toLowerCase(),
    );
    if (exists) {
      setKeywordDraft("");
      return;
    }
    setNicheKeywords((prev) => [...prev, value]);
    setKeywordDraft("");
  }

  function removeKeyword(kw: string) {
    setNicheKeywords((prev) => prev.filter((k) => k !== kw));
  }

  const canSubmit =
    businessName.trim() &&
    (nicheKeywords.length > 0 || description.trim().length > 0);

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      if (!bootstrapped) {
        await ensureUser({});
        await seedCategories({});
        setBootstrapped(true);
      }
      await completeOnboarding({
        siteId,
        categoryIds: selected,
        businessName,
        description: description.trim() || undefined,
        nicheKeywords: nicheKeywords.length ? nicheKeywords : undefined,
        channels: channels.length ? channels : undefined,
      });
      router.push("/trends");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || user === undefined || categories === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted">
        Cargando…
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-muted">Tenés que iniciar sesión para continuar.</p>
        <Link
          href="/sign-in"
          className="rounded-md bg-accent px-4 py-2 text-background"
        >
          Entrar
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-8">
      <header className="mb-10 flex items-center justify-between">
        <Link href="/" className="font-display text-xl text-accent">
          TrendOS
        </Link>
        <UserButton />
      </header>

      <p className="text-sm text-muted">Paso {step} de 2</p>
      <h1 className="font-display mt-2 text-3xl md:text-4xl">
        {step === 1 ? "¿Qué querés vender?" : "Tu nicho de tienda"}
      </h1>
      <p className="mt-2 text-muted">
        {step === 1
          ? "Elegí país y categorías. La investigación se acota a tu nicho."
          : "Keywords + descripción definen qué productos investigamos (nada fuera de tu negocio)."}
      </p>

      {error && step === 1 ? (
        <p className="mt-4 text-sm text-danger">{error}</p>
      ) : null}

      {step === 1 ? (
        <div className="mt-8 space-y-8">
          <div>
            <label className="mb-2 block text-sm text-muted">País</label>
            <div className="flex flex-wrap gap-2">
              {SITES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSiteId(s.id)}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    siteId === s.id
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border text-foreground"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm text-muted">Categorías</label>
            <div className="grid gap-2 sm:grid-cols-2">
              {categories.map((cat) => {
                const active = selected.includes(cat._id);
                return (
                  <button
                    key={cat._id}
                    type="button"
                    onClick={() => toggleCategory(cat._id)}
                    className={`rounded-md border px-4 py-3 text-left ${
                      active
                        ? "border-accent bg-accent/10"
                        : "border-border bg-surface"
                    }`}
                  >
                    <div className="font-medium">{cat.name}</div>
                    {cat.description ? (
                      <div className="mt-1 text-sm text-muted">
                        {cat.description}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            disabled={selected.length === 0}
            onClick={() => setStep(2)}
            className="rounded-md bg-accent px-5 py-3 font-medium text-background disabled:opacity-40"
          >
            Continuar
          </button>
        </div>
      ) : (
        <div className="mt-8 space-y-5">
          <Field label="Nombre del negocio">
            <input
              className="w-full rounded-md border border-border bg-surface px-3 py-2"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Mi tienda"
            />
          </Field>

          <div>
            <span className="mb-2 block text-sm text-muted">
              Keywords de nicho (hasta {MAX_KEYWORDS})
            </span>
            <div className="flex flex-wrap gap-2">
              {nicheKeywords.map((kw) => (
                <button
                  key={kw}
                  type="button"
                  onClick={() => removeKeyword(kw)}
                  className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm text-accent"
                  title="Quitar"
                >
                  {kw} ×
                </button>
              ))}
            </div>
            {nicheKeywords.length < MAX_KEYWORDS ? (
              <div className="mt-2 flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2"
                  value={keywordDraft}
                  onChange={(e) => setKeywordDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addKeyword();
                    }
                  }}
                  placeholder="Ej. mates, termos, bombillas"
                />
                <button
                  type="button"
                  onClick={addKeyword}
                  className="rounded-md border border-border px-3 py-2 text-sm"
                >
                  Agregar
                </button>
              </div>
            ) : null}
          </div>

          <Field label="Tipo de producto que revendés (corto)">
            <textarea
              className="w-full rounded-md border border-border bg-surface px-3 py-2"
              rows={2}
              maxLength={200}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ej. Vendo mates, termos y accesorios para cebar"
            />
            <span className="mt-1 block text-xs text-muted">
              {description.length}/200
            </span>
          </Field>

          <Field label="Canales (opcional)">
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => toggleChannel(ch)}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    channels.includes(ch)
                      ? "border-accent text-accent"
                      : "border-border"
                  }`}
                >
                  {ch}
                </button>
              ))}
            </div>
          </Field>

          {error ? <p className="text-sm text-danger">{error}</p> : null}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-md border border-border px-5 py-3"
            >
              Atrás
            </button>
            <button
              type="button"
              disabled={saving || !canSubmit}
              onClick={() => void submit()}
              className="rounded-md bg-accent px-5 py-3 font-medium text-background disabled:opacity-40"
            >
              {saving ? "Guardando…" : "Ver Trends"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}
