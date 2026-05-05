# ea-explorer-worker

Cloudflare Worker backing the EA Architecture Explorer at
sajivfrancis.com/lab/ea-explorer.

Proxies Anthropic API calls so the API key stays server-side, and rate-limits
per IP via Workers KV.

```bash
npm install
wrangler dev          # local
wrangler deploy       # production
```
