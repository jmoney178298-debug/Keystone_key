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

app.get("/shots/:name", (c) => {
  const name = c.req.param("name");
  if (!/^[\w-]+\.png$/.test(name)) return c.text("Not found", 404);
  const p = `shots/${name}`;
  if (!fs.existsSync(p)) return c.text("Not found", 404);
  return c.body(fs.readFileSync(p), 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
});

app.get("/", (c) => c.html(fs.readFileSync("index.html", "utf8")));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
console.log(`Keystone listening on ${port}`);
