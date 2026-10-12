/**
 * HeyGen API client (server-side only).
 * Auth: X-Api-Key header from HEYGEN_API_KEY env var.
 * The key never leaves the server — never expose it to client-side code.
 *
 * Flow: generate → video_id → poll status until completed → video_url.
 */
const HEYGEN_BASE = "https://api.heygen.com";

export function heygenConfigured(): boolean {
  return !!process.env.HEYGEN_API_KEY;
}

function heygenHeaders(): Record<string, string> {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new Error("HeyGen is not connected yet (API key not configured).");
  return { "X-Api-Key": key, "Content-Type": "application/json" };
}

async function heygenFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${HEYGEN_BASE}${path}`, { ...init, headers: heygenHeaders() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HeyGen API error ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  if (j.error) throw new Error(`HeyGen error: ${j.error}`);
  return j.data;
}

export type VideoFormat = "landscape" | "portrait" | "square";

const DIMENSIONS: Record<VideoFormat, { width: number; height: number }> = {
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
  square: { width: 1080, height: 1080 },
};

/** List available stock avatars. */
export function heygenListAvatars(): Promise<any[]> {
  return heygenFetch("/v2/avatars").then((d) => d.avatars ?? []);
}

/** List available voices. */
export function heygenListVoices(): Promise<any[]> {
  return heygenFetch("/v2/voices").then((d) => d.voices ?? []);
}

export interface GenerateVideoOpts {
  script: string;
  avatarId?: string;
  voiceId?: string;
  format?: VideoFormat;
  title?: string;
  backgroundColor?: string;
}

/**
 * Generate a talking-head spokesperson video. Returns the HeyGen video_id.
 * If avatarId/voiceId are omitted, the first available English avatar/voice is used.
 */
export async function heygenGenerateVideo(opts: GenerateVideoOpts): Promise<{ video_id: string }> {
  const format: VideoFormat = opts.format ?? "landscape";
  let { avatarId, voiceId } = opts;
  if (!avatarId || !voiceId) {
    const [avatars, voices] = await Promise.all([heygenListAvatars(), heygenListVoices()]);
    if (!avatarId) {
      const a = avatars.find((x: any) => /en/i.test(x.language ?? "") || !x.language) ?? avatars[0];
      if (!a) throw new Error("No HeyGen avatars available on this account.");
      avatarId = a.avatar_id;
    }
    if (!voiceId) {
      const v = voices.find((x: any) => x.language === "en" || /en-US/i.test(x.voice_id ?? "")) ?? voices[0];
      if (!v) throw new Error("No HeyGen voices available on this account.");
      voiceId = v.voice_id;
    }
  }
  const data = await heygenFetch("/v2/video/generate", {
    method: "POST",
    body: JSON.stringify({
      title: opts.title ?? "AIU video",
      dimension: DIMENSIONS[format],
      video_inputs: [
        {
          character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" },
          voice: { type: "text", input_text: opts.script, voice_id: voiceId, speed: 1.0 },
          background: { type: "color", value: opts.backgroundColor ?? "#0B0F1A" },
        },
      ],
    }),
  });
  return { video_id: data.video_id };
}

/** Check a video's render status. Returns { status, video_url? }. */
export async function heygenVideoStatus(videoId: string): Promise<{ status: string; video_url?: string; error?: string }> {
  const data = await heygenFetch(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`);
  return { status: data.status, video_url: data.video_url, error: data.error };
}
