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
  /** public page views (incremented on each /f/:slug load) */
  views: integer("views").notNull().default(0),
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

/** Partner (yearly subscription) access. Stripe is the source of truth. */
export const partnerAccess = sqliteTable("partner_access", {
  userId: text("user_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  createdAt: createdAt(),
});

/** Affiliates: users who refer buyers. Partners are affiliates with tier='partner' (40%). */
export const affiliates = sqliteTable("affiliates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().unique(),
  /** unique referral code, e.g. "KX7Q2M9P" */
  code: text("code").notNull().unique(),
  /** affiliate | partner */
  tier: text("tier").notNull().default("affiliate"),
  /** active | paused */
  status: text("status").notNull().default("active"),
  /** 1 = locked 50% for life (first 15 ladder / first 5 fast-track, or owner grant) */
  elite: integer("elite").notNull().default(0),
  /** ladder | fast | manual (how the lifetime lock was earned) */
  eliteKind: text("elite_kind"),
  /** contact info for payouts/refunds (collected at signup) */
  phone: text("phone"),
  address: text("address"),
  createdAt: createdAt(),
});

/** Partner-submitted product ideas. Ideas become the property of the business; submitting conveys no ownership. */
export const ideas = sqliteTable("ideas", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** new | reviewing | shipped | declined */
  status: text("status").notNull().default("new"),
  createdAt: createdAt(),
});

/** Referral attributions + commissions owed. */
export const referrals = sqliteTable("referrals", {  id: integer("id").primaryKey({ autoIncrement: true }),
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

/** Assistant chat conversations — one row per chat thread. */
export const assistantConversations = sqliteTable("assistant_conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  /** auto-titled from the first message */
  title: text("title").notNull().default("New chat"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Messages inside an assistant conversation. */
export const assistantMessages = sqliteTable("assistant_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull(),
  /** user | assistant */
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: createdAt(),
});

/** Times a user hit their daily AI limit (upgrade-signal for the owner). */
export const limitHits = sqliteTable("limit_hits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  /** plan the user was on when they hit the wall */
  plan: text("plan").notNull(),
  createdAt: createdAt(),
});

/** IPs that have already used a free trial. Blocks trial abuse via new emails. One trial per IP. */
export const trialIps = sqliteTable("trial_ips", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ip: text("ip").notNull().unique(),
  userId: text("user_id").notNull(),
  createdAt: createdAt(),
});

/** Blog posts synced from the BabyLoveGrowth API. Upserted idempotently by slug. */
export const blgPosts = sqliteTable("blg_posts", {  id: integer("id").primaryKey({ autoIncrement: true }),
  /** BLG article id */
  blgId: integer("blg_id"),
  /** URL slug — the idempotency key */
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  contentHtml: text("content_html"),
  contentMarkdown: text("content_markdown"),
  metaDescription: text("meta_description"),
  heroImageUrl: text("hero_image_url"),
  jsonLd: text("json_ld"),
  faqJsonLd: text("faq_json_ld"),
  languageCode: text("language_code").notNull().default("en"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** HeyGen spokesperson video jobs. Status: queued → processing → completed | failed. */
export const videoJobs = sqliteTable("video_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  heygenVideoId: text("heygen_video_id").notNull().unique(),
  title: text("title").notNull(),
  script: text("script").notNull(),
  format: text("format").notNull().default("landscape"),
  status: text("status").notNull().default("queued"),
  videoUrl: text("video_url"),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Generic media jobs: AI images, TTS voiceovers, background removal. */
export const mediaJobs = sqliteTable("media_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(), // 'image' | 'tts' | 'bgremove'
  prompt: text("prompt"),
  status: text("status").notNull().default("done"), // 'done' | 'failed'
  resultUrl: text("result_url"),
  error: text("error"),
  createdAt: createdAt(),
});

/** Content clipper jobs: upload → transcribe → highlights → clips. */
export const contentJobs = sqliteTable("content_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  sourceFile: text("source_file").notNull(),
  isVideo: integer("is_video").notNull().default(0),
  durationSec: integer("duration_sec").notNull().default(0),
  transcript: text("transcript"),
  highlights: text("highlights"), // JSON array of {start, end, title, summary, topics}
  clips: text("clips"), // JSON array of {title, file, start, end}
  status: text("status").notNull().default("uploaded"), // uploaded | transcribing | analyzing | clipping | done | failed
  error: text("error"),
  createdAt: createdAt(),
});

/** Per-user settings: assistant name, preferences. */
export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.key] })]);

/** API keys for third-party AI services (encrypted at rest, never sent to client). */
export const integrationKeys = sqliteTable("integration_keys", {
  service: text("service").primaryKey(), // elevenlabs | gemini | perplexity | grok | openai | anthropic | leonardo | heygen
  apiKeyEnc: text("api_key_enc").notNull(), // AES-256-GCM encrypted
  iv: text("iv").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** AI subscription tracker: every AI tool subscription with renewal dates + cancel links. */
export const aiSubscriptions = sqliteTable("ai_subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  serviceName: text("service_name").notNull(), // e.g. "OpenGen"
  planName: text("plan_name"), // e.g. "Pro Trial"
  costCents: integer("cost_cents").notNull().default(0), // renewal cost in cents
  currency: text("currency").notNull().default("USD"),
  billingCycle: text("billing_cycle").notNull().default("monthly"), // monthly | yearly | one_time | trial
  renewalDate: integer("renewal_date"), // unix ms of next renewal/charge
  trialEnds: integer("trial_ends"), // unix ms when trial converts
  cancelUrl: text("cancel_url"),
  notes: text("notes"),
  status: text("status").notNull().default("active"), // active | canceled | expired
  createdAt: createdAt(),
});
