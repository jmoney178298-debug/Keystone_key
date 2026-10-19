import { betterAuth } from "better-auth";
import { google, apple, facebook } from "better-auth/social-providers";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dbPath, sqlite } from "./db";

function authSecret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  const file = path.join(path.dirname(dbPath), ".auth-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const s = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const APP_URL = (process.env.APP_URL || "https://www.getaiu.online").replace(/\/$/, "");

/** Password-reset email via Resend (same infra as lead notifications). */
async function sendResetPasswordEmail(to: string, token: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[auth] RESEND_API_KEY not set — password reset email not sent to", to);
    return;
  }
  const from = process.env.NOTIFY_FROM || "AIU <notifications@getaiu.online>";
  const resetUrl = `${APP_URL}/#reset?token=${encodeURIComponent(token)}`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject: "Reset your AIU password",
      text: `You asked to reset your AIU password. Click the link below (valid for 1 hour):\n\n${resetUrl}\n\nIf you didn't ask for this, ignore this email — your password stays the same.`,
    }),
  });
}

/** Social providers are env-gated: a button only appears when its credentials are set.
 *  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — Google Cloud Console → APIs & Services → Credentials (OAuth client, Web)
 *  APPLE_CLIENT_ID / APPLE_CLIENT_SECRET — Apple Developer → Identifiers (Services ID) + key for client-secret JWT
 *  FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET — Meta for Developers → your app → Facebook Login
 *  NOTE: Instagram has no standalone third-party login — Meta folded it into Facebook Login.
 *  The Instagram button reuses the Facebook/Meta OAuth app, which is the official path. */
const socialProviders: Record<string, any> = {};
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = google({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  });
}
if (process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET) {
  const appleCfg: Record<string, any> = {
    clientId: process.env.APPLE_CLIENT_ID,
    clientSecret: process.env.APPLE_CLIENT_SECRET,
  };
  if (process.env.APPLE_TEAM_ID) appleCfg.teamId = process.env.APPLE_TEAM_ID;
  if (process.env.APPLE_KEY_ID) appleCfg.keyId = process.env.APPLE_KEY_ID;
  if (process.env.APPLE_PRIVATE_KEY) appleCfg.privateKey = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  socialProviders.apple = apple(appleCfg);
}
if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
  socialProviders.facebook = facebook({
    clientId: process.env.FACEBOOK_CLIENT_ID,
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
  });
}

/** Which social buttons the login page should render (mirrors the env-gated providers above). */
export function enabledSocialProviders(): string[] {
  const out: string[] = [];
  if (socialProviders.google) out.push("google");
  if (socialProviders.apple) out.push("apple");
  if (socialProviders.facebook) { out.push("facebook"); out.push("instagram"); } // Instagram runs through the Meta/Facebook OAuth app
  return out;
}

export const auth = betterAuth({
  database: sqlite,
  baseURL: process.env.APP_URL,
  secret: authSecret(),
  trustedOrigins: process.env.APP_URL ? [process.env.APP_URL] : [],
  advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    sendResetPassword: async ({ user, token }) => {
      await sendResetPasswordEmail(user.email, token);
    },
    resetPasswordTokenExpiresIn: 3600, // 1 hour
  },
  ...(Object.keys(socialProviders).length ? { socialProviders } : {}),
});
