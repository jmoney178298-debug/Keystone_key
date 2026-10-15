import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import { auth } from "./auth";
import { db } from "./db";
import { keystone } from "./keystone";
import { lifetimeAccess, partnerAccess, subscriptions } from "./schema";

const OWNER = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
const app = new Hono();

app.get("/health", (c) => c.text("ok"));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/", keystone);

// The Keystone app itself: owner or active subscribers only. Served from /private, never from /public.
// Stripe sends buyers here after checkout. Redirect into the app (preserving the result) instead of 404ing.
app.get("/app/billing", (c) => {
  const status = c.req.query("status");
  return c.redirect(`/app${status ? `?billing=${encodeURIComponent(status)}` : ""}`);
});

app.get("/app", async (c) => {  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return c.redirect("/#login");
  const isOwner = OWNER !== "" && session.user.email.toLowerCase() === OWNER;
  if (!isOwner) {
    const [part] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, session.user.id));
    const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, session.user.id));
    if (!part && !life) {
      const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, session.user.id));
      if (!s || !["active", "trialing"].includes(s.status)) return c.redirect("/#account");
    }
  }
  c.header("Cache-Control", "no-store");
  return c.html(fs.readFileSync("app.html", "utf8"));
});

app.get("/pwa/:name", (c) => {
  const name = c.req.param("name");
  if (!/^[\w.-]+\.(png|json|js)$/.test(name)) return c.text("Not found", 404);
  const p = `pwa/${name}`;
  if (!fs.existsSync(p)) return c.text("Not found", 404);
  const type = name.endsWith(".json") ? "application/manifest+json" : name.endsWith(".js") ? "application/javascript" : "image/png";
  return c.body(fs.readFileSync(p), 200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
});

app.get("/shots/:name", (c) => {
  const name = c.req.param("name");
  if (!/^[\w-]+\.png$/.test(name)) return c.text("Not found", 404);
  const p = `shots/${name}`;
  if (!fs.existsSync(p)) return c.text("Not found", 404);
  return c.body(fs.readFileSync(p), 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
});

app.get("/", (c) => c.html(fs.readFileSync("index.html", "utf8")));

// SEO/GEO discoverability files
app.get("/robots.txt", (c) => c.body(fs.readFileSync("robots.txt", "utf8"), 200, { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" }));
app.get("/ads.txt", (c) => c.body(fs.readFileSync("ads.txt", "utf8"), 200, { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" }));
app.get("/founder.jpg", (c) => {
  const fp = "founder.jpg";
  if (!fs.existsSync(fp)) return c.notFound();
  return new Response(fs.readFileSync(fp), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
});
app.get("/sitemap.xml", async (c) => {
  // Dynamic sitemap: homepage + every synced blog post.
  let urls = `  <url><loc>https://www.getaiu.online/</loc><lastmod>2026-10-12</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n`;
  urls += `  <url><loc>https://www.getaiu.online/blog</loc><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  try {
    const { db } = await import("./db");
    const { blgPosts } = await import("./schema");
    const posts = await db.select({ slug: blgPosts.slug, updatedAt: blgPosts.updatedAt }).from(blgPosts);
    for (const p of posts) {
      const lastmod = p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : "2026-10-12";
      urls += `  <url><loc>https://www.getaiu.online/blog/${p.slug}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
    }
  } catch { /* sitemap still serves the homepage */ }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>`;
  return c.body(xml, 200, { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" });
});
app.get("/llms.txt", (c) => c.body(fs.readFileSync("llms.txt", "utf8"), 200, { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
console.log(`Keystone listening on ${port}`);
