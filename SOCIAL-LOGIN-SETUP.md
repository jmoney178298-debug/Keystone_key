# Social Login + Password Reset — Setup Guide
The code is live. These credentials unlock each piece. Add them as Railway environment variables on the GetAIU service, then redeploy.

## Password reset (Resend)
- **RESEND_API_KEY** — from resend.com → API Keys. The "Forgot password?" link emails a 1-hour reset link. Without this key, the reset form shows but no email sends (you'll see a warning in the logs).

## Google sign-in
1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Web application)
2. Authorized redirect URI: `https://www.getaiu.online/api/auth/callback/google`
3. Set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

## Apple sign-in
1. Apple Developer → Certificates, Identifiers & Profiles → Identifiers → create a Services ID
2. Create a key for Sign in with Apple; build the client-secret JWT (or paste it directly)
3. Set: `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`
4. Optional (if you want auto-generated secrets): `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`

## Facebook + Instagram sign-in
1. Meta for Developers → create an app → add Facebook Login product
2. Valid OAuth redirect URI: `https://www.getaiu.online/api/auth/callback/facebook`
3. Set: `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`
4. Instagram note: Meta folded Instagram login into Facebook Login — there is no separate Instagram OAuth app for third-party sites. The "Continue with Instagram" button uses your Meta/Facebook app, which is the official path.

## How it behaves
- A social button only appears on the login page when its credentials are set. No keys = no buttons = email login only (nothing breaks).
- After social sign-in, users land in `/app` like everyone else; trials and subscriptions work the same.
