# E4-T08 real Cloudflare deployment

This directory contains the two small Workers used by the real E4-T08 profile:

- `sandbox-runner/` is the official Cloudflare Sandbox SDK worker. It creates the
  provider container, materializes the pinned files, starts and cancels real
  processes, and forwards the allowlisted probe to the Gatekeeper worker.
- `gatekeeper/` is a dedicated Durable Object-backed origin. It records only the
  probe id, path, host, timestamp, and a fixed marker; it never receives a
  credential or request body.

The official Cloudflare OS Worker remains the authority for the workspace/Gadget,
Cap'n Web authentication, lifecycle fence, and durable resource state. Its
deployment must add a service binding named `E4_RUNNER` pointing at the deployed
Sandbox worker and must pass that binding through the dynamic Gadget loader:

```ts
if (this.env.E4_RUNNER) env.E4_RUNNER = this.env.E4_RUNNER;
```

The binding and loader change are intentionally kept outside this repository's
runtime package because the official OS source is an external Cloudflare project.
The checked-in source here is the deployment contract used by the live evidence.

## Deploy

Run these commands from this directory (with Wrangler authenticated to the
dedicated test account and Docker running). Keep the names unique to the test
account; the names below are the deployed 2026-08-24 profile.

```sh
cd sandbox-runner
npm install
DOCKER_HOST=unix:///Users/brettlamy/.docker/run/docker.sock npx wrangler deploy

cd ../gatekeeper
npx wrangler deploy
```

After deployment, add the Sandbox service binding to the official OS Wrangler
configuration, deploy the official OS Worker, and set the real-runner variables
required by `tools/verify/cold_clone.sh verify-E4-T08-real`:

```sh
CF_OS_PROTOCOL=official-cloudflare-os
CF_OS_BASE_URL=https://<official-os-worker>.workers.dev
CF_OS_TOKEN=<session-token-held-out-of-logs>
CF_OS_GATEKEEPER_SCHEME=https
CF_OS_GATEKEEPER_HOST=<gatekeeper-worker>.workers.dev
CF_OS_GATEKEEPER_PORT=443
CF_OS_GATEKEEPER_PURPOSE=e4-t08-gatekeeper
CF_OS_TEST_PROFILE=e4-t08-accepted-timeout-once
```

The verifier also requires bounded tenant/workspace/agent identities and two
credential-free public DNS names for the rebinding and public-listener negative
probes. It refuses localhost, IP literals, query-bearing URLs, non-HTTPS OS
origins, missing provider configuration, and the legacy fake `/v1` protocol.

No Cloudflare API token or session token belongs in this directory, a commit, or
the evidence files. The `E4_T08` service binding is the only path from an official
OS Gadget to the Sandbox worker.
