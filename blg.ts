/**
 * BabyLoveGrowth API client (server-side only).
 * Auth: X-API-Key header from BABYLOVEGROWTH_API_KEY env var.
 * The key never leaves the server — never expose it to client-side code.
 */
const BLG_BASE = "https://api.babylovegrowth.ai/api/integrations";

export function blgConfigured(): boolean {
  return !!process.env.BABYLOVEGROWTH_API_KEY;
}

async function blgFetch(path: string): Promise<any> {
  const key = process.env.BABYLOVEGROWTH_API_KEY;
  if (!key) throw new Error("BabyLoveGrowth is not connected yet (API key not configured).");
  const res = await fetch(`${BLG_BASE}${path}`, {
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`BabyLoveGrowth API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** List article summaries. */
export function blgListArticles(limit = 50, offset = 0): Promise<any> {
  return blgFetch(`/v1/articles?limit=${Math.min(Math.max(limit, 1), 100)}&offset=${Math.max(offset, 0)}`);
}

/** Get one full article (content_html and content_markdown). */
export function blgGetArticle(id: string | number): Promise<any> {
  return blgFetch(`/v1/articles/${encodeURIComponent(String(id))}`);
}
