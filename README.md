# Keystone
Flat layout (no folders) so it can be uploaded from a phone. See package.json for the start command (npm start).
Public: index.html (landing/sign-in/account). Gated: app.html (served only at /app to the owner and active subscribers).
Required Railway variables: APP_URL, OWNER_EMAIL, DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_BASIC, STRIPE_PRICE_PRO, STRIPE_PRICE_PROPLUS.
