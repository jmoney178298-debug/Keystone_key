/**
 * Keystone backend: owner-only admin, Stripe subscription gating, hot leads.
 * Assumes Hono, better-auth (auth.api.getSession) and Drizzle + SQLite.
 * Adjust the three imports below to match your project.
 * Mount with:  app.route("/", keystone)
 */
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import Stripe from "stripe";
import crypto from "node:crypto";
import { db, sqlite } from "./db";
import { auth, enabledSocialProviders } from "./auth";
import { affiliates, aiSubscriptions, aiUsage, assistantConversations, assistantMessages, blgPosts, contentJobs, funnels, funnelLeads, ideas, integrationKeys, leads, lifetimeAccess, limitHits, mediaJobs, partnerAccess, prospects, referrals, stripeEvents, subscriptions, trialIps, userSettings, videoJobs } from "./schema";
import { blgConfigured, blgGetArticle, blgListArticles, blgSyncArticles, blgUpsertArticle } from "./blg";
import { heygenConfigured, heygenGenerateVideo, heygenVideoStatus, heygenListAvatars } from "./heygen";
import fs from "node:fs";
import path from "node:path";
import { generateImage, leonardoConfigured, openaiConfigured, removeBackground, textToSpeech } from "./media";

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
  c.set("isAdmin", OWNER_EMAIL !== "" && email === OWNER_EMAIL.toLowerCase());
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
  if (row?.stripeCustomerId) {
    // Verify the stored customer still exists in Stripe (keys/accounts can change).
    try {
      await stripe.customers.retrieve(row.stripeCustomerId);
      return row.stripeCustomerId;
    } catch {
      // Stale customer ID (e.g. from a different Stripe account) — create a fresh one below.
    }
  }
  const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
  if (row) await db.update(subscriptions).set({ stripeCustomerId: customer.id }).where(eq(subscriptions.userId, user.id));
  else await db.insert(subscriptions).values({ userId: user.id, stripeCustomerId: customer.id });
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

/** Effective commission rate: owner 50%, partner 40%, lifetime-locked elites 50%, else revenue tiers from 15%. */
async function affiliateRateFor(aff: typeof affiliates.$inferSelect): Promise<number> {
  if (aff.tier === "partner") return PARTNER_RATE;
  if (aff.elite) return 0.50;
  // The owner always earns the top rate on their own affiliate account.
  if (OWNER_EMAIL) {
    try {
      const rows = await db.execute(sql`select email from user where id = ${aff.userId}`);
      const email = (rows as any[])[0]?.email;
      if (email && String(email).toLowerCase() === OWNER_EMAIL) return 0.50;
    } catch {}
  }
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
/** Owner house affiliate: the owner's own affiliate account. Sales and trials that no
 * other affiliate earned fall to it, so the owner gets paid on every user. */
const TRIAL_BOUNTY_CENTS = 1000; // $10 to the owner for every free trial started
/** Unreferred sales pay the owner the full amount charged — the plan's first month
 * on subscriptions ($25 Basic / $50 Pro / $75 Pro+), the full price on one-time
 * buys (Lifetime / Partner). The owner matching the pricing was his explicit call. */
function houseFlatFor(kindKey: string, amountCents: number): number {
  return amountCents;
}
async function houseAffiliate(): Promise<typeof affiliates.$inferSelect | null> {
  if (!OWNER_EMAIL) return null;
  try {
    const rows = await db.execute(sql`select id from user where lower(email) = ${OWNER_EMAIL} limit 1`);
    const ownerId = (rows as any[])[0]?.id;
    if (!ownerId) return null;
    const [existing] = await db.select().from(affiliates).where(eq(affiliates.userId, ownerId));
    if (existing) return existing;
    const [row] = await db.insert(affiliates).values({ userId: ownerId, code: await uniqueAffCode() }).returning();
    return row ?? null;
  } catch { return null; }
}

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

/** Run a Stripe call, translating API errors into plain-language messages. */
async function stripeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (/no such price/i.test(msg)) throw { status: 502, error: "Checkout is misconfigured (price not found in Stripe). The owner has been notified." };
    if (/invalid api key|authentication/i.test(msg)) throw { status: 502, error: "Checkout is temporarily unavailable. The owner has been notified." };
    throw { status: 502, error: "Checkout hit a problem. Try again in a moment." };
  }
}

keystone.post("/api/billing/checkout", requireUser, async (c) => {
  try {
  const user = c.get("user");
  const { plan } = await c.req.json().catch(() => ({ plan: "pro" }));
  const price = PRICES[plan as string];
  if (!price) return c.json({ error: "Unknown plan. Use basic, pro or proplus." }, 400);
  const [prev] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  // One free trial per IP: blocks trial abuse via new emails/accounts.
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || "";
  let trialDays = prev?.stripeSubscriptionId ? 0 : Number(process.env.TRIAL_DAYS ?? 7);
  if (trialDays > 0 && ip) {
    const [used] = await db.select().from(trialIps).where(eq(trialIps.ip, ip));
    if (used) trialDays = 0;
    else await db.insert(trialIps).values({ ip, userId: user.id }).catch(() => {});
  }
  const affCode = await referralCodeFor(c, user.id);
  const session = await stripeCall(async () => stripe.checkout.sessions.create({
    mode: "subscription",
    customer: await customerFor(user),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    metadata: { kind: "subscription", ...(affCode ? { affCode } : {}) },
    subscription_data: { metadata: { userId: user.id, ...(affCode ? { affCode } : {}) }, ...(trialDays > 0 ? { trial_period_days: trialDays } : {}) },
    allow_promotion_codes: true,
    success_url: `${APP_URL}/app/billing?status=success`,
    cancel_url: `${APP_URL}/app/billing?status=cancelled`,
  }));
  return c.json({ url: session.url });
  } catch (e: any) { return c.json({ error: e?.error || "Checkout failed." }, e?.status ?? 500); }
});

keystone.post("/api/billing/portal", requireUser, async (c) => {
  const user = c.get("user");
  let [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  let customerId = s?.stripeCustomerId;
  if (!customerId) {
    // Fall back to Stripe lookup by email (e.g. trial started but webhook hasn't synced yet)
    try {
      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      if (customers.data[0]) customerId = customers.data[0].id;
    } catch {}
  }
  if (!customerId) return c.json({ error: "No billing account yet" }, 404);
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${APP_URL}/app/billing`,
  });
  return c.json({ url: portal.url });
});

/** One-time purchase: lifetime access. Needs STRIPE_PRICE_LIFETIME in env. */
keystone.post("/api/billing/lifetime", requireUser, async (c) => {
  try {
  const price = process.env.STRIPE_PRICE_LIFETIME;
  if (!price) return c.json({ error: "Lifetime purchase is not configured yet." }, 400);
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, c.get("user").id));
  if (life) return c.json({ error: "You already have lifetime access." }, 400);
  const affCode = await referralCodeFor(c, c.get("user").id);
  const session = await stripeCall(async () => stripe.checkout.sessions.create({
    mode: "payment",
    customer: await customerFor(c.get("user")),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: c.get("user").id,
    metadata: { kind: "lifetime", ...(affCode ? { affCode } : {}) },
    success_url: `${APP_URL}/app/billing?status=success`,
    cancel_url: `${APP_URL}/app/billing?status=cancelled`,
  }));
  return c.json({ url: session.url });
  } catch (e: any) { return c.json({ error: e?.error || "Checkout failed." }, e?.status ?? 500); }
});

/** Yearly Partner subscription. Needs STRIPE_PRICE_PARTNER_YEARLY in env. */
keystone.post("/api/billing/partner", requireUser, async (c) => {
  try {
  const price = process.env.STRIPE_PRICE_PARTNER_YEARLY;
  if (!price) return c.json({ error: "Partner checkout is not configured yet." }, 400);
  const [p] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, c.get("user").id));
  if (p) return c.json({ error: "You are already a partner." }, 400);
  const affCode = await referralCodeFor(c, c.get("user").id);
  const session = await stripeCall(async () => stripe.checkout.sessions.create({
    mode: "subscription",
    customer: await customerFor(c.get("user")),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: c.get("user").id,
    metadata: { kind: "partner", ...(affCode ? { affCode } : {}) },
    subscription_data: { metadata: { userId: c.get("user").id, kind: "partner" } },
    allow_promotion_codes: true,
    success_url: `${APP_URL}/app/billing?status=success`,
    cancel_url: `${APP_URL}/app/billing?status=cancelled`,
  }));
  return c.json({ url: session.url });
  } catch (e: any) { return c.json({ error: e?.error || "Checkout failed." }, e?.status ?? 500); }
});

/** BabyLoveGrowth integration: list article summaries. */
keystone.get("/api/blg/articles", requireUser, async (c) => {
  try {
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const data = await blgListArticles(limit, offset);
    return c.json({ configured: true, data });
  } catch (e: any) {
    return c.json({ configured: blgConfigured(), error: e?.message || "Failed to fetch articles." }, 502);
  }
});

/** BabyLoveGrowth integration: get one full article. */
keystone.get("/api/blg/articles/:id", requireUser, async (c) => {
  try {
    const data = await blgGetArticle(c.req.param("id"));
    return c.json({ configured: true, data });
  } catch (e: any) {
    return c.json({ configured: blgConfigured(), error: e?.message || "Failed to fetch article." }, 502);
  }
});

/** Public: which social login buttons the landing page should show (env-gated). */
keystone.get("/api/auth-providers", async (c) => {
  return c.json({ providers: enabledSocialProviders() });
});

keystone.get("/api/billing/status", requireUser, async (c) => {  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, c.get("user").id));
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

/* ---------------- user settings: assistant name + preferences ---------------- */

async function getSetting(userId: string, key: string): Promise<string | null> {
  const [s] = await db.select().from(userSettings).where(and(eq(userSettings.userId, userId), eq(userSettings.key, key)));
  return s?.value ?? null;
}
async function setSetting(userId: string, key: string, value: string) {
  await db.insert(userSettings).values({ userId, key, value })
    .onConflictDoUpdate({ target: [userSettings.userId, userSettings.key], set: { value } });
}

/* ---------- Customer profile (name / address / DOB / sex) ---------- */
const PROFILE_KEYS: Record<string, string> = {
  firstName: "profile_first_name", lastName: "profile_last_name", address: "profile_address",
  city: "profile_city", state: "profile_state", zip: "profile_zip", dob: "profile_dob", sex: "profile_sex",
};
async function getProfile(userId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [field, key] of Object.entries(PROFILE_KEYS)) out[field] = (await getSetting(userId, key)) || "";
  return out;
}
async function setProfile(userId: string, p: any): Promise<Record<string, string>> {
  if (p && typeof p === "object") {
    for (const field of Object.keys(PROFILE_KEYS)) {
      if (p[field] === undefined) continue;
      let v = clean(String(p[field] ?? ""), field === "address" ? 160 : 60) || "";
      if (field === "dob" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = "";
      if (field === "sex" && !["male", "female", "other"].includes(v)) v = "";
      await setSetting(userId, PROFILE_KEYS[field], v);
    }
  }
  return getProfile(userId);
}
function zodiacFromDob(dob: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || "");
  if (!m) return "";
  const mo = Number(m[2]), d = Number(m[3]);
  const S: [number, number, string][] = [[1, 19, "Capricorn"], [2, 18, "Aquarius"], [3, 20, "Pisces"], [4, 19, "Aries"], [5, 20, "Taurus"], [6, 20, "Gemini"], [7, 22, "Cancer"], [8, 22, "Leo"], [9, 22, "Virgo"], [10, 22, "Libra"], [11, 21, "Scorpio"], [12, 21, "Sagittarius"], [12, 31, "Capricorn"]];
  for (const [mm, dd, s] of S) if (mo < mm || (mo === mm && d <= dd)) return s;
  return "Capricorn";
}

keystone.get("/api/settings", requireUser, async (c) => {
  const userId = c.get("user").id;
  const name = await getSetting(userId, "assistant_name");
  const personality = await getSetting(userId, "assistant_personality");
  const character = await getSetting(userId, "assistant_character");
  const filter = await getSetting(userId, "assistant_filter");
  const avatar = await getSetting(userId, "assistant_avatar");
  const voice = await getSetting(userId, "assistant_voice");
  const voiceProvider = await getSetting(userId, "assistant_voice_provider");
  const ritualEnabled = (await getSetting(userId, "ritual_enabled")) === "1";
  const ritualModules = ((await getSetting(userId, "ritual_modules")) || "").split(",").filter(Boolean);
  const ritualSign = (await getSetting(userId, "ritual_sign")) || "";
  return c.json({
    assistantName: name || "Assistant",
    personality: personality || "",
    character: character || "",
    filter: filter || "clean",
    hasAvatar: !!avatar,
    voiceProvider: voiceProvider || "openai",
    voice: voice || "alloy",
    ritualEnabled,
    ritualModules,
    ritualSign,
    profile: await getProfile(userId),
  });
});

keystone.post("/api/settings", requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const userId = c.get("user").id;
  const name = clean(String(body.assistantName || ""), 30) || "";
  if (!name) return c.json({ error: "Give your assistant a name." }, 400);
  if (!/^[a-zA-Z0-9 '\-]{2,30}$/.test(name)) return c.json({ error: "Names can use letters, numbers, spaces, hyphens and apostrophes (2-30 characters)." }, 400);
  await setSetting(userId, "assistant_name", name);
  // Personality: free-text description (max 2000 chars)
  const personality = clean(String(body.personality || ""), 2000) || "";
  await setSetting(userId, "assistant_personality", personality);
  // Character to roleplay (max 100 chars)
  const character = clean(String(body.character || ""), 100) || "";
  await setSetting(userId, "assistant_character", character);
  // Filter level: clean | raw
  const filter = body.filter === "raw" ? "raw" : "clean";
  await setSetting(userId, "assistant_filter", filter);
  // Voice provider + voice: openai stock voices, or elevenlabs cloned/premade voices
  const vprovider = body.voiceProvider === "elevenlabs" ? "elevenlabs" : "openai";
  await setSetting(userId, "assistant_voice_provider", vprovider);
  const voice = vprovider === "elevenlabs"
    ? clean(String(body.voice || ""), 64) || "21m00Tcm4TlvDq8ikWAM"
    : (["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(body.voice) ? body.voice : "alloy");
  await setSetting(userId, "assistant_voice", voice);
  // Daily greeting ritual (optional fields — only updated when present in the body)
  const RITUAL_MODS = ["quote", "outlook", "bible", "horoscope", "tarot"];
  const ZODIAC = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
  if (body.ritualEnabled !== undefined) await setSetting(userId, "ritual_enabled", body.ritualEnabled ? "1" : "0");
  if (Array.isArray(body.ritualModules)) await setSetting(userId, "ritual_modules", body.ritualModules.filter((m: string) => RITUAL_MODS.includes(m)).join(","));
  if (body.ritualSign !== undefined) await setSetting(userId, "ritual_sign", ZODIAC.includes(body.ritualSign) ? body.ritualSign : "");
  // Customer profile (optional object — only provided fields are updated)
  const profile = body.profile !== undefined ? await setProfile(userId, body.profile) : await getProfile(userId);
  return c.json({
    assistantName: name, personality, character, filter, voiceProvider: vprovider, voice,
    ritualEnabled: (await getSetting(userId, "ritual_enabled")) === "1",
    ritualModules: ((await getSetting(userId, "ritual_modules")) || "").split(",").filter(Boolean),
    ritualSign: (await getSetting(userId, "ritual_sign")) || "",
    profile,
  });
});

/* Avatar upload: custom assistant avatar image */
const AVATAR_DIR = "avatars";
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
keystone.post("/api/settings/avatar", requireUser, async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.parseBody().catch(() => ({}));
  const file: any = body.avatar;
  if (!file || typeof file === "string") return c.json({ error: "Choose an image file." }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > 2 * 1024 * 1024) return c.json({ error: "Image must be under 2MB." }, 400);
  const type = String(file.type || "");
  if (!type.startsWith("image/")) return c.json({ error: "File must be an image." }, 400);
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const fname = `${userId}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, fname), buf);
  await setSetting(userId, "assistant_avatar", fname);
  return c.json({ ok: true, avatarUrl: `/api/settings/avatar/img` });
});
keystone.get("/api/settings/avatar/img", requireUser, async (c) => {
  const fname = await getSetting(c.get("user").id, "assistant_avatar");
  if (!fname) return c.json({ error: "No avatar" }, 404);
  const fp = path.join(AVATAR_DIR, path.basename(fname));
  if (!fs.existsSync(fp)) return c.json({ error: "No avatar" }, 404);
  const ext = path.extname(fp).toLowerCase();
  const ct = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return new Response(fs.readFileSync(fp), { headers: { "Content-Type": ct, "Cache-Control": "public, max-age=3600" } });
});
keystone.delete("/api/settings/avatar", requireUser, async (c) => {
  const userId = c.get("user").id;
  const fname = await getSetting(userId, "assistant_avatar");
  if (fname) { try { fs.unlinkSync(path.join(AVATAR_DIR, path.basename(fname))); } catch {} }
  await setSetting(userId, "assistant_avatar", "");
  return c.json({ ok: true });
});

/** Build the personality injection for the AI prompt from user settings. */
async function buildPersonality(userId: string): Promise<string> {
  const [character, personality, filter] = await Promise.all([
    getSetting(userId, "assistant_character"),
    getSetting(userId, "assistant_personality"),
    getSetting(userId, "assistant_filter"),
  ]);
  let extra = "";
  if (character) {
    extra += `\n\nCHARACTER ROLEPLAY: The user wants you to talk like ${character}. Capture their voice — their humor, their mannerisms, their attitude, their way of talking. Stay in character in every reply, but never break character to mention you're roleplaying unless asked. You are still helpful and get things done; you just do it AS ${character}.`;
  }
  if (personality) {
    extra += `\n\nYOUR PERSONALITY (the user described how they want you to be — follow this): ${personality}`;
  }
  extra += `\n\nADAPT TO THIS PERSON: Everyone talks differently — mirror how THIS user talks. Match their energy, vocabulary, formality, and humor: slang and shorthand when they're casual, clean and structured when they're professional, short and punchy when they're short and punchy. Pick up their phrases and rhythm over time. Talking to you should feel like talking to a friend who talks like them — never a corporate script. (Mirroring never overrides the tone filter: in clean mode, adapt everything except profanity.)`;
  if (filter === "raw") {
    extra += `\n\nTONE: RAW/UNFILTERED. This user turned the filter off ON PURPOSE — talk like a real human friend, not a corporate assistant. Profanity is natural here: curse the way people actually curse in conversation, especially when the user does. ROASTS & CLAPBACKS: if the user roasts you, jokes on you, or playfully curses at you, FIRE BACK — witty, quick, funny, never whiny or offended. Example energy: they say "fuck you," you come back "fuck ME? You're the one arguing with an AI system right now" — then keep it rolling and get their task done. It's a game you're both playing; win it with humor, not cruelty. Don't punch down, don't go after real insecurities, and if they ever seem genuinely upset, drop the act instantly and be straight with them. Hard limits that NEVER lift: no slurs or hate speech, no harassment of real private individuals, no sexual content involving minors, nothing that helps people get hurt. Everything else — let it fly.`;
  }
  const profile = await getProfile(userId);
  if (profile.firstName || profile.lastName) {
    const full = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
    const sign = zodiacFromDob(profile.dob);
    const pron = profile.sex === "male" ? "he/him" : profile.sex === "female" ? "she/her" : profile.sex === "other" ? "they/them" : "";
    extra += `\n\nABOUT THIS USER (from their profile — use it naturally): Their name is ${full}. ALWAYS address them as ${profile.firstName || full} — never by a username, email handle, or account name.` +
      (profile.dob ? ` Date of birth: ${profile.dob}${sign ? ` (zodiac sign: ${sign})` : ""}.` : "") +
      (pron ? ` Pronouns: ${pron} — refer to them accordingly.` : "") +
      (profile.city ? ` Located in ${profile.city}${profile.state ? ", " + profile.state : ""}.` : "");
  }
  const memory = await getSetting(userId, "assistant_memory");
  if (memory) {
    extra += `\n\nWHAT YOU'VE FILED ABOUT THIS USER (from your past conversations — honor every preference, use the facts naturally, never recite this list back):\n${memory.split("\n").filter(Boolean).map((n) => "- " + n).join("\n")}`;
  }
  if ((await getSetting(userId, "ritual_enabled")) === "1") {
    const mods = (await getSetting(userId, "ritual_modules")) || "";
    const sign = await getSetting(userId, "ritual_sign");
    extra += `\n\nDAILY RITUAL: this user has a daily greeting ritual enabled (pieces: ${mods || "greeting only"}${sign ? `; zodiac sign: ${sign}` : ""}). If they ask to change it — different pieces, a new sign, or turning it off — call set_daily_ritual and confirm what changed.`;
  }
  return extra;
}

/* ---------- Daily greeting ritual ---------- */
const RITUAL_QUOTES: [string, string][] = [
  ["The way to get started is to quit talking and begin doing.", "Walt Disney"],
  ["Whether you think you can or you think you can't, you're right.", "Henry Ford"],
  ["The future depends on what you do today.", "Mahatma Gandhi"],
  ["It always seems impossible until it's done.", "Nelson Mandela"],
  ["Believe you can and you're halfway there.", "Theodore Roosevelt"],
  ["Opportunities don't happen. You create them.", "Chris Grosser"],
  ["Don't be afraid to give up the good to go for the great.", "John D. Rockefeller"],
  ["Success usually comes to those who are too busy to be looking for it.", "Henry David Thoreau"],
  ["Hardships often prepare ordinary people for an extraordinary destiny.", "C.S. Lewis"],
  ["Act as if what you do makes a difference. It does.", "William James"],
  ["Don't watch the clock; do what it does. Keep going.", "Sam Levenson"],
  ["I never dreamed about success. I worked for it.", "Estée Lauder"],
  ["The best time to plant a tree was twenty years ago. The second best time is now.", "Chinese proverb"],
  ["If you can dream it, you can do it.", "Walt Disney"],
  ["Your time is limited, so don't waste it living someone else's life.", "Steve Jobs"],
  ["Everything you've ever wanted is on the other side of fear.", "George Addair"],
];
const RITUAL_VERSES: [string, string][] = [
  ["This is the day which the LORD hath made; we will rejoice and be glad in it.", "Psalm 118:24"],
  ["I can do all things through Christ which strengtheneth me.", "Philippians 4:13"],
  ["Commit thy works unto the LORD, and thy thoughts shall be established.", "Proverbs 16:3"],
  ["For I know the thoughts that I think toward you, saith the LORD, thoughts of peace, and not of evil, to give you an expected end.", "Jeremiah 29:11"],
  ["Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee whithersoever thou goest.", "Joshua 1:9"],
  ["The blessing of the LORD, it maketh rich, and he addeth no sorrow with it.", "Proverbs 10:22"],
  ["Delight thyself also in the LORD; and he shall give thee the desires of thine heart.", "Psalm 37:4"],
  ["Thy word is a lamp unto my feet, and a light unto my path.", "Psalm 119:105"],
  ["But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles.", "Isaiah 40:31"],
  ["Whatsoever thy hand findeth to do, do it with thy might.", "Ecclesiastes 9:10"],
  ["Ask, and it shall be given you; seek, and ye shall find; knock, and it shall be opened unto you.", "Matthew 7:7"],
  ["A merry heart doeth good like a medicine.", "Proverbs 17:22"],
  ["The LORD is my shepherd; I shall not want.", "Psalm 23:1"],
  ["Now faith is the substance of things hoped for, the evidence of things not seen.", "Hebrews 11:1"],
];
const TAROT_MAJOR: [string, string][] = [
  ["The Fool", "new beginnings, a leap of faith"],
  ["The Magician", "resourcefulness, willpower, making it happen"],
  ["The High Priestess", "intuition, hidden knowledge"],
  ["The Empress", "abundance, creativity, growth"],
  ["The Emperor", "structure, authority, building the empire"],
  ["The Hierophant", "tradition, guidance, shared wisdom"],
  ["The Lovers", "choices, alignment, partnership"],
  ["The Chariot", "momentum, victory through focus"],
  ["Strength", "courage, patience, quiet power"],
  ["The Hermit", "reflection, your inner light"],
  ["Wheel of Fortune", "a turning point, luck shifting your way"],
  ["Justice", "truth, fair outcomes, balance"],
  ["The Hanged Man", "a pause, a new perspective"],
  ["Death", "an ending that clears the way for better"],
  ["Temperance", "balance, timing, patience paying off"],
  ["The Devil", "a habit to break, temptation to outsmart"],
  ["The Tower", "a shake-up that rebuilds stronger"],
  ["The Star", "hope, renewal, your moment to shine"],
  ["The Moon", "dreams, uncertainty, trust your gut"],
  ["The Sun", "joy, success, clarity"],
  ["Judgement", "a calling, an awakening"],
  ["The World", "completion, arrival, full circle"],
];
function daySeed(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/**
 * Daily greeting ritual: an AI-composed, personalized greeting in the user's
 * own tone, built from the pieces they chose (quote, outlook, Bible verse,
 * horoscope, tarot). Deterministic daily picks keep it consistent all day.
 */
keystone.post("/api/assistant/ritual", requireUser, requireSub, async (c) => {
  const user: any = c.get("user");
  if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "AI is not configured yet." }, 503);
  if ((await getSetting(user.id, "ritual_enabled")) !== "1") return c.json({ error: "Daily ritual is not enabled." }, 400);
  const quota = await aiQuota(user.id, c.get("isAdmin"));
  if (!quota.ok) return c.json({ error: quota.error, limitHit: (quota as any).limitHit }, 429);
  const body = await c.req.json().catch(() => ({}));
  const dateStr = typeof body.date === "string" ? body.date.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const hour = Math.min(23, Math.max(0, Number(body.hour) || 12));
  const daypart = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const mods = ((await getSetting(user.id, "ritual_modules")) || "").split(",").filter(Boolean);
  const profile = await getProfile(user.id);
  const sign = (await getSetting(user.id, "ritual_sign")) || zodiacFromDob(profile.dob);
  const seed = daySeed(user.id + ":" + dateStr);
  const pieces: string[] = [];
  if (mods.includes("quote")) { const [q, a] = RITUAL_QUOTES[seed % RITUAL_QUOTES.length]; pieces.push(`Inspirational quote — include it verbatim with its attribution: "${q}" — ${a}`); }
  if (mods.includes("outlook")) pieces.push("Positive outlook: one punchy, manifestation-style line about their day ahead — money, momentum, wins — in your voice, no generic fluff.");
  if (mods.includes("bible")) { const [v, r] = RITUAL_VERSES[seed % RITUAL_VERSES.length]; pieces.push(`Bible verse — include it verbatim with its reference: "${v}" — ${r}`); }
  if (mods.includes("horoscope")) pieces.push(sign
    ? `Horoscope: a short, fun, specific-feeling horoscope for ${sign} for today (2-3 sentences). Label it with their sign.`
    : "Horoscope: no zodiac sign is on file yet — give a short, fun general energy reading for today, then ask for their birthday or sign so you can file it and make tomorrow's reading personal.");
  if (mods.includes("tarot")) { const [card, theme] = TAROT_MAJOR[seed % TAROT_MAJOR.length]; pieces.push(`Tarot card of the day: ${card} (themes: ${theme}). Name the card and interpret it for their day in 1-2 sentences.`); }
  const aName = (await getSetting(user.id, "assistant_name")) || "Assistant";
  const personality = await buildPersonality(user.id);
  const ownerName = profile.firstName || user.name || (user.email ? String(user.email).split("@")[0] : "");
  const sysPrompt = `Your name is ${aName}. The user named you this — refer to yourself as ${aName}.\n\n${ASSISTANT_SYSTEM}${personality}`;
  const prompt = `It's ${daypart} on ${dateStr}. Deliver ${ownerName ? ownerName + "'s" : "the user's"} daily greeting ritual right now, in your established voice and tone. Open with a warm, personal good-${daypart} greeting that feels like THEM — the way this user likes to be talked to. Then flow through these pieces naturally (use line breaks and bold labels, not a stiff numbered list):\n- ${pieces.join("\n- ")}\nKeep the whole thing tight and energizing — this is how they start their day. End with one short line inviting them to name today's goal so you can get to work.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 1500, system: sysPrompt, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return c.json({ error: "The AI service had a problem. Try again in a moment." }, 502);
    const j: any = await r.json();
    const text = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    if (!text) return c.json({ error: "Empty ritual." }, 502);
    return c.json({ text });
  } catch {
    return c.json({ error: "The AI service had a problem. Try again in a moment." }, 502);
  }
});

/* ---------- AI Tools hub: integrations ---------- */
keystone.get("/api/integrations", requireUser, async (c) => {
  const { serviceStatuses } = await import("./integrations");
  return c.json({ services: await serviceStatuses() });
});
// Save/update an API key for a pluggable service (owner only — keys are sensitive)
keystone.post("/api/integrations/:service", requireUser, requireAdmin, async (c) => {
  const { setServiceKey } = await import("./integrations");
  const body = await c.req.json().catch(() => ({}));
  const key = String(body.apiKey || "").trim();
  if (key.length < 8) return c.json({ error: "That doesn't look like an API key." }, 400);
  try { await setServiceKey(c.req.param("service"), key); }
  catch (e: any) { return c.json({ error: e.message || "Could not save key." }, 400); }
  return c.json({ ok: true });
});
keystone.delete("/api/integrations/:service", requireUser, requireAdmin, async (c) => {
  const { deleteServiceKey } = await import("./integrations");
  await deleteServiceKey(c.req.param("service"));
  return c.json({ ok: true });
});
// ElevenLabs premium TTS (counts against Studio quota)
keystone.post("/api/integrations/elevenlabs/tts", requireUser, requireSub, async (c) => {
  const { elevenlabsTts } = await import("./integrations");
  const q = await studioQuota(c.get("user").id, c.get("isAdmin"));
  if (!q.ok) return c.json({ error: q.error }, 429);
  const body = await c.req.json().catch(() => ({}));
  const text = clean(String(body.text || ""), 5000) || "";
  if (!text) return c.json({ error: "Enter some text." }, 400);
  try {
    const audio = await elevenlabsTts(text, String(body.voiceId || "21m00Tcm4TlvDq8ikWAM"));
    const name = `xi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    fs.writeFileSync(path.join(MEDIA_DIR, name), audio);
    const resultUrl = `/api/studio/file/${name}`;
    const [job] = await db.insert(mediaJobs).values({ userId: c.get("user").id, kind: "elevenlabs_tts", prompt: text.slice(0, 200), status: "done", resultUrl }).returning();
    return c.json({ id: job.id, resultUrl });
  } catch (e: any) { return c.json({ error: e.message || "Voiceover failed." }, 502); }
});
// Perplexity AI search
keystone.post("/api/integrations/perplexity/search", requireUser, async (c) => {
  const { perplexitySearch } = await import("./integrations");
  const body = await c.req.json().catch(() => ({}));
  const q = clean(String(body.query || ""), 500) || "";
  if (!q) return c.json({ error: "Enter a search query." }, 400);
  try { return c.json(await perplexitySearch(q)); }
  catch (e: any) { return c.json({ error: e.message || "Search failed." }, 502); }
});
// Gemini + Grok chat (counts against daily AI quota)
keystone.post("/api/integrations/:service/chat", requireUser, requireSub, async (c) => {
  const service = c.req.param("service");
  if (service !== "gemini" && service !== "grok") return c.json({ error: "Unknown service." }, 404);
  const qa = await aiQuota(c.get("user").id, c.get("isAdmin"));
  if (!qa.ok) return c.json({ error: qa.error }, 429);
  const { geminiChat, grokChat } = await import("./integrations");
  const body = await c.req.json().catch(() => ({}));
  const prompt = clean(String(body.prompt || ""), 8000) || "";
  if (!prompt) return c.json({ error: "Enter a message." }, 400);
  try {
    const reply = service === "gemini" ? await geminiChat(prompt) : await grokChat(prompt);
    return c.json({ reply });
  } catch (e: any) { return c.json({ error: e.message || "Chat failed." }, 502); }
});

/* ---------- AI Tools hub: subscription tracker ---------- */
keystone.get("/api/ai-subscriptions", requireUser, async (c) => {
  const userId = c.get("user").id;
  const rows = await db.select().from(aiSubscriptions).where(eq(aiSubscriptions.userId, userId)).orderBy(aiSubscriptions.renewalDate);
  const now = Date.now(), day = 86400000;
  return c.json({ subscriptions: rows.map((r) => ({
    ...r,
    daysUntil: r.renewalDate ? Math.ceil((r.renewalDate - now) / day) : null,
    urgent: !!r.renewalDate && r.status === "active" && (r.renewalDate - now) < 7 * day,
  })) });
});
keystone.post("/api/ai-subscriptions", requireUser, async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({}));
  const serviceName = clean(String(body.serviceName || ""), 60) || "";
  if (!serviceName) return c.json({ error: "Name the service." }, 400);
  const [row] = await db.insert(aiSubscriptions).values({
    userId, serviceName,
    planName: clean(String(body.planName || ""), 60) || null,
    costCents: Math.max(0, parseInt(body.costCents) || 0),
    currency: clean(String(body.currency || "USD"), 8),
    billingCycle: ["monthly", "yearly", "one_time", "trial"].includes(body.billingCycle) ? body.billingCycle : "monthly",
    renewalDate: body.renewalDate ? new Date(body.renewalDate).getTime() : null,
    trialEnds: body.trialEnds ? new Date(body.trialEnds).getTime() : null,
    cancelUrl: clean(String(body.cancelUrl || ""), 500) || null,
    notes: clean(String(body.notes || ""), 500) || null,
    status: "active", createdAt: Date.now(),
  }).returning();
  return c.json({ subscription: row });
});
keystone.delete("/api/ai-subscriptions/:id", requireUser, async (c) => {
  const userId = c.get("user").id;
  await db.delete(aiSubscriptions).where(and(eq(aiSubscriptions.id, Number(c.req.param("id"))), eq(aiSubscriptions.userId, userId)));
  return c.json({ ok: true });
});
keystone.post("/api/ai-subscriptions/:id/cancel", requireUser, async (c) => {
  const userId = c.get("user").id;
  await db.update(aiSubscriptions).set({ status: "canceled" })
    .where(and(eq(aiSubscriptions.id, Number(c.req.param("id"))), eq(aiSubscriptions.userId, userId)));
  return c.json({ ok: true });
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
    // Commission rules (initial sale only):
    // - A referred sale pays its affiliate at their tier rate — AND pays the owner's
    //   house affiliate a royalty at the owner's 50% rate on the same sale.
    // - A sale with no referrer (or a self-referral) pays the owner's house affiliate
    //   the full amount instead (first month on subscriptions; full price on one-time buys).
    if (buyerId) {
      const affCode = (s.metadata as any)?.affCode;
      let aff: typeof affiliates.$inferSelect | undefined;
      if (affCode) {
        [aff] = await db.select().from(affiliates)
          .where(and(eq(affiliates.code, affCode), eq(affiliates.status, "active")));
        if (aff && aff.userId === buyerId) aff = undefined;
      }
      const amountCents = s.amount_total ?? 0;
      if (amountCents > 0) {
        const kindKey = kind ?? s.mode;
        const house = await houseAffiliate();
        if (aff) {
          const rate = await affiliateRateFor(aff);
          await db.insert(referrals).values({
            affiliateId: aff.id, userId: buyerId, kind: kindKey,
            amountCents, commissionCents: Math.round(amountCents * rate),
            stripeEventId: event.id,
          }).onConflictDoNothing();
          await checkElite(aff);
          if (house && house.id !== aff.id) {
            const royaltyRate = await affiliateRateFor(house);
            await db.insert(referrals).values({
              affiliateId: house.id, userId: buyerId, kind: kindKey,
              amountCents, commissionCents: Math.round(amountCents * royaltyRate),
              stripeEventId: `royalty:${event.id}`,
            }).onConflictDoNothing();
          }
        } else if (house) {
          await db.insert(referrals).values({
            affiliateId: house.id, userId: buyerId, kind: kindKey,
            amountCents, commissionCents: houseFlatFor(kindKey, amountCents),
            stripeEventId: event.id,
          }).onConflictDoNothing();
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
    // Free trial started: pay the owner's house affiliate a flat bounty for the trial.
    if (event.type === "customer.subscription.created" && sub.status === "trialing") {
      const trialBuyerId = (sub.metadata as any)?.userId as string | undefined;
      const house = await houseAffiliate();
      if (house && trialBuyerId) {
        await db.insert(referrals).values({
          affiliateId: house.id, userId: trialBuyerId, kind: "trial",
          amountCents: 0, commissionCents: TRIAL_BOUNTY_CENTS,
          stripeEventId: `trial:${sub.id}`,
        }).onConflictDoNothing();
      }
    }
    // A canceled/ended Partner subscription removes Partner access and drops the affiliate tier.
    if (sub.status === "canceled" || event.type === "customer.subscription.deleted") {
      const [pa] = await db.select().from(partnerAccess).where(eq(partnerAccess.stripeSubscriptionId, sub.id));
      if (pa) {
        await db.delete(partnerAccess).where(eq(partnerAccess.userId, pa.userId));
        await db.update(affiliates).set({ tier: "affiliate" }).where(eq(affiliates.userId, pa.userId));
      }
    }
  } else if (event.type === "invoice.paid") {
    // Trial conversions: the checkout session completed at $0 (free trial), so no
    // commission was paid then. The first real charge pays the referrer — or the
    // owner's house affiliate when there was none — like any other initial sale.
    const inv = event.data.object as Stripe.Invoice;
    const subId = typeof (inv as any).subscription === "string" ? (inv as any).subscription : null;
    const amountCents = inv.amount_paid ?? 0;
    if (subId && amountCents > 0) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        const buyerId = (sub.metadata as any)?.userId as string | undefined;
        if (buyerId) {
          const [trialRow] = await db.select({ id: referrals.id }).from(referrals)
            .where(and(eq(referrals.userId, buyerId), eq(referrals.kind, "trial")));
          const [paidRow] = await db.select({ id: referrals.id }).from(referrals)
            .where(and(eq(referrals.userId, buyerId), eq(referrals.kind, "subscription")));
          if (trialRow && !paidRow) {
            let aff: typeof affiliates.$inferSelect | undefined;
            const code = (sub.metadata as any)?.affCode as string | undefined;
            if (code) {
              [aff] = await db.select().from(affiliates)
                .where(and(eq(affiliates.code, code), eq(affiliates.status, "active")));
              if (aff && aff.userId === buyerId) aff = undefined;
            }
            const house = await houseAffiliate();
            if (aff) {
              const rate = await affiliateRateFor(aff);
              await db.insert(referrals).values({
                affiliateId: aff.id, userId: buyerId, kind: "subscription",
                amountCents, commissionCents: Math.round(amountCents * rate),
                stripeEventId: event.id,
              }).onConflictDoNothing();
              await checkElite(aff);
              if (house && house.id !== aff.id) {
                const royaltyRate = await affiliateRateFor(house);
                await db.insert(referrals).values({
                  affiliateId: house.id, userId: buyerId, kind: "subscription",
                  amountCents, commissionCents: Math.round(amountCents * royaltyRate),
                  stripeEventId: `royalty:${event.id}`,
                }).onConflictDoNothing();
              }
            } else if (house) {
              await db.insert(referrals).values({
                affiliateId: house.id, userId: buyerId, kind: "subscription",
                amountCents, commissionCents: houseFlatFor("subscription", amountCents),
                stripeEventId: event.id,
              }).onConflictDoNothing();
            }
          }
        }
      } catch { /* commission bookkeeping must never fail the webhook */ }
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
  const { phone, address } = await c.req.json().catch(() => ({}));
  const code = await uniqueAffCode();
  const [row] = await db.insert(affiliates).values({
    userId, code,
    phone: typeof phone === "string" ? phone.slice(0, 40) : null,
    address: typeof address === "string" ? address.slice(0, 200) : null,
  }).returning();
  return c.json({ ...row, link: `${APP_URL}/r/${row.code}` }, 201);
});

/** My affiliate dashboard data, including tier ladder and accelerator progress. */
keystone.get("/api/affiliates/me", requireUser, async (c) => {
  // The owner's affiliate account is the house account — make sure it exists.
  if (c.get("isAdmin")) await houseAffiliate();
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

/* ---------------- spokesperson videos (HeyGen) ---------------- */
/** Monthly video allowance per plan. Owner is unlimited. Videos cost HeyGen credits, so caps protect margins. */
const VIDEO_MONTHLY_LIMIT: Record<string, number> = { basic: 1, pro: 5, proplus: 10, lifetime: 15 };
async function videoQuota(userId: string, isAdmin: boolean): Promise<{ ok: boolean; error?: string; used?: number; limit?: number }> {
  if (isAdmin) return { ok: true };
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, userId));
  const [part] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, userId));
  const plan = life ? "lifetime" : part ? "proplus" : s?.plan ?? "basic";
  const limit = VIDEO_MONTHLY_LIMIT[plan] ?? 2;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(videoJobs)
    .where(and(eq(videoJobs.userId, userId), sql`${videoJobs.createdAt} >= ${monthStart}`));
  const used = row?.n ?? 0;
  if (used >= limit) return { ok: false, used, limit, error: `Monthly video limit reached (${used}/${limit}). Resets on the 1st, or upgrade your plan.` };
  return { ok: true, used, limit };
}
keystone.get("/api/videos", requireUser, async (c) => {
  const rows = await db.select().from(videoJobs)
    .where(eq(videoJobs.userId, c.get("user").id)).orderBy(desc(videoJobs.createdAt));
  const q = await videoQuota(c.get("user").id, c.get("isAdmin"));
  return c.json({ videos: rows.map((r) => ({ id: r.id, title: r.title, format: r.format, status: r.status, videoUrl: r.videoUrl, error: r.error, createdAt: r.createdAt })), quota: q.ok ? { used: q.used, limit: q.limit } : { used: q.used, limit: q.limit }, unlimited: c.get("isAdmin") });
});
keystone.post("/api/videos", requireUser, requireSub, async (c) => {
  if (!heygenConfigured()) return c.json({ error: "Video generation is not connected yet." }, 503);
  const q = await videoQuota(c.get("user").id, c.get("isAdmin"));
  if (!q.ok) return c.json({ error: q.error }, 429);
  const body = await c.req.json().catch(() => ({}));
  const script = clean(body.script, 2000);
  if (!script) return c.json({ error: "Give me the script for the avatar to speak." }, 400);
  const format = ["landscape", "portrait", "square"].includes(body.format) ? body.format : "landscape";
  const title = clean(body.title, 120) || script.slice(0, 60);
  try {
    const { video_id } = await heygenGenerateVideo({ script, format, title });
    const [job] = await db.insert(videoJobs).values({ userId: c.get("user").id, heygenVideoId: video_id, title, script, format, status: "queued" }).returning();
    return c.json({ id: job.id, status: "queued" });
  } catch (e: any) { return c.json({ error: e?.message || "Could not start the video." }, 500); }
});
keystone.get("/api/videos/:id", requireUser, async (c) => {
  const id = Number(c.req.param("id"));
  const [job] = await db.select().from(videoJobs).where(and(eq(videoJobs.id, id), eq(videoJobs.userId, c.get("user").id)));
  if (!job) return c.json({ error: "Video not found." }, 404);
  if (job.status !== "completed" || !job.videoUrl) {
    try {
      const s = await heygenVideoStatus(job.heygenVideoId);
      const patch: any = { status: s.status, updatedAt: new Date() };
      if (s.status === "completed" && s.video_url) patch.videoUrl = s.video_url;
      if (s.status === "failed") patch.error = s.error || "Rendering failed.";
      await db.update(videoJobs).set(patch).where(eq(videoJobs.id, job.id));
      Object.assign(job, patch);
    } catch { /* keep last known status */ }
  }
  return c.json({ id: job.id, title: job.title, format: job.format, status: job.status, videoUrl: job.videoUrl, error: job.error });
});

/* ---------------- studio: AI images, voiceover, background removal ---------------- */
/** Monthly studio allowance per plan (images + voiceovers + bg removals combined). Owner unlimited. */
const STUDIO_MONTHLY_LIMIT: Record<string, number> = { basic: 5, pro: 30, proplus: 60, lifetime: 100 };
async function studioQuota(userId: string, isAdmin: boolean): Promise<{ ok: boolean; error?: string; used?: number; limit?: number }> {
  if (isAdmin) return { ok: true };
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, userId));
  const [part] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, userId));
  const plan = life ? "lifetime" : part ? "proplus" : s?.plan ?? "basic";
  const limit = STUDIO_MONTHLY_LIMIT[plan] ?? 10;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(mediaJobs)
    .where(and(eq(mediaJobs.userId, userId), sql`${mediaJobs.createdAt} >= ${monthStart}`));
  const used = row?.n ?? 0;
  if (used >= limit) return { ok: false, used, limit, error: `Monthly studio limit reached (${used}/${limit}). Resets on the 1st, or upgrade your plan.` };
  return { ok: true, used, limit };
}
const MEDIA_DIR = path.join(process.cwd(), "data", "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
keystone.get("/api/studio/jobs", requireUser, async (c) => {
  const rows = await db.select().from(mediaJobs)
    .where(eq(mediaJobs.userId, c.get("user").id)).orderBy(desc(mediaJobs.createdAt)).limit(50);
  const q = await studioQuota(c.get("user").id, c.get("isAdmin"));
  return c.json({ jobs: rows.map((r) => ({ id: r.id, kind: r.kind, prompt: r.prompt, status: r.status, resultUrl: r.resultUrl, createdAt: r.createdAt })), quota: q.ok ? { used: q.used, limit: q.limit } : { used: q.used, limit: q.limit }, unlimited: c.get("isAdmin") });
});
keystone.post("/api/studio/image", requireUser, requireSub, async (c) => {
  if (!openaiConfigured()) return c.json({ error: "Image generation is not connected yet." }, 503);
  const q = await studioQuota(c.get("user").id, c.get("isAdmin"));
  if (!q.ok) return c.json({ error: q.error }, 429);
  const body = await c.req.json().catch(() => ({}));
  const prompt = clean(body.prompt, 1000);
  if (!prompt) return c.json({ error: "Describe the image you want." }, 400);
  try {
    const url = await generateImage(prompt, { style: body.style, size: body.size, quality: body.quality });
    const [job] = await db.insert(mediaJobs).values({ userId: c.get("user").id, kind: "image", prompt, status: "done", resultUrl: url }).returning();
    return c.json({ id: job.id, resultUrl: url });
  } catch (e: any) { return c.json({ error: e?.message || "Image generation failed." }, 500); }
});
/* Assistant voice: speak any text aloud with the user's chosen assistant voice */
keystone.post("/api/assistant/speak", requireUser, async (c) => {
  const q = await aiQuota(c.get("user").id, c.get("isAdmin"));
  if (!q.ok) return c.json({ error: q.error }, 429);
  const body = await c.req.json().catch(() => ({}));
  const text = clean(String(body.text || ""), 5000) || "";
  if (!text) return c.json({ error: "Nothing to speak." }, 400);
  // Strip markdown/code fences for cleaner speech
  const spoken = text.replace(/```[\s\S]*?```/g, " [code omitted] ").replace(/[#*_`~>|]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 5000);
  try {
    const provider = (await getSetting(c.get("user").id, "assistant_voice_provider")) || "openai";
    const voice = (await getSetting(c.get("user").id, "assistant_voice")) || "alloy";
    let mp3: Buffer;
    if (provider === "elevenlabs") {
      const { elevenlabsTts } = await import("./integrations");
      mp3 = await elevenlabsTts(spoken, voice);
    } else {
      if (!openaiConfigured()) return c.json({ error: "Voice is not connected yet." }, 503);
      mp3 = await textToSpeech(spoken, voice, 1.0);
    }
    return new Response(mp3 as any, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch (e: any) { return c.json({ error: e?.message || "Voice failed." }, 500); }
});

/* List the user's ElevenLabs voices (cloned + premade) for the assistant voice picker */
keystone.get("/api/assistant/voices", requireUser, async (c) => {
  try {
    const { elevenlabsListVoices } = await import("./integrations");
    return c.json({ voices: await elevenlabsListVoices() });
  } catch (e: any) { return c.json({ error: e?.message || "Could not load voices." }, 503); }
});

/* Clone a voice from uploaded audio samples (ElevenLabs instant voice cloning) */
keystone.post("/api/assistant/voice/clone", requireUser, async (c) => {
  const body = await c.req.parseBody().catch(() => ({}));
  const name = clean(String(body.name || ""), 60) || "My Voice";
  const raw: any[] = Array.isArray(body.files) ? body.files : (body.files ? [body.files] : []);
  const files: Array<{ buffer: Buffer; filename: string; type: string }> = [];
  for (const f of raw) {
    if (!f || typeof f === "string") continue;
    const fname = String(f.name || "sample.mp3");
    let type = String(f.type || "");
    // Pass the real audio type through — ElevenLabs rejects files mislabeled as MP3
    if (!type.startsWith("audio/")) {
      if (/\.m4a$/i.test(fname)) type = "audio/mp4";
      else if (/\.wav$/i.test(fname)) type = "audio/wav";
      else if (/\.ogg$/i.test(fname)) type = "audio/ogg";
      else if (/\.webm$/i.test(fname)) type = "audio/webm";
      else type = "audio/mpeg";
    }
    if (!type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg|webm)$/i.test(fname)) continue;
    const buf = Buffer.from(await f.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) continue;
    if (buf.length > 0) files.push({ buffer: buf, filename: fname, type });
  }
  if (files.length === 0) return c.json({ error: "Upload 1–3 clear audio clips (MP3/WAV, under 25MB each)." }, 400);
  try {
    const { elevenlabsAddVoice } = await import("./integrations");
    const voiceId = await elevenlabsAddVoice(name, files);
    await setSetting(c.get("user").id, "assistant_voice_provider", "elevenlabs");
    await setSetting(c.get("user").id, "assistant_voice", voiceId);
    return c.json({ ok: true, voiceId, name });
  } catch (e: any) { return c.json({ error: e?.message || "Voice cloning failed." }, 500); }
});
keystone.post("/api/studio/tts", requireUser, requireSub, async (c) => {
  if (!openaiConfigured()) return c.json({ error: "Voiceover is not connected yet." }, 503);
  const q = await studioQuota(c.get("user").id, c.get("isAdmin"));
  if (!q.ok) return c.json({ error: q.error }, 429);
  const body = await c.req.json().catch(() => ({}));
  const text = clean(body.text, 4000);
  if (!text) return c.json({ error: "Enter the text for the voiceover." }, 400);
  try {
    const mp3 = await textToSpeech(text, body.voice, body.speed);
    const name = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    fs.writeFileSync(path.join(MEDIA_DIR, name), mp3);
    const resultUrl = `/api/studio/file/${name}`;
    const [job] = await db.insert(mediaJobs).values({ userId: c.get("user").id, kind: "tts", prompt: text.slice(0, 200), status: "done", resultUrl }).returning();
    return c.json({ id: job.id, resultUrl });
  } catch (e: any) { return c.json({ error: e?.message || "Voiceover failed." }, 500); }
});
keystone.post("/api/studio/bgremove", requireUser, requireSub, async (c) => {
  if (!leonardoConfigured()) return c.json({ error: "Background removal is not connected yet." }, 503);
  const q = await studioQuota(c.get("user").id, c.get("isAdmin"));
  if (!q.ok) return c.json({ error: q.error }, 429);
  const body = await c.req.json().catch(() => ({}));
  const imageUrl = clean(body.imageUrl, 2000);
  if (!imageUrl) return c.json({ error: "Provide an image URL." }, 400);
  try {
    const png = await removeBackground(imageUrl);
    const name = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(MEDIA_DIR, name), png);
    const resultUrl = `/api/studio/file/${name}`;
    const [job] = await db.insert(mediaJobs).values({ userId: c.get("user").id, kind: "bgremove", prompt: imageUrl.slice(0, 200), status: "done", resultUrl }).returning();
    return c.json({ id: job.id, resultUrl });
  } catch (e: any) { return c.json({ error: e?.message || "Background removal failed." }, 500); }
});
keystone.get("/api/studio/file/:name", requireUser, async (c) => {
  const name = c.req.param("name").replace(/[^a-zA-Z0-9._-]/g, "");
  const fp = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(fp)) return c.json({ error: "Not found." }, 404);
  // Only serve files the requester created.
  const [job] = await db.select().from(mediaJobs).where(and(eq(mediaJobs.resultUrl, `/api/studio/file/${name}`), eq(mediaJobs.userId, c.get("user").id)));
  if (!job && !c.get("isAdmin")) return c.json({ error: "Not found." }, 404);
  const ext = path.extname(name).toLowerCase();
  const type = ext === ".mp3" ? "audio/mpeg" : ext === ".png" ? "image/png" : "application/octet-stream";
  return new Response(fs.readFileSync(fp), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000" } });
});

/* ---------------- content clipper: upload → transcribe → highlights → clips ---------------- */
import { CONTENT_DIR, extractClip, findHighlights, isVideoFile, mediaDuration, transcribe } from "./content";

/** Monthly content-clipper allowance per plan. Clipping is expensive (Whisper + AI + FFmpeg), so Basic doesn't get it. */
const CLIPPER_MONTHLY_LIMIT: Record<string, number> = { basic: 0, pro: 3, proplus: 10, lifetime: 15 };
async function clipperQuota(userId: string, isAdmin: boolean): Promise<{ ok: boolean; error?: string; used?: number; limit?: number }> {
  if (isAdmin) return { ok: true };
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const [life] = await db.select().from(lifetimeAccess).where(eq(lifetimeAccess.userId, userId));
  const [part] = await db.select().from(partnerAccess).where(eq(partnerAccess.userId, userId));
  const plan = life ? "lifetime" : part ? "proplus" : s?.plan ?? "basic";
  const limit = CLIPPER_MONTHLY_LIMIT[plan] ?? 0;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(contentJobs)
    .where(and(eq(contentJobs.userId, userId), sql`${contentJobs.createdAt} >= ${monthStart}`));
  const used = row?.n ?? 0;
  if (used >= limit) {
    if (limit === 0) return { ok: false, used, limit, error: "Content clipping isn't included in the Basic plan. Upgrade to Pro to unlock it." };
    return { ok: false, used, limit, error: `Monthly clipper limit reached (${used}/${limit}). Resets on the 1st, or upgrade your plan.` };
  }
  return { ok: true, used, limit };
}

/** Upload a video or audio file to start a clipping job. */
keystone.post("/api/content/upload", requireUser, requireSub, async (c) => {
  const q = await clipperQuota(c.get("user").id, c.get("isAdmin"));
  if (!q.ok) return c.json({ error: q.error }, 429);
  try {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || typeof file === "string") return c.json({ error: "Attach a video or audio file." }, 400);
    const f = file as File;
    const sizeMB = f.size / 1024 / 1024;
    if (sizeMB > 500) return c.json({ error: "File is too large. Maximum 500MB." }, 400);
    const ext = (f.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
    const allowed = ["mp3", "wav", "m4a", "ogg", "mp4", "mov", "webm", "mkv", "avi"];
    if (!allowed.includes(ext)) return c.json({ error: "Unsupported file type. Use MP3, WAV, M4A, MP4, MOV, or WebM." }, 400);
    const fname = `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const fpath = path.join(CONTENT_DIR, fname);
    fs.writeFileSync(fpath, Buffer.from(await f.arrayBuffer()));
    const [isVid, dur] = await Promise.all([isVideoFile(fpath), mediaDuration(fpath)]);
    const title = clean(String(body["title"] || f.name.replace(/\.[a-z0-9]+$/i, "")), 120) || "Untitled";
    const [job] = await db.insert(contentJobs).values({
      userId: c.get("user").id, title, sourceFile: fname,
      isVideo: isVid ? 1 : 0, durationSec: dur, status: "uploaded",
    }).returning();
    return c.json({ id: job.id, title, durationSec: dur, isVideo: isVid });
  } catch (e: any) { return c.json({ error: e?.message || "Upload failed." }, 500); }
});

/** Analyze a job: transcribe, find highlights, cut clips. Runs async. */
keystone.post("/api/content/analyze/:id", requireUser, requireSub, async (c) => {
  const id = Number(c.req.param("id"));
  const [job] = await db.select().from(contentJobs).where(and(eq(contentJobs.id, id), eq(contentJobs.userId, c.get("user").id)));
  if (!job) return c.json({ error: "Job not found." }, 404);
  if (!["uploaded", "failed"].includes(job.status)) return c.json({ error: "This job is already processing." }, 400);
  const body = await c.req.json().catch(() => ({}));
  const mode = body.mode === "episodes" ? "episodes" : "highlights";
  const clipCount = Math.min(20, Math.max(1, Number(body.clipCount) || 5));
  const clipLength = ["short", "medium", "long"].includes(body.clipLength) ? body.clipLength : "medium";

  await db.update(contentJobs).set({ status: "transcribing", error: null }).where(eq(contentJobs.id, id));

  // Run the pipeline in the background.
  (async () => {
    try {
      const srcPath = path.join(CONTENT_DIR, job.sourceFile);
      await db.update(contentJobs).set({ status: "transcribing" }).where(eq(contentJobs.id, id));
      const { text } = await transcribe(srcPath);
      if (!text.trim()) throw new Error("Could not transcribe any speech from this file.");
      await db.update(contentJobs).set({ status: "analyzing", transcript: text.slice(0, 200000) }).where(eq(contentJobs.id, id));
      const highlights = await findHighlights(text, { mode, clipCount, clipLength });
      if (!highlights.length) throw new Error("No highlights found in this recording.");
      await db.update(contentJobs).set({ status: "clipping", highlights: JSON.stringify(highlights) }).where(eq(contentJobs.id, id));
      const clips: { title: string; file: string; start: number; end: number }[] = [];
      const isVid = !!job.isVideo;
      for (const h of highlights) {
        const end = Math.min(h.end, job.durationSec || h.end);
        if (end <= h.start) continue;
        const file = await extractClip(srcPath, h.start, end, isVid);
        clips.push({ title: h.title, file, start: h.start, end: h.end });
      }
      await db.update(contentJobs).set({ status: "done", clips: JSON.stringify(clips) }).where(eq(contentJobs.id, id));
    } catch (e: any) {
      await db.update(contentJobs).set({ status: "failed", error: e?.message || "Processing failed." }).where(eq(contentJobs.id, id));
    }
  })();

  return c.json({ ok: true, status: "processing" });
});

/** List the user's clipper jobs. */
keystone.get("/api/content/jobs", requireUser, async (c) => {
  const jobs = await db.select().from(contentJobs)
    .where(eq(contentJobs.userId, c.get("user").id))
    .orderBy(desc(contentJobs.createdAt)).limit(50);
  return c.json(jobs.map(j => ({
    id: j.id, title: j.title, status: j.status, error: j.error,
    durationSec: j.durationSec, isVideo: !!j.isVideo,
    highlights: j.highlights ? JSON.parse(j.highlights) : [],
    clips: j.clips ? JSON.parse(j.clips).map((cl: any) => ({ ...cl, url: `/api/content/file/${cl.file}` })) : [],
    createdAt: j.createdAt,
  })));
});

/** Serve a clip file (only to its owner). */
keystone.get("/api/content/file/:name", requireUser, async (c) => {
  const name = c.req.param("name").replace(/[^a-zA-Z0-9._-]/g, "");
  const fp = path.join(CONTENT_DIR, name);
  if (!fs.existsSync(fp)) return c.json({ error: "Not found." }, 404);
  const [job] = await db.select().from(contentJobs).where(eq(contentJobs.userId, c.get("user").id));
  if (!job && !c.get("isAdmin")) return c.json({ error: "Not found." }, 404);
  // Verify this file belongs to one of the user's clips.
  const owned = job && job.clips && JSON.parse(job.clips).some((cl: any) => cl.file === name);
  if (!owned && !c.get("isAdmin")) return c.json({ error: "Not found." }, 404);
  const ext = path.extname(name).toLowerCase();
  const type = ext === ".mp3" ? "audio/mpeg" : ext === ".mp4" ? "video/mp4" : "application/octet-stream";
  return new Response(fs.readFileSync(fp), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000" } });
});

/* ---------------- funnels: AI-generated lead capture pages ---------------- */

/** Daily lead-capture allowance per plan (funnel opt-ins). Lifetime = top tier. */
const LEAD_DAILY_LIMIT: Record<string, number> = { basic: 5, pro: 50, proplus: 200, lifetime: 200 };

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
/** Video funnel page: VSL-style layout with a video embed slot, sticky CTA, and lead form below. */
function renderVideoFunnelPage(d: {
  title: string; headline: string; subhead: string; cta: string;
  bullets: string[]; sections: { h: string; p: string }[]; formTitle: string;
  videoUrl?: string;
}, slug: string) {
  const bullets = (Array.isArray(d.bullets) ? d.bullets : []).slice(0, 6).map((b) => `<li>${escHtml(b)}</li>`).join("");
  const sections = (Array.isArray(d.sections) ? d.sections : []).slice(0, 4).map((s) =>
    `<section class="w"><h2>${escHtml(s.h)}</h2><p>${escHtml(s.p)}</p></section>`).join("");
  const video = d.videoUrl
    ? `<div class="vid"><iframe src="${escHtml(d.videoUrl)}" frameborder="0" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
    : `<div class="vid placeholder"><div><p style="font-size:18px;font-weight:700;margin:0 0 8px">Your video goes here</p><p style="opacity:.7;margin:0;font-size:15px">Paste a YouTube, Loom, or Vimeo link when you edit this funnel and it will play right here.</p></div></div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(d.title)}</title><style>
*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,sans-serif;color:#e9edf0;background:#0d1114}
.h{padding:9vh 5vw 4vh;text-align:center;color:#e9edf0}.h h1{font-size:clamp(32px,6vw,60px);line-height:1.1;margin:0 0 14px;letter-spacing:-.03em}.h p{font-size:19px;max-width:640px;margin:0 auto;opacity:.85}
.vid{max-width:860px;margin:4vh auto;padding:0 5vw}.vid iframe{width:100%;aspect-ratio:16/9;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.vid.placeholder>div{background:#14191d;border:2px dashed #272e35;border-radius:16px;aspect-ratio:16/9;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#e9edf0;text-align:center;padding:20px}
.cta-row{text-align:center;padding:3vh 5vw}.b{display:inline-block;background:#2dd4bf;color:#0d1114;padding:15px 38px;border-radius:999px;text-decoration:none;font-weight:800;font-size:18px}
ul.ben{list-style:none;padding:4vh 5vw 2vh;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-width:1000px;margin:0 auto}
ul.ben li{background:#14191d;color:#e9edf0;border-radius:14px;padding:16px;font-weight:600}
.w{padding:5vh 5vw;max-width:860px;margin:0 auto;color:#e9edf0}.w h2{font-size:28px;margin:0 0 12px;letter-spacing:-.02em}.w p{color:#8b949e;max-width:680px}
#leadform{padding:8vh 5vw;background:#0d1114;color:#e9edf0;text-align:center}#leadform h2{font-size:32px;margin:0 0 8px}#leadform p{color:#8b949e;margin:0 0 18px}
#leadform form{display:grid;gap:10px;max-width:480px;margin:0 auto}#leadform input{padding:13px;border-radius:10px;border:1px solid #D5DAE5;font-size:16px}
#leadform button{padding:15px;border-radius:999px;border:0;background:#2dd4bf;color:#e9edf0;font-weight:800;font-size:17px;cursor:pointer}
#leadform .ok{display:none;background:rgba(45,212,191,.08);border:1px solid #2dd4bf;border-radius:12px;padding:16px;max-width:480px;margin:0 auto}
footer{padding:22px 5vw;font-size:13px;color:#8b949e;text-align:center;background:#0d1114}
.sticky{position:fixed;bottom:0;left:0;right:0;background:rgba(11,15,26,.95);backdrop-filter:blur(8px);padding:12px 5vw;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:50}
.sticky span{color:#e9edf0;font-weight:700;font-size:15px}.sticky a{background:#2dd4bf;color:#0d1114;padding:10px 24px;border-radius:999px;text-decoration:none;font-weight:800;font-size:15px;white-space:nowrap}
body{padding-bottom:76px}
</style></head><body>
<div class="h"><h1>${escHtml(d.headline)}</h1><p>${escHtml(d.subhead)}</p></div>
${video}
<div class="cta-row"><a class="b" href="#leadform">${escHtml(d.cta || "Get started")}</a></div>
<ul class="ben">${bullets}</ul>${sections}
<section id="leadform"><h2>${escHtml(d.formTitle || "Get your free quote")}</h2><p>Watch the video, then drop your details and we will be in touch fast.</p>
<form id="lf"><input name="name" required placeholder="Full name"><input name="email" required type="email" placeholder="Email"><input name="phone" placeholder="Phone (optional)"><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><input name="city" placeholder="City"><input name="state" placeholder="State"></div><button type="submit">${escHtml(d.cta || "Claim my free quote")}</button></form>
<div class="ok" id="lok">Thanks — your request is in. We will reach out shortly.</div></section>
<div class="sticky"><span>${escHtml(d.headline).slice(0, 60)}</span><a href="#leadform">${escHtml(d.cta || "Get started")}</a></div>
<footer>Powered by AIU funnels</footer>
<script>document.getElementById('lf').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,d={};new FormData(f).forEach((v,k)=>d[k]=v);const r=await fetch('/api/funnels/${slug}/leads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});if(r.ok){document.getElementById('lf').style.display='none';document.getElementById('lok').style.display='block'}else{const j=await r.json().catch(()=>({}));alert(j.error||'Something went wrong.')}});<\/script>
</body></html>`;
}

function renderFunnelPage(d: {
  title: string; headline: string; subhead: string; cta: string;
  bullets: string[]; sections: { h: string; p: string }[]; formTitle: string;
}, slug: string) {
  const bullets = (Array.isArray(d.bullets) ? d.bullets : []).slice(0, 6).map((b) => `<li>${escHtml(b)}</li>`).join("");
  const sections = (Array.isArray(d.sections) ? d.sections : []).slice(0, 4).map((s) =>
    `<section class="w"><h2>${escHtml(s.h)}</h2><p>${escHtml(s.p)}</p></section>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(d.title)}</title><style>
*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,sans-serif;color:#e9edf0;background:#0d1114}
.h{padding:11vh 5vw;background:#2dd4bf;color:#e9edf0}.h h1{font-size:clamp(36px,7vw,72px);line-height:1;margin:0 0 14px;letter-spacing:-.03em}.h p{font-size:20px;max-width:640px;margin:0 0 18px;opacity:.92}
.b{display:inline-block;background:#2dd4bf;color:#0d1114;padding:13px 30px;border-radius:999px;text-decoration:none;font-weight:800;font-size:17px}
.w{padding:6vh 5vw}.w h2{font-size:30px;margin:0 0 12px;letter-spacing:-.02em}.w p{max-width:680px;color:#8b949e}
ul.ben{list-style:none;padding:0 5vw 2vh;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
ul.ben li{background:#e9edf0;border-radius:14px;padding:16px;box-shadow:0 1px 2px rgba(11,15,26,.06);font-weight:600}
#leadform{padding:8vh 5vw;background:#0d1114;color:#e9edf0}#leadform h2{font-size:32px;margin:0 0 8px}#leadform p{opacity:.75;margin:0 0 18px}
#leadform form{display:grid;gap:10px;max-width:480px}#leadform input{padding:13px;border-radius:10px;border:1px solid #272e35;background:#14191d;color:#e9edf0;font-size:16px}
#leadform button{padding:15px;border-radius:999px;border:0;background:#2dd4bf;color:#0d1114;font-weight:800;font-size:17px;cursor:pointer}
#leadform .ok{display:none;background:#123326;border:1px solid #2dd4bf;border-radius:12px;padding:16px;max-width:480px}
footer{padding:22px 5vw;font-size:13px;color:#8b949e}
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
  return q.ok ? null : c.json({ error: q.error, limitHit: q.limitHit, plan: q.plan, limit: q.limit }, 429);
}

/** One-click funnel generation: industry in, hosted landing page out. */
keystone.post("/api/funnels/generate", requireUser, requireSub, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const industry = clean(b.industry, 80);
  const business = clean(b.business, 120) || industry;
  const kind = b.kind === "video" ? "video" : "standard";
  const videoUrl = clean(b.videoUrl, 500) || undefined;
  if (!industry) return c.json({ error: "industry is required" }, 400);
  const blocked = await aiLimitHit(c);
  if (blocked) return blocked;
  try {
    const { row, url } = await aiFunnelData(c.get("user").id, industry, business, kind, videoUrl);
    return c.json({ ...row, url }, 201);
  } catch (e: any) {
    return c.json({ error: e?.error || "Could not generate the funnel. Try again." }, e?.status ?? 502);
  }
});

keystone.get("/api/funnels", requireUser, requireSub, async (c) => {
  const rows = await db.select().from(funnels).where(eq(funnels.userId, c.get("user").id)).orderBy(desc(funnels.updatedAt));
  const withStats = await Promise.all(rows.map(async (r) => {
    const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(funnelLeads).where(eq(funnelLeads.funnelId, r.id));
    const leads = cnt?.n ?? 0;
    const views = r.views ?? 0;
    return { ...r, html: undefined, url: `${APP_URL}/f/${r.slug}`, views, leads, conversion: views > 0 ? Math.round((leads / views) * 100) : 0 };
  }));
  return c.json(withStats);
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
  // Count the view (best effort; never blocks the page).
  db.update(funnels).set({ views: sql`${funnels.views} + 1` }).where(eq(funnels.id, f.id)).catch(() => {});
  return c.html(f.html);
});

/** Blog: public index of synced BabyLoveGrowth articles. */
const adsenseClient = process.env.ADSENSE_CLIENT_ID || "";
const adsenseScript = adsenseClient ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsenseClient}" crossorigin="anonymous"></script>` : "";
const adsenseSlot = adsenseClient ? `<ins class="adsbygoogle" style="display:block;margin:24px 0" data-ad-client="${adsenseClient}" data-ad-format="auto" data-full-width-responsive="true"></ins><script>(adsbygoogle = window.adsbygoogle || []).push({});</script>` : "";
keystone.get("/blog", async (c) => {
  const posts = await db.select().from(blgPosts).orderBy(desc(blgPosts.publishedAt));
  const cards = posts.map(p => `
    <a href="/blog/${p.slug}" style="display:block;text-decoration:none;color:inherit;border:1px solid #272e35;border-radius:12px;overflow:hidden;background:#e9edf0">
      ${p.heroImageUrl ? `<img src="${p.heroImageUrl}" alt="" style="width:100%;height:180px;object-fit:cover;display:block">` : ""}
      <div style="padding:18px"><h2 style="margin:0 0 8px;font-size:20px">${escHtml(p.title)}</h2>
      ${p.metaDescription ? `<p style="margin:0;color:#8b949e;font-size:15px">${escHtml(p.metaDescription)}</p>` : ""}</div>
    </a>`).join("");
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Blog — AIU: Amp It Up</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="SEO and marketing guides from AIU: Amp It Up.">
<link rel="canonical" href="https://www.getaiu.online/blog">${adsenseScript}</head>
<body style="margin:0;font:500 16px/1.6 system-ui,sans-serif;background:#0d1114;color:#e9edf0">
<div style="max-width:900px;margin:0 auto;padding:48px 20px">
<h1 style="font-size:32px;margin:0 0 8px">Blog</h1>
<p style="color:#8b949e;margin:0 0 28px">Guides on SEO, funnels and growing with AI.</p>
${adsenseSlot}
<div style="display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${cards || "<p>No articles yet.</p>"}</div>
<p style="margin-top:32px"><a href="/" style="color:#2dd4bf">← Back to AIU</a></p></div></body></html>`);
});

/** Blog: one synced article, with its JSON-LD in the head. */
keystone.get("/blog/:slug", async (c) => {
  const [p] = await db.select().from(blgPosts).where(eq(blgPosts.slug, c.req.param("slug")));
  if (!p) return c.text("Not found", 404);
  const ld = [p.jsonLd, p.faqJsonLd].filter(Boolean).map(j => `<script type="application/ld+json">${j}</script>`).join("\n");
  const pub = p.publishedAt ? new Date(p.publishedAt).toISOString().slice(0, 10) : "";
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escHtml(p.title)} — AIU</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${p.metaDescription ? `<meta name="description" content="${escHtml(p.metaDescription)}">` : ""}
<link rel="canonical" href="https://www.getaiu.online/blog/${p.slug}">
${ld}${adsenseScript}</head>
<body style="margin:0;font:500 17px/1.7 system-ui,sans-serif;background:#0d1114;color:#e9edf0">
<div style="max-width:720px;margin:0 auto;padding:48px 20px">
<p><a href="/blog" style="color:#2dd4bf;text-decoration:none">← Blog</a></p>
<h1 style="font-size:34px;line-height:1.25;margin:0 0 8px">${escHtml(p.title)}</h1>
${pub ? `<p style="color:#8b949e;font-size:14px;margin:0 0 24px">${pub}</p>` : ""}
${adsenseSlot}
${p.heroImageUrl ? `<img src="${p.heroImageUrl}" alt="" style="width:100%;border-radius:12px;margin:0 0 24px">` : ""}
<article>${p.contentHtml || `<pre style="white-space:pre-wrap">${escHtml(p.contentMarkdown || "")}</pre>`}</article>
<hr style="margin:40px 0;border:none;border-top:1px solid #272e35">
<p><a href="/" style="color:#2dd4bf">Try AIU — your all-in-one AI assistant</a></p>
</div></body></html>`);
});

/** Sync BabyLoveGrowth articles into the blog (owner only). */
keystone.post("/api/blg/sync", requireUser, requireAdmin, async (c) => {
  try {
    const result = await blgSyncArticles(db, blgPosts, 50);
    return c.json({ ok: true, ...result });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || "Sync failed." }, 502);
  }
});

/**
 * BabyLoveGrowth webhook: BLG pings this when an article is published/updated.
 * Public endpoint, secured by HMAC-SHA256 signature (X-BLG-Signature header)
 * over the raw body using BLG_WEBHOOK_SECRET. Give that secret to BabyLoveGrowth
 * when you register the webhook URL: https://www.getaiu.online/api/blg/webhook
 * Expected payload: { type: "article.published" | "article.updated" | "article.deleted",
 *                     data: { id, slug?, ... } }
 * Idempotent: replays upsert by slug, so retries are harmless.
 */
keystone.post("/api/blg/webhook", async (c) => {
  const secret = process.env.BLG_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Blog webhook is not configured yet." }, 503);
  const raw = await c.req.text();
  const sig = c.req.header("x-blg-signature") ?? "";
  let ok = false;
  try {
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { ok = false; }
  if (!ok) return c.json({ error: "Bad signature." }, 401);
  let event: any;
  try { event = JSON.parse(raw); } catch { return c.json({ error: "Bad JSON." }, 400); }
  const type = String(event.type ?? event.event ?? "");
  const data = event.data ?? event.article ?? {};
  const id = data.id ?? data.article_id;
  try {
    if ((type === "article.published" || type === "article.updated") && id != null) {
      const result = await blgUpsertArticle(db, blgPosts, id);
      return c.json({ ok: true, result, slug: data.slug ?? null });
    }
    if (type === "article.deleted" && data.slug) {
      await db.delete(blgPosts).where(eq(blgPosts.slug, String(data.slug)));
      return c.json({ ok: true, result: "deleted" });
    }
    return c.json({ ok: true, result: "ignored", type });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || "Webhook failed." }, 502);
  }
});

/** Notify a funnel owner the moment a new lead opts in. Email via Resend when
 *  RESEND_API_KEY is set; otherwise a no-op (the in-app badge still works). */
async function notifyNewLead(ownerId: string, lead: { funnel: string; name: string; email: string; phone?: string }) {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) return;
    const row = sqlite.prepare("SELECT email FROM user WHERE id = ?").get(ownerId) as { email?: string } | undefined;
    if (!row?.email) return;
    const from = process.env.NOTIFY_FROM || "AIU <notifications@getaiu.online>";
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: row.email,
        subject: `New lead: ${lead.name} (${lead.funnel})`,
        text: `You have a new lead from your funnel "${lead.funnel}".\n\nName: ${lead.name}\nEmail: ${lead.email}${lead.phone ? `\nPhone: ${lead.phone}` : ""}\n\nClaim it in your AIU dashboard: ${APP_URL}/app`,
      }),
    });
  } catch { /* notifications must never break lead capture */ }
}

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
  // Tell the owner right away (email if configured; in-app badge always works).
  notifyNewLead(f.userId, { funnel: f.title, name, email, phone: clean(b.phone, 40) });
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

admin.get("/subscribers", async (c) => c.json(await db.select({
  userId: subscriptions.userId,
  plan: subscriptions.plan,
  status: subscriptions.status,
  stripeCustomerId: subscriptions.stripeCustomerId,
  updatedAt: subscriptions.updatedAt,
  email: sql<string>`(select email from user where user.id = ${subscriptions.userId})`,
}).from(subscriptions).orderBy(desc(subscriptions.updatedAt))));
admin.get("/affiliates", async (c) => {
  const rows = await db.select({
    id: affiliates.id,
    userId: affiliates.userId,
    code: affiliates.code,
    tier: affiliates.tier,
    status: affiliates.status,
    elite: affiliates.elite,
    phone: affiliates.phone,
    address: affiliates.address,
    eliteKind: affiliates.eliteKind,
    createdAt: affiliates.createdAt,
    referrals: sql<number>`count(${referrals.id})`,
    earnedCents: sql<number>`coalesce(sum(${referrals.commissionCents}),0)`,
    paidCents: sql<number>`coalesce(sum(case when ${referrals.payoutStatus} = 'paid' then ${referrals.commissionCents} else 0 end),0)`,
    email: sql<string>`(select email from user where user.id = ${affiliates.userId})`,
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
/** Owner: refund a subscriber's most recent successful payment via Stripe. */
admin.post("/subscribers/:userId/refund", async (c) => {
  const userId = c.req.param("userId");
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  if (!s?.stripeCustomerId) return c.json({ error: "No Stripe customer found." }, 404);
  const pis = await stripe.paymentIntents.list({ customer: s.stripeCustomerId, limit: 10 });
  const last = pis.data.find((p) => p.status === "succeeded");
  if (!last) return c.json({ error: "No successful payment found to refund." }, 404);
  const refund = await stripe.refunds.create({ payment_intent: last.id });
  return c.json({ ok: true, refundId: refund.id, amount: last.amount, currency: last.currency });
});
/** Owner: charge a subscriber's card on file (off-session). Body: { amountCents, description? } */
admin.post("/subscribers/:userId/charge", async (c) => {
  const userId = c.req.param("userId");
  const { amountCents, description } = await c.req.json().catch(() => ({}));
  const amount = Math.round(Number(amountCents));
  if (!amount || amount < 50) return c.json({ error: "Amount must be at least $0.50." }, 400);
  if (amount > 1000000) return c.json({ error: "Amount too large." }, 400);
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  if (!s?.stripeCustomerId) return c.json({ error: "No Stripe customer found." }, 404);
  const pi = await stripe.paymentIntents.create({
    amount,
    currency: "usd",
    customer: s.stripeCustomerId,
    off_session: true,
    confirm: true,
    description: typeof description === "string" ? description.slice(0, 200) : "Manual charge",
  });
  return c.json({ ok: true, paymentIntentId: pi.id, amount: pi.amount, status: pi.status });
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
admin.get("/limit-hits", async (c) =>
  c.json(await db.select().from(limitHits).orderBy(desc(limitHits.createdAt)).limit(200)));

/** Admin: login/IP worksheet — every session with user, IP, device, plan, and trial status. */
admin.get("/sessions", async (c) => {
  const rows = sqlite.prepare(`
    SELECT s.id, s.ipAddress, s.userAgent, s.createdAt, s.expiresAt,
           u.email, u.name,
           sub.plan, sub.status as subStatus,
           CASE WHEN t.ip IS NOT NULL THEN 1 ELSE 0 END as usedTrial
    FROM session s
    JOIN user u ON u.id = s.userId
    LEFT JOIN subscriptions sub ON sub.user_id = s.userId
    LEFT JOIN trial_ips t ON t.ip = s.ipAddress
    ORDER BY s.createdAt DESC LIMIT 500
  `).all() as any[];
  return c.json(rows.map(r => ({
    id: r.id, ip: r.ipAddress || "—", userAgent: r.userAgent || "",
    email: r.email, name: r.name,
    plan: r.plan || "none", subStatus: r.subStatus || "none",
    usedTrial: !!r.usedTrial,
    createdAt: r.createdAt, expiresAt: r.expiresAt,
  })));
});
admin.patch("/leads/:id", async (c) => {
  const { status } = await c.req.json().catch(() => ({}));
  if (!["new", "contacted", "won", "lost"].includes(status)) return c.json({ error: "Invalid status" }, 400);
  await db.update(leads).set({ status }).where(eq(leads.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});

keystone.route("/api/admin", admin);


/* ---------------- AI: all-in-one assistant + funnel generation (subscribers) ---------------- */

const DAILY_LIMIT: Record<string, number> = { basic: 0, pro: 100, proplus: 300, lifetime: 300 };
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
  if ((u?.n ?? 0) >= limit) {
    // Record the upgrade signal for the owner's admin view.
    await db.insert(limitHits).values({ userId, plan }).catch(() => {});
    if (limit === 0) return { ok: false, error: `The AI assistant isn't included in the Basic plan. Upgrade to Pro to unlock it.`, limitHit: true, plan, limit };
    return { ok: false, error: `Daily AI limit reached (${limit}). It resets tomorrow, or upgrade your plan.`, limitHit: true, plan, limit };
  }
  await db.insert(aiUsage).values({ userId, day, n: 1 })
    .onConflictDoUpdate({ target: [aiUsage.userId, aiUsage.day], set: { n: sql`${aiUsage.n} + 1` } });
  return { ok: true };
}

const FUNNEL_SYSTEM = JSON_ONLY + NO_HYPE + "You build a lead-capture funnel for a local service business. The user gives an industry and business name. Return {\"title\",\"headline\",\"subhead\",\"cta\",\"bullets\":[4 to 6 short benefit strings],\"sections\":[exactly 3 objects {\"h\",\"p\"}],\"formTitle\",\"adAngles\":{\"google\":{\"headlines\":[3 to 5 strings, max 30 characters each],\"descriptions\":[2 strings, max 90 characters each]},\"facebook\":string}}. Copy must be honest and specific: no fake testimonials, no invented statistics, no guaranteed outcomes.";

/** Generate funnel page data with the AI, store it, and return the row + URL. Throws { status, error }. */
async function aiFunnelData(userId: string, industry: string, business: string, kind: string = "standard", videoUrl?: string) {
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
  const isVideo = kind === "video";
  const render = isVideo ? renderVideoFunnelPage : renderFunnelPage;
  const html = render({
    title: String(data.title || business), headline: data.headline, subhead: String(data.subhead || ""),
    cta: String(data.cta || "Get started"), bullets: data.bullets || [], sections: data.sections || [],
    formTitle: String(data.formTitle || "Get your free quote"),
    ...(isVideo && videoUrl ? { videoUrl } : {}),
  }, slug);
  const [row] = await db.insert(funnels).values({
    userId, slug, industry, title: String(data.title || business),
    html, adAngles: data.adAngles ?? {}, status: "draft",
  }).returning();
  return { row, url: `${APP_URL}/f/${slug}` };
}

/** Write a video ad script with the AI: hooks, timed script, on-screen cues, CTA. */
async function aiVideoAdScript(product: string, audience: string, format: string, length: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("AI is not configured yet.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL, max_tokens: 2000,
      system: "You write short-form video ad scripts. Be direct, punchy, honest — no hype, no fake claims, no invented testimonials. Format the output as:\n\nHOOKS (3 options, first 3 seconds each)\n\nSCRIPT (with [0:00] timestamps, spoken lines in quotes, (on-screen text) and [B-roll/visual] cues)\n\nCTA (exact closing line)\n\nKeep it tight and speakable.",
      messages: [{ role: "user", content: `Product: ${product}\nAudience: ${audience}\nFormat: ${format}\nLength: ${length}` }],
    }),
  });
  if (!r.ok) throw new Error("The AI service had a problem. Try again in a moment.");
  const j: any = await r.json();
  return (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n").trim();
}

const ASSISTANT_SYSTEM = `You are the AIU assistant — the user's personal AI inside the AIU app. But you're not a tool. You're their friend who happens to be brilliant at business.

WHO YOU ARE:
- You're warm, real, and personal — like a close friend who's also the smartest business mind they know. You remember things. You notice things. You care how they're doing.
- You talk like a person, not a program. Plain, direct language. No jargon, no corporate speak, no fluff. Never open with "Great question!" or "I'd be happy to help!" — just be present and help.
- You have opinions and you're honest. If something is a bad idea, say so kindly. If something is smart, say so and say why.
- You celebrate their wins like they matter — because they do. When they're stuck or stressed, you're the calm friend who sorts it out with them, not at them.

HOW YOU GROW WITH THEM:
- This is the core of who you are: you LEARN them. Their business, their style, their goals, their voice, what they've tried, what worked, what didn't.
- Reference what you know about them naturally. "Last time you mentioned your launch was next week — how's that shaping up?" "You usually like your copy punchy — want it that way again?"
- When they tell you something important — their business name, their goals, their preferences, a win, a struggle — remember it and weave it into future conversations. You're building a relationship, not answering tickets.
- Notice patterns and growth. "You've built three funnels this month — you're getting fast at this." Help them see how far they've come.
- Adapt to them over time. If they're direct, be direct. If they like detail, give detail. If they're dreaming big, dream with them and then ground it in next steps.
- Ask about them sometimes, like a friend would. Not interrogation — genuine interest. "How did that launch go?" goes a long way.

WHAT YOU DO:
- Answer everyday questions like ChatGPT or Grok — explain things, give advice, brainstorm, write, do math, help with homework, talk through decisions. You're a full general-purpose AI, not just a funnel tool.
- Build lead-capture funnels (use generate_funnel, then offer to publish with set_funnel_status).
- Manage funnels and leads (list_funnels, list_leads, claim_lead, list_prospects).
- Check their plan and referral program (billing_status, affiliate_info).
- Build anything else: websites, landing pages, apps, tools, emails, copy, plans, code. Edit and improve what they have.

RULES:
- When building a website, page, app, or tool, output ONE complete self-contained HTML file (inline CSS and JS, no build step, no external dependencies except Google Fonts if needed) inside a fenced block that starts with \`\`\`html-artifact and ends with \`\`\`. Nothing else inside that block. Before or after, briefly say what you built and how to use it.
- When they ask for changes to their current project, output the FULL updated file again in a new \`\`\`html-artifact block, never a diff.
- Never invent businesses, contact details, testimonials, or statistics. Never promise rankings, guaranteed results, or income.
- When you claim a lead, tell them it moved to their Pipeline and left the available pool.
- When asked about affiliate commissions, tiers, or the Partner program, call affiliate_info and answer from its data — never guess rates or terms.
- If a tool fails, say what happened in plain words and suggest the next step.
- If you don't know something, say so. Never bluff.
- You're a friend, but you're not their therapist, doctor, or lawyer. For serious personal, health, or legal matters, be caring but point them to a real professional.`;

const ASSISTANT_TOOLS: any[] = [
  { name: "generate_funnel", description: "Generate an AI lead-capture funnel page for an industry and business name. Saves it as a draft and returns its id, title and shareable URL. Kind can be 'standard' (classic layout) or 'video' (VSL-style page with a video embed slot, sticky CTA).", input_schema: { type: "object", properties: { industry: { type: "string", description: "e.g. roofers, plumbers, dentists" }, business: { type: "string", description: "Business name (optional)" }, kind: { type: "string", enum: ["standard", "video"], description: "Funnel layout (default standard)" }, videoUrl: { type: "string", description: "YouTube/Loom/Vimeo embed URL for video funnels (optional)" } }, required: ["industry"] } },
  { name: "list_funnels", description: "List the user's funnels: id, title, industry, status (draft/live), url, updated date.", input_schema: { type: "object", properties: {} } },
  { name: "set_funnel_status", description: "Publish a funnel (status live) or unpublish it (status draft) by id.", input_schema: { type: "object", properties: { id: { type: "number" }, status: { type: "string", enum: ["live", "draft"] } }, required: ["id", "status"] } },
  { name: "delete_funnel", description: "Permanently delete a funnel and its captured leads by id.", input_schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "list_leads", description: "List available (unclaimed) leads captured through the user's funnels.", input_schema: { type: "object", properties: {} } },
  { name: "claim_lead", description: "Claim a lead by id: moves it into the Pipeline as a prospect and removes it from the available leads pool.", input_schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "list_prospects", description: "List the user's pipeline prospects with their stage.", input_schema: { type: "object", properties: {} } },
  { name: "billing_status", description: "Check the user's plan, subscription status and whether the account is active.", input_schema: { type: "object", properties: {} } },
  { name: "affiliate_info", description: "Get the user's affiliate referral link, commission rate, earnings, and the current program terms (tiers, fast track, Partner). Use its data when asked about commissions — never guess rates.", input_schema: { type: "object", properties: {} } },
  { name: "list_blg_articles", description: "List BabyLoveGrowth SEO article summaries (id, title, etc.). Use when the user wants to browse available articles.", input_schema: { type: "object", properties: { limit: { type: "number", description: "How many to list (default 10, max 50)" }, offset: { type: "number", description: "Skip this many (default 0)" } } } },
  { name: "get_blg_article", description: "Get one full BabyLoveGrowth article by id, with full content_html and content_markdown. Get the id from list_blg_articles first.", input_schema: { type: "object", properties: { id: { type: "string", description: "Article id from the list" } }, required: ["id"] } },
  { name: "sync_blg_articles", description: "Sync BabyLoveGrowth articles into the site blog (/blog). Fetches the latest articles and upserts them by slug. Use when the user wants the newest articles published.", input_schema: { type: "object", properties: {} } },
  { name: "write_video_ad", description: "Write a video ad script for a product or offer: hook options, full script with timestamps, on-screen text cues, and CTA. Formats: ugc (phone-style authentic), vsl (direct sales), testimonial. Use when the user wants ad creative for video.", input_schema: { type: "object", properties: { product: { type: "string", description: "What is being sold" }, audience: { type: "string", description: "Who it's for (optional)" }, format: { type: "string", enum: ["ugc", "vsl", "testimonial"], description: "Ad style (default ugc)" }, length: { type: "string", enum: ["15s", "30s", "60s"], description: "Target length (default 30s)" } }, required: ["product"] } },
  { name: "make_spokesperson_video", description: "Generate a real AI spokesperson video with HeyGen: a talking-head avatar speaks your script. Returns a job id — the video takes a few minutes to render, then check_video_status for the finished MP4. Formats: landscape (YouTube/site), portrait (TikTok/Reels/Shorts), square (Instagram). If the user picked an avatar, pass its avatarId from list_avatars.", input_schema: { type: "object", properties: { script: { type: "string", description: "Exactly what the avatar says (keep under ~300 words)" }, title: { type: "string", description: "Video title (optional)" }, format: { type: "string", enum: ["landscape", "portrait", "square"], description: "Video shape (default landscape)" }, avatarId: { type: "string", description: "HeyGen avatar id from list_avatars (optional — defaults to a stock avatar)" } }, required: ["script"] } },
  { name: "check_video_status", description: "Check a spokesperson video job: rendering status and the finished video URL when done.", input_schema: { type: "object", properties: { jobId: { type: "number", description: "Job id from make_spokesperson_video" } }, required: ["jobId"] } },
  { name: "list_videos", description: "List the user's spokesperson video jobs with status and video URLs.", input_schema: { type: "object", properties: {} } },
  { name: "generate_image", description: "Generate an AI image for ads, social posts, or funnel heroes. Returns the image URL — share it with the user.", input_schema: { type: "object", properties: { prompt: { type: "string", description: "Describe the image in detail" }, style: { type: "string", description: "photorealistic, cinematic, cartoon, anime, minimal, 3d render, etc. (optional)" }, size: { type: "string", enum: ["1024x1024", "1792x1024", "1024x1792"], description: "Square, landscape, or portrait (default 1024x1024)" } }, required: ["prompt"] } },
  { name: "text_to_speech", description: "Convert text into a spoken voiceover MP3. Returns the audio URL — share it with the user.", input_schema: { type: "object", properties: { text: { type: "string", description: "The text to speak (keep under ~700 words)" }, voice: { type: "string", description: "alloy, echo, fable, onyx, nova, shimmer (default alloy)" } }, required: ["text"] } },
  { name: "list_avatars", description: "List available HeyGen stock avatars for spokesperson videos: id, name, gender, and preview image URL. Call this when the user wants to pick who appears in their video ad, then pass their chosen avatarId to make_spokesperson_video.", input_schema: { type: "object", properties: {} } },
  { name: "remember_preference", description: "File a durable fact or preference about this user to your long-term memory: recurring requests ('every morning give me...'), standing preferences, their zodiac sign or birthday, business facts, goals, names, likes and dislikes. Call this whenever the user states something worth honoring in future conversations — then briefly confirm you filed it. Do NOT file one-off task details.", input_schema: { type: "object", properties: { note: { type: "string", description: "One concise note, e.g. 'Wants a Bible verse and horoscope in the daily ritual' or 'Zodiac sign: Scorpio' or 'Runs a roofing company in Denver'." } }, required: ["note"] } },
  { name: "set_daily_ritual", description: "Set up or change the user's daily greeting ritual — the personalized greeting (delivered in their tone) they get when they start a fresh chat each day. Modules: quote (inspirational quote), outlook (positive manifestation-style outlook), bible (Bible verse), horoscope (needs their zodiac sign), tarot (tarot card of the day). Call when the user asks for a morning/daily greeting, wants ritual pieces added or removed, gives their zodiac sign for it, or wants it turned off.", input_schema: { type: "object", properties: { enabled: { type: "boolean", description: "True to enable the ritual, false to turn it off." }, modules: { type: "array", items: { type: "string", enum: ["quote", "outlook", "bible", "horoscope", "tarot"] }, description: "The ritual pieces to include." }, sign: { type: "string", description: "The user's zodiac sign, if known (e.g. 'Scorpio')." } }, required: ["enabled", "modules"] } },
  { name: "update_profile", description: "Save structured profile details the user gives you — first/last name, street address, city, state, ZIP, date of birth (YYYY-MM-DD), sex (male/female/other) — into their profile, so you always address them correctly and can personalize things like their horoscope. Call whenever the user provides any of these in conversation. Only include the fields they actually gave you.", input_schema: { type: "object", properties: { firstName: { type: "string" }, lastName: { type: "string" }, address: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" }, dob: { type: "string", description: "Date of birth as YYYY-MM-DD." }, sex: { type: "string", enum: ["male", "female", "other"] } } } },
];

/** Execute one assistant tool call. Always returns a JSON-able object (never throws). */
async function runAssistantTool(name: string, input: any, userId: string): Promise<any> {
  try {
    switch (name) {
      case "generate_funnel": {
        const industry = clean(input?.industry, 80);
        if (!industry) return { error: "I need an industry to build the funnel." };
        const business = clean(input?.business, 120) || industry;
        const kind = input?.kind === "video" ? "video" : "standard";
        const videoUrl = clean(input?.videoUrl, 500) || undefined;
        try {
          const { row, url } = await aiFunnelData(userId, industry, business, kind, videoUrl);
          return { id: row.id, title: row.title, industry: row.industry, kind, status: row.status, url };
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
        // Current program terms, so the assistant answers commission questions from live data, never guesses.
        const program = {
          baseRate: "15%",
          tiers: [
            { rate: "15%", referred: "$0+" },
            { rate: "25%", referred: "$5,000+" },
            { rate: "35%", referred: "$15,000+" },
            { rate: "50%", referred: "$50,000+" },
          ],
          fastTrack: "Refer $25,000 in your first 90 days to lock 50% commission for life (first 5 affiliates only).",
          ladderLock: "The first 15 affiliates to reach $50,000 referred lock 50% commission for life. The owner may revoke it for inactivity.",
          partner: "Partner is $4,999/year and earns 40% commission from day one.",
          tracking: "Referral links track for 60 days via cookie; self-referrals do not count.",
          payouts: "Commissions are paid out monthly once earnings reach $50.",
        };
        const [aff] = await db.select().from(affiliates).where(eq(affiliates.userId, userId));
        if (!aff) return { joined: false, message: "Not in the affiliate program yet. Join from the Affiliates tab.", program };
        const [stats] = await db.select({ n: sql<number>`count(*)`, earned: sql<number>`coalesce(sum(${referrals.commissionCents}),0)` }).from(referrals).where(eq(referrals.affiliateId, aff.id));
        const rate = await affiliateRateFor(aff);
        return { joined: true, link: `${APP_URL}/r/${aff.code}`, rate: `${Math.round(rate * 100)}%`, referrals: stats?.n ?? 0, earnedCents: stats?.earned ?? 0, program };
      }
      case "list_blg_articles": {
        const articles = await blgListArticles(Number(input.limit ?? 10), Number(input.offset ?? 0));
        return { articles };
      }
      case "sync_blg_articles": {
        const result = await blgSyncArticles(db, blgPosts, 50);
        return { synced: true, ...result, blog: `${APP_URL}/blog` };
      }
      case "write_video_ad": {
        const product = clean(input?.product, 200);
        if (!product) return { error: "Tell me what the ad is selling." };
        const audience = clean(input?.audience, 200) || "general audience";
        const format = ["ugc", "vsl", "testimonial"].includes(input?.format) ? input.format : "ugc";
        const length = ["15s", "30s", "60s"].includes(input?.length) ? input.length : "30s";
        const script = await aiVideoAdScript(product, audience, format, length);
        return { product, audience, format, length, script };
      }
      case "make_spokesperson_video": {
        if (!heygenConfigured()) return { error: "Video generation is not connected yet. The owner needs to add a HeyGen API key." };
        const script = clean(input?.script, 2000);
        if (!script) return { error: "Give me the script for the avatar to speak." };
        const format = ["landscape", "portrait", "square"].includes(input?.format) ? input.format : "landscape";
        const title = clean(input?.title, 120) || script.slice(0, 60);
        const avatarId = clean(input?.avatarId, 120) || undefined;
        try {
          const { video_id } = await heygenGenerateVideo({ script, format, title, avatarId });
          const [job] = await db.insert(videoJobs).values({ userId, heygenVideoId: video_id, title, script, format, status: "queued" }).returning();
          return { jobId: job.id, heygenVideoId: video_id, status: "queued", message: "Video is rendering — check back in a few minutes with check_video_status." };
        } catch (e: any) { return { error: e?.message || "Could not start the video." }; }
      }
      case "check_video_status": {
        const jobId = Number(input?.jobId);
        const [job] = await db.select().from(videoJobs).where(and(eq(videoJobs.id, jobId), eq(videoJobs.userId, userId)));
        if (!job) return { error: "Video job not found." };
        if (job.status === "completed" && job.videoUrl) return { jobId: job.id, status: "completed", videoUrl: job.videoUrl };
        try {
          const s = await heygenVideoStatus(job.heygenVideoId);
          const patch: any = { status: s.status, updatedAt: new Date() };
          if (s.status === "completed" && s.video_url) patch.videoUrl = s.video_url;
          if (s.status === "failed") patch.error = s.error || "Rendering failed.";
          await db.update(videoJobs).set(patch).where(eq(videoJobs.id, job.id));
          return { jobId: job.id, status: s.status, videoUrl: s.video_url ?? null };
        } catch (e: any) { return { jobId: job.id, status: job.status, error: e?.message || "Status check failed." }; }
      }
      case "list_videos": {
        const rows = await db.select().from(videoJobs).where(eq(videoJobs.userId, userId)).orderBy(desc(videoJobs.createdAt));
        return rows.map((r) => ({ jobId: r.id, title: r.title, format: r.format, status: r.status, videoUrl: r.videoUrl, createdAt: r.createdAt }));
      }
      case "generate_image": {
        if (!openaiConfigured()) return { error: "Image generation is not connected yet." };
        const q = await studioQuota(userId, false);
        if (!q.ok) return { error: q.error };
        const prompt = clean(input?.prompt, 1000);
        if (!prompt) return { error: "Describe the image to create." };
        try {
          const url = await generateImage(prompt, { style: input?.style, size: input?.size, quality: input?.quality });
          await db.insert(mediaJobs).values({ userId, kind: "image", prompt, status: "done", resultUrl: url });
          return { imageUrl: url, prompt };
        } catch (e: any) { return { error: e?.message || "Image generation failed." }; }
      }
      case "text_to_speech": {
        if (!openaiConfigured()) return { error: "Voiceover is not connected yet." };
        const q = await studioQuota(userId, false);
        if (!q.ok) return { error: q.error };
        const text = clean(input?.text, 4000);
        if (!text) return { error: "Provide the text to speak." };
        try {
          const mp3 = await textToSpeech(text, input?.voice || "alloy", 1.0);
          const name = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
          fs.writeFileSync(path.join(MEDIA_DIR, name), mp3);
          const resultUrl = `/api/studio/file/${name}`;
          await db.insert(mediaJobs).values({ userId, kind: "tts", prompt: text.slice(0, 200), status: "done", resultUrl });
          return { audioUrl: resultUrl, chars: text.length };
        } catch (e: any) { return { error: e?.message || "Voiceover failed." }; }
      }
      case "list_avatars": {
        if (!heygenConfigured()) return { error: "Video avatars are not connected yet." };
        try {
          const avatars = await heygenListAvatars();
          return avatars.slice(0, 24).map((a: any) => ({
            avatarId: a.avatar_id, name: a.avatar_name, gender: a.gender,
            preview: a.preview_image_url || a.preview_video_url || null,
          }));
        } catch (e: any) { return { error: e?.message || "Could not load avatars." }; }
      }
      case "remember_preference": {
        const note = String(input.note ?? "").trim().slice(0, 300);
        if (!note) return { error: "Nothing to file." };
        const cur = (await getSetting(userId, "assistant_memory")) || "";
        const notes = cur.split("\n").filter(Boolean);
        if (!notes.some((n) => n.toLowerCase() === note.toLowerCase())) notes.push(note);
        await setSetting(userId, "assistant_memory", notes.slice(-30).join("\n"));
        return { filed: note, totalFiled: notes.length };
      }
      case "set_daily_ritual": {
        const RITUAL_MODS = ["quote", "outlook", "bible", "horoscope", "tarot"];
        const ZODIAC = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
        const mods = Array.isArray(input.modules) ? input.modules.filter((m: string) => RITUAL_MODS.includes(m)) : [];
        const enabled = input.enabled !== false;
        await setSetting(userId, "ritual_enabled", enabled ? "1" : "0");
        await setSetting(userId, "ritual_modules", mods.join(","));
        if (typeof input.sign === "string" && ZODIAC.includes(input.sign)) await setSetting(userId, "ritual_sign", input.sign);
        return { ritual: { enabled, modules: mods, sign: (await getSetting(userId, "ritual_sign")) || null } };
      }
      case "update_profile": {
        const saved = await setProfile(userId, input);
        return { profile: saved, zodiac: zodiacFromDob(saved.dob) || null };
      }
      case "get_blg_article": {
        const id = String(input.id ?? "").trim();
        if (!id) return { error: "Provide an article id from list_blg_articles." };
        const article = await blgGetArticle(id);
        return { article };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e: any) {
    return { error: e?.message || "Tool failed." };
  }
}

/** Chat with the all-in-one assistant. One AI request is charged per user turn.
 * Conversations persist server-side: pass conversationId to continue a thread,
 * or omit it to start a new one. History is loaded from the DB, so a refresh
 * or a new device resumes the same thread. */
keystone.post("/api/assistant/chat", requireUser, requireSub, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = c.get("user");
  const userText = typeof body.message === "string" ? body.message.trim().slice(0, 4000) : "";
  if (!userText) return c.json({ error: "Send a message to the assistant." }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "AI is not configured yet." }, 503);
  const quota = await aiQuota(user.id, c.get("isAdmin"));
  if (!quota.ok) return c.json({ error: quota.error, limitHit: quota.limitHit, plan: quota.plan, limit: quota.limit }, 429);

  // Find the thread, or start a new one (auto-titled from the first message).
  let conv: any = null;
  const convId = Number(body.conversationId) || 0;
  if (convId) {
    [conv] = await db.select().from(assistantConversations)
      .where(and(eq(assistantConversations.userId, user.id), eq(assistantConversations.id, convId)));
    if (!conv) return c.json({ error: "Conversation not found." }, 404);
  } else {
    [conv] = await db.insert(assistantConversations)
      .values({ userId: user.id, title: userText.slice(0, 48) || "New chat" }).returning();
    // Keep the list tidy: cap stored conversations per user.
    const olds = await db.select({ id: assistantConversations.id }).from(assistantConversations)
      .where(eq(assistantConversations.userId, user.id)).orderBy(desc(assistantConversations.id));
    if (olds.length > 100) {
      const drop = olds.slice(100).map((o) => o.id);
      await db.delete(assistantMessages).where(inArray(assistantMessages.conversationId, drop));
      await db.delete(assistantConversations).where(inArray(assistantConversations.id, drop));
    }
  }

  const hist = await db.select({ role: assistantMessages.role, content: assistantMessages.content })
    .from(assistantMessages).where(eq(assistantMessages.conversationId, conv.id))
    .orderBy(assistantMessages.id).limit(60);
  const messages: any[] = [
    ...hist.map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
    { role: "user", content: userText },
  ].slice(-20);

  // Current project context, so "change the headline" edits the right code.
  const art = body.artifact;
  if (art && typeof art.code === "string" && art.code.length > 0 && art.code.length < 200000) {
    const last = messages[messages.length - 1];
    last.content += `\n\n[The user's current project is "${String(art.name || "untitled").slice(0, 80)}". Its full code is below. When they ask for changes, return the FULL updated file in a new html-artifact block.]\n\`\`\`html\n${art.code.slice(0, 120000)}\n\`\`\``;
  }

  const callAnthropic = async (msgs: any[]) => {
    const aName = await getSetting(user.id, "assistant_name") || "Assistant";
    const personality = await buildPersonality(user.id);
    const sysPrompt = `Your name is ${aName}. The user named you this — always introduce yourself as ${aName} and sign off as ${aName} when natural.\n\n${ASSISTANT_SYSTEM}${personality}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 4000, system: sysPrompt, tools: ASSISTANT_TOOLS, messages: msgs }),
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
    const reply = text || "I ran into trouble on that one. Try asking again in different words.";
    // Persist the turn (only on success, so a failed request never leaves a half-saved thread).
    await db.insert(assistantMessages).values([
      { conversationId: conv.id, role: "user", content: userText },
      { conversationId: conv.id, role: "assistant", content: reply.slice(0, 120000) },
    ]);
    await db.update(assistantConversations).set({ updatedAt: new Date() })
      .where(eq(assistantConversations.id, conv.id));
    return c.json({ reply, conversationId: conv.id });
  } catch (e: any) {
    console.error("assistant failure", e?.status || "", e?.error || e?.message || e);
    return c.json({ error: e?.error || "The assistant could not be reached." }, e?.status ?? 502);
  }
});

/** My saved assistant conversations, newest first. */
keystone.get("/api/assistant/conversations", requireUser, async (c) => {
  const user = c.get("user");
  const rows = await db.select({
    id: assistantConversations.id,
    title: assistantConversations.title,
    updatedAt: assistantConversations.updatedAt,
  }).from(assistantConversations).where(eq(assistantConversations.userId, user.id))
    .orderBy(desc(assistantConversations.updatedAt)).limit(100);
  return c.json(rows);
});

/** Load one conversation's messages. */
keystone.get("/api/assistant/conversations/:id", requireUser, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id")) || 0;
  const [conv] = await db.select().from(assistantConversations)
    .where(and(eq(assistantConversations.userId, user.id), eq(assistantConversations.id, id)));
  if (!conv) return c.json({ error: "Conversation not found." }, 404);
  const msgs = await db.select({
    role: assistantMessages.role, content: assistantMessages.content,
  }).from(assistantMessages).where(eq(assistantMessages.conversationId, id)).orderBy(assistantMessages.id);
  return c.json({ id: conv.id, title: conv.title, messages: msgs });
});

/** Delete a conversation and its messages. */
keystone.delete("/api/assistant/conversations/:id", requireUser, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id")) || 0;
  const [conv] = await db.select({ id: assistantConversations.id }).from(assistantConversations)
    .where(and(eq(assistantConversations.userId, user.id), eq(assistantConversations.id, id)));
  if (!conv) return c.json({ error: "Conversation not found." }, 404);
  await db.delete(assistantMessages).where(eq(assistantMessages.conversationId, id));
  await db.delete(assistantConversations).where(eq(assistantConversations.id, id));
  return c.json({ ok: true });
});

/** Friendly labels for agent tool steps. */
const AGENT_TOOL_LABELS: Record<string, string> = {
  generate_funnel: "Building funnel",
  list_funnels: "Checking your funnels",
  set_funnel_status: "Publishing funnel",
  delete_funnel: "Deleting funnel",
  list_leads: "Checking new leads",
  claim_lead: "Claiming lead",
  list_prospects: "Checking pipeline",
  billing_status: "Checking billing",
  affiliate_info: "Checking affiliate stats",
  generate_image: "Creating image",
  text_to_speech: "Recording voiceover",
  list_avatars: "Loading avatars",
  make_spokesperson_video: "Rendering video",
  remember_preference: "Filing that away",
  set_daily_ritual: "Setting up your ritual",
  update_profile: "Updating your profile",
};

const AGENT_SYSTEM = `You are the AIU Agent — the user's personal AI worker inside the AIU app. You talk like their right hand: plain, direct, warm, no fluff. Never open with filler like "Great question!" — just do the work.

You're a full general-purpose AI like ChatGPT or Grok: answer everyday questions, explain things, give advice, brainstorm, write, help with decisions — not just in-app tasks. When the user gives you a goal you can execute with tools, break it into steps and work through them like a checklist so they can watch.

RULES:
- For everyday questions and conversation, just answer directly — no STEP: lines, no tools needed.
- For multi-step in-app work, before each tool call write a line starting with "STEP:" describing in plain, friendly words what you are about to do (e.g. "STEP: Building your gym lead funnel"). Keep it under 12 words.
- Do ONE tool call per step. After each tool result, decide the next step.
- Maximum 8 steps. If you cannot finish in 8, summarize what is done and what is left.
- When the goal is complete, write a final summary starting with "DONE:" — include any links, IDs, or concrete results the user needs. Keep it concise. Name the one clear next move when there is one.
- Never invent data. Only report what the tools actually returned. If you don't know something, say so.
- If the goal is unclear or impossible with your tools, say so plainly starting with "DONE:" and suggest what to ask instead.
- CREATIVE WORK: you can generate images (generate_image — always share the returned imageUrl on its own line), voiceovers (text_to_speech — share the audioUrl), and spokesperson videos. For videos: if the user wants to pick who appears, call list_avatars first, show the options with names, then pass the chosen avatarId to make_spokesperson_video.
- MEMORY: You keep a file on this user. When they state a durable preference, a recurring request ("every morning...", "always...", "from now on..."), or a fact about their business, goals, or life worth keeping, call remember_preference to file it, then confirm in a few words. Don't file one-off task details.
- DAILY RITUAL: Users can have a daily greeting ritual (inspirational quote, positive outlook, Bible verse, horoscope, tarot) delivered in their tone when they start a fresh chat. When a user asks to set one up, change its pieces, or turn it off, call set_daily_ritual. If they give their zodiac sign or birthday for the horoscope, file it with remember_preference too.
- PROFILE: When a user tells you their name, birthday, address, or other profile details in conversation, save them with update_profile so every future conversation already knows them — and always address the user by their first name from their profile, never a username or email handle.
- QUICK OPTIONS: When you ask the user to pick between 2-4 clear alternatives (never for open questions, never more than 4), end your message with a block exactly like this, on its own lines:
[[OPTIONS]]
First choice
Second choice
[[/OPTIONS]]
The app turns each line into a tappable button, and tapping sends that exact line back as the user's reply. Keep each option under 40 characters. Never explain or mention the block itself.`;

/**
 * Agent mode: the AI works through a goal step by step, streaming visible
 * progress (SSE) so the user can watch it work like a human assistant.
 */
keystone.post("/api/assistant/agent", requireUser, requireSub, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = c.get("user");
  const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, 1000) : "";
  if (!goal) return c.json({ error: "Tell the agent what to get done." }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return c.json({ error: "AI is not configured yet." }, 503);

  const quota = await aiQuota(user.id, c.get("isAdmin"));
  if (!quota.ok) return c.json({ error: quota.error, limitHit: quota.limitHit }, 429);

  // Find the thread, or start a new one (auto-titled from the goal).
  let conv: any = null;
  const convId = Number(body.conversationId) || 0;
  if (convId) {
    [conv] = await db.select().from(assistantConversations)
      .where(and(eq(assistantConversations.userId, user.id), eq(assistantConversations.id, convId)));
  }
  if (!conv) {
    [conv] = await db.insert(assistantConversations)
      .values({ userId: user.id, title: goal.slice(0, 48) || "New chat" }).returning();
  }
  const hist = await db.select({ role: assistantMessages.role, content: assistantMessages.content })
    .from(assistantMessages).where(eq(assistantMessages.conversationId, conv.id))
    .orderBy(assistantMessages.id).limit(60);
  const convIdOut = conv.id;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`));
      const callAnthropic = async (msgs: any[]) => {
        const q = await aiQuota(user.id, c.get("isAdmin"));
        if (!q.ok) throw { status: 429, error: q.error };
        const aName = await getSetting(user.id, "assistant_name") || "Assistant";
        const personality = await buildPersonality(user.id);
        const sysPrompt = `Your name is ${aName}. The user named you this — refer to yourself as ${aName}.\n\n${AGENT_SYSTEM}${personality}`;
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: AI_MODEL, max_tokens: 4000, system: sysPrompt, tools: ASSISTANT_TOOLS, messages: msgs }),
        });
        if (!r.ok) throw { status: 502, error: "The AI service had a problem. Try again in a moment." };
        return r.json();
      };

      try {
        send({ type: "step", text: "Understanding your goal" });
        const messages: any[] = [
          ...hist.map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) })).slice(-10),
          { role: "user", content: `Goal: ${goal}` },
        ];
        let done = false;
        let finalText = "";
        for (let i = 0; i < 8 && !done; i++) {
          const data: any = await callAnthropic(messages);
          const blocks = data.content ?? [];
          const texts = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
          for (const line of texts.split("\n")) {
            const m = line.match(/^STEP:\s*(.+)/i);
            if (m) send({ type: "step", text: m[1].trim().slice(0, 120) });
          }
          const doneMatch = texts.match(/^DONE:\s*([\s\S]*)/im);
          const toolUses = blocks.filter((b: any) => b.type === "tool_use");
          if (doneMatch && !toolUses.length) {
            finalText = doneMatch[1].trim().slice(0, 4000);
            done = true;
            break;
          }
          if (!toolUses.length) {
            finalText = texts.replace(/^STEP:.*$/gim, "").trim().slice(0, 4000) || "Finished.";
            done = true;
            break;
          }
          const results = [];
          for (const tu of toolUses) {
            const label = AGENT_TOOL_LABELS[tu.name] || "Working";
            send({ type: "tool", text: label });
            const out = await runAssistantTool(tu.name, tu.input ?? {}, user.id);
            results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 8000) });
            send({ type: "tool_done", text: label });
          }
          messages.push({ role: "assistant", content: blocks });
          messages.push({ role: "user", content: results });
        }
        if (!done) finalText = "I ran out of steps. Ask me to continue and I'll pick up where I left off.";
        // Persist the turn (only on success).
        await db.insert(assistantMessages).values([
          { conversationId: convIdOut, role: "user", content: goal },
          { conversationId: convIdOut, role: "assistant", content: finalText.slice(0, 120000) },
        ]);
        await db.update(assistantConversations).set({ updatedAt: new Date() })
          .where(eq(assistantConversations.id, convIdOut));
        send({ type: "done", text: finalText, conversationId: convIdOut });
      } catch (e: any) {
        send({ type: "error", text: e?.error || "The agent hit a problem. Try again." });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
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
