# AIU
Flat layout (no folders) so it can be uploaded from a phone. See package.json for the start command (npm start).
Public: index.html (landing/sign-in/account). Gated: app.html (served only at /app to the owner and active subscribers).
Required Railway variables: APP_URL, OWNER_EMAIL, DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_BASIC, STRIPE_PRICE_PRO, STRIPE_PRICE_PROPLUS.
Optional: STRIPE_PRICE_LIFETIME (one-time purchase price ID for lifetime access), ANTHROPIC_API_KEY (AI features), AI_MODEL.

## Funnels (lead generation system)
- App > Funnels tab: type an industry, AI builds a complete lead-capture landing page in one click.
- Publish to get a public link (/f/your-slug). Run ads to it; every opt-in (name, email, phone, city, state + IP) lands in your leads pool.
- Claim a lead to move it to the Pipeline — claimed leads leave the available pool automatically.
- Daily lead-capture caps per tier: basic 10, pro 50, proplus/lifetime 200.
- Buyers can subscribe monthly (basic/pro/proplus) or buy lifetime access outright via /app billing.
