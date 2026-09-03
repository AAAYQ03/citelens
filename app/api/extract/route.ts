import { NextRequest, NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export const maxDuration = 30;

const PRIVATE_HOST = /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i;

export async function POST(req: NextRequest) {
  try {
    const { url } = (await req.json()) as { url?: string };
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) {
      throw new Error("blocked url");
    }
    const res = await fetch(u, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; CiteLens/0.1)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const html = await res.text();
    const dom = new JSDOM(html, { url: u.href });
    const article = new Readability(dom.window.document).parse();
    const content = (article?.textContent || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 30000);
    if (!content) throw new Error("empty");
    return NextResponse.json({
      title: article?.title || u.hostname,
      content,
      url: u.href,
    });
  } catch {
    return NextResponse.json({ error: "extract_failed" }, { status: 422 });
  }
}
