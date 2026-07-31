"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

const CHANNELS = ["Mercado Libre", "Tienda propia", "Instagram", "WhatsApp"];
const MAX_KEYWORDS = 3;

export default function TiendaPage() {
  const router = useRouter();
  const user = useQuery(api.users.me);
  const profile = useQuery(api.users.getBusinessProfile);

  useEffect(() => {
    if (user === null) return;
    if (user && !user.onboardingComplete) {
      router.replace("/onboarding");
    }
  }, [user, router]);

  if (user === undefined || profile === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted">
        Cargando tienda…
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-muted">Todavía no tenés perfil de tienda.</p>
        <Link href="/onboarding" className="text-accent underline">
          Completar onboarding
        </Link>
      </main>
    );
  }

  return (
    <TiendaForm
      key={`${profile._id}-${profile.updatedAt}`}
      initial={{
        businessName: profile.businessName,
        description: profile.description ?? "",
        nicheKeywords: profile.nicheKeywords ?? [],
        channels: profile.channels ?? [],
      }}
    />
  );
}

function TiendaForm({
  initial,
}: {
  initial: {
    businessName: string;
    description: string;
    nicheKeywords: string[];
    channels: string[];
  };
}) {
  const updateProfile = useMutation(api.users.updateBusinessProfile);
  const [businessName, setBusinessName] = useState(initial.businessName);
  const [description, setDescription] = useState(initial.description);
  const [nicheKeywords, setNicheKeywords] = useState(initial.nicheKeywords);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [channels, setChannels] = useState(initial.channels);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  function addKeyword() {
    const value = keywordDraft.trim().replace(/\s+/g, " ");
    if (!value || nicheKeywords.length >= MAX_KEYWORDS) return;
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

  function toggleChannel(ch: string) {
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((x) => x !== ch) : [...prev, ch],
    );
  }

  const canSave =
    businessName.trim() &&
    (nicheKeywords.length > 0 || description.trim().length > 0);

  async function save() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await updateProfile({
        businessName,
        description: description.trim() || undefined,
        nicheKeywords: nicheKeywords.length ? nicheKeywords : undefined,
        channels: channels.length ? channels : undefined,
        scheduleResearch: true,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-8">
      <header className="mb-10 flex items-center justify-between">
        <Link href="/ads" className="font-display text-xl text-foreground">
          TrendOS
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href="/ads"
            className="rounded-md border border-border px-3 py-2 text-sm"
          >
            Anuncios
          </Link>
          <UserButton />
        </div>
      </header>

      <h1 className="font-display text-3xl md:text-4xl">Mi tienda</h1>
      <p className="mt-2 text-muted">
        Editá tu nicho. Usamos estas keywords para filtrar anuncios.
      </p>

      <div className="mt-8 space-y-5">
        <label className="block">
          <span className="mb-2 block text-sm text-muted">
            Nombre del negocio
          </span>
          <input
            className="w-full rounded-md border border-border bg-surface px-3 py-2"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
          />
        </label>

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
                placeholder="Ej. mates"
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

        <label className="block">
          <span className="mb-2 block text-sm text-muted">
            Tipo de producto que revendés
          </span>
          <textarea
            className="w-full rounded-md border border-border bg-surface px-3 py-2"
            rows={2}
            maxLength={200}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            {description.length}/200
          </span>
        </label>

        <div>
          <span className="mb-2 block text-sm text-muted">Canales</span>
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
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {saved ? (
          <p className="text-sm text-accent">
            Guardado. Investigación encolada para tu nicho.
          </p>
        ) : null}

        <button
          type="button"
          disabled={saving || !canSave}
          onClick={() => void save()}
          className="rounded-md bg-accent px-5 py-3 font-medium text-background disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Guardar y reinvestigar"}
        </button>
      </div>
    </main>
  );
}
