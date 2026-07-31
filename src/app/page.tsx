import Link from "next/link";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <span className="font-display text-xl text-foreground">TrendOS</span>
        <nav className="flex items-center gap-3">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button className="rounded-lg border border-border bg-surface px-4 py-2 text-sm text-foreground">
                Entrar
              </button>
            </SignInButton>
            <Link
              href="/sign-up"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              Crear cuenta
            </Link>
          </Show>
          <Show when="signed-in">
            <Link
              href="/ads"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              Anuncios
            </Link>
            <UserButton />
          </Show>
        </nav>
      </header>

      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 pb-20 pt-10">
        <h1 className="font-display max-w-2xl text-4xl leading-tight text-foreground md:text-5xl">
          Encontrá productos que ya se están anunciando en Argentina
        </h1>
        <p className="mt-4 max-w-lg text-lg text-muted">
          Miramos anuncios de Meta que están activos hoy. Vos elegís qué vender.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Show when="signed-out">
            <Link
              href="/sign-up"
              className="rounded-lg bg-accent px-6 py-3 text-base font-medium text-white"
            >
              Empezar
            </Link>
          </Show>
          <Show when="signed-in">
            <Link
              href="/onboarding"
              className="rounded-lg bg-accent px-6 py-3 text-base font-medium text-white"
            >
              Continuar
            </Link>
            <Link
              href="/ads"
              className="rounded-lg border border-border bg-surface px-6 py-3 text-base text-foreground"
            >
              Ver anuncios
            </Link>
          </Show>
        </div>
      </section>
    </main>
  );
}
