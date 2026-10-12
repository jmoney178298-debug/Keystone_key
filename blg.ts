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

/**
 * Sync articles from BabyLoveGrowth into the local blg_posts table.
 * Upserts idempotently by slug: new slugs insert, existing slugs update.
 * Returns { inserted, updated }.
 */
export async function blgSyncArticles(db: any, blgPosts: any, limit = 50): Promise<{ inserted: number; updated: number }> {
  const { eq } = await import("drizzle-orm");
  const list = await blgListArticles(limit, 0);
  const items: any[] = Array.isArray(list) ? list : list?.articles ?? list?.data ?? [];
  let inserted = 0, updated = 0;
  for (const summary of items) {
    const id = summary.id ?? summary.article_id;
    if (id == null || !summary.slug) continue;
    let full: any = summary;
    try { full = await blgGetArticle(id); } catch { /* fall back to summary */ }
    const row = {
      blgId: Number(id),
      slug: String(summary.slug),
      title: String(full.title ?? summary.title ?? "Untitled"),
      contentHtml: full.content_html ?? summary.content_html ?? null,
      contentMarkdown: full.content_markdown ?? summary.content_markdown ?? null,
      metaDescription: full.meta_description ?? summary.meta_description ?? null,
      heroImageUrl: full.hero_image_url ?? summary.hero_image_url ?? null,
      jsonLd: typeof full.jsonLd !== "undefined" ? JSON.stringify(full.jsonLd) : typeof full.json_ld !== "undefined" ? JSON.stringify(full.json_ld) : null,
      faqJsonLd: typeof full.faqJsonLd !== "undefined" ? JSON.stringify(full.faqJsonLd) : typeof full.faq_json_ld !== "undefined" ? JSON.stringify(full.faq_json_ld) : null,
      languageCode: String(full.languageCode ?? full.language_code ?? summary.languageCode ?? "en"),
      publishedAt: full.publishedAt ?? full.published_at ?? summary.publishedAt ? new Date(full.publishedAt ?? full.published_at ?? summary.publishedAt) : null,
      updatedAt: new Date(),
    };
    const [existing] = await db.select({ id: blgPosts.id }).from(blgPosts).where(eq(blgPosts.slug, row.slug));
    if (existing) {
      await db.update(blgPosts).set(row).where(eq(blgPosts.id, existing.id));
      updated++;
    } else {
      await db.insert(blgPosts).values(row);
      inserted++;
    }
  }
  return { inserted, updated };
}
