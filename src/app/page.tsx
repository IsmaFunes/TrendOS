import Link from "next/link";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { Compass, Megaphone, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { BrandLogo } from "@/components/BrandLogo";

const STEPS = [
  {
    icon: Compass,
    title: "Elegí tu nicho",
    body: "De un catálogo ya armado: mates, tecnología, fitness y más.",
  },
  {
    icon: Megaphone,
    title: "Vemos qué se anuncia",
    body: "Escaneamos Meta todos los días y te mostramos los anuncios activos.",
  },
  {
    icon: ShoppingBag,
    title: "Investigá el producto",
    body: "Lo buscamos en Mercado Libre y con proveedores para que sepas el margen.",
  },
];

function HeroPreviewCard({
  pageName,
  days,
  quality,
  position,
}: {
  pageName: string;
  days: number;
  quality: string;
  position: string;
}) {
  return (
    <Card
      className={`absolute w-[72%] gap-0 overflow-hidden p-0 shadow-elev-lg ${position}`}
    >
      <div className="flex aspect-[4/3] items-center justify-center bg-surface-2">
        <ShoppingBag className="size-9 text-neutral-600" strokeWidth={1.3} />
      </div>
      <div className="flex flex-col gap-2 p-4">
        <span className="truncate text-[13px] font-medium">{pageName}</span>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-[10.5px]">
            {days} días activo
          </Badge>
          <Badge variant="outline" className="text-[10.5px]">
            Activo
          </Badge>
        </div>
        <p className="text-xs text-primary">{quality}</p>
      </div>
    </Card>
  );
}

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <BrandLogo />
        <nav className="flex items-center gap-3">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button variant="secondary">Entrar</Button>
            </SignInButton>
            <Button render={<Link href="/sign-up" />}>Crear cuenta</Button>
          </Show>
          <Show when="signed-in">
            <Button variant="secondary" render={<Link href="/ads" />}>
              Anuncios
            </Button>
            <UserButton />
          </Show>
        </nav>
      </header>

      <section className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 py-10 md:grid-cols-2 md:py-16">
        <div>
          <h1 className="max-w-xl text-4xl leading-tight text-foreground md:text-5xl">
            Encontrá productos que ya se están anunciando en Argentina
          </h1>
          <p className="mt-4 max-w-md text-lg text-muted-foreground">
            Vemos qué se anuncia hoy en Meta y te ayudamos a conseguirlo:
            match con Mercado Libre y proveedores.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Show when="signed-out">
              <Button size="lg" render={<Link href="/sign-up" />}>
                Empezar
              </Button>
            </Show>
            <Show when="signed-in">
              <Button size="lg" render={<Link href="/onboarding" />}>
                Continuar
              </Button>
              <Button size="lg" variant="secondary" render={<Link href="/ads" />}>
                Ver anuncios
              </Button>
            </Show>
          </div>
        </div>

        <div className="relative mx-auto hidden h-[360px] w-full max-w-sm md:block">
          <HeroPreviewCard
            pageName="Termos del Sur"
            days={62}
            quality="Tienda muy activa"
            position="right-0 bottom-0 rotate-[4deg]"
          />
          <HeroPreviewCard
            pageName="Mate Imperial AR"
            days={28}
            quality="Oportunidad alta"
            position="left-0 top-0 -rotate-[3deg]"
          />
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl border-t border-border px-6 py-16">
        <div className="grid gap-10 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={step.title} className="flex flex-col gap-3 pt-6 first:pt-0 sm:px-6 sm:pt-0 sm:first:pl-0">
                <div className="flex items-center gap-2.5">
                  <Icon className="size-[18px] text-primary" strokeWidth={1.6} />
                  <span className="font-mono text-xs text-muted-foreground">
                    {i + 1}
                  </span>
                </div>
                <h3 className="text-base">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      <Show when="signed-out">
        <section className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-6 pb-20 text-center">
          <h2 className="text-2xl">¿Listo para encontrar tu próximo producto?</h2>
          <Button size="lg" render={<Link href="/sign-up" />}>
            Empezar
          </Button>
        </section>
      </Show>
    </main>
  );
}
