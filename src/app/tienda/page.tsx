"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ToggleChip } from "@/components/ToggleChip";

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
      <AppShell>
        <p className="text-muted-foreground">Cargando tienda…</p>
      </AppShell>
    );
  }

  if (!profile) {
    return (
      <AppShell>
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-muted-foreground">
            Todavía no tenés perfil de tienda.
          </p>
          <Link href="/onboarding" className="text-primary underline">
            Completar onboarding
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <TiendaForm
        key={`${profile._id}-${profile.updatedAt}`}
        initial={{
          businessName: profile.businessName,
          description: profile.description ?? "",
          nicheKeywords: profile.nicheKeywords ?? [],
          channels: profile.channels ?? [],
        }}
      />
    </AppShell>
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
    <div className="max-w-2xl">
      <h2>Mi tienda</h2>
      <p className="mt-1 text-muted-foreground">
        Editá tu nicho. Usamos estas keywords para filtrar anuncios.
      </p>

      <Card className="mt-8 gap-5 p-6">
        <label className="block">
          <span className="mb-1.5 block text-xs text-muted-foreground">
            Nombre del negocio
          </span>
          <Input
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
          />
        </label>

        <div>
          <span className="mb-1.5 block text-xs text-muted-foreground">
            Keywords de nicho (hasta {MAX_KEYWORDS})
          </span>
          <div className="flex flex-wrap gap-2">
            {nicheKeywords.map((kw) => (
              <Badge
                key={kw}
                variant="outline"
                render={
                  <button type="button" onClick={() => removeKeyword(kw)} />
                }
              >
                {kw} ✕
              </Badge>
            ))}
          </div>
          {nicheKeywords.length < MAX_KEYWORDS && (
            <div className="mt-2 flex gap-2">
              <Input
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
              <Button type="button" variant="secondary" onClick={addKeyword}>
                Agregar
              </Button>
            </div>
          )}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs text-muted-foreground">
            Tipo de producto que revendés
          </span>
          <Textarea
            rows={2}
            maxLength={200}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            {description.length}/200
          </span>
        </label>

        <div>
          <span className="mb-1.5 block text-xs text-muted-foreground">
            Canales
          </span>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((ch) => (
              <ToggleChip
                key={ch}
                selected={channels.includes(ch)}
                onClick={() => toggleChannel(ch)}
              >
                {ch}
              </ToggleChip>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && (
          <p className="text-sm text-primary">
            Guardado. Investigación encolada para tu nicho.
          </p>
        )}

        <Button
          type="button"
          disabled={saving || !canSave}
          onClick={() => void save()}
          className="w-full"
        >
          {saving ? "Guardando…" : "Guardar y reinvestigar"}
        </Button>
      </Card>
    </div>
  );
}
