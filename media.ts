/** AI media generation: images (OpenAI DALL-E), voiceover (OpenAI TTS), background removal (remove.bg). */

export const openaiConfigured = () => !!process.env.OPENAI_API_KEY;
export const removebgConfigured = () => !!process.env.REMOVEBG_API_KEY;

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

/** Remove the background from an image URL via remove.bg. Returns PNG bytes. */
export async function removeBackground(imageUrl: string): Promise<Buffer> {
  const key = process.env.REMOVEBG_API_KEY;
  if (!key) throw new Error("Background removal is not connected yet.");
  const form = new FormData();
  form.append("image_url", imageUrl);
  form.append("size", "auto");
  const r = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": key },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Background removal failed (${r.status}). ${t.slice(0, 120)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}
