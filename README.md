# BiblioReads Monitor

A Cloudflare Worker that monitors BiblioReads instance status, caches results in KV, and does a health check on the main instance.

Built with [Hono](https://hono.dev/) and [Cloudflare Workers](https://developers.cloudflare.com/workers/) using Cloudflare’s generated runtime types (`wrangler types`).

---

### Features

- Fetches and caches instance list from a source URL
- Checks instance availability with concurrency + timeout controls
- KV caching with stale‑while‑revalidate (serves stale data, refreshes in background)

### API Routes

- `/instances` for a raw list of all instances
- `/all` for all instances with status
- `/up` for only healthy instances
- `/down` for failing instances
- `/random` for random healthy instance
- `/api-check` for runs API health checks and notifies via NTFY

---

## Local Development

```bash
npm install
```
Rename `.example.dev.vars` to `dev.vars` and edit with your env vars:

```bash
mv .example.dev.vars .dev.vars
```

Update the KV namespace configuration in `wrangler.jsonc`

Always run wrangler types after editing wrangler.jsonc or .dev.vars
```bash
npx wrangler types
```
