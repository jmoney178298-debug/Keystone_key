/** Content clipper: upload video/audio → transcribe (Whisper) → find highlights (AI) → cut clips (FFmpeg). */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const openaiKey = () => process.env.OPENAI_API_KEY || process.env.OPENAI_APP_KEY;
const anthropicKey = () => process.env.ANTHROPIC_API_KEY;

export const CONTENT_DIR = path.join(process.cwd(), "data", "content");
fs.mkdirSync(CONTENT_DIR, { recursive: true });

export interface Highlight {
  start: number;      // seconds
  end: number;        // seconds
  title: string;
  summary: string;
  topics: string[];
}

/** Transcribe audio/video with OpenAI Whisper. Returns text with segment timestamps. */
export async function transcribe(filePath: string): Promise<{ text: string; segments: { start: number; end: number; text: string }[] }> {
  const key = openaiKey();
  if (!key) throw new Error("Transcription is not connected yet.");
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1) || "mp3";
  const form = new FormData();
  form.append("file", new Blob([data], { type: `audio/${ext}` }), `audio.${ext}`);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}` },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Transcription failed (${r.status}).`);
  return {
    text: j.text || "",
    segments: (j.segments || []).map((s: any) => ({ start: s.start, end: s.end, text: s.text })),
  };
}

/** Ask Claude to find the best highlight moments from a transcript. */
export async function findHighlights(
  transcript: string,
  opts: { mode: string; clipCount: number; clipLength: string }
): Promise<Highlight[]> {
  const key = anthropicKey();
  if (!key) throw new Error("Highlight analysis is not connected yet.");
  const lengthGuide = { short: "30-60 seconds each", medium: "2-5 minutes each", long: "5-15 minutes each" }[opts.clipLength] || "2-5 minutes each";
  const modeGuide = opts.mode === "episodes"
    ? "Break the content into episode-sized segments that each stand alone as a mini-episode with a clear topic."
    : "Pick the most engaging, shareable highlight moments — the parts someone would clip for social media.";

  // Truncate very long transcripts to fit context.
  const trimmed = transcript.length > 120000 ? transcript.slice(0, 120000) + "\n[...truncated...]" : transcript;

  const prompt = `You are analyzing a transcript of a long audio/video recording (podcast, interview, talk, etc.).

${modeGuide}

For each highlight, estimate start and end timestamps IN SECONDS based on the content flow. Aim for ${opts.clipCount} highlights, each roughly ${lengthGuide}.

Return ONLY valid JSON — an array of objects, no markdown, no commentary:
[{"start": 0, "end": 120, "title": "Short punchy title", "summary": "One-sentence description of what happens in this moment.", "topics": ["topic1", "topic2"]}]

Transcript:
${trimmed}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "claude-sonnet-4-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Highlight analysis failed (${r.status}).`);
  const text = j?.content?.[0]?.text || "[]";
  const clean = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed)) throw new Error("Highlight analysis returned an unexpected format.");
  return parsed.map((h: any) => ({
    start: Math.max(0, Math.floor(Number(h.start) || 0)),
    end: Math.max(1, Math.ceil(Number(h.end) || 60)),
    title: String(h.title || "Highlight").slice(0, 120),
    summary: String(h.summary || "").slice(0, 500),
    topics: Array.isArray(h.topics) ? h.topics.map(String).slice(0, 5) : [],
  })).filter(h => h.end > h.start);
}

/** Extract a clip from a source file with FFmpeg. Returns the output filename. */
export async function extractClip(sourcePath: string, start: number, end: number, isVideo: boolean): Promise<string> {
  const ext = isVideo ? "mp4" : "mp3";
  const outName = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const outPath = path.join(CONTENT_DIR, outName);
  const duration = end - start;
  const args = isVideo
    ? ["-ss", String(start), "-i", sourcePath, "-t", String(duration), "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-y", outPath]
    : ["-ss", String(start), "-i", sourcePath, "-t", String(duration), "-c:a", "libmp3lame", "-y", outPath];
  await execFileAsync("ffmpeg", args, { timeout: 300000 });
  if (!fs.existsSync(outPath)) throw new Error("Clip extraction failed.");
  return outName;
}

/** Get the duration of a media file in seconds. */
export async function mediaDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ]);
    return Math.floor(parseFloat(stdout.trim()) || 0);
  } catch { return 0; }
}

/** Check if a file is a video (vs audio-only). */
export async function isVideoFile(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ]);
    return stdout.trim() === "video";
  } catch { return false; }
}
