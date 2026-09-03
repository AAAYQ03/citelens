import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import type { AnswerBlock, SourceDoc } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { question, sources, apiKey } = (await req.json()) as {
      question?: string;
      sources?: SourceDoc[];
      apiKey?: string;
    };
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) return NextResponse.json({ error: "no_key" }, { status: 400 });
    if (!question?.trim() || !Array.isArray(sources) || sources.length === 0) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: key });
    const content: Anthropic.ContentBlockParam[] = [
      ...sources.slice(0, 3).map((s) => ({
        type: "document" as const,
        source: {
          type: "text" as const,
          media_type: "text/plain" as const,
          data: String(s.content).slice(0, 30000),
        },
        title: String(s.title || "Source").slice(0, 200),
        citations: { enabled: true },
      })),
      {
        type: "text" as const,
        text:
          "Answer the question using ONLY the provided sources. Be concise (4-8 sentences). " +
          "Cite the sources for every factual claim. If the sources contradict a common belief, say so. " +
          "If something relevant is not covered by the sources, say it is not covered rather than stating it as fact.\n\n" +
          `Question: ${question.slice(0, 2000)}`,
      },
    ];

    const msg = await client.messages.create({
      model: process.env.ANSWER_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    });

    const blocks: AnswerBlock[] = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => ({
        text: b.text,
        citations: (b.citations ?? []).flatMap((c) =>
          c.type === "char_location"
            ? [{ docIndex: c.document_index, citedText: c.cited_text }]
            : []
        ),
      }));

    return NextResponse.json({ blocks });
  } catch (e) {
    const message = e instanceof Error ? e.message : "generation_failed";
    return NextResponse.json({ error: "generation_failed", message }, { status: 500 });
  }
}
