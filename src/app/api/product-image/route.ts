/**
 * Resolve a product preview image from a research/source URL (or an explicit
 * image hint from Gemini). Nothing is stored — fetch + extract on demand.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const UA =
  "Mozilla/5.0 (compatible; TrendOSPreview/1.0; +https://trendos.local)";

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function extractMetaContent(html: string, property: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`,
      "i",
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function absolutize(base: string, maybeRelative: string): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

async function resolveImageUrl(
  pageUrl: string,
  hint: string | null,
): Promise<string | null> {
  if (hint && isHttpUrl(hint)) return hint;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(pageUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": UA,
      },
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 250_000);
    const candidates = [
      extractMetaContent(html, "og:image"),
      extractMetaContent(html, "og:image:url"),
      extractMetaContent(html, "twitter:image"),
      extractMetaContent(html, "twitter:image:src"),
    ].filter((c): c is string => !!c);

    for (const c of candidates) {
      const abs = absolutize(pageUrl, c);
      if (abs && isHttpUrl(abs)) return abs;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pageUrl = searchParams.get("url");
  const hint = searchParams.get("hint");

  if ((!pageUrl || !isHttpUrl(pageUrl)) && !(hint && isHttpUrl(hint))) {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  const imageUrl = await resolveImageUrl(
    pageUrl && isHttpUrl(pageUrl) ? pageUrl : hint!,
    hint && isHttpUrl(hint) ? hint : null,
  );
  if (!imageUrl) {
    return new NextResponse(null, { status: 404 });
  }

  // JSON mode for clients that want the resolved URL
  if (searchParams.get("format") === "json") {
    return NextResponse.json(
      { imageUrl },
      {
        headers: {
          "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
        },
      },
    );
  }

  // Proxy the image bytes so hotlink blocks / mixed CDNs still render.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const imgRes = await fetch(imageUrl, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "image/*" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!imgRes.ok || !imgRes.body) {
      return new NextResponse(null, { status: 404 });
    }
    const contentType = imgRes.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return new NextResponse(null, { status: 404 });
    }
    return new NextResponse(imgRes.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
