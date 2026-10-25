# Production deployment blueprint

This folder is an inert example until a VPS, domain, pinned container images,
and independent secrets are approved. It exposes only Caddy on ports 80/443.
The WAHA API and dashboard are not published to the internet; the Shopify app
reaches WAHA over the private Docker network.

1. Copy `production.env.example` to `.env.production` on the server and set
   restrictive file permissions. Never commit it.
2. Set `APP_DOMAIN` and `SHOPIFY_APP_URL` to the same permanent HTTPS origin.
3. Pin `CADDY_IMAGE` and `WAHA_IMAGE` to reviewed version tags or digests. Do
   not use `latest`; choose the WAHA image that matches the VPS CPU architecture.
4. Use a new `WAHA_API_KEY` and the Shopify app credentials. Do not reuse any
   Cloudflare, Whapi, Shopify-store, or existing WAHA credential.
5. Validate before starting:

   ```sh
   docker compose --env-file .env.production -f compose.production.yml config
   ```

6. After the permanent URL is approved, update `shopify.app.toml`, deploy that
   Shopify configuration, and install the custom-distribution app on the single
   allowed store.

The named volumes retain Shopify sessions, WAHA sessions, media, and Caddy TLS
state across container restarts. Back up the WAHA and Shopify volumes before
server migration. The operator must scan the WhatsApp QR manually; this stack
does not link a phone automatically.

WAHA's current FAQ recommends at least 2 CPU and 4 GB RAM even for one session.
Its planning table estimates that ten WEBJS sessions need roughly 3 CPU/2.5 GB,
while NOWEB and GOWS use fewer resources. This blueprint stays on the already
tested `WEBJS` engine by default; changing engines requires a separate payload,
session-storage, and message-flow test first. See:
https://waha.devlike.pro/docs/overview/faq/ and
https://waha.devlike.pro/docs/how-to/engines/.
