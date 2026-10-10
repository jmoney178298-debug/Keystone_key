import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

const createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date());
const updatedAt = () => integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date());

export const subscriptions = sqliteTable("subscriptions", {
  userId: text("user_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  plan: text("plan").notNull().default("pro"),
  status: text("status").notNull().default("incomplete"),
  currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }),
  updatedAt: updatedAt(),
});

export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  createdAt: createdAt(),
});

export const hotLeads = sqliteTable("hot_leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  businessName: text("business_name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  industry: text("industry"),
  city: text("city"),
  signals: text("signals", { mode: "json" }).$type<string[]>().notNull().default([]),
  score: integer("score").notNull().default(0),
  status: text("status").notNull().default("new"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const prospects = sqliteTable("prospects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  businessName: text("business_name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  industry: text("industry"),
  city: text("city"),
  stage: text("stage").notNull().default("new"),
  dealValue: integer("deal_value"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company"),
  interest: text("interest").notNull(),
  message: text("message"),
  status: text("status").notNull().default("new"),
  createdAt: createdAt(),
});

/** Daily AI request counter per user (cost control). */
export const aiUsage = sqliteTable("ai_usage", {
  userId: text("user_id").notNull(),
  day: text("day").notNull(),
  n: integer("n").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.day] })]);

/** AI-generated lead capture funnels. One row per funnel. */
export const funnels = sqliteTable("funnels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  /** public URL slug, unique */
  slug: text("slug").notNull().unique(),
  industry: text("industry").notNull(),
  title: text("title").notNull(),
  /** full generated landing page HTML */
  html: text("html").notNull(),
  /** JSON: { google: { headlines[], descriptions[] }, facebook: string } */
  adAngles: text("ad_angles", { mode: "json" }).$type<Record<string, any>>().notNull().default({}),
  /** draft | live */
  status: text("status").notNull().default("draft"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Leads captured through a funnel's public opt-in form. Real opt-ins only. */
export const funnelLeads = sqliteTable("funnel_leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  funnelId: integer("funnel_id").notNull(),
  /** funnel owner */
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  city: text("city"),
  state: text("state"),
  ip: text("ip"),
  /** new | claimed */
  status: text("status").notNull().default("new"),
  createdAt: createdAt(),
});

/** Lifetime (one-time purchase) access. Stripe is the source of truth. */
export const lifetimeAccess = sqliteTable("lifetime_access", {
  userId: text("user_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  createdAt: createdAt(),
});

/** Partner (one-time $4,999 purchase) access. Stripe is the source of truth. */
export const partnerAccess = sqliteTable("partner_access", {
  userId: text("user_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  createdAt: createdAt(),
});

/** Affiliates: users who refer buyers. Partners are affiliates with tier='partner' (50% vs 30%). */
export const affiliates = sqliteTable("affiliates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().unique(),
  /** unique referral code, e.g. "KX7Q2M9P" */
  code: text("code").notNull().unique(),
  /** affiliate | partner */
  tier: text("tier").notNull().default("affiliate"),
  /** active | paused */
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

/** Referral attributions + commissions owed. */
export const referrals = sqliteTable("referrals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  affiliateId: integer("affiliate_id").notNull(),
  /** buyer */
  userId: text("user_id").notNull(),
  /** subscription | lifetime | partner */
  kind: text("kind").notNull(),
  /** gross sale amount in cents */
  amountCents: integer("amount_cents").notNull(),
  /** commission earned in cents */
  commissionCents: integer("commission_cents").notNull(),
  /** pending | paid */
  payoutStatus: text("payout_status").notNull().default("pending"),
  stripeEventId: text("stripe_event_id").unique(),
  createdAt: createdAt(),
});
