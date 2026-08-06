import Link from "next/link";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/BrandLogo";

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
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

      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 pt-10 pb-20">
        <h1 className="max-w-2xl text-4xl leading-tight text-foreground md:text-5xl">
          Encontrá productos que ya se están anunciando en Argentina
        </h1>
        <p className="mt-4 max-w-lg text-lg text-muted-foreground">
          Miramos anuncios de Meta que están activos hoy. Vos elegís qué
          vender.
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
      </section>
    </main>
  );
}
