"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { type ReactNode, useMemo } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const client = useMemo(() => {
    if (!convexUrl) {
      throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
    }
    return new ConvexReactClient(convexUrl);
  }, [convexUrl]);

  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#9184d9",
          colorBackground: "#232532",
          colorForeground: "#e9e9ed",
          colorMuted: "#292b31",
          colorMutedForeground: "rgba(233,233,237,0.55)",
          colorInput: "#161826",
          colorInputForeground: "#e9e9ed",
          colorBorder: "color-mix(in srgb, #e9e9ed 16%, transparent)",
          colorDanger: "#ef4444",
          colorRing: "#9184d9",
          colorNeutral: "#e9e9ed",
          borderRadius: "0.5rem",
          fontFamily: "var(--font-sans), system-ui, sans-serif",
        },
      }}
    >
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
