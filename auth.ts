import { betterAuth } from "better-auth";
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

export const auth = betterAuth({
  database: sqlite,
  baseURL: process.env.APP_URL,
  secret: authSecret(),
  trustedOrigins: process.env.APP_URL ? [process.env.APP_URL] : [],
  advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
});
