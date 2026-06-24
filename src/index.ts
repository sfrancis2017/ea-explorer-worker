// EA Explorer Worker
// Proxies Anthropic API calls for sajivfrancis.com/lab/ea-explorer.
// - Server-side API key (never reaches the browser)
// - CORS allowlist (sajivfrancis.com + www + local dev origins)
// - Rate limit per IP via Workers KV: N/day and M/minute
// - Server controls the system prompt and JSON schema; client just sends
//   { industryLabel, selections } — keeps the surface narrow.

interface Env {
  RATE_LIMIT_KV: KVNamespace;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  ALLOWED_ORIGINS: string;
  RATE_LIMIT_PER_DAY: string;
  RATE_LIMIT_PER_MINUTE: string;
  // Owner bearer (= TOOLS_TOKEN). When a request carries it, the per-IP rate
  // limit is skipped so the owner is never throttled on their own tools.
  // Set via: npx wrangler secret put TOOLS_TOKEN
  TOOLS_TOKEN?: string;
}

// Constant-time compare so a valid owner token bypasses the rate limit without
// leaking timing. Returns false unless TOOLS_TOKEN is configured and matches.
function isOwnerRequest(request: Request, env: Env): boolean {
  if (!env.TOOLS_TOKEN) return false;
  const m = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const a = new TextEncoder().encode(m[1]);
  const b = new TextEncoder().encode(env.TOOLS_TOKEN);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

interface GenerateRequest {
  industryLabel: string;
  selections: Record<string, { name: string; layerLabel: string }[]>;
  sic?: string[]; // representative SEC SIC codes for the industry (grounding)
  representativeFilers?: string[]; // representative public filers (grounding)
}

const SYSTEM_PROMPT = `You are a senior enterprise architect with deep expertise across all major industries and technology stacks. You provide concise, practical, and insightful enterprise architecture recommendations grounded in real integration patterns. You always respond with pure valid JSON only — no markdown, no code fences, no preamble, no trailing text. Just the JSON object.`;

function buildPrompt(body: GenerateRequest): string {
  const layerSummary = Object.entries(body.selections)
    .map(([_layerId, vendors]) => {
      const layerLabel = vendors[0]?.layerLabel ?? _layerId;
      const names = vendors.map((v) => v.name).filter(Boolean);
      return `  ${layerLabel}: ${names.length > 0 ? names.join(', ') : '(none selected — choose best fit for industry)'}`;
    })
    .join('\n');

  const sic = (body.sic ?? []).filter(Boolean);
  const filers = (body.representativeFilers ?? []).filter(Boolean);
  const grounding =
    (sic.length ? `Representative SEC SIC codes: ${sic.join(', ')}.\n` : '') +
    (filers.length
      ? `Representative public filers (SEC-classified in this industry): ${filers.join(', ')}.\n`
      : '');

  return `Industry: ${body.industryLabel}
${grounding ? '\n' + grounding : ''}
User's Selected Vendors by Architecture Layer:
${layerSummary}

Generate 3 enterprise reference architectures (1 primary + 2 alternates) for this ${body.industryLabel} organization.

Rules:
- GROUNDING: target a large public filer in this industry${filers.length ? ` (companies like ${filers.slice(0, 4).join(', ')})` : ''}${sic.length ? `, SIC ${sic.slice(0, 4).join('/')}` : ''}. Reflect that organisation's scale, regulatory/compliance drivers, and the integration patterns those specific systems use in production — not a generic stack.
- Primary: use user's selections as the base, recommend optimal integration patterns between them.
- Alternate 1: propose a cloud-native / SaaS-optimised variant (different middleware or data platform).
- Alternate 2: propose a cost-optimised or best-of-breed variant with different trade-offs.
- If a layer has no selection, pick the most appropriate vendor for the industry.
- Node IDs: short unique strings (e.g. "n1", "n2").
- Edges: 6-10 showing key data/integration flows. Use concise pattern labels: "API/REST", "OData", "Kafka stream", "ETL/ELT", "SFTP batch", "FHIR R4", "OPC-UA", "PI connector".
- Each edge includes a 1-sentence description of what data/control flows over that integration.
- The "layer" field on each node MUST be exactly one of these lowercase strings: "source", "ot", "erp", "middleware", "data", "bi", "ai". Do not invent variants like "Source" or "data_platform" — use the exact tokens.
- Every node referenced by an edge (in "from" or "to") MUST exist in the "nodes" array with a vendor name. Do not emit edges that reference undefined node ids.
- CONNECTIVITY: every node MUST be connected to the architecture by at least one edge (no isolated nodes/islands). Every layer that contains nodes MUST have at least one inbound or outbound edge connecting it to another layer. Specifically:
  * Reporting & BI ("bi") nodes MUST have at least one inbound edge from "data" or "erp".
  * AI ("ai") nodes MUST have at least one inbound edge from "data", "middleware", or "erp".
  * Data ("data") nodes MUST have at least one inbound edge from "erp", "middleware", "source", or "ot".
  * Middleware ("middleware") nodes MUST connect at least one of {source, ot, erp} to at least one of {data, ai}.
  Verify these constraints before emitting the JSON. The diagram should read as a coherent end-to-end flow from operational systems through to analytics and AI, not as disconnected lanes.
- Executive summary: 4-5 sentences in a business-leadership tone, no buzzword stuffing.
- Roadmap: 3 phases (Foundation, Integration, Activation), each with duration and 3-4 implementation items.

Return ONLY valid JSON with no markdown fences, no preamble, no trailing text:
{
  "architectures": [
    {
      "type": "primary",
      "name": "Short name (3-5 words)",
      "executiveSummary": "4-5 sentence summary.",
      "rationale": "2-3 sentence technical rationale.",
      "strengths": ["one", "two", "three"],
      "considerations": ["one", "two"],
      "roadmap": [
        { "phase": "Foundation", "duration": "Q1", "items": ["...", "...", "..."] },
        { "phase": "Integration", "duration": "Q2", "items": ["...", "...", "..."] },
        { "phase": "Activation", "duration": "Q3+", "items": ["...", "...", "..."] }
      ],
      "nodes": [
        { "id": "n1", "vendor": "Vendor Name", "layer": "source" }
      ],
      "edges": [
        { "from": "n1", "to": "n2", "label": "API/REST", "description": "1-sentence description." }
      ]
    },
    { "type": "alternate1", ... },
    { "type": "alternate2", ... }
  ]
}`;
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function checkAndIncrementRateLimit(
  ip: string,
  env: Env,
): Promise<{ ok: true } | { ok: false; reason: 'minute' | 'day'; retryAfter: number }> {
  const dayLimit = parseInt(env.RATE_LIMIT_PER_DAY, 10);
  const minLimit = parseInt(env.RATE_LIMIT_PER_MINUTE, 10);
  const dayKey = `rl:day:${ip}`;
  const minKey = `rl:min:${ip}`;

  const [dayVal, minVal] = await Promise.all([
    env.RATE_LIMIT_KV.get(dayKey),
    env.RATE_LIMIT_KV.get(minKey),
  ]);
  const dayCount = parseInt(dayVal ?? '0', 10);
  const minCount = parseInt(minVal ?? '0', 10);

  if (minCount >= minLimit) {
    return { ok: false, reason: 'minute', retryAfter: 60 };
  }
  if (dayCount >= dayLimit) {
    return { ok: false, reason: 'day', retryAfter: 86400 };
  }

  await Promise.all([
    env.RATE_LIMIT_KV.put(dayKey, String(dayCount + 1), { expirationTtl: 86400 }),
    env.RATE_LIMIT_KV.put(minKey, String(minCount + 1), { expirationTtl: 60 }),
  ]);

  return { ok: true };
}

function validateRequest(body: unknown): GenerateRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid request body' };
  const b = body as Record<string, unknown>;

  if (typeof b.industryLabel !== 'string' || b.industryLabel.length === 0 || b.industryLabel.length > 100) {
    return { error: 'industryLabel required (1-100 chars)' };
  }
  if (!b.selections || typeof b.selections !== 'object') {
    return { error: 'selections must be an object' };
  }

  // Cap total payload — prevent absurdly large prompts
  const json = JSON.stringify(b);
  if (json.length > 10_000) return { error: 'Request payload too large' };

  // Sanitize optional grounding fields (string arrays only; bounded; no newlines).
  const cleanStrings = (arr: unknown): string[] | undefined =>
    Array.isArray(arr)
      ? arr
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 15)
          .map((s) => s.replace(/[\r\n]+/g, ' ').slice(0, 60))
      : undefined;

  const result = b as unknown as GenerateRequest;
  result.sic = cleanStrings(b.sic);
  result.representativeFilers = cleanStrings(b.representativeFilers);
  return result;
}

async function callAnthropic(prompt: string, env: Env): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content?: { text?: string }[] };
  return data?.content?.[0]?.text ?? '';
}

function parseArchResponse(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

const MERMAID_SYSTEM = `You convert a diagram image into Mermaid.js source code. Study the shapes, connectors, arrows, swimlanes/groups, and every text label, and reproduce the structure as faithfully as possible. Choose the most appropriate Mermaid diagram type (flowchart, sequenceDiagram, erDiagram, classDiagram, stateDiagram-v2, etc.). Preserve label wording. Output ONLY raw, valid Mermaid code — no markdown fences, no commentary, no explanation.`;

async function imageToMermaid(imageB64: string, mediaType: string, env: Env): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: MERMAID_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
            { type: 'text', text: 'Convert this diagram into Mermaid. Output only the Mermaid code.' },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content?: { text?: string }[] };
  return (data?.content?.[0]?.text ?? '').replace(/```mermaid|```/g, '').trim();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, model: env.ANTHROPIC_MODEL }, 200, cors);
    }

    if (url.pathname === '/image-to-mermaid') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
      // Public + paid (Claude Vision). Rate-limit per IP exactly like /generate
      // so it can't be driven to amplify cost — but the OWNER (valid token)
      // bypasses the limit so they're never throttled on their own tools.
      if (!isOwnerRequest(request, env)) {
        const ipImg = request.headers.get('CF-Connecting-IP') ?? 'localhost';
        const limImg = await checkAndIncrementRateLimit(ipImg, env);
        if (!limImg.ok) {
          return jsonResponse(
            {
              error:
                limImg.reason === 'minute'
                  ? 'Rate limit: 1 request per minute per IP. Wait a moment and try again.'
                  : `Daily limit reached (${env.RATE_LIMIT_PER_DAY} per day per IP). Try again tomorrow.`,
              retryAfter: limImg.retryAfter,
            },
            429,
            cors,
          );
        }
      }
      let body: { image?: unknown; mediaType?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
      }
      const img = typeof body.image === 'string' ? body.image : '';
      const mt = typeof body.mediaType === 'string' ? body.mediaType : 'image/png';
      if (!img) return jsonResponse({ error: 'image (base64) required' }, 400, cors);
      if (img.length > 8_000_000) return jsonResponse({ error: 'Image too large (max ~6 MB)' }, 413, cors);
      if (!/^image\/(png|jpe?g|webp|gif)$/.test(mt)) return jsonResponse({ error: 'Unsupported image type' }, 400, cors);
      try {
        const mermaid = await imageToMermaid(img, mt, env);
        return jsonResponse({ mermaid }, 200, cors);
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : 'failed' }, 502, cors);
      }
    }

    if (url.pathname !== '/generate') {
      return jsonResponse({ error: 'Not found' }, 404, cors);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    }

    // Rate limit per IP (CF-Connecting-IP set by Cloudflare; localhost in dev).
    // The owner (valid token) bypasses it so they're never throttled.
    if (!isOwnerRequest(request, env)) {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'localhost';
      const limit = await checkAndIncrementRateLimit(ip, env);
      if (!limit.ok) {
        return jsonResponse(
          {
            error:
              limit.reason === 'minute'
                ? 'Rate limit: 1 generation per minute per IP. Wait a moment and try again.'
                : `Daily limit reached (${env.RATE_LIMIT_PER_DAY} per day per IP). Try again tomorrow.`,
            retryAfter: limit.retryAfter,
          },
          429,
          { ...cors, 'Retry-After': String(limit.retryAfter) },
        );
      }
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON in request body' }, 400, cors);
    }

    const validated = validateRequest(body);
    if ('error' in validated) {
      return jsonResponse({ error: validated.error }, 400, cors);
    }

    const prompt = buildPrompt(validated);

    try {
      const text = await callAnthropic(prompt, env);
      const parsed = parseArchResponse(text);
      return jsonResponse(parsed, 200, cors);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Generation failed:', message);
      return jsonResponse(
        { error: 'Generation failed. Try again in a moment.', detail: message },
        502,
        cors,
      );
    }
  },
};
