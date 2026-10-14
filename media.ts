/** AI media generation: images (OpenAI DALL-E), voiceover (OpenAI TTS), background removal (Leonardo AI). */

/* Accept either env name — Railway has it as OPENAI_APP_KEY. */
const openaiKey = () => process.env.OPENAI_API_KEY || process.env.OPENAI_APP_KEY;
export const openaiConfigured = () => !!openaiKey();
export const leonardoConfigured = () => !!process.env.LEONARDO_API_KEY;

/** Generate an image with DALL-E 3. Returns a public image URL. */
export async function generateImage(prompt: string, opts: { style?: string; size?: string; quality?: string } = {}): Promise<string> {
  const key = openaiKey();
  if (!key) throw new Error("Image generation is not connected yet.");
  const styles: Record<string, string> = {
    photorealistic: "photorealistic, ultra-detailed, professional photography",
    cinematic: "cinematic lighting, dramatic, film still quality",
    cartoon: "vibrant cartoon style, bold colors, animated",
    anime: "anime style, detailed, studio-quality illustration",
    oilpainting: "classical oil painting, rich textures, artistic",
    watercolor: "soft watercolor painting, delicate, artistic",
    cyberpunk: "cyberpunk aesthetic, neon lights, futuristic",
    minimal: "minimalist, clean lines, simple elegant composition",
    threed: "3D render, octane render, high detail",
    comic: "comic book art style, bold outlines, dynamic",
  };
  const styleHint = opts.style && styles[opts.style] ? `, ${styles[opts.style]}` : "";
  const size = ["1024x1024", "1792x1024", "1024x1792"].includes(opts.size || "") ? opts.size! : "1024x1024";
  const quality = opts.quality === "hd" ? "hd" : "standard";
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dall-e-3", prompt: prompt + styleHint, n: 1, size, quality }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Image generation failed (${r.status}).`);
  const url = j?.data?.[0]?.url;
  if (!url) throw new Error("Image generation returned no image.");
  return url;
}

/** Text-to-speech with OpenAI. Returns MP3 bytes. */
export async function textToSpeech(text: string, voice = "alloy", speed = 1.0): Promise<Buffer> {
  const key = openaiKey();
  if (!key) throw new Error("Voiceover is not connected yet.");
  const v = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(voice) ? voice : "alloy";
  const s = Math.min(4.0, Math.max(0.25, Number(speed) || 1.0));
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", input: text, voice: v, speed: s, response_format: "mp3" }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.error?.message || `Voiceover failed (${r.status}).`);
  }
  return Buffer.from(await r.arrayBuffer());
}

/** Remove the background from an image URL via Leonardo AI. Returns PNG bytes. */
export async function removeBackground(imageUrl: string): Promise<Buffer> {
  const key = process.env.LEONARDO_API_KEY;
  if (!key) throw new Error("Background removal is not connected yet.");
  const auth = { "authorization": `Bearer ${key}`, "Content-Type": "application/json" };
  // 1. Download the source image.
  const src = await fetch(imageUrl);
  if (!src.ok) throw new Error("Could not download the source image.");
  const bytes = Buffer.from(await src.arrayBuffer());
  // 2. Get a Leonardo upload slot.
  const init = await fetch("https://cloud.leonardo.ai/api/rest/v2/init-image", {
    method: "POST", headers: auth, body: JSON.stringify({ extension: "png" }),
  });
  const initJ = await init.json().catch(() => ({}));
  const uploadUrl = initJ?.uploadInitImage?.url;
  const imageId = initJ?.uploadInitImage?.id;
  if (!uploadUrl || !imageId) throw new Error("Leonardo upload init failed.");
  // 3. Upload the image bytes.
  const up = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: bytes });
  if (!up.ok) throw new Error("Leonardo image upload failed.");
  // 4. Run synchronous background removal.
  const gen = await fetch("https://cloud.leonardo.ai/api/rest/v2/generationssync", {
    method: "POST", headers: auth,
    body: JSON.stringify({
      model: "remove-bg", public: false, ephemeral: true,
      parameters: {
        size: "auto", type: "auto", format: "png",
        guidances: { image_reference: [{ image: { id: imageId, type: "UPLOADED" } }] },
      },
    }),
  });
  const genJ = await gen.json().catch(() => ({}));
  const outUrl = genJ?.generations?.[0]?.url || genJ?.url;
  if (!gen.ok || !outUrl) throw new Error(genJ?.error || "Leonardo background removal failed.");
  // 5. Download the result.
  const out = await fetch(outUrl);
  if (!out.ok) throw new Error("Could not download the result image.");
  return Buffer.from(await out.arrayBuffer());
}
