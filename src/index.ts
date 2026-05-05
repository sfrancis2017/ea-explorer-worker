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
}

interface GenerateRequest {
  industryLabel: string;
  selections: Record<string, { name: string; layerLabel: string }[]>;
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

  return `Industry: ${body.industryLabel}

User's Selected Vendors by Architecture Layer:
${layerSummary}

Generate 3 enterprise reference architectures (1 primary + 2 alternates) for this ${body.industryLabel} organization.

Rules:
- Primary: use user's selections as the base, recommend optimal integration patterns between them.
- Alternate 1: propose a cloud-native / SaaS-optimised variant (different middleware or data platform).
- Alternate 2: propose a cost-optimised or best-of-breed variant with different trade-offs.
- If a layer has no selection, pick the most appropriate vendor for the industry.
- Node IDs: short unique strings (e.g. "n1", "n2").
- Edges: 5-8 max showing key data/integration flows. Use concise pattern labels: "API/REST", "OData", "Kafka stream", "ETL/ELT", "SFTP batch", "FHIR R4", "OPC-UA", "PI connector".
- Each edge includes a 1-sentence description of what data/control flows over that integration.
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
    'Access-Control-Allow-Headers': 'Content-Type',
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

  return b as unknown as GenerateRequest;
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

    if (url.pathname !== '/generate') {
      return jsonResponse({ error: 'Not found' }, 404, cors);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    }

    // Rate limit per IP (CF-Connecting-IP set by Cloudflare; localhost in dev)
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
