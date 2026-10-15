/**
 * integrations.ts — AI service hub for AIU.
 *
 * Central registry of every AI service the app can talk to, with
 * encrypted API-key storage and ready-to-use clients for services
 * beyond the built-in ones (OpenAI, Anthropic, Leonardo, HeyGen).
 *
 * Supported services:
 *   Built-in (env keys): openai, anthropic, leonardo, heygen
 *   Pluggable (keys stored here): elevenlabs, gemini, perplexity, grok
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { integrationKeys } from "./schema";

export interface AiService {
  id: string;
  name: string;
  description: string;
  tools: string[];
  keyHint: string; // where to get the key
  keyPrefix?: string; // expected prefix, for validation display
  builtin: boolean; // true = read from env, false = stored in integration_keys
  envVar?: string;
}

/** Every AI the app knows about. Add new ones here — the UI renders from this list. */
export const AI_SERVICES: AiService[] = [
  { id: "openai", name: "OpenAI", description: "GPT chat, DALL-E images, Whisper transcription, TTS voices", tools: ["Chat", "Images", "Voiceover", "Transcription"], keyHint: "platform.openai.com → API keys", keyPrefix: "sk-", builtin: true, envVar: "OPENAI_APP_KEY" },
  { id: "anthropic", name: "Anthropic Claude", description: "Claude chat + agent that powers the AIU assistant", tools: ["Assistant chat", "Agent mode", "Highlight analysis"], keyHint: "console.anthropic.com → API keys", keyPrefix: "sk-ant-", builtin: true, envVar: "ANTHROPIC_API_KEY" },
  { id: "leonardo", name: "Leonardo AI", description: "Image generation + background removal", tools: ["Image gen", "Background removal"], keyHint: "app.leonardo.ai → API access", builtin: true, envVar: "LEONARDO_API_KEY" },
  { id: "heygen", name: "HeyGen", description: "AI spokesperson / talking-head videos", tools: ["Spokesperson video"], keyHint: "app.heygen.ai → API", builtin: true, envVar: "HEYGEN_API_KEY" },
  { id: "elevenlabs", name: "ElevenLabs", description: "Ultra-realistic AI voiceover in 30+ voices", tools: ["Premium TTS"], keyHint: "elevenlabs.io → Profile → API keys", keyPrefix: "sk_", builtin: false },
  { id: "gemini", name: "Google Gemini", description: "Google's AI — chat, vision, fast reasoning", tools: ["Chat", "Vision"], keyHint: "aistudio.google.com → Get API key", builtin: false },
  { id: "perplexity", name: "Perplexity", description: "AI search with cited sources — research assistant", tools: ["AI search"], keyHint: "perplexity.ai → Settings → API", keyPrefix: "pplx-", builtin: false },
  { id: "grok", name: "xAI Grok", description: "Grok chat with real-time X/Twitter knowledge", tools: ["Chat"], keyHint: "console.x.ai → API keys", keyPrefix: "xai-", builtin: false },
];

/* ---------- encrypted key storage ---------- */

function encKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET || "aiu-integration-fallback";
  return scryptSync(secret, "aiu-integrations", 32);
}

export function encryptApiKey(plain: string): { enc: string; iv: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: Buffer.concat([enc, tag]).toString("base64"), iv: iv.toString("base64") };
}

export function decryptApiKey(encB64: string, ivB64: string): string {
  const data = Buffer.from(encB64, "base64");
  const enc = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** Get a service's API key: env var first, then encrypted DB row for pluggable. */
export async function getServiceKey(serviceId: string): Promise<string | null> {
  const svc = AI_SERVICES.find((s) => s.id === serviceId);
  if (!svc) return null;
  // Env var always wins when present (Railway variables).
  const envMap: Record<string, string[]> = {
    openai: ["OPENAI_APP_KEY", "OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    leonardo: ["LEONARDO_API_KEY"],
    heygen: ["HEYGEN_API_KEY"],
    elevenlabs: ["ELEVENLABS_API_KEY"],
    gemini: ["GEMINI_API_KEY"],
    perplexity: ["PERPLEXITY_API_KEY"],
    grok: ["GROK_API_KEY", "XAI_API_KEY"],
  };
  for (const v of envMap[serviceId] || []) {
    if (process.env[v]) return process.env[v]!;
  }
  if (svc.builtin) return null;
  const [row] = await db.select().from(integrationKeys).where(eq(integrationKeys.service, serviceId));
  if (!row) return null;
  try { return decryptApiKey(row.apiKeyEnc, row.iv); } catch { return null; }
}

export async function setServiceKey(serviceId: string, apiKey: string): Promise<void> {
  const svc = AI_SERVICES.find((s) => s.id === serviceId && !s.builtin);
  if (!svc) throw new Error("Unknown or built-in service");
  const { enc, iv } = encryptApiKey(apiKey.trim());
  await db.insert(integrationKeys).values({ service: serviceId, apiKeyEnc: enc, iv, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: integrationKeys.service, set: { apiKeyEnc: enc, iv, updatedAt: Date.now() } });
}

export async function deleteServiceKey(serviceId: string): Promise<void> {
  await db.delete(integrationKeys).where(eq(integrationKeys.service, serviceId));
}

/** Status list for the UI — never includes key values. */
export async function serviceStatuses(): Promise<Array<AiService & { connected: boolean }>> {
  const out: Array<AiService & { connected: boolean }> = [];
  for (const svc of AI_SERVICES) {
    out.push({ ...svc, connected: !!(await getServiceKey(svc.id)) });
  }
  return out;
}

/* ---------- pluggable service clients ---------- */

/** ElevenLabs text-to-speech. Returns MP3 bytes. */
export async function elevenlabsTts(text: string, voiceId = "21m00Tcm4TlvDq8ikWAM"): Promise<Buffer> {
  const key = await getServiceKey("elevenlabs");
  if (!key) throw new Error("ElevenLabs API key not configured. Add it in AI Tools → Integrations.");
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: text.slice(0, 5000), model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  });
  if (!r.ok) throw new Error(`ElevenLabs error ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Google Gemini chat. */
export async function geminiChat(prompt: string, system?: string): Promise<string> {
  const key = await getServiceKey("gemini");
  if (!key) throw new Error("Gemini API key not configured. Add it in AI Tools → Integrations.");
  const body: any = { contents: [{ parts: [{ text: (system ? system + "\n\n" : "") + prompt }] }] };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": key },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gemini error ${r.status}`);
  const j: any = await r.json();
  return j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

/** Perplexity AI search with citations. */
export async function perplexitySearch(query: string): Promise<{ answer: string; citations: string[] }> {
  const key = await getServiceKey("perplexity");
  if (!key) throw new Error("Perplexity API key not configured. Add it in AI Tools → Integrations.");
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: query }], return_citations: true }),
  });
  if (!r.ok) throw new Error(`Perplexity error ${r.status}`);
  const j: any = await r.json();
  return { answer: j.choices?.[0]?.message?.content ?? "", citations: j.citations ?? [] };
}

/** xAI Grok chat. */
export async function grokChat(prompt: string, system?: string): Promise<string> {
  const key = await getServiceKey("grok");
  if (!key) throw new Error("Grok API key not configured. Add it in AI Tools → Integrations.");
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "grok-3-mini",
      messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Grok error ${r.status}`);
  const j: any = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
}
