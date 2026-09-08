"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleChip } from "@/components/ToggleChip";
import { NichePicker } from "@/components/NichePicker";

const CHANNELS = ["Mercado Libre", "Tienda propia", "Instagram", "WhatsApp"];

export default function TiendaPage() {
  const router = useRouter();
  const user = useQuery(api.users.me);
  const profile = useQuery(api.users.getBusinessProfile);
  const allCategories = useQuery(api.categories.list);
  const userCategories = useQuery(api.categories.listForUser);

  useEffect(() => {
    if (user === null) return;
    if (user && !user.onboardingComplete) {
      router.replace("/onboarding");
    }
  }, [user, router]);

  if (
    user === undefined ||
    profile === undefined ||
    allCategories === undefined ||
    userCategories === undefined
  ) {
    return (
      <AppShell>
        <p className="text-muted-foreground">Cargando tienda…</p>
      </AppShell>
    );
  }

  if (!profile || !user) {
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
        categories={allCategories}
        maxNiches={user.plan === "pro" ? 3 : 1}
        initial={{
          businessName: profile.businessName,
          description: profile.description ?? "",
          nicheIds: profile.nicheIds,
          channels: profile.channels ?? [],
          categoryIds: userCategories.map((c) => c._id),
        }}
      />
    </AppShell>
  );
}

type CategoryOption = {
  _id: Id<"categories">;
  name: string;
};

function TiendaForm({
  categories,
  maxNiches,
  initial,
}: {
  categories: CategoryOption[];
  maxNiches: number;
  initial: {
    businessName: string;
    description: string;
    nicheIds: Id<"radarNiches">[];
    channels: string[];
    categoryIds: Id<"categories">[];
  };
}) {
  const updateProfile = useMutation(api.users.updateBusinessProfile);
  const [businessName, setBusinessName] = useState(initial.businessName);
  const [description, setDescription] = useState(initial.description);
  const [nicheIds, setNicheIds] = useState(initial.nicheIds);
  const [channels, setChannels] = useState(initial.channels);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState(
    initial.categoryIds,
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  function toggleChannel(ch: string) {
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((x) => x !== ch) : [...prev, ch],
    );
  }

  function toggleCategory(id: Id<"categories">) {
    setSelectedCategoryIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  }

  const canSave = businessName.trim().length > 0 && nicheIds.length > 0;

  async function save() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await updateProfile({
        businessName,
        description: description.trim() || undefined,
        nicheIds,
        channels: channels.length ? channels : undefined,
        categoryIds: selectedCategoryIds,
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
        Editá tu nicho. Usamos esto para mostrarte los anuncios más relevantes.
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
            {maxNiches === 1 ? "Nicho" : `Nichos (hasta ${maxNiches})`}
          </span>
          <NichePicker
            selected={nicheIds}
            onChange={setNicheIds}
            maxSelect={maxNiches}
          />
        </div>

        <div>
          <span className="mb-1.5 block text-xs text-muted-foreground">
            Categorías
          </span>
          {categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Todavía no hay categorías cargadas.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {categories.map((cat) => (
                <ToggleChip
                  key={cat._id}
                  selected={selectedCategoryIds.includes(cat._id)}
                  onClick={() => toggleCategory(cat._id)}
                >
                  {cat.name}
                </ToggleChip>
              ))}
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
        {saved && <p className="text-sm text-primary">Guardado.</p>}

        <Button
          type="button"
          disabled={saving || !canSave}
          onClick={() => void save()}
          className="w-full"
        >
          {saving ? "Guardando…" : "Guardar"}
        </Button>
      </Card>
    </div>
  );
}
