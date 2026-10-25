# WAHA on Cloudflare Containers

This directory prepares the existing `indexes-waha` Worker and Container for a
reviewed deployment. It does not deploy anything by itself.

## Current target

- Cloudflare account: `34dad04466d97745f2c9f8214c81c0f2`
- Existing Worker and Container application: `indexes-waha`
- Existing application ID: `a031b602-91b4-4a58-a888-ce838b7713e5`
- Public route: `https://indexes-waha.helalalfqih.workers.dev`
- Image: `devlikeapro/waha` pinned to digest
  `sha256:ecadb467ff9af107e7c235a955cab99ef5a1c13656cbc78aeb3e6b4d30fae7e4`
- Instance: `standard-1` (`0.5 vCPU`, `4 GiB`, `8 GB`), one instance maximum

The pinned manifest was checked directly in Docker Hub and is `linux/amd64`,
which is the architecture Cloudflare Containers requires.

The current live configuration runs the pinned upstream image; it does not
build the WAHA application source in this fork. This branch now contains a
candidate WAHA source fix for PostgreSQL and webhook transport validation, but
that code is not present in the running image. Applying the fix requires a
separately approved custom image built from an exact fork commit, review of its
SBOM, and an immutable image digest pinned here. Repeat the runtime acceptance
test before any rollout.

The checked-in `WAHA_CONFIG_REVISION` begins with `blocked-`. The gateway
rejects such a revision before resolving or starting the Container, so this
tree cannot accidentally present the pinned upstream image as transport-safe.
The scheduled lifecycle path also destroys an already-running Container when
it observes a blocked revision, before honoring any saved keepalive backoff and
without starting a replacement. That cleanup is not instantaneous: a deployment
alone does not prove the old instance has stopped, and the instance can continue
autonomous database, WhatsApp, or webhook traffic until the next scheduled path
runs. Treat a blocked-revision rollout as intentionally disruptive and require
a separately approved stop plus a read-only confirmation that no instance is
running before calling it quarantined.
After a reviewed secure image digest is pinned, assign a new non-blocked
revision in the same reviewed change. That revision bump is mandatory so a
running Container created from an older image cannot be reused by fingerprint.

The current endpoint returned Cloudflare `403 / 1010` to an unauthenticated
probe. That confirms an edge block, not WAHA readiness. No WhatsApp session,
PostgreSQL connection, message delivery, or restart recovery has been verified.

## Design

The Worker authenticates requests before resolving the Durable Object, so a
bad request cannot wake a Container. It uses one fixed Durable Object name and
`max_instances: 1` to avoid request-controlled instance creation.
The fixed name is `default`, matching the live Worker's existing
`env.WAHA.getByName("default")` calls; changing it would address a different
Durable Object.

Only these routes are reachable:

- `GET /healthz`: Worker liveness only; never starts the Container.
- Authenticated `GET /readyz`: starts or reconnects the Container and returns
  only `ready` or `not_ready`.
- Authenticated `/health` and `/api/**`, except the permanent deny list.
- `/api/{session}/auth/qr` additionally requires the separate
  `WAHA_QR_TOKEN` and `WAHA_QR_ENABLED=true`. The flag defaults to `false`, so
  the route remains a `404` outside an approved pairing deployment.

The permanent deny list includes the Dashboard, Swagger, WebSocket, MCP, jobs,
metrics, screenshots, server environment, server debug, and server stop routes.
Inbound edge credentials are removed before the Worker injects the separate
WAHA API key. Responses are `no-store` and do not expose cookies, CORS, or
server-identifying headers. Explicit, unrelated passwords are also supplied for
the disabled Dashboard and Swagger so upstream WAHA does not generate and print
credentials during startup. The edge, upstream, QR, Dashboard, and Swagger
credentials must all be different. `WAHA_API_KEY` must be the plaintext
high-entropy key used in the request header, not a `sha512:` value; the WAHA
entrypoint replaces it with a SHA-512 digest before Node starts.

The checked-in PostgreSQL URL must include `sslmode=verify-full`; plaintext,
duplicate modes, and the weaker `sslmode=require` fail closed. The candidate
source fix maps every enabled TLS mode to Node certificate and hostname
verification and serializes the GOWS database URL explicitly as `verify-full`.
The pinned upstream image does not contain that change: its parser sets
`rejectUnauthorized: false` for every enabled SSL mode. Do not deploy the
checked-in configuration against that image or treat the source patch as
runtime evidence. A custom image still needs wrong-CA and wrong-hostname
integration tests before Preview.

Webhook delivery is also fail-closed in the candidate source. It defaults to
public HTTPS destinations, validates literal and connection-time DNS addresses,
rejects private and reserved ranges, disables redirects and ambient proxies,
and keeps normal TLS certificate and hostname verification. A server-owned
exact private-origin exception exists only for controlled local testing. The
Cloudflare configuration sets `WAHA_WEBHOOK_ALLOWED_ORIGINS` to
`https://webhook.invalid`, a reserved placeholder that intentionally permits no
real receiver. Replace it only with the exact approved user-owned HTTPS origin
in an isolated Preview; it is not a secret and it must not be broadened to an
HTTP, wildcard, or private destination.

The Container uses GOWS and PostgreSQL session storage. GOWS writes live auth
state to PostgreSQL; WEBJS and WPP remote auth use periodic snapshots and can
lose recent state. Local disk is still ephemeral, so automatic media downloads
are disabled. Cloudflare Container snapshots are not used as session storage.

`WAHA_PUBLIC_BASE_URL` is a non-secret exact HTTPS origin and is passed to the
Container as `WAHA_BASE_URL`. This keeps on-demand media URLs on the protected
Worker route instead of exposing the internal `0.0.0.0` listener. Any isolated
Preview must use its own public route. This does not make media bytes durable:
event downloads remain disabled and session PostgreSQL storage is not media
storage.

### Engine scope

The live application did not expose a `WHATSAPP_DEFAULT_ENGINE` variable name,
so it currently falls back to WEBJS. This proposal deliberately changes it to
GOWS for direct PostgreSQL-backed auth state and substantially lower browser
overhead. That choice needs approval before deployment.

GOWS is not a drop-in implementation of every browser-backed WAHA feature. It
supports the main message, reaction, acknowledgement, edit, revoke, chats,
groups, contacts, and webhook flows, but the WAHA feature matrices show gaps.
For example, `message.waiting`, contact “about”, contact block/unblock, browser
screenshots, and some browser-specific message types are unavailable. The
gateway exposes authenticated `/api/**`; it does not emulate unsupported GOWS
operations. Confirm every endpoint and event required by the integration
against the WAHA engine tables before approving this engine change. If a
browser-only feature is mandatory, revisit WEBJS together with its higher
resource use and snapshot/recovery trade-off.

There is no documented single engine that combines complete chat and channel
coverage, every event, and this deployment's persistence requirement. NOWEB is
closer if chat archive/pin or channel history/delete is mandatory, but it
requires its store to be enabled and a full-sync decision before QR pairing;
some channel claims also differ between current docs and source. Keep GOWS only
for the bounded endpoint/event manifest in `ACCEPTANCE.md`, or choose and test a
different engine before linking the isolated test account. Do not present any
of these choices as full WAHA coverage.

The Worker labels a started Container with an opaque HMAC fingerprint of its
runtime revision and Container secrets. The fingerprint changes when the WAHA
key or database URL changes without placing either value in a label. On the
first readiness check after this proposal is deployed, the currently running
unlabelled Container is deliberately replaced so the GOWS, database, and
security environment takes effect. This causes an interruption and is one
reason deployment requires an approved rollout window. Increment
`WAHA_CONFIG_REVISION` for future non-secret runtime-setting changes.

The configured five-minute Worker schedule checks readiness and restarts the
Container after a platform stop once this Worker code is deployed. A
fifteen-minute Durable Object alarm is a fallback if scheduled events are
delayed, with bounded backoff on repeated failures. The Container inactivity
timeout is six hours. This reduces downtime but does not guarantee
uninterrupted WhatsApp delivery. Cloudflare can stop a Container for a host
restart or rollout, and missed webhook delivery is not guaranteed.

## Dashboard preview proposal (not deployed)

The upstream WAHA Dashboard is present in the pinned image, but the deployed
gateway deliberately blocks it. This branch adds an opt-in
`WAHA_DASHBOARD_PREVIEW_ENABLED` flag (default `false`), a separate
`WAHA_DASHBOARD_ACCESS_USERNAME` and
`WAHA_DASHBOARD_ACCESS_PASSWORD` browser Basic-auth challenge on
`/dashboard/**`, and distinct upstream Dashboard credentials. The preview
password must be staged as a secret, never placed in `vars` or the repository.

**Not yet verified:** WAHA Dashboard asset paths, browser navigation, cookies,
WebSockets and the complete login flow behind the gateway. The gateway still
strips cookies and denies unrelated root paths. Therefore this change is a
security-gated prototype, **not proof of a working complete Dashboard**.
Do not turn on the flag or deploy until an isolated preview validates the
actual WAHA routes/assets and Cloudflare Access protection. Browser Basic auth
is defense in depth, not a replacement for Cloudflare Access. Enabling the flag
changes the Container runtime fingerprint and may restart a running instance.
The production flag remains `false`.

## Local validation

Docker is required only for a full `wrangler dev` Container test.

```bash
cd deploy/cloudflare
npm ci
npm test
npm run test:lifecycle
npm run typecheck
npm run cf:types
npm run cf:dry-run
```

The `pretypecheck` hook generates the ignored `worker-configuration.d.ts` from
`wrangler.jsonc`; `npm run cf:types` then verifies that it is current.

`wrangler@4.152.0` currently reaches `undici@7.29.1` through Miniflare. The
package override resolves it to `7.30.1`, which is outside the affected 7.x
range for `GHSA-4qv8-2p9j-2685`. This is development tooling and is not bundled
into the deployed Worker. The root WAHA manifest and Yarn lock also raise their
direct `undici` floor and resolution to `7.30.1`; re-run the complete immutable
root install before treating that source graph as release evidence.

The current acceptance status and the approval gates for any isolated live test
are tracked in [ACCEPTANCE.md](./ACCEPTANCE.md).

Create `.dev.vars` from `.dev.vars.example` only for local testing. Empty or
short credentials fail closed. Never commit `.dev.vars` or paste secrets into
commands, logs, issues, or pull requests.

## Deployment gates

Do not run `wrangler deploy` until all of these have explicit approval:

1. Confirm Workers Paid in the Cloudflare dashboard. The available OAuth
   connection can read Workers and Containers but Billing Read returned `403`.
2. Approve a monthly usage budget. At 730 always-on hours, `standard-1` costs
   about `$27.48` for memory and disk plus about `$2.18` at 10% average CPU.
   This excludes the `$5` Workers plan and Worker, Durable Object, database,
   logging, egress, and tax charges. Budget alerts do not cap spend.
3. Approve a separate rotation of the current Worker and database credentials.
   An authorized Cloudflare application read included existing environment
   values in the connector response. No value was copied or used, and this is
   not evidence that an unauthorized party accessed them; rotation is a
   precaution because the values appeared in tool output.
4. Verify the PostgreSQL provider supports authenticated TLS, outbound
   Cloudflare access, enough connections, and `CREATE DATABASE`. Include
   `sslmode=verify-full`, provision the required trusted CA without weakening
   verification, and prove both wrong-CA and wrong-hostname failures. WAHA
   creates a main database and a database per session.
5. Resolve database and webhook TLS validation before any Preview or production
   rollout. The fork contains a source-level candidate, but the live upstream
   image does not. Use a future upstream image with equivalent protections, or
   obtain separate approval to build `linux/amd64` from the reviewed fork
   commit, generate and review an SBOM, pin the immutable digest, and run the
   positive and negative transport tests. The image must reject HTTP/private
   webhook destinations unless an exact server-owned test exception was
   deliberately configured. Do not use the current encrypted-but-unverified
   behavior as the deployment default.
6. During the approved rollout window, stage distinct `ADMIN_TOKEN`, plaintext
   `WAHA_API_KEY`, `WAHA_QR_TOKEN`, `WAHA_DISABLED_DASHBOARD_PASSWORD`,
   `WAHA_DISABLED_SWAGGER_PASSWORD`, and
   `WHATSAPP_SESSIONS_POSTGRESQL_URL` values with interactive
   `wrangler versions secret put` prompts. Unlike `wrangler secret put`, the
   versions form does not immediately deploy the new Worker version. Keep
   `WAHA_QR_ENABLED=false` except in a separately reviewed pairing version.
7. Re-read the live Worker, Container application, image digest, routes, and
   secret names immediately before deployment. Do not create a second app.
8. Re-read the live Worker source and confirm it still uses the `default`
   Durable Object identity pinned by this proposal. Do not deploy if it changed.
9. Approve the rollout window and rollback plan. The first readiness check will
   replace the old unlabelled Container, and a Containers deployment is not
   transactional: Worker code becomes live before the image rollout finishes.

## Runtime acceptance test

Deployment is not proof of session durability. Before declaring success:

1. Confirm `/healthz` without credentials and `/readyz` with the edge token.
2. Link a test WhatsApp account through the guarded QR route.
3. Send and receive a test message and verify the intended webhook.
4. Request a controlled `SIGTERM`/restart during an approved window.
5. Verify that GOWS restores the same session from PostgreSQL without a new QR.
6. Send and receive again after restart, and record any delivery gap.
7. Confirm the Dashboard, Swagger, environment, debug, stop, screenshot, and QR
   routes remain unavailable outside their intended policy.

Until that test passes, do not claim uninterrupted reception or durable session
recovery.

## References

- [Cloudflare Containers API](https://developers.cloudflare.com/containers/api/)
- [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/)
- [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- [Container limits](https://developers.cloudflare.com/containers/platform/limits/)
- [WAHA storage](https://waha.devlike.pro/docs/how-to/storages/)
- [WAHA engines](https://waha.devlike.pro/docs/how-to/engines/)
- [GOWS engine](https://waha.devlike.pro/docs/engines/gows/)
- [WAHA receive-message feature matrix](https://waha.devlike.pro/docs/how-to/receive-messages/)
- [WAHA contacts feature matrix](https://waha.devlike.pro/docs/how-to/contacts/)
- [WAHA security](https://waha.devlike.pro/docs/how-to/security/)
- [Undici EventSource advisory](https://github.com/nodejs/undici/security/advisories/GHSA-4qv8-2p9j-2685)
- [Cloudflare Workers SDK dependency issue](https://github.com/cloudflare/workers-sdk/issues/15007)
