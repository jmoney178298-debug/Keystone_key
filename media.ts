/** AI media generation: images (OpenAI DALL-E), voiceover (OpenAI TTS), background removal (Leonardo AI). */

export const openaiConfigured = () => !!process.env.OPENAI_API_KEY;
export const leonardoConfigured = () => !!process.env.LEONARDO_API_KEY;

/** Generate an image with DALL-E 3. Returns a public image URL. */
export async function generateImage(prompt: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Image generation is not connected yet.");
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size: "1024x1024", quality: "standard" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Image generation failed (${r.status}).`);
  const url = j?.data?.[0]?.url;
  if (!url) throw new Error("Image generation returned no image.");
  return url;
}

/** Text-to-speech with OpenAI. Returns MP3 bytes. */
export async function textToSpeech(text: string, voice = "alloy"): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Voiceover is not connected yet.");
  const v = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(voice) ? voice : "alloy";
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", input: text, voice: v, response_format: "mp3" }),
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
