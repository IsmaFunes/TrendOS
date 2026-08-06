"use client";

import { useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Check, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ToggleChip } from "@/components/ToggleChip";
import { BrandLogo } from "@/components/BrandLogo";
import { cn } from "@/lib/utils";

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

const STEP_LABELS = [
  "Argentina",
  "Objetivo",
  "Canales",
  "Categorías",
  "Nicho",
  "Logística",
];

function Stepper({ step, total }: { step: number; total: number }) {
  const labels = STEP_LABELS.slice(0, total);
  return (
    <div className="mb-8 flex items-center">
      {labels.map((label, idx) => {
        const n = idx + 1;
        const isDone = n < step;
        const isCurrent = n === step;
        return (
          <div key={label} className="flex flex-1 items-center last:flex-none">
            {idx > 0 && (
              <div
                className={cn(
                  "mx-1 mb-[18px] h-px flex-1",
                  n <= step ? "bg-accent-700" : "bg-border",
                )}
              />
            )}
            <div className="flex flex-none flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex size-7 flex-none items-center justify-center rounded-full text-xs",
                  isDone && "bg-accent-800 text-accent-100",
                  isCurrent &&
                    "border-[1.5px] border-primary font-semibold text-accent-200",
                  !isDone && !isCurrent && "border-[1.5px] border-neutral-700 text-neutral-600",
                )}
              >
                {isDone ? <Check className="size-3.5" /> : n}
              </div>
              <span
                className={cn(
                  "text-[11px]",
                  isCurrent ? "text-accent-200" : "text-neutral-500",
                )}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChoiceButton({
  selected,
  onClick,
  title,
  subtitle,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtitle?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border-[1.5px] px-4 py-3.5 text-left text-sm transition-colors",
        selected
          ? "border-primary bg-primary/12 text-accent-100"
          : "border-border bg-transparent text-neutral-300 hover:border-neutral-500",
      )}
    >
      <div className="font-medium">{title}</div>
      {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
    </button>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const user = useQuery(api.users.me);
  const categories = useQuery(api.categories.list);
  const ensureUser = useMutation(api.users.ensureUser);
  const completeOnboarding = useMutation(api.users.completeOnboarding);

  const [step, setStep] = useState(1);
  const [goal, setGoal] = useState<BusinessGoal | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [storeUrl, setStoreUrl] = useState("");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<
    Id<"categories">[]
  >([]);
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

  function toggleCategory(id: Id<"categories">) {
    setSelectedCategoryIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
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
  const totalSteps = needsLogistics ? 6 : 5;

  async function finish() {
    if (!goal) return;
    setSaving(true);
    setError(null);
    try {
      await completeOnboarding({
        goal,
        channels: channels.length ? channels : undefined,
        existingStoreUrl: storeUrl.trim() || undefined,
        categoryIds: selectedCategoryIds.length ? selectedCategoryIds : undefined,
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
      <main className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        Cargando…
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-4 px-6">
        <h1 className="font-display text-2xl">Entrá para continuar</h1>
        <Button size="lg" className="w-full" render={<Link href="/sign-in" />}>
          Iniciar sesión
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-6 py-12 md:py-16">
      <div className="mb-8 flex items-center justify-between">
        <BrandLogo href="/" size="sm" />
        <UserButton />
      </div>

      <h1 className="text-[30px]">Contanos sobre tu negocio</h1>
      <p className="max-w-[56ch] text-muted-foreground">
        Esto nos ayuda a armar tu nicho y encontrar los productos con más
        potencial para vos.
      </p>

      <Stepper step={step} total={totalSteps} />

      <Card className="min-h-[340px] gap-0 p-8 shadow-elev-md">
        {step === 1 && (
          <section className="flex flex-1 flex-col">
            <h3>Empezamos en Argentina</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Por ahora solo buscamos anuncios y productos para el mercado
              argentino.
            </p>
          </section>
        )}

        {step === 2 && (
          <section className="flex flex-1 flex-col">
            <h3>¿Qué querés hacer?</h3>
            <div className="mt-6 flex max-w-[420px] flex-col gap-2.5">
              {GOALS.map((g) => (
                <ChoiceButton
                  key={g.id}
                  selected={goal === g.id}
                  onClick={() => setGoal(g.id)}
                  title={g.title}
                  subtitle={g.subtitle}
                />
              ))}
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="flex flex-1 flex-col">
            <h3>¿Por dónde vendés?</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Podés elegir más de uno.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
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
            {needsStoreUrl && (
              <label className="mt-6 block max-w-[360px]">
                <span className="mb-1.5 block text-xs text-muted-foreground">
                  Link de tu tienda (opcional)
                </span>
                <Input
                  value={storeUrl}
                  onChange={(e) => setStoreUrl(e.target.value)}
                  placeholder="https://…"
                />
              </label>
            )}
          </section>
        )}

        {step === 4 && (
          <section className="flex flex-1 flex-col">
            <h3>¿Qué categorías vendés?</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Elegí todas las que apliquen — podés ajustar esto después.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {categories === undefined && (
                <p className="text-sm text-muted-foreground">
                  Cargando categorías…
                </p>
              )}
              {categories?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Todavía no hay categorías cargadas — podés saltar este paso
                  y usar keywords en el siguiente.
                </p>
              )}
              {categories?.map((cat) => (
                <ToggleChip
                  key={cat._id}
                  selected={selectedCategoryIds.includes(cat._id)}
                  onClick={() => toggleCategory(cat._id)}
                >
                  {cat.name}
                </ToggleChip>
              ))}
            </div>
          </section>
        )}

        {step === 5 && (
          <section className="flex flex-1 flex-col">
            <h3>Nicho específico</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {selectedCategoryIds.length > 0
                ? "Opcional — sumá palabras clave para afinar más tu nicho dentro de las categorías que elegiste."
                : "Escribí palabras clave (ej. cocina, mascotas, fitness)."}
            </p>
            <div className="mt-6 flex max-w-[420px] gap-2">
              <Input
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
                placeholder="Agregar keyword"
              />
              <Button type="button" variant="secondary" onClick={addKeyword}>
                Agregar
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {nicheKeywords.map((kw) => (
                <Badge
                  key={kw}
                  variant="outline"
                  render={
                    <button
                      type="button"
                      onClick={() =>
                        setNicheKeywords((prev) =>
                          prev.filter((k) => k !== kw),
                        )
                      }
                    />
                  }
                >
                  {kw} ✕
                </Badge>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowExclusions((v) => !v)}
              className="mt-6 text-left text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {showExclusions ? "Ocultar" : "No quiero vender…"}
            </button>
            {showExclusions && (
              <div className="mt-2 max-w-[420px]">
                <div className="flex gap-2">
                  <Input
                    value={excludeDraft}
                    onChange={(e) => setExcludeDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addExclusion();
                      }
                    }}
                    placeholder="ej. suplementos"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={addExclusion}
                  >
                    Agregar
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {excludedKeywords.map((kw) => (
                    <Badge
                      key={kw}
                      variant="secondary"
                      render={
                        <button
                          type="button"
                          onClick={() =>
                            setExcludedKeywords((prev) =>
                              prev.filter((k) => k !== kw),
                            )
                          }
                        />
                      }
                    >
                      {kw} ✕
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          </section>
        )}

        {step === 6 && needsLogistics && (
          <section className="flex flex-1 flex-col">
            <h3>¿Tenés lugar para guardar stock?</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Opcional — nos ayuda a filtrar mejor.
            </p>
            <div className="mt-6 flex max-w-[420px] flex-col gap-2.5">
              {(
                [
                  [true, "Sí"],
                  [false, "No / dropshipping"],
                ] as const
              ).map(([val, label]) => (
                <ChoiceButton
                  key={String(val)}
                  selected={hasWarehouseStorage === val}
                  onClick={() => setHasWarehouseStorage(val)}
                  title={label}
                />
              ))}
            </div>
            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          </section>
        )}

        <div className="mt-auto flex gap-2.5 pt-8">
          {step > 1 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep((s) => s - 1)}
            >
              Atrás
            </Button>
          )}
          {step < totalSteps ? (
            <Button
              type="button"
              className="flex-1"
              onClick={() => {
                if (
                  step === 5 &&
                  goal !== "browse_ads" &&
                  nicheKeywords.length === 0 &&
                  selectedCategoryIds.length === 0
                ) {
                  setError("Elegí una categoría o agregá una keyword");
                  return;
                }
                setError(null);
                setStep((s) => s + 1);
              }}
              disabled={step === 2 && !goal}
            >
              Continuar
              <ChevronRight className="size-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              className="flex-1"
              disabled={saving}
              onClick={() => {
                if (
                  goal !== "browse_ads" &&
                  nicheKeywords.length === 0 &&
                  selectedCategoryIds.length === 0
                ) {
                  setError("Elegí una categoría o agregá una keyword");
                  return;
                }
                void finish();
              }}
            >
              {saving ? "Guardando…" : "Finalizar"}
              <ChevronRight className="size-3.5" />
            </Button>
          )}
        </div>
      </Card>
    </main>
  );
}
