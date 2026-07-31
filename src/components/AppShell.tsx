"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const adsActive = pathname.startsWith("/ads");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/" className="font-display text-lg text-foreground">
              TrendOS
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/ads"
                className={`rounded-md px-3 py-1.5 ${
                  adsActive
                    ? "bg-surface-2 font-medium text-foreground"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Anuncios
              </Link>
            </nav>
          </div>
          <UserButton />
        </div>
      </header>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</div>
    </div>
  );
}
