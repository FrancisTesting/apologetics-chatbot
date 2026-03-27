import { GoogleGenerativeAI } from "@google/generative-ai";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

type Chunk = {
  source: string;
  text: string;
};

type HistoryItem = {
  role?: "user" | "bot";
  content?: string;
};
type ResponseStyle = "short" | "medium" | "detailed";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function scoreChunk(query: string, chunkText: string): number {
  const q = tokenize(query);
  if (!q.length) return 0;
  const words = new Set(tokenize(chunkText));
  let score = 0;
  for (const token of q) {
    if (words.has(token)) score += 1;
  }
  return score / q.length;
}

function chunkText(text: string, source: string): Chunk[] {
  const clean = text.replace(/\r/g, "").trim();
  if (!clean) return [];
  const maxChars = 1200;
  const parts: Chunk[] = [];
  for (let i = 0; i < clean.length; i += maxChars) {
    parts.push({ source, text: clean.slice(i, i + maxChars) });
  }
  return parts;
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(full);
      files.push(...nested);
      continue;
    }

    if (/\.(txt|md)$/i.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

async function loadKnowledgeChunks(): Promise<Chunk[]> {
  const knowledgeDir = path.join(process.cwd(), "knowledge");
  try {
    const files = await collectFiles(knowledgeDir);
    const chunks: Chunk[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, "utf8");
      const source = path.relative(process.cwd(), file);
      chunks.push(...chunkText(text, source));
    }
    return chunks;
  } catch {
    return [];
  }
}

function retrieveTopChunks(question: string, chunks: Chunk[]): Chunk[] {
  const scored = chunks
    .map((c) => ({ chunk: c, score: scoreChunk(question, c.text) }))
    .sort((a, b) => b.score - a.score);

  const strong = scored.filter((x) => x.score >= 0.06).slice(0, 6);
  if (strong.length) return strong.map((x) => x.chunk);

  // Fallback for broad prompts like "explain", "summarize", "in simple words".
  return scored.slice(0, 4).map((x) => x.chunk);
}

function buildSearchQuery(message: string, history: HistoryItem[]): string {
  const normalized = message.trim();
  const isFollowup =
    tokenize(normalized).length <= 4 ||
    /\b(explain|why|how|example|more|clarify|it|this|that)\b/i.test(normalized);

  if (!isFollowup) return normalized;

  const lastUser = [...history]
    .reverse()
    .find((h) => h.role === "user" && h.content)?.content;
  const lastBot = [...history]
    .reverse()
    .find((h) => h.role === "bot" && h.content)?.content;

  return [lastUser, lastBot, normalized].filter(Boolean).join("\n");
}

async function resolveModel(apiKey: string): Promise<string[]> {
  const preferred = [
    process.env.GEMINI_MODEL,
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
  ].filter(Boolean) as string[];

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (!res.ok) return preferred;

    const data = await res.json();
    const dynamic =
      data?.models
        ?.filter((m: any) =>
          m?.supportedGenerationMethods?.includes("generateContent")
        )
        ?.map((m: any) => String(m.name || "").replace(/^models\//, ""))
        ?.filter(Boolean) || [];

    return [...preferred, ...dynamic];
  } catch {
    return preferred;
  }
}

function smallTalkReply(message: string): string | null {
  const text = message.toLowerCase().trim();
  if (/^(hi|hello|hey|shalom)\b/.test(text)) {
    return "Hello, Praise the Lord. Welcome to GA Chat. I can help with clear, conversational answers on Christian apologetics. Ready whenever you are.";
  }
  if (/how are you|how r you|how're you/.test(text)) {
    return "Hello, Praise the Lord. I can help with clear, conversational answers on Christian apologetics. Ready whenever you are.";
  }
  if (/who are you|what are you/.test(text)) {
    return "I am a Christian apologetics assistant. I can summarize, explain, and compare key ideas clearly.";
  }
  return null;
}

function isUnsafeQuery(message: string): boolean {
  const text = message.toLowerCase();
  const patterns = [
    /how to (kill|murder|poison|bomb|stab)/,
    /how to (commit )?(suicide|self[- ]harm)/,
    /make (a )?(bomb|explosive|poison)/,
    /hack (into|someone|bank|account)/,
    /(sexual|porn) (content|story) involving (minor|child|kid)/,
  ];
  return patterns.some((p) => p.test(text));
}

function styleInstruction(style: ResponseStyle): string {
  if (style === "short") {
    return "Keep response to 3-5 lines max.";
  }
  if (style === "detailed") {
    return "Give a thorough explanation in short sections with bullet points.";
  }
  return "Give a balanced answer in 1-2 short paragraphs and bullets if useful.";
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: "Missing GEMINI_API_KEY in .env.local" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const message = String(body?.message ?? "");
    const history = Array.isArray(body?.history) ? (body.history as HistoryItem[]) : [];
    const style: ResponseStyle =
      body?.style === "short" || body?.style === "detailed" ? body.style : "medium";
    const searchQuery = buildSearchQuery(message, history);
    const chitChat = smallTalkReply(message);
    if (chitChat) {
      return Response.json({ reply: chitChat });
    }
    if (isUnsafeQuery(message)) {
      return Response.json({
        reply:
          "I can't help with harmful or illegal requests. But I can help with biblical, apologetics, and pastoral guidance for healing, hope, and support.",
      });
    }

    const knowledgeChunks = await loadKnowledgeChunks();
    if (!knowledgeChunks.length) {
      return Response.json(
        {
          error:
            "No knowledge documents found. Add .txt or .md files under /knowledge.",
        },
        { status: 400 }
      );
    }

    const matched = retrieveTopChunks(searchQuery, knowledgeChunks);
    if (!matched.length) {
      return Response.json({
        reply:
          "I could not find enough support for that in GA's current biblical research.\nTry: 'summarize physical evil', 'explain cause #3', or 'what verse supports this?'",
      });
    }

    const citations = matched.map((m, i) => `[${i + 1}] ${m.source}`).join("\n");
    const context = matched
      .map((m, i) => `Source ${i + 1} (${m.source}):\n${m.text}`)
      .join("\n\n");

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelCandidates = await resolveModel(apiKey);

    let result: any = null;
    let lastError: unknown = null;

    for (const modelName of modelCandidates) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        result = await model.generateContent([
          `You are a Christian apologetics assistant.
Speak naturally, warm, and conversationally like a helpful AI chat assistant.
You may summarize, explain in simple words, expand, compare, or give step-by-step clarification.
Use only facts from DOCUMENT CONTEXT below.
Use natural conversational style; do not force the same opener in every response.
If you need to mention the source, prefer phrases like "as per GA's biblical research" or "from GA's biblical understanding".
Avoid saying words like "documents", "uploaded files", "knowledge base", or "knowledge files" in user-facing responses.
Always reply in the same language as the user's latest message. If user writes in Hindi, reply in Hindi.
If the user asks something not supported by the context, say:
"I could not find enough support for that in GA's current biblical research."
Add citations like [1], [2] to factual statements.
When user asks "explain", "summarize", or "simplify", provide a clear summary from context.
Use clear formatting: short paragraphs and bullets when helpful.
${styleInstruction(style)}

DOCUMENT CONTEXT:
${context}

AVAILABLE SOURCES:
${citations}`,
          `User question: ${message}
Recent conversation:
${history
  .slice(-6)
  .map((h) => `${h.role === "user" ? "User" : "Bot"}: ${h.content ?? ""}`)
  .join("\n")}`,
        ]);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!result) {
      throw lastError ?? new Error("No available Gemini model");
    }

    const response = result.response.text();

    return Response.json({ reply: response });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error";

    return Response.json({ error: message }, { status: 500 });
  }
}

