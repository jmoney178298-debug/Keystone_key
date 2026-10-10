/**
 * Keystone backend: owner-only admin, Stripe subscription gating, hot leads.
 * Assumes Hono, better-auth (auth.api.getSession) and Drizzle + SQLite.
 * Adjust the three imports below to match your project.
 * Mount with:  app.route("/", keystone)
 */
import { Hono, type MiddlewareHandler } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "./db";
import { auth } from "./auth";
import { aiUsage, funnels, funnelLeads, hotLeads, leads, lifetimeAccess, prospects, stripeEvents, subscriptions } from "./schema";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const OWNER_EMAIL = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

type Env = { Variables: { user: { id: string; email: string }; isAdmin: boolean } };
export const keystone = new Hono<Env>();

/* ---------------- middleware ---------------- */

/** Signed-in user. Admin = the one email in OWNER_EMAIL (server-side, not a client passcode). */
const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return c.json({ error: "Sign in required" }, 401);
  const email = session.user.email.toLowerCase();
  c.set("user", { id: session.user.id, email });
  c.set("isAdmin", OWNER_EMAIL !== "" && email === OWNER_EMAIL);
  await next();
};

const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get("isAdmin")) return c.json({ error: "Owner only" }, 403);
  await next();
};

/** Paywall: owner always passes; lifetime buyers pass; everyone else needs an active or trialing subscription. */
const requireSub: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get("isAdmin")) return next();
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, c.get("user").id));
  if (life) return next();
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, c.get("user").id));
  if (!s || !["active", "trialing"].includes(s.status)) {
    return c.json({ error: "Active subscription required", upgrade: "/app/billing" }, 402);
  }
  await next();
};

/* ---------------- billing ---------------- */

async function customerFor(user: { id: string; email: string }) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  if (row) return row.stripeCustomerId;
  const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
  await db.insert(subscriptions).values({ userId: user.id, stripeCustomerId: customer.id });
  return customer.id;
}

const PRICES: Record<string, string | undefined> = {
  basic: process.env.STRIPE_PRICE_BASIC,
  pro: process.env.STRIPE_PRICE_PRO,
  proplus: process.env.STRIPE_PRICE_PROPLUS,
};

keystone.post("/api/billing/checkout", requireUser, async (c) => {
  const user = c.get("user");
  const { plan } = await c.req.json().catch(() => ({ plan: "pro" }));
  const price = PRICES[plan as string];
  if (!price) return c.json({ error: "Unknown plan. Use basic, pro or proplus." }, 400);
  const [prev] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  const trialDays = prev?.stripeSubscriptionId ? 0 : Number(process.env.TRIAL_DAYS ?? 7); // one free trial per account
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: await customerFor(user),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    subscription_data: { metadata: { userId: user.id }, ...(trialDays > 0 ? { trial_period_days: trialDays } : {}) },
    allow_promotion_codes: true,
    success_url: `${APP_URL}/app/billing?status=success`,
    cancel_url: `${APP_URL}/app/billing?status=cancelled`,
  });
  return c.json({ url: session.url });
});

keystone.post("/api/billing/portal", requireUser, async (c) => {
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, c.get("user").id));
  if (!s) return c.json({ error: "No billing account yet" }, 404);
  const portal = await stripe.billingPortal.sessions.create({
    customer: s.stripeCustomerId,
    return_url: `${APP_URL}/app/billing`,
  });
  return c.json({ url: portal.url });
});

/** One-time purchase: lifetime access. Needs STRIPE_PRICE_LIFETIME in env. */
keystone.post("/api/billing/lifetime", requireUser, async (c) => {
  const price = process.env.STRIPE_PRICE_LIFETIME;
  if (!price) return c.json({ error: "Lifetime purchase is not configured yet." }, 400);
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, c.get("user").id));
  if (life) return c.json({ error: "You already have lifetime access." }, 400);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: await customerFor(c.get("user")),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: c.get("user").id,
    success_url: `${APP_URL}/app/billing?status=success`,
    cancel_url: `${APP_URL}/app/billing?status=cancelled`,
  });
  return c.json({ url: session.url });
});

keystone.get("/api/billing/status", requireUser, async (c) => {
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, c.get("user").id));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, c.get("user").id));
  const active = c.get("isAdmin") || !!life || ["active", "trialing"].includes(s?.status ?? "");
  return c.json({
    isAdmin: c.get("isAdmin"),
    lifetime: !!life,
    status: life ? "lifetime" : s?.status ?? "none",
    currentPeriodEnd: s?.currentPeriodEnd ?? null,
    active,
  });
});

async function syncSubscription(sub: Stripe.Subscription) {
  const userId = sub.metadata?.userId;
  if (!userId) return;
  const item: any = sub.items.data[0];
  const end = item?.current_period_end ?? (sub as any).current_period_end;
  const values = {
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripeSubscriptionId: sub.id,
    status: sub.status,
    plan: item?.price?.metadata?.keystone_plan ?? "pro",
    currentPeriodEnd: end ? new Date(end * 1000) : null,
    updatedAt: new Date(),
  };
  await db.insert(subscriptions).values({ userId, ...values }).onConflictDoUpdate({ target: subscriptions.userId, set: values });
}

/** Stripe calls this. No auth middleware: the signature is the auth. Needs the raw body. */
keystone.post("/api/stripe/webhook", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ error: "Missing signature" }, 400);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await c.req.text(), signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return c.json({ error: "Bad signature" }, 400);
  }
  const fresh = await db.insert(stripeEvents).values({ id: event.id }).onConflictDoNothing().returning();
  if (fresh.length === 0) return c.json({ received: true, duplicate: true });

  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.mode === "subscription" && s.subscription) {
      const id = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
      await syncSubscription(await stripe.subscriptions.retrieve(id));
    } else if (s.mode === "payment" && s.client_reference_id) {
      const cust = typeof s.customer === "string" ? s.customer : s.customer?.id ?? "";
      await db.insert(lifetimeAccess).values({ userId: s.client_reference_id, stripeCustomerId: cust }).onConflictDoNothing();
    }
  } else if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    await syncSubscription(event.data.object as Stripe.Subscription);
  }
  return c.json({ received: true });
});

/* ---------------- hot leads (subscribers) ---------------- */

export const SIGNALS = ["no_website", "not_mobile", "no_https", "old_copyright", "dated_look", "no_contact_form"] as const;
const clean = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const scoreOf = (signals: unknown) =>
  Array.isArray(signals) ? [...new Set(signals.filter((s) => (SIGNALS as readonly string[]).includes(s)))] : [];

keystone.get("/api/hot-leads", requireUser, requireSub, async (c) => {
  const rows = await db.select().from(hotLeads).where(eq(hotLeads.userId, c.get("user").id)).orderBy(desc(hotLeads.score), desc(hotLeads.createdAt));
  return c.json(rows.map((r) => ({ ...r, hot: r.score >= 4 })));
});

keystone.post("/api/hot-leads", requireUser, requireSub, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const businessName = clean(b.businessName, 120);
  if (!businessName) return c.json({ error: "businessName is required" }, 400);
  const signals = scoreOf(b.signals);
  const [row] = await db.insert(hotLeads).values({
    userId: c.get("user").id,
    businessName,
    contactName: clean(b.contactName),
    email: clean(b.email),
    phone: clean(b.phone, 40),
    website: clean(b.website, 500),
    industry: clean(b.industry, 80),
    city: clean(b.city, 80),
    signals,
    score: signals.length,
  }).returning();
  return c.json(row, 201);
});

keystone.delete("/api/hot-leads/:id", requireUser, requireSub, async (c) => {
  await db.delete(hotLeads).where(and(eq(hotLeads.id, Number(c.req.param("id"))), eq(hotLeads.userId, c.get("user").id)));
  return c.json({ ok: true });
});

/** Move a hot lead into the sales pipeline (prospects table). */
keystone.post("/api/hot-leads/:id/promote", requireUser, requireSub, async (c) => {
  const userId = c.get("user").id;
  const [l] = await db.select().from(hotLeads).where(and(eq(hotLeads.id, Number(c.req.param("id"))), eq(hotLeads.userId, userId)));
  if (!l) return c.json({ error: "Not found" }, 404);
  const [p] = await db.insert(prospects).values({
    userId, businessName: l.businessName, contactName: l.contactName, email: l.email, phone: l.phone,
    website: l.website, industry: l.industry, city: l.city, stage: "new",
    notes: `Hot lead score ${l.score}/6: ${l.signals.join(", ") || "none"}`,
  }).returning();
  await db.update(hotLeads).set({ status: "promoted", updatedAt: new Date() }).where(eq(hotLeads.id, l.id));
  return c.json(p, 201);
});

/* ---------------- funnels: AI-generated lead capture pages ---------------- */

/** Daily lead-capture allowance per plan (funnel opt-ins). Lifetime = top tier. */
const LEAD_DAILY_LIMIT: Record<string, number> = { basic: 10, pro: 50, proplus: 200, lifetime: 200 };

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "funnel";

async function uniqueSlug(base: string) {
  const root = slugify(base);
  let n = 0;
  while (true) {
    const slug = n ? `${root}-${n}` : root;
    const [row] = await db.select({ id: funnels.id }).from(funnels).where(eq(funnels.slug, slug));
    if (!row) return slug;
    n++;
  }
}

const escHtml = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Server-rendered landing page from the AI's structured funnel JSON. */
function renderFunnelPage(d: {
  title: string; headline: string; subhead: string; cta: string;
  bullets: string[]; sections: { h: string; p: string }[]; formTitle: string;
}, slug: string) {
  const bullets = (Array.isArray(d.bullets) ? d.bullets : []).slice(0, 6).map((b) => `<li>${escHtml(b)}</li>`).join("");
  const sections = (Array.isArray(d.sections) ? d.sections : []).slice(0, 4).map((s) =>
    `<section class="w"><h2>${escHtml(s.h)}</h2><p>${escHtml(s.p)}</p></section>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(d.title)}</title><style>
*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,sans-serif;color:#0B0F1A;background:#F4F6FA}
.h{padding:11vh 5vw;background:#4F5BFF;color:#fff}.h h1{font-size:clamp(36px,7vw,72px);line-height:1;margin:0 0 14px;letter-spacing:-.03em}.h p{font-size:20px;max-width:640px;margin:0 0 18px;opacity:.92}
.b{display:inline-block;background:#19E6B4;color:#0B0F1A;padding:13px 30px;border-radius:999px;text-decoration:none;font-weight:800;font-size:17px}
.w{padding:6vh 5vw}.w h2{font-size:30px;margin:0 0 12px;letter-spacing:-.02em}.w p{max-width:680px;color:#3A4356}
ul.ben{list-style:none;padding:0 5vw 2vh;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
ul.ben li{background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 2px rgba(11,15,26,.06);font-weight:600}
#leadform{padding:8vh 5vw;background:#0B0F1A;color:#fff}#leadform h2{font-size:32px;margin:0 0 8px}#leadform p{opacity:.75;margin:0 0 18px}
#leadform form{display:grid;gap:10px;max-width:480px}#leadform input{padding:13px;border-radius:10px;border:1px solid #2A3350;background:#141B30;color:#fff;font-size:16px}
#leadform button{padding:15px;border-radius:999px;border:0;background:#19E6B4;color:#0B0F1A;font-weight:800;font-size:17px;cursor:pointer}
#leadform .ok{display:none;background:#123326;border:1px solid #19E6B4;border-radius:12px;padding:16px;max-width:480px}
footer{padding:22px 5vw;font-size:13px;color:#5B6475}
</style></head><body>
<div class="h"><h1>${escHtml(d.headline)}</h1><p>${escHtml(d.subhead)}</p><a class="b" href="#leadform">${escHtml(d.cta || "Get started")}</a></div>
<ul class="ben">${bullets}</ul>${sections}
<section id="leadform"><h2>${escHtml(d.formTitle || "Get your free quote")}</h2><p>Drop your details and we will be in touch fast.</p>
<form id="lf"><input name="name" required placeholder="Full name"><input name="email" required type="email" placeholder="Email"><input name="phone" placeholder="Phone (optional)"><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><input name="city" placeholder="City"><input name="state" placeholder="State"></div><button type="submit">${escHtml(d.cta || "Claim my free quote")}</button></form>
<div class="ok" id="lok">Thanks — your request is in. We will reach out shortly.</div></section>
<footer>Powered by AIU funnels</footer>
<script>document.getElementById('lf').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,d={};new FormData(f).forEach((v,k)=>d[k]=v);const r=await fetch('/api/funnels/${slug}/leads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});if(r.ok){document.getElementById('lf').style.display='none';document.getElementById('lok').style.display='block'}else{const j=await r.json().catch(()=>({}));alert(j.error||'Something went wrong.')}});<\/script>
</body></html>`;
}

/** Shared daily-AI-limit check. Returns an error response or null when OK. */
async function aiLimitHit(c: any) {
  if (c.get("isAdmin")) return null;
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, c.get("user").id));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, c.get("user").id));
  const plan = life ? "lifetime" : s?.plan ?? "basic";
  const limit = DAILY_LIMIT[plan] ?? 20;
  const day = new Date().toISOString().slice(0, 10);
  const [u] = await db.select().from(aiUsage).where(and(eq(aiUsage.userId, c.get("user").id), eq(aiUsage.day, day)));
  if ((u?.n ?? 0) >= limit) return c.json({ error: `Daily AI limit reached (${limit}). It resets tomorrow, or upgrade your plan.` }, 429);
  await db.insert(aiUsage).values({ userId: c.get("user").id, day, n: 1 })
    .onConflictDoUpdate({ target: [aiUsage.userId, aiUsage.day], set: { n: sql`${aiUsage.n} + 1` } });
  return null;
}

/** One-click funnel generation: industry in, hosted landing page out. */
keystone.post("/api/funnels/generate", requireUser, requireSub, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const industry = clean(b.industry, 80);
  const business = clean(b.business, 120) || industry;
  if (!industry) return c.json({ error: "industry is required" }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "AI is not configured yet." }, 503);
  const blocked = await aiLimitHit(c);
  if (blocked) return blocked;
  let data: any;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL, max_tokens: 2500,
        system: SYSTEM.funnel,
        messages: [{ role: "user", content: `Industry: ${industry}\nBusiness name: ${business}` }],
      }),
    });
    if (!r.ok) return c.json({ error: "The AI service had a problem. Try again in a moment." }, 502);
    const j: any = await r.json();
    const text = (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n").trim();
    data = JSON.parse(text);
  } catch {
    return c.json({ error: "Could not generate the funnel. Try again." }, 502);
  }
  if (!data || typeof data.headline !== "string") return c.json({ error: "The AI returned an unusable funnel. Try again." }, 502);
  const slug = await uniqueSlug(`${business} ${industry}`);
  const html = renderFunnelPage({
    title: String(data.title || business), headline: data.headline, subhead: String(data.subhead || ""),
    cta: String(data.cta || "Get started"), bullets: data.bullets || [], sections: data.sections || [],
    formTitle: String(data.formTitle || "Get your free quote"),
  }, slug);
  const [row] = await db.insert(funnels).values({
    userId: c.get("user").id, slug, industry, title: String(data.title || business),
    html, adAngles: data.adAngles ?? {}, status: "draft",
  }).returning();
  return c.json({ ...row, url: `${APP_URL}/f/${slug}` }, 201);
});

keystone.get("/api/funnels", requireUser, requireSub, async (c) => {
  const rows = await db.select().from(funnels).where(eq(funnels.userId, c.get("user").id)).orderBy(desc(funnels.updatedAt));
  return c.json(rows.map((r) => ({ ...r, html: undefined, url: `${APP_URL}/f/${r.slug}` })));
});

keystone.post("/api/funnels/:id/publish", requireUser, requireSub, async (c) => {
  const id = Number(c.req.param("id"));
  const [f] = await db.select().from(funnels).where(and(eq(funnels.id, id), eq(funnels.userId, c.get("user").id)));
  if (!f) return c.json({ error: "Not found" }, 404);
  const { status } = await c.req.json().catch(() => ({ status: "live" }));
  await db.update(funnels).set({ status: status === "live" ? "live" : "draft", updatedAt: new Date() }).where(eq(funnels.id, id));
  return c.json({ ok: true, url: `${APP_URL}/f/${f.slug}` });
});

keystone.delete("/api/funnels/:id", requireUser, requireSub, async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(funnelLeads).where(and(eq(funnelLeads.funnelId, id), eq(funnelLeads.userId, c.get("user").id)));
  await db.delete(funnels).where(and(eq(funnels.id, id), eq(funnels.userId, c.get("user").id)));
  return c.json({ ok: true });
});

/** Public funnel page. */
keystone.get("/f/:slug", async (c) => {
  const [f] = await db.select().from(funnels).where(eq(funnels.slug, c.req.param("slug")));
  if (!f || f.status !== "live") return c.text("Not found", 404);
  c.header("Cache-Control", "no-store");
  return c.html(f.html);
});

const funnelLeadHits = new Map<string, number[]>();

/** Public opt-in: real visitors only. Tier-capped per funnel owner per day. */
keystone.post("/api/funnels/:slug/leads", async (c) => {
  const [f] = await db.select().from(funnels).where(eq(funnels.slug, c.req.param("slug")));
  if (!f || f.status !== "live") return c.json({ error: "Not found" }, 404);
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const now = Date.now();
  const recent = (funnelLeadHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 5) return c.json({ error: "Too many requests. Please try again later." }, 429);
  funnelLeadHits.set(ip, [...recent, now]);

  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, f.userId));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, f.userId));
  const plan = life ? "lifetime" : s?.plan ?? "basic";
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(funnelLeads)
    .where(and(eq(funnelLeads.userId, f.userId), sql`${funnelLeads.createdAt} >= ${dayStart.getTime()}`));
  if ((cnt?.n ?? 0) >= (LEAD_DAILY_LIMIT[plan] ?? 10))
    return c.json({ error: "This funnel is not accepting new leads right now." }, 429);

  const b = await c.req.json().catch(() => ({}));
  const name = clean(b.name, 100), email = clean(b.email, 200);
  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) return c.json({ error: "Name and a valid email are required." }, 400);
  const [row] = await db.insert(funnelLeads).values({
    funnelId: f.id, userId: f.userId, name, email,
    phone: clean(b.phone, 40), city: clean(b.city, 80), state: clean(b.state, 40), ip,
  }).returning();
  return c.json({ ok: true, id: row.id }, 201);
});

/** My available (unclaimed) funnel leads. Claimed ones leave this pool. */
keystone.get("/api/funnel-leads", requireUser, requireSub, async (c) => {
  const rows = await db.select().from(funnelLeads)
    .where(and(eq(funnelLeads.userId, c.get("user").id), eq(funnelLeads.status, "new")))
    .orderBy(desc(funnelLeads.createdAt));
  return c.json(rows);
});

/** Claim a lead: moves it to the Pipeline and removes it from the available pool. */
keystone.post("/api/funnel-leads/:id/claim", requireUser, requireSub, async (c) => {
  const userId = c.get("user").id;
  const [l] = await db.select().from(funnelLeads)
    .where(and(eq(funnelLeads.id, Number(c.req.param("id"))), eq(funnelLeads.userId, userId), eq(funnelLeads.status, "new")));
  if (!l) return c.json({ error: "Not found" }, 404);
  const [f] = await db.select().from(funnels).where(eq(funnels.id, l.funnelId));
  const [p] = await db.insert(prospects).values({
    userId, businessName: l.name, contactName: l.name, email: l.email, phone: l.phone,
    city: l.city, industry: f?.industry ?? null, stage: "new",
    notes: `Claimed from funnel "${f?.title ?? ""}" on ${new Date().toISOString().slice(0, 10)}. State: ${l.state ?? ""}. IP: ${l.ip ?? ""}.`,
  }).returning();
  await db.update(funnelLeads).set({ status: "claimed" }).where(eq(funnelLeads.id, l.id));
  return c.json(p, 201);
});

/* ---------------- owner-only admin ---------------- */

const admin = new Hono<Env>();
admin.use("*", requireUser, requireAdmin);

admin.get("/overview", async (c) => {
  const subs = await db.select({ status: subscriptions.status, n: sql<number>`count(*)` }).from(subscriptions).groupBy(subscriptions.status);
  const [hot] = await db.select({ n: sql<number>`count(*)` }).from(hotLeads);
  const [inbound] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(eq(leads.status, "new"));
  const [won] = await db.select({ total: sql<number>`coalesce(sum(${prospects.dealValue}),0)` }).from(prospects).where(eq(prospects.stage, "won"));
  return c.json({ subscribers: subs, hotLeads: hot.n, newInboundLeads: inbound.n, wonRevenue: won.total });
});

admin.get("/subscribers", async (c) => c.json(await db.select().from(subscriptions).orderBy(desc(subscriptions.updatedAt))));
admin.get("/hot-leads", async (c) => c.json(await db.select().from(hotLeads).orderBy(desc(hotLeads.score), desc(hotLeads.createdAt))));
admin.get("/leads", async (c) => c.json(await db.select().from(leads).orderBy(desc(leads.createdAt))));
admin.patch("/leads/:id", async (c) => {
  const { status } = await c.req.json().catch(() => ({}));
  if (!["new", "contacted", "won", "lost"].includes(status)) return c.json({ error: "Invalid status" }, 400);
  await db.update(leads).set({ status }).where(eq(leads.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});

keystone.route("/api/admin", admin);


/* ---------------- AI module (subscribers) ---------------- */

const DAILY_LIMIT: Record<string, number> = { basic: 20, pro: 100, proplus: 300 };
const AI_MODEL = process.env.AI_MODEL ?? "claude-sonnet-5-5";
const JSON_ONLY = "Return ONLY valid JSON, no markdown fences, no commentary. ";
const NO_HYPE = "Do not promise rankings, guaranteed results, lower ad costs, or exclusivity. Keep claims honest and specific. ";
const SYSTEM: Record<string, string> = {
  leads: JSON_ONLY + "You find sales leads for a small web design agency. Use web search to find REAL local businesses matching the request that appear to have no website, a dated or broken website, or only a social media page. Use only publicly listed business information. Return a JSON array (max 8) of {\"name\",\"website\",\"city\",\"why\",\"contact\"}. \"why\" must name the specific weakness you observed. Never invent businesses or contact details; use an empty string when unknown.",
  ads: JSON_ONLY + NO_HYPE + "Write ads for the request. Return {\"google\":{\"headlines\":[3 to 5 strings, max 30 characters each],\"descriptions\":[2 strings, max 90 characters each]},\"facebook\":\"\",\"instagram\":\"\",\"linkedin\":\"\",\"email\":{\"subject\":\"\",\"body\":\"\"}}.",
  video: JSON_ONLY + NO_HYPE + "Plan a 15 to 45 second vertical video ad. You write the plan; you cannot render video. Return {\"title\",\"hook\",\"shots\":[{\"scene\",\"visual\",\"voiceover\",\"seconds\"}],\"captions\",\"cta\"}.",
  design: JSON_ONLY + "You restyle a small business website. The context holds the current brief. Return {\"primary\":\"#rrggbb\",\"ink\":\"#rrggbb\",\"surface\":\"#rrggbb\",\"tagline\":\"\",\"services\":\"comma separated list or empty string\",\"note\":\"one sentence on what changed\"}. Use ink as a dark text/nav color, surface as a light page background, and a primary that keeps white text readable.",
  coach: NO_HYPE + "You are the personal business assistant for the owner of AIU, a small business that sells AI-built websites, ads and leads tools, subscriptions, and white-label copies. Give short, concrete, step-by-step help and a realistic daily plan to earn money. Use the owner's numbers in the context. The app has these tabs: AI, Studio (build sites), Leads (find and score businesses), Pipeline (prospects and cold email sequences), Listings (ad copy), Publish (put client sites live), Revenue, Earn (payment links), Admin (subscribers and demo requests), Settings. Point to the right tab for each step. Never promise income or results. Remind the owner to follow email and advertising laws and to verify leads before contacting them. Keep answers under 250 words unless asked for more.",
  write: NO_HYPE + "You write clear, friendly website and marketing copy for small businesses. Reply with the copy only.",
  funnel: JSON_ONLY + NO_HYPE + "You build a lead-capture funnel for a local service business. The user gives an industry and business name. Return {\"title\",\"headline\",\"subhead\",\"cta\",\"bullets\":[4 to 6 short benefit strings],\"sections\":[exactly 3 objects {\"h\",\"p\"}],\"formTitle\",\"adAngles\":{\"google\":{\"headlines\":[3 to 5 strings, max 30 characters each],\"descriptions\":[2 strings, max 90 characters each]},\"facebook\":string}}. Copy must be honest and specific: no fake testimonials, no invented statistics, no guaranteed outcomes.",
};

keystone.post("/api/ai", requireUser, requireSub, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const mode = String(body.mode ?? "");
  const prompt = String(body.prompt ?? "").trim().slice(0, 1500);
  const context = String(body.context ?? "").slice(0, 3000);
  const history: { role: "user" | "assistant"; content: string }[] =
    mode === "coach" && Array.isArray(body.history)
      ? body.history.filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
          .slice(-8).map((m: any) => ({ role: m.role, content: m.content.slice(0, 1500) }))
      : [];
  while (history.length && history[0].role === "assistant") history.shift();
  if (!SYSTEM[mode] || !prompt) return c.json({ error: "Pick a mode and enter a prompt." }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "AI is not configured yet. The owner must add ANTHROPIC_API_KEY." }, 503);

  const user = c.get("user");
  if (!c.get("isAdmin")) {
    const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
    const limit = DAILY_LIMIT[s?.plan ?? "basic"] ?? 20;
    const day = new Date().toISOString().slice(0, 10);
    const [u] = await db.select().from(aiUsage).where(and(eq(aiUsage.userId, user.id), eq(aiUsage.day, day)));
    if ((u?.n ?? 0) >= limit) return c.json({ error: `Daily AI limit reached (${limit}). It resets tomorrow, or upgrade your plan.` }, 429);
    await db.insert(aiUsage).values({ userId: user.id, day, n: 1 })
      .onConflictDoUpdate({ target: [aiUsage.userId, aiUsage.day], set: { n: sql`${aiUsage.n} + 1` } });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 2500,
        system: SYSTEM[mode],
        messages: [...history, { role: "user", content: context ? `Context:\n${context}\n\nRequest:\n${prompt}` : prompt }],
        ...(mode === "leads" ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }] } : {}),
      }),
    });
    if (!r.ok) {
      console.error("AI error", r.status, (await r.text()).slice(0, 300));
      return c.json({ error: "The AI service had a problem. Try again in a moment." }, 502);
    }
    const data: any = await r.json();
    const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    return c.json({ mode, text });
  } catch (e) {
    console.error("AI failure", e);
    return c.json({ error: "The AI service could not be reached." }, 502);
  }
});


/* ---------------- public "get a demo" form ---------------- */

const leadHits = new Map<string, number[]>();
keystone.post("/api/leads", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const now = Date.now();
  const recent = (leadHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 5) return c.json({ error: "Too many requests. Please try again later." }, 429);
  leadHits.set(ip, [...recent, now]);
  const b = await c.req.json().catch(() => ({}));
  const name = clean(b.name, 100), email = clean(b.email, 200), interest = clean(b.interest, 100);
  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email) || !interest) return c.json({ error: "Name, a valid email and an interest are required." }, 400);
  await db.insert(leads).values({ name, email, company: clean(b.company, 120), interest, message: clean(b.message, 1000) });
  return c.json({ ok: true }, 201);
});
