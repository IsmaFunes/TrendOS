"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { Megaphone, Store } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { BrandLogo } from "@/components/BrandLogo";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/ads", label: "Explorador de Ads", icon: Megaphone },
  { href: "/tienda", label: "Mi tienda", icon: Store },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useQuery(api.users.me);

  return (
    <div className="flex min-h-full flex-1">
      <aside className="sticky top-0 flex h-screen w-[250px] flex-none flex-col gap-8 border-r border-border px-4 py-6">
        <BrandLogo href="/ads" size="sm" className="px-2" />

        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border-l-2 border-transparent px-3 py-2 text-[13.5px] transition-colors",
                  active
                    ? "border-l-primary bg-primary/14 font-medium text-accent-100"
                    : "text-neutral-400 hover:bg-foreground/5 hover:text-foreground",
                )}
              >
                <Icon className="size-[18px]" strokeWidth={1.6} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <div className="flex items-center gap-2.5 border-t border-border px-2 pt-3">
          <UserButton />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">
              {user?.name || user?.email || "Mi cuenta"}
            </div>
            <Badge
              variant={user?.plan === "pro" ? "default" : "secondary"}
              className="mt-0.5"
            >
              {user?.plan === "pro" ? "Plan Pro" : "Plan Free"}
            </Badge>
          </div>
        </div>
      </aside>

      <main className="min-w-0 max-w-[1440px] flex-1 px-6 py-8 md:px-12 md:py-10">
        {children}
      </main>
    </div>
  );
}
