import Link from "next/link";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <span className="font-display text-2xl tracking-tight text-accent">
          TrendOS
        </span>
        <nav className="flex items-center gap-3">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition hover:border-accent/50">
                Entrar
              </button>
            </SignInButton>
            <Link
              href="/sign-up"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-background transition hover:brightness-110"
            >
              Crear cuenta
            </Link>
          </Show>
          <Show when="signed-in">
            <Link
              href="/trends"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-background"
            >
              Ir a Trends
            </Link>
            <UserButton />
          </Show>
        </nav>
      </header>

      <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 pb-24 pt-8">
        <p className="mb-4 text-sm uppercase tracking-[0.2em] text-muted">
          LATAM · Mercado Libre · Google Trends
        </p>
        <h1 className="font-display max-w-3xl text-5xl leading-[1.05] text-foreground md:text-7xl">
          TrendOS
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted md:text-xl">
          Productos y keywords que se están vendiendo ahora. Score de tendencia
          0–1, actualizado cada 8 horas.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Show when="signed-out">
            <Link
              href="/sign-up"
              className="rounded-md bg-accent px-6 py-3 text-base font-medium text-background"
            >
              Empezar gratis
            </Link>
          </Show>
          <Show when="signed-in">
            <Link
              href="/onboarding"
              className="rounded-md bg-accent px-6 py-3 text-base font-medium text-background"
            >
              Completar onboarding
            </Link>
            <Link
              href="/trends"
              className="rounded-md border border-border px-6 py-3 text-base text-foreground"
            >
              Ver Trends
            </Link>
          </Show>
        </div>
      </section>
    </main>
  );
}
