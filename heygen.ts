/**
 * HeyGen API client (server-side only) — API v3.
 * Auth: X-Api-Key header from HEYGEN_API_KEY env var.
 * The key never leaves the server — never expose it to client-side code.
 *
 * Flow: create video → video id → poll status until completed → video_url.
 *
 * Migrated to v3 on 2026-10-19: HeyGen retires the v1/v2 endpoints on
 * Oct 31, 2026. v3 equivalents (per developers.heygen.com/endpoint-version-comparison):
 *   POST /v2/video/generate        → POST /v3/videos
 *   GET  /v1/video_status.get      → GET  /v3/videos/{video_id}
 *   GET  /v2/avatars               → GET  /v3/avatars (avatar groups with looks)
 *   GET  /v2/voices                → GET  /v3/voices
 * v3 responses are normalized below into the shapes the rest of the app
 * already consumes (avatar_id / avatar_name / voice_id / video_id / status).
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

/** Returns the full parsed response body; callers pick `.data`. */
async function heygenFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${HEYGEN_BASE}${path}`, { ...init, headers: heygenHeaders() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HeyGen API error ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  if (j.error) throw new Error(`HeyGen error: ${typeof j.error === "string" ? j.error : JSON.stringify(j.error).slice(0, 200)}`);
  return j;
}

/** Pull a list out of a v3 list response, tolerating envelope variations. */
function listFrom(j: any): any[] {
  const d = j?.data ?? j;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.avatars)) return d.avatars;
  if (Array.isArray(d?.voices)) return d.voices;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.data)) return d.data;
  return [];
}

export type VideoFormat = "landscape" | "portrait" | "square";

const ASPECT_RATIO: Record<VideoFormat, string> = {
  landscape: "16:9",
  portrait: "9:16",
  square: "1:1",
};

/**
 * List available stock avatars, normalized to
 * { avatar_id, avatar_name, gender, preview_image_url, preview_video_url }.
 * In v3, /v3/avatars returns avatar groups; the id used to generate a video
 * is a look id, so groups are flattened to their looks.
 */
export async function heygenListAvatars(): Promise<any[]> {
  const j = await heygenFetch("/v3/avatars?limit=50");
  const raw = listFrom(j);
  const out: any[] = [];
  for (const item of raw) {
    const looks = item?.looks ?? item?.avatar_looks ?? [];
    if (Array.isArray(looks) && looks.length) {
      for (const look of looks) {
        const avatarId = look?.id ?? look?.avatar_id ?? look?.look_id;
        if (!avatarId) continue;
        out.push({
          avatar_id: avatarId,
          avatar_name: look?.name ?? look?.avatar_name ?? item?.name ?? item?.avatar_name ?? "Avatar",
          gender: look?.gender ?? item?.gender ?? null,
          preview_image_url: look?.preview_image_url ?? look?.image_url ?? item?.preview_image_url ?? null,
          preview_video_url: look?.preview_video_url ?? item?.preview_video_url ?? null,
          language: item?.language ?? look?.language,
        });
      }
    } else {
      const avatarId = item?.id ?? item?.avatar_id;
      if (!avatarId) continue;
      out.push({
        avatar_id: avatarId,
        avatar_name: item?.name ?? item?.avatar_name ?? "Avatar",
        gender: item?.gender ?? null,
        preview_image_url: item?.preview_image_url ?? item?.image_url ?? null,
        preview_video_url: item?.preview_video_url ?? null,
        language: item?.language,
      });
    }
  }
  return out;
}

/** List available voices, normalized to { voice_id, name, language, gender }. */
export async function heygenListVoices(): Promise<any[]> {
  const j = await heygenFetch("/v3/voices?limit=100");
  return listFrom(j)
    .map((v: any) => ({
      voice_id: v?.voice_id ?? v?.id,
      name: v?.name ?? v?.voice_name ?? null,
      language: v?.language ?? v?.locale ?? "",
      gender: v?.gender ?? null,
    }))
    .filter((v: any) => v.voice_id);
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
 * Generate a talking-head spokesperson video. Returns the HeyGen video id.
 * If avatarId/voiceId are omitted, the first available English avatar/voice
 * is used; if no voice is resolved, HeyGen falls back to the avatar's
 * default voice (v3 behavior).
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
      const v = voices.find((x: any) => /^(en|english)/i.test(x.language ?? "") || /en[-_]/i.test(x.voice_id ?? "")) ?? voices[0];
      if (v) voiceId = v.voice_id;
    }
  }
  const body: Record<string, any> = {
    type: "avatar",
    avatar_id: avatarId,
    script: opts.script,
    title: opts.title ?? "AIU video",
    aspect_ratio: ASPECT_RATIO[format],
    resolution: "720p",
  };
  if (voiceId) body.voice_id = voiceId;
  const j = await heygenFetch("/v3/videos", { method: "POST", body: JSON.stringify(body) });
  const videoId = j?.data?.id ?? j?.data?.video_id;
  if (!videoId) throw new Error(`HeyGen did not return a video id: ${JSON.stringify(j).slice(0, 200)}`);
  return { video_id: videoId };
}

/** Check a video's render status. Returns { status, video_url?, error? }. */
export async function heygenVideoStatus(videoId: string): Promise<{ status: string; video_url?: string; error?: string }> {
  const j = await heygenFetch(`/v3/videos/${encodeURIComponent(videoId)}`);
  const data = j?.data ?? {};
  const failed = !!data.failure_code || !!data.failure_message;
  return {
    status: failed && data.status !== "completed" ? "failed" : data.status,
    video_url: data.video_url,
    error: data.failure_message ?? (typeof data.error === "string" ? data.error : undefined),
  };
}
