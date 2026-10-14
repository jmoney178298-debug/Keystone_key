import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export const dbPath = (process.env.DATABASE_URL ?? "file:./data/keystone.db").replace(/^file:/, "");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Tables are created on first boot, so there is no separate migration step.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS user (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, emailVerified integer NOT NULL DEFAULT 0, image text, createdAt date NOT NULL, updatedAt date NOT NULL);
CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, expiresAt date NOT NULL, token text NOT NULL UNIQUE, createdAt date NOT NULL, updatedAt date NOT NULL, ipAddress text, userAgent text, userId text NOT NULL REFERENCES user(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS account (id text PRIMARY KEY, accountId text NOT NULL, providerId text NOT NULL, userId text NOT NULL REFERENCES user(id) ON DELETE CASCADE, accessToken text, refreshToken text, idToken text, accessTokenExpiresAt date, refreshTokenExpiresAt date, scope text, password text, createdAt date NOT NULL, updatedAt date NOT NULL);
CREATE TABLE IF NOT EXISTS verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expiresAt date NOT NULL, createdAt date, updatedAt date);
CREATE TABLE IF NOT EXISTS subscriptions (user_id text PRIMARY KEY, stripe_customer_id text NOT NULL, stripe_subscription_id text, plan text NOT NULL DEFAULT 'pro', status text NOT NULL DEFAULT 'incomplete', current_period_end integer, updated_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS stripe_events (id text PRIMARY KEY, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS prospects (id integer PRIMARY KEY AUTOINCREMENT, user_id text NOT NULL, business_name text NOT NULL, contact_name text, email text, phone text, website text, industry text, city text, stage text NOT NULL DEFAULT 'new', deal_value integer, notes text, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage (user_id text NOT NULL, day text NOT NULL, n integer NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
CREATE TABLE IF NOT EXISTS leads (id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL, email text NOT NULL, company text, interest text NOT NULL, message text, status text NOT NULL DEFAULT 'new', created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS funnels (id integer PRIMARY KEY AUTOINCREMENT, user_id text NOT NULL, slug text NOT NULL UNIQUE, industry text NOT NULL, title text NOT NULL, html text NOT NULL, ad_angles text NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft', views integer NOT NULL DEFAULT 0, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS funnel_leads (id integer PRIMARY KEY AUTOINCREMENT, funnel_id integer NOT NULL, user_id text NOT NULL, name text NOT NULL, email text NOT NULL, phone text, city text, state text, ip text, status text NOT NULL DEFAULT 'new', created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS lifetime_access (user_id text PRIMARY KEY, stripe_customer_id text NOT NULL, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS partner_access (user_id text PRIMARY KEY, stripe_customer_id text NOT NULL, stripe_subscription_id text, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS affiliates (id integer PRIMARY KEY AUTOINCREMENT, user_id text NOT NULL UNIQUE, code text NOT NULL UNIQUE, tier text NOT NULL DEFAULT 'affiliate', status text NOT NULL DEFAULT 'active', elite integer NOT NULL DEFAULT 0, elite_kind text, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS referrals (id integer PRIMARY KEY AUTOINCREMENT, affiliate_id integer NOT NULL, user_id text NOT NULL, kind text NOT NULL, amount_cents integer NOT NULL, commission_cents integer NOT NULL, payout_status text NOT NULL DEFAULT 'pending', stripe_event_id text UNIQUE, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS ideas (id integer PRIMARY KEY AUTOINCREMENT, user_id text NOT NULL, title text NOT NULL, body text NOT NULL, status text NOT NULL DEFAULT 'new', created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_conversations (id integer PRIMARY KEY AUTOINCREMENT, user_id text NOT NULL, title text NOT NULL DEFAULT 'New chat', created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_messages (id integer PRIMARY KEY AUTOINCREMENT, conversation_id integer NOT NULL, role text NOT NULL, content text NOT NULL, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS limit_hits (id integer PRIMARY KEY AUTOINCREMENT, user_id text NOT NULL, plan text NOT NULL, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS blg_posts (id integer PRIMARY KEY AUTOINCREMENT, blg_id integer, slug text NOT NULL UNIQUE, title text NOT NULL, content_html text, content_markdown text, meta_description text, hero_image_url text, json_ld text, faq_json_ld text, language_code text NOT NULL DEFAULT 'en', published_at integer, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS video_jobs (id integer PRIMARY KEY AUTOINCREMENT, user_id text NOT NULL, heygen_video_id text NOT NULL UNIQUE, title text NOT NULL, script text NOT NULL, format text NOT NULL DEFAULT 'landscape', status text NOT NULL DEFAULT 'queued', video_url text, error text, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS media_jobs (id integer PRIMARY KEY AUTOINCREMENT, user_id text NOT NULL, kind text NOT NULL, prompt text, status text NOT NULL DEFAULT 'done', result_url text, error text, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS trial_ips (id integer PRIMARY KEY AUTOINCREMENT, ip text NOT NULL UNIQUE, user_id text NOT NULL, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS user_settings (user_id text NOT NULL, key text NOT NULL, value text NOT NULL, created_at integer NOT NULL, PRIMARY KEY (user_id, key));
`);

// Column upgrades for databases created before these columns existed.
for (const stmt of [
  "ALTER TABLE affiliates ADD COLUMN elite integer NOT NULL DEFAULT 0",
  "ALTER TABLE affiliates ADD COLUMN elite_kind text",
  "ALTER TABLE partner_access ADD COLUMN stripe_subscription_id text",
  "ALTER TABLE funnels ADD COLUMN views integer NOT NULL DEFAULT 0",
  "ALTER TABLE affiliates ADD COLUMN phone text",
  "ALTER TABLE affiliates ADD COLUMN address text",
]) {
  try { sqlite.exec(stmt); } catch { /* column already exists */ }
}

export const db = drizzle(sqlite, { schema });
