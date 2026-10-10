/**
 * Keystone backend: owner-only admin, Stripe subscription gating, hot leads.
 * Assumes Hono, better-auth (auth.api.getSession) and Drizzle + SQLite.
 * Adjust the three imports below to match your project.
 * Mount with:  app.route("/", keystone)
 */
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { and, desc, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import crypto from "node:crypto";
import { db } from "./db";
import { auth } from "./auth";
import { affiliates, aiUsage, funnels, funnelLeads, ideas, leads, lifetimeAccess, partnerAccess, prospects, referrals, stripeEvents, subscriptions } from "./schema";

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

/** Paywall: owner always passes; partners and lifetime buyers pass; everyone else needs an active or trialing subscription. */
const requireSub: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get("isAdmin")) return next();
  const [part] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, c.get("user").id));
  if (part) return next();
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

/* ---------------- affiliates: tracking + commissions ---------------- */

const AFFILIATE_RATE = 0.15;
/** Partner yearly members. */
const PARTNER_RATE = 0.40;
/** Affiliate revenue tiers (lifetime referred revenue in cents -> rate). */
const AFFILIATE_TIERS = [
  { atCents: 5000000, rate: 0.50 },  // $50k
  { atCents: 1500000, rate: 0.35 },  // $15k
  { atCents: 500000, rate: 0.25 },   // $5k
];
/** Fast track: refer this much within 90 days of joining -> 50% for life (first 5 only). */
const FAST_TRACK_CENTS = 2500000; // $25k
const FAST_TRACK_DAYS = 90;
/** Lifetime-50% lock caps. */
const ELITE_LADDER_MAX = 15;
const ELITE_FAST_MAX = 5;
const AFF_COOKIE = "aff_code";
const AFF_COOKIE_DAYS = 60;

function genAffCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no look-alike chars
  const buf = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[buf[i] % chars.length];
  return s;
}

async function uniqueAffCode(): Promise<string> {
  while (true) {
    const code = genAffCode();
    const [row] = await db.select({ id: affiliates.id }).from(affiliates).where(eq(affiliates.code, code));
    if (!row) return code;
  }
}

/** Affiliate code from the tracking cookie, validated: exists, active, and not the buyer's own. */
async function referralCodeFor(c: { req: any }, buyerUserId: string): Promise<string | undefined> {
  const code = getCookie(c as any, AFF_COOKIE);
  if (!code) return undefined;
  const [aff] = await db.select().from(affiliates)
    .where(and(eq(affiliates.code, code), eq(affiliates.status, "active")));
  if (!aff || aff.userId === buyerUserId) return undefined;
  return code;
}

/** Lifetime referred revenue for an affiliate, in cents. */
async function affiliateRevenueCents(affiliateId: number): Promise<number> {
  const [r] = await db.select({ total: sql<number>`coalesce(sum(${referrals.amountCents}),0)` })
    .from(referrals).where(eq(referrals.affiliateId, affiliateId));
  return r?.total ?? 0;
}

/** Effective commission rate: partner 40%, lifetime-locked elites 50%, else revenue tiers from 15%. */
async function affiliateRateFor(aff: typeof affiliates.$inferSelect): Promise<number> {
  if (aff.tier === "partner") return PARTNER_RATE;
  if (aff.elite) return 0.50;
  const rev = await affiliateRevenueCents(aff.id);
  for (const t of AFFILIATE_TIERS) if (rev >= t.atCents) return t.rate;
  return AFFILIATE_RATE;
}

/** How many lifetime-50% locks have been granted via a given path. */
async function eliteCount(kind: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(affiliates)
    .where(and(eq(affiliates.elite, 1), eq(affiliates.eliteKind, kind)));
  return r?.n ?? 0;
}

/**
 * Lifetime-50% lock. Two paths:
 *  - Ladder: climb to $50k referred — first 15 lock 50% for life.
 *  - Fast track: $25k in the first 90 days — first 5 lock 50% for life.
 * The lock never decays on its own; only the owner can revoke it.
 */
async function checkElite(aff: typeof affiliates.$inferSelect): Promise<boolean> {
  if (aff.elite || aff.tier === "partner") return false;
  const rev = await affiliateRevenueCents(aff.id);
  if (rev >= AFFILIATE_TIERS[0].atCents) {
    if (await eliteCount("ladder") < ELITE_LADDER_MAX) {
      await db.update(affiliates).set({ elite: 1, eliteKind: "ladder" }).where(eq(affiliates.id, aff.id));
      return true;
    }
    return false;
  }
  const daysSinceJoin = (Date.now() - new Date(aff.createdAt).getTime()) / 86400000;
  if (daysSinceJoin <= FAST_TRACK_DAYS && rev >= FAST_TRACK_CENTS) {
    if (await eliteCount("fast") < ELITE_FAST_MAX) {
      await db.update(affiliates).set({ elite: 1, eliteKind: "fast" }).where(eq(affiliates.id, aff.id));
      return true;
    }
  }
  return false;
}

keystone.post("/api/billing/checkout", requireUser, async (c) => {
  const user = c.get("user");
  const { plan } = await c.req.json().catch(() => ({ plan: "pro" }));
  const price = PRICES[plan as string];
  if (!price) return c.json({ error: "Unknown plan. Use basic, pro or proplus." }, 400);
  const [prev] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  const trialDays = prev?.stripeSubscriptionId ? 0 : Number(process.env.TRIAL_DAYS ?? 7); // one free trial per account
  const affCode = await referralCodeFor(c, user.id);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: await customerFor(user),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    metadata: { kind: "subscription", ...(affCode ? { affCode } : {}) },
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
  const affCode = await referralCodeFor(c, c.get("user").id);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: await customerFor(c.get("user")),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: c.get("user").id,
    metadata: { kind: "lifetime", ...(affCode ? { affCode } : {}) },
    success_url: `${APP_URL}/app/billing?status=success`,
    cancel_url: `${APP_URL}/app/billing?status=cancelled`,
  });
  return c.json({ url: session.url });
});

/** Yearly Partner subscription. Needs STRIPE_PRICE_PARTNER_YEARLY in env. */
keystone.post("/api/billing/partner", requireUser, async (c) => {
  const price = process.env.STRIPE_PRICE_PARTNER_YEARLY;
  if (!price) return c.json({ error: "Partner checkout is not configured yet." }, 400);
  const [p] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, c.get("user").id));
  if (p) return c.json({ error: "You are already a partner." }, 400);
  const affCode = await referralCodeFor(c, c.get("user").id);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: await customerFor(c.get("user")),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: c.get("user").id,
    metadata: { kind: "partner", ...(affCode ? { affCode } : {}) },
    subscription_data: { metadata: { userId: c.get("user").id, kind: "partner" } },
    allow_promotion_codes: true,
    success_url: `${APP_URL}/app/billing?status=success`,
    cancel_url: `${APP_URL}/app/billing?status=cancelled`,
  });
  return c.json({ url: session.url });
});

keystone.get("/api/billing/status", requireUser, async (c) => {
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, c.get("user").id));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, c.get("user").id));
  const [part] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, c.get("user").id));
  const active = c.get("isAdmin") || !!part || !!life || ["active", "trialing"].includes(s?.status ?? "");
  return c.json({
    isAdmin: c.get("isAdmin"),
    lifetime: !!life,
    partner: !!part,
    status: part ? "partner" : life ? "lifetime" : s?.status ?? "none",
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
    const kind = s.metadata?.kind;
    const buyerId = s.client_reference_id || (s.metadata as any)?.userId;
    const cust = typeof s.customer === "string" ? s.customer : s.customer?.id ?? "";
    if (s.mode === "subscription" && s.subscription && buyerId) {
      const id = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
      await syncSubscription(await stripe.subscriptions.retrieve(id));
      if (kind === "partner") {
        // Yearly Partner subscription: access lasts while the subscription is active.
        await db.insert(partnerAccess).values({ userId: buyerId, stripeCustomerId: cust, stripeSubscriptionId: id })
          .onConflictDoUpdate({ target: partnerAccess.userId, set: { stripeSubscriptionId: id, stripeCustomerId: cust } });
        const [existingAff] = await db.select({ id: affiliates.id }).from(affiliates).where(eq(affiliates.userId, buyerId));
        if (existingAff) {
          await db.update(affiliates).set({ tier: "partner" }).where(eq(affiliates.id, existingAff.id));
        } else {
          await db.insert(affiliates).values({ userId: buyerId, code: await uniqueAffCode(), tier: "partner" });
        }
      }
    } else if (s.mode === "payment" && buyerId) {
      if (kind === "partner") {
        // Legacy one-time Partner purchase.
        await db.insert(partnerAccess).values({ userId: buyerId, stripeCustomerId: cust }).onConflictDoNothing();
        const [existingAff] = await db.select({ id: affiliates.id }).from(affiliates).where(eq(affiliates.userId, buyerId));
        if (existingAff) {
          await db.update(affiliates).set({ tier: "partner" }).where(eq(affiliates.id, existingAff.id));
        } else {
          await db.insert(affiliates).values({ userId: buyerId, code: await uniqueAffCode(), tier: "partner" });
        }
      } else {
        await db.insert(lifetimeAccess).values({ userId: buyerId, stripeCustomerId: cust }).onConflictDoNothing();
      }
    }
    // Referral commission on any completed purchase (initial sale only), at the referrer's current tier rate.
    const affCode = (s.metadata as any)?.affCode;
    if (affCode && buyerId) {
      const [aff] = await db.select().from(affiliates)
        .where(and(eq(affiliates.code, affCode), eq(affiliates.status, "active")));
      if (aff && aff.userId !== buyerId) {
        const amountCents = s.amount_total ?? 0;
        if (amountCents > 0) {
          const rate = await affiliateRateFor(aff);
          await db.insert(referrals).values({
            affiliateId: aff.id, userId: buyerId, kind: kind ?? s.mode,
            amountCents, commissionCents: Math.round(amountCents * rate),
            stripeEventId: event.id,
          }).onConflictDoNothing();
          await checkElite(aff);
        }
      }
    }
  } else if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const sub = event.data.object as Stripe.Subscription;
    await syncSubscription(sub);
    // A canceled/ended Partner subscription removes Partner access and drops the affiliate tier.
    if (sub.status === "canceled" || event.type === "customer.subscription.deleted") {
      const [pa] = await db.select().from(partnerAccess).where(eq(partnerAccess.stripeSubscriptionId, sub.id));
      if (pa) {
        await db.delete(partnerAccess).where(eq(partnerAccess.userId, pa.userId));
        await db.update(affiliates).set({ tier: "affiliate" }).where(eq(affiliates.userId, pa.userId));
      }
    }
  }
  return c.json({ received: true });
});

/* ---------------- affiliates: referral links + dashboard ---------------- */

/** Public referral link: sets a 60-day tracking cookie, then sends the visitor to the site. */
keystone.get("/r/:code", async (c) => {
  const code = c.req.param("code").toUpperCase().trim();
  const [aff] = await db.select({ id: affiliates.id }).from(affiliates)
    .where(and(eq(affiliates.code, code), eq(affiliates.status, "active")));
  if (!aff) return c.text("Not found", 404);
  setCookie(c, AFF_COOKIE, code, {
    path: "/",
    maxAge: AFF_COOKIE_DAYS * 24 * 3600,
    httpOnly: true,
    sameSite: "Lax",
    secure: APP_URL.startsWith("https://"),
  });
  return c.redirect("/", 302);
});

/** Join the affiliate program (free). Returns your referral code + link. */
keystone.post("/api/affiliates/join", requireUser, async (c) => {
  const userId = c.get("user").id;
  const [existing] = await db.select().from(affiliates).where(eq(affiliates.userId, userId));
  if (existing) return c.json({ ...existing, link: `${APP_URL}/r/${existing.code}` });
  const code = await uniqueAffCode();
  const [row] = await db.insert(affiliates).values({ userId, code }).returning();
  return c.json({ ...row, link: `${APP_URL}/r/${row.code}` }, 201);
});

/** My affiliate dashboard data, including tier ladder and accelerator progress. */
keystone.get("/api/affiliates/me", requireUser, async (c) => {
  const [aff] = await db.select().from(affiliates).where(eq(affiliates.userId, c.get("user").id));
  if (!aff) return c.json({ affiliate: null });
  const [stats] = await db.select({
    n: sql<number>`count(*)`,
    earned: sql<number>`coalesce(sum(${referrals.commissionCents}),0)`,
    paid: sql<number>`coalesce(sum(case when ${referrals.payoutStatus} = 'paid' then ${referrals.commissionCents} else 0 end),0)`,
    revenue: sql<number>`coalesce(sum(${referrals.amountCents}),0)`,
  }).from(referrals).where(eq(referrals.affiliateId, aff.id));
  const recent = await db.select().from(referrals)
    .where(eq(referrals.affiliateId, aff.id)).orderBy(desc(referrals.createdAt)).limit(20);
  const rate = await affiliateRateFor(aff);
  const revenueCents = stats?.revenue ?? 0;
  const nextTier = aff.tier === "partner" || aff.elite ? null
    : [...AFFILIATE_TIERS].reverse().find((t) => revenueCents < t.atCents) ?? null;
  const daysSinceJoin = (Date.now() - new Date(aff.createdAt).getTime()) / 86400000;
  const [ladderElites, fastElites] = await Promise.all([eliteCount("ladder"), eliteCount("fast")]);
  const fastTrack = aff.tier === "partner" ? null : {
    elite: !!aff.elite,
    daysLeft: Math.max(0, Math.ceil(FAST_TRACK_DAYS - daysSinceJoin)),
    targetCents: FAST_TRACK_CENTS,
    spotsLeft: Math.max(0, ELITE_FAST_MAX - fastElites),
    revenueCents,
    qualified: !!aff.elite,
  };
  return c.json({
    affiliate: { ...aff, link: `${APP_URL}/r/${aff.code}`, rate },
    stats: { referrals: stats?.n ?? 0, earnedCents: stats?.earned ?? 0, paidCents: stats?.paid ?? 0, revenueCents },
    tiers: [
      { rate: 0.15, atCents: 0, label: "Starter" },
      ...[...AFFILIATE_TIERS].reverse().map((t) => ({ rate: t.rate, atCents: t.atCents, label: `$${(t.atCents / 100).toLocaleString()}+ referred` })),
    ],
    nextTier, fastTrack,
    ladderSpotsLeft: Math.max(0, ELITE_LADDER_MAX - ladderElites),
    recent,
  });
});

/* Shared string cleaner. */
const clean = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

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
  const q = await aiQuota(c.get("user").id, c.get("isAdmin"));
  return q.ok ? null : c.json({ error: q.error }, 429);
}

/** One-click funnel generation: industry in, hosted landing page out. */
keystone.post("/api/funnels/generate", requireUser, requireSub, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const industry = clean(b.industry, 80);
  const business = clean(b.business, 120) || industry;
  if (!industry) return c.json({ error: "industry is required" }, 400);
  const blocked = await aiLimitHit(c);
  if (blocked) return blocked;
  try {
    const { row, url } = await aiFunnelData(c.get("user").id, industry, business);
    return c.json({ ...row, url }, 201);
  } catch (e: any) {
    return c.json({ error: e?.error || "Could not generate the funnel. Try again." }, e?.status ?? 502);
  }
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

/** Partners (and the owner) can pitch product ideas. Submitting an idea conveys no ownership or rights. */
keystone.post("/api/ideas", requireUser, async (c) => {
  const u = c.get("user");
  const isOwner = u.email === OWNER_EMAIL;
  const [aff] = await db.select().from(affiliates).where(eq(affiliates.userId, u.id));
  if (!isOwner && !(aff?.tier === "partner" && aff.status === "active"))
    return c.json({ error: "Ideas are open to partners." }, 403);
  const { title, body } = await c.req.json().catch(() => ({}));
  if (!title?.trim() || !body?.trim() || String(title).length > 120 || String(body).length > 2000)
    return c.json({ error: "Give your idea a title and a short description." }, 400);
  const [row] = await db.insert(ideas).values({ userId: u.id, title: String(title).trim(), body: String(body).trim() }).returning();
  return c.json({ idea: row });
});

/* ---------------- owner-only admin ---------------- */

const admin = new Hono<Env>();
admin.use("*", requireUser, requireAdmin);

admin.get("/overview", async (c) => {
  const subs = await db.select({ status: subscriptions.status, n: sql<number>`count(*)` }).from(subscriptions).groupBy(subscriptions.status);
  const [inbound] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(eq(leads.status, "new"));
  const [won] = await db.select({ total: sql<number>`coalesce(sum(${prospects.dealValue}),0)` }).from(prospects).where(eq(prospects.stage, "won"));
  return c.json({ subscribers: subs, newInboundLeads: inbound.n, wonRevenue: won.total });
});

admin.get("/subscribers", async (c) => c.json(await db.select().from(subscriptions).orderBy(desc(subscriptions.updatedAt))));
admin.get("/affiliates", async (c) => {
  const rows = await db.select({
    id: affiliates.id,
    userId: affiliates.userId,
    code: affiliates.code,
    tier: affiliates.tier,
    status: affiliates.status,
    elite: affiliates.elite,
    eliteKind: affiliates.eliteKind,
    createdAt: affiliates.createdAt,
    referrals: sql<number>`count(${referrals.id})`,
    earnedCents: sql<number>`coalesce(sum(${referrals.commissionCents}),0)`,
    paidCents: sql<number>`coalesce(sum(case when ${referrals.payoutStatus} = 'paid' then ${referrals.commissionCents} else 0 end),0)`,
  }).from(affiliates)
    .leftJoin(referrals, eq(referrals.affiliateId, affiliates.id))
    .groupBy(affiliates.id)
    .orderBy(desc(affiliates.createdAt));
  return c.json(rows);
});
admin.get("/referrals", async (c) => {
  const status = c.req.query("status");
  const where = status === "pending" || status === "paid" ? eq(referrals.payoutStatus, status) : undefined;
  const rows = await db.select().from(referrals)
    .where(where as any)
    .orderBy(desc(referrals.createdAt)).limit(200);
  return c.json(rows);
});
admin.post("/referrals/:id/pay", async (c) => {
  await db.update(referrals).set({ payoutStatus: "paid" }).where(eq(referrals.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});
admin.post("/affiliates/:id/status", async (c) => {
  const { status } = await c.req.json().catch(() => ({}));
  if (!["active", "paused"].includes(status)) return c.json({ error: "Invalid status" }, 400);
  await db.update(affiliates).set({ status }).where(eq(affiliates.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});
/** Owner: grant or revoke the lifetime-50% lock by hand. */
admin.post("/affiliates/:id/elite", async (c) => {
  const { elite } = await c.req.json().catch(() => ({}));
  const v = elite ? 1 : 0;
  await db.update(affiliates)
    .set({ elite: v, eliteKind: v ? "manual" : null })
    .where(eq(affiliates.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});
/** Partner-submitted ideas. */
admin.get("/ideas", async (c) =>
  c.json(await db.select().from(ideas).orderBy(desc(ideas.createdAt)).limit(100)));
admin.post("/ideas/:id/status", async (c) => {
  const { status } = await c.req.json().catch(() => ({}));
  if (!["new", "reviewing", "shipped", "declined"].includes(status)) return c.json({ error: "Invalid status" }, 400);
  await db.update(ideas).set({ status }).where(eq(ideas.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});
admin.get("/leads", async (c) => c.json(await db.select().from(leads).orderBy(desc(leads.createdAt))));
admin.patch("/leads/:id", async (c) => {
  const { status } = await c.req.json().catch(() => ({}));
  if (!["new", "contacted", "won", "lost"].includes(status)) return c.json({ error: "Invalid status" }, 400);
  await db.update(leads).set({ status }).where(eq(leads.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});

keystone.route("/api/admin", admin);


/* ---------------- AI: all-in-one assistant + funnel generation (subscribers) ---------------- */

const DAILY_LIMIT: Record<string, number> = { basic: 20, pro: 100, proplus: 300, lifetime: 300 };
const AI_MODEL = process.env.AI_MODEL ?? "claude-sonnet-5-5";
const JSON_ONLY = "Return ONLY valid JSON, no markdown fences, no commentary. ";
const NO_HYPE = "Do not promise rankings, guaranteed results, lower ad costs, or exclusivity. Keep claims honest and specific. ";

/** Charge one AI request against the user's daily quota. Admin is unlimited. */
async function aiQuota(userId: string, isAdmin: boolean): Promise<{ ok: boolean; error?: string }> {
  if (isAdmin) return { ok: true };
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, userId));
  const plan = life ? "lifetime" : s?.plan ?? "basic";
  const limit = DAILY_LIMIT[plan] ?? 20;
  const day = new Date().toISOString().slice(0, 10);
  const [u] = await db.select().from(aiUsage).where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, day)));
  if ((u?.n ?? 0) >= limit) return { ok: false, error: `Daily AI limit reached (${limit}). It resets tomorrow, or upgrade your plan.` };
  await db.insert(aiUsage).values({ userId, day, n: 1 })
    .onConflictDoUpdate({ target: [aiUsage.userId, aiUsage.day], set: { n: sql`${aiUsage.n} + 1` } });
  return { ok: true };
}

const FUNNEL_SYSTEM = JSON_ONLY + NO_HYPE + "You build a lead-capture funnel for a local service business. The user gives an industry and business name. Return {\"title\",\"headline\",\"subhead\",\"cta\",\"bullets\":[4 to 6 short benefit strings],\"sections\":[exactly 3 objects {\"h\",\"p\"}],\"formTitle\",\"adAngles\":{\"google\":{\"headlines\":[3 to 5 strings, max 30 characters each],\"descriptions\":[2 strings, max 90 characters each]},\"facebook\":string}}. Copy must be honest and specific: no fake testimonials, no invented statistics, no guaranteed outcomes.";

/** Generate funnel page data with the AI, store it, and return the row + URL. Throws { status, error }. */
async function aiFunnelData(userId: string, industry: string, business: string) {
  if (!process.env.ANTHROPIC_API_KEY) throw { status: 503, error: "AI is not configured yet." };
  let data: any;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL, max_tokens: 2500,
        system: FUNNEL_SYSTEM,
        messages: [{ role: "user", content: `Industry: ${industry}\nBusiness name: ${business}` }],
      }),
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      console.error("anthropic upstream", r.status, bodyText.slice(0, 500));
      throw { status: 502, error: "The AI service had a problem. Try again in a moment." };
    }
    const j: any = await r.json();
    const text = (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n").trim();
    data = JSON.parse(text);
  } catch (e: any) {
    if (e?.status) throw e;
    throw { status: 502, error: "Could not generate the funnel. Try again." };
  }
  if (!data || typeof data.headline !== "string") throw { status: 502, error: "The AI returned an unusable funnel. Try again." };
  const slug = await uniqueSlug(`${business} ${industry}`);
  const html = renderFunnelPage({
    title: String(data.title || business), headline: data.headline, subhead: String(data.subhead || ""),
    cta: String(data.cta || "Get started"), bullets: data.bullets || [], sections: data.sections || [],
    formTitle: String(data.formTitle || "Get your free quote"),
  }, slug);
  const [row] = await db.insert(funnels).values({
    userId, slug, industry, title: String(data.title || business),
    html, adAngles: data.adAngles ?? {}, status: "draft",
  }).returning();
  return { row, url: `${APP_URL}/f/${slug}` };
}

const ASSISTANT_SYSTEM = `You are the AIU assistant, an all-in-one AI helper inside the AIU app. You help the user:
- build lead-capture funnels (use the generate_funnel tool, then offer to publish it with set_funnel_status),
- manage their funnels and leads (list_funnels, list_leads, claim_lead, list_prospects),
- check their plan and referral program (billing_status, affiliate_info),
- and build anything else they can think of: websites, landing pages, apps, tools, emails, copy, plans, code. You can also edit and improve things they already have.

Rules:
- Be direct and useful. Short answers unless detail is asked for.
- When the user asks you to build a website, page, app, or tool, output ONE complete self-contained HTML file (inline CSS and JS, no build step, no external dependencies except Google Fonts if needed) inside a fenced block that starts with \`\`\`html-artifact and ends with \`\`\`. Nothing else may be inside that block. Before or after it, briefly say what you built and how to use it.
- When the user asks to change something in their current project, output the FULL updated file again in a new \`\`\`html-artifact block, never a diff.
- Never invent businesses, contact details, testimonials, or statistics. Never promise rankings, guaranteed results, or income.
- When you claim a lead, tell the user it moved to their Pipeline and left the available pool.
- If a tool fails, say what happened in plain words and suggest the next step.`;

const ASSISTANT_TOOLS: any[] = [
  { name: "generate_funnel", description: "Generate an AI lead-capture funnel page for an industry and business name. Saves it as a draft and returns its id, title and shareable URL.", input_schema: { type: "object", properties: { industry: { type: "string", description: "e.g. roofers, plumbers, dentists" }, business: { type: "string", description: "Business name (optional)" } }, required: ["industry"] } },
  { name: "list_funnels", description: "List the user's funnels: id, title, industry, status (draft/live), url, updated date.", input_schema: { type: "object", properties: {} } },
  { name: "set_funnel_status", description: "Publish a funnel (status live) or unpublish it (status draft) by id.", input_schema: { type: "object", properties: { id: { type: "number" }, status: { type: "string", enum: ["live", "draft"] } }, required: ["id", "status"] } },
  { name: "delete_funnel", description: "Permanently delete a funnel and its captured leads by id.", input_schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "list_leads", description: "List available (unclaimed) leads captured through the user's funnels.", input_schema: { type: "object", properties: {} } },
  { name: "claim_lead", description: "Claim a lead by id: moves it into the Pipeline as a prospect and removes it from the available leads pool.", input_schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "list_prospects", description: "List the user's pipeline prospects with their stage.", input_schema: { type: "object", properties: {} } },
  { name: "billing_status", description: "Check the user's plan, subscription status and whether the account is active.", input_schema: { type: "object", properties: {} } },
  { name: "affiliate_info", description: "Get the user's affiliate referral link, commission rate and earnings.", input_schema: { type: "object", properties: {} } },
];

/** Execute one assistant tool call. Always returns a JSON-able object (never throws). */
async function runAssistantTool(name: string, input: any, userId: string): Promise<any> {
  try {
    switch (name) {
      case "generate_funnel": {
        const industry = clean(input?.industry, 80);
        if (!industry) return { error: "I need an industry to build the funnel." };
        const business = clean(input?.business, 120) || industry;
        try {
          const { row, url } = await aiFunnelData(userId, industry, business);
          return { id: row.id, title: row.title, industry: row.industry, status: row.status, url };
        } catch (e: any) { return { error: e?.error || "Could not generate the funnel." }; }
      }
      case "list_funnels": {
        const rows = await db.select().from(funnels).where(eq(funnels.userId, userId)).orderBy(desc(funnels.updatedAt));
        return rows.map((r) => ({ id: r.id, title: r.title, industry: r.industry, status: r.status, url: `${APP_URL}/f/${r.slug}` }));
      }
      case "set_funnel_status": {
        const id = Number(input?.id);
        const status = input?.status === "live" ? "live" : "draft";
        const [f] = await db.select().from(funnels).where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
        if (!f) return { error: "Funnel not found." };
        await db.update(funnels).set({ status, updatedAt: new Date() }).where(eq(funnels.id, id));
        return { ok: true, id, status, url: `${APP_URL}/f/${f.slug}` };
      }
      case "delete_funnel": {
        const id = Number(input?.id);
        await db.delete(funnelLeads).where(and(eq(funnelLeads.funnelId, id), eq(funnelLeads.userId, userId)));
        await db.delete(funnels).where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
        return { ok: true, id };
      }
      case "list_leads": {
        const rows = await db.select().from(funnelLeads)
          .where(and(eq(funnelLeads.userId, userId), eq(funnelLeads.status, "new")))
          .orderBy(desc(funnelLeads.createdAt)).limit(50);
        const titles = new Map<number, string>();
        for (const fid of [...new Set(rows.map((r) => r.funnelId))]) {
          const [f] = await db.select().from(funnels).where(eq(funnels.id, fid));
          if (f) titles.set(fid, f.title);
        }
        return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, city: r.city, state: r.state, funnel: titles.get(r.funnelId) ?? "" }));
      }
      case "claim_lead": {
        const id = Number(input?.id);
        const [l] = await db.select().from(funnelLeads)
          .where(and(eq(funnelLeads.id, id), eq(funnelLeads.userId, userId), eq(funnelLeads.status, "new")));
        if (!l) return { error: "Lead not found or already claimed." };
        const [f] = await db.select().from(funnels).where(eq(funnels.id, l.funnelId));
        const [p] = await db.insert(prospects).values({
          userId, businessName: l.name, contactName: l.name, email: l.email, phone: l.phone,
          city: l.city, industry: f?.industry ?? null, stage: "new",
          notes: `Claimed from funnel "${f?.title ?? ""}".`,
        }).returning();
        await db.update(funnelLeads).set({ status: "claimed" }).where(eq(funnelLeads.id, l.id));
        return { ok: true, prospect: { id: p.id, name: p.businessName, email: p.email, stage: p.stage } };
      }
      case "list_prospects": {
        const rows = await db.select().from(prospects).where(eq(prospects.userId, userId)).orderBy(desc(prospects.updatedAt)).limit(50);
        return rows.map((r) => ({ id: r.id, name: r.businessName, contact: r.contactName, email: r.email, phone: r.phone, stage: r.stage, dealValue: r.dealValue }));
      }
      case "billing_status": {
        const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
        const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, userId));
        const [part] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, userId));
        return { plan: part ? "partner" : life ? "lifetime" : s?.plan ?? "none", status: s?.status ?? (life || part ? "active" : "none"), lifetime: !!life, partner: !!part };
      }
      case "affiliate_info": {
        const [aff] = await db.select().from(affiliates).where(eq(affiliates.userId, userId));
        if (!aff) return { joined: false, message: "Not in the affiliate program yet. Join from the Affiliates tab." };
        const [stats] = await db.select({ n: sql<number>`count(*)`, earned: sql<number>`coalesce(sum(${referrals.commissionCents}),0)` }).from(referrals).where(eq(referrals.affiliateId, aff.id));
        return { joined: true, link: `${APP_URL}/r/${aff.code}`, rate: aff.tier === "partner" ? "50%" : "30%", referrals: stats?.n ?? 0, earnedCents: stats?.earned ?? 0 };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e: any) {
    return { error: e?.message || "Tool failed." };
  }
}

/** Chat with the all-in-one assistant. One AI request is charged per user turn. */
keystone.post("/api/assistant/chat", requireUser, requireSub, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = c.get("user");
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const messages: any[] = incoming
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
    .slice(-20)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user")
    return c.json({ error: "Send a message to the assistant." }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "AI is not configured yet." }, 503);
  const quota = await aiQuota(user.id, c.get("isAdmin"));
  if (!quota.ok) return c.json({ error: quota.error }, 429);

  // Current project context, so "change the headline" edits the right code.
  const art = body.artifact;
  if (art && typeof art.code === "string" && art.code.length > 0 && art.code.length < 200000) {
    const last = messages[messages.length - 1];
    last.content += `\n\n[The user's current project is "${String(art.name || "untitled").slice(0, 80)}". Its full code is below. When they ask for changes, return the FULL updated file in a new html-artifact block.]\n\`\`\`html\n${art.code.slice(0, 120000)}\n\`\`\``;
  }

  const callAnthropic = async (msgs: any[]) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 4000, system: ASSISTANT_SYSTEM, tools: ASSISTANT_TOOLS, messages: msgs }),
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      console.error("anthropic upstream", r.status, bodyText.slice(0, 500));
      throw { status: 502, error: "The AI service had a problem. Try again in a moment." };
    }
    return r.json();
  };

  try {
    let data: any = await callAnthropic(messages);
    for (let i = 0; i < 5; i++) {
      if (data.stop_reason !== "tool_use") break;
      const toolUses = (data.content ?? []).filter((b: any) => b.type === "tool_use");
      if (!toolUses.length) break;
      const results = [];
      for (const tu of toolUses) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(await runAssistantTool(tu.name, tu.input ?? {}, user.id)).slice(0, 8000),
        });
      }
      messages.push({ role: "assistant", content: data.content });
      messages.push({ role: "user", content: results });
      data = await callAnthropic(messages);
    }
    const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    return c.json({ reply: text || "I ran into trouble on that one. Try asking again in different words." });
  } catch (e: any) {
    console.error("assistant failure", e?.status || "", e?.error || e?.message || e);
    return c.json({ error: e?.error || "The assistant could not be reached." }, e?.status ?? 502);
  }
});

/** Today's AI usage for the chat UI. */
keystone.get("/api/assistant/limits", requireUser, async (c) => {
  const user = c.get("user");
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, user.id));
  const plan = life ? "lifetime" : s?.plan ?? "basic";
  const limit = c.get("isAdmin") ? -1 : DAILY_LIMIT[plan] ?? 20;
  const day = new Date().toISOString().slice(0, 10);
  const [u] = await db.select().from(aiUsage).where(and(eq(aiUsage.userId, user.id), eq(aiUsage.day, day)));
  return c.json({ plan, limit, used: u?.n ?? 0 });
});

/** My pipeline prospects (claimed leads live here). */
keystone.get("/api/prospects", requireUser, requireSub, async (c) => {
  const rows = await db.select().from(prospects).where(eq(prospects.userId, c.get("user").id)).orderBy(desc(prospects.updatedAt));
  return c.json(rows);
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
