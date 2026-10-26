# Production deployment blueprint

This folder is an inert example until a VPS, domains, pinned container images,
and independent secrets are approved. It exposes only Caddy on ports 80/443.
The Shopify app reaches WAHA over the private Docker network. The optional
operator dashboard uses a separate HTTPS hostname and two authentication
layers; port 3000 remains private.

1. Copy `production.env.example` to `.env.production` on the server and set
   restrictive file permissions. Never commit it.
2. Set `APP_DOMAIN` and `SHOPIFY_APP_URL` to the same HTTPS origin. The checked-in
   example uses the operator-owned `waha.indexesstore.com` subdomain for the
   approved VPS. Keep the store apex and other subdomains unchanged.
3. Pin `CADDY_IMAGE` and `WAHA_IMAGE` to reviewed version tags or digests. Do
   not use `latest`; choose the WAHA image that matches the VPS CPU architecture.
4. Use a new `WAHA_API_KEY` and the Shopify app credentials. Do not reuse any
   Cloudflare, Whapi, Shopify-store, or existing WAHA credential.
5. Set `DASHBOARD_DOMAIN` to an operator-only hostname. Generate a separate,
   strong `DASHBOARD_PASSWORD`, then put its Caddy-compatible hash in
   `DASHBOARD_PASSWORD_HASH`, wrapped in single quotes so Compose preserves the
   hash's `$` characters. The same dashboard username and password satisfy
   both the outer Caddy gate and WAHA's dashboard login, while API calls still
   require the independent `WAHA_API_KEY`.
6. Validate before starting:

   ```sh
   docker compose --env-file .env.production -f compose.production.yml config
   ```

7. After the permanent URL is approved, update `shopify.app.toml`, deploy that
   Shopify configuration, and install the custom-distribution app on the single
   allowed store.

The dashboard proxy permits only `/dashboard`, `/api`, `/health`, and `/ws`
routes needed by the UI. Swagger and every other WAHA route remain unavailable
through the dashboard hostname. Never publish the WAHA container port directly.

The production WAHA container restarts the saved session after a container or
worker restart, with a short startup delay. The operator still performs the
initial WhatsApp QR scan manually from the embedded Shopify app.

The named volumes retain Shopify sessions, WAHA sessions, media, and Caddy TLS
state across container restarts. Back up the WAHA and Shopify volumes before
server migration. The operator must scan the WhatsApp QR manually; this stack
does not link a phone automatically.

## Private ChatGPT access

The `tunnel-client` service gives ChatGPT outbound-only access to a restricted
gateway in front of WAHA's MCP endpoint through an OpenAI Secure MCP Tunnel. It
does not publish `/mcp`, either health port, or the WAHA container port on the
VPS.

1. Pin `TUNNEL_CLIENT_IMAGE` to the reviewed platform-specific image digest and
   set `OPENAI_TUNNEL_ID` in `.env.production`.
2. Create `deploy/.secrets/openai-runtime-api-key` containing only the restricted
   OpenAI runtime key with Tunnels Read + Use permissions.
3. Create `deploy/.secrets/waha-admin-api-key` containing the WAHA admin key,
   owned by UID/GID `1000:1000`. The key is mounted only into the restricted
   gateway; the tunnel client and ChatGPT never receive it.
4. Set the directory to mode `700` and both files to mode `600`. The `.secrets`
   directory is ignored by the repository and must never be committed.
5. Validate configuration, run the tunnel client's `doctor --explain` check,
   start the service, and require `/readyz` to return HTTP 200 before creating
   the ChatGPT connector.

The gateway exposes only tools annotated read-only from the approved WhatsApp
domains. It explicitly excludes API-key, app-management, authentication,
arbitrary-API, environment, session-control, settings, and deletion tools.
Read operations accept any session currently in `WORKING` state, so newly
connected numbers become readable without granting broader control. Message
sending remains available only for `WAHA_MCP_SEND_SESSION`, which defaults to
`indexs`. The OpenAI runtime key and WAHA admin key have separate lifecycles;
rotating either key does not require relinking a WhatsApp device.

WAHA's current FAQ recommends at least 2 CPU and 4 GB RAM even for one session.
Its planning table estimates that ten WEBJS sessions need roughly 3 CPU/2.5 GB,
while NOWEB and GOWS use fewer resources. This blueprint stays on the already
tested `WEBJS` engine by default; changing engines requires a separate payload,
session-storage, and message-flow test first. See:
https://waha.devlike.pro/docs/overview/faq/ and
https://waha.devlike.pro/docs/how-to/engines/.
