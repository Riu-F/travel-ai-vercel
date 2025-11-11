// api/generate.js
//
// Proxy for Wordware "released app" that:
// - Accepts { inputs, version? } from the client
// - Calls Wordware's streaming endpoint
// - Extracts the final JSON object from the stream
// - Returns { json, text } to the browser

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey =
    process.env.WORDWARE_API_KEY ||
    process.env.NEXT_PUBLIC_WORDWARE_API_KEY;

  if (!apiKey) {
    console.error('[generate] Missing WORDWARE_API_KEY');
    return res.status(500).json({ error: 'WORDWARE_API_KEY not configured' });
  }

  try {
    const body =
      typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const inputs = body.inputs;
    const version = body.version || '^1.0';

    if (!inputs || typeof inputs !== 'object') {
      console.error('[generate] Missing or invalid inputs:', body);
      return res.status(400).json({ error: 'Missing or invalid inputs' });
    }

    // Hard-coded released app ID for this WordApp
    const appId = '54801f70-9c87-438e-872a-be47eb1eb222';

    console.log('[generate] Calling Wordware app:', appId, 'version:', version);
    console.log('[generate] Inputs:', inputs);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000 * 300); // 5 min

    const upstream = await fetch(
      `https://app.wordware.ai/api/released-app/${appId}/run`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // streaming logs + JSON
          Accept: 'text/event-stream, application/json;q=0.9, */*;q=0.8'
        },
        body: JSON.stringify({ inputs, version }),
        signal: controller.signal
      }
    ).finally(() => clearTimeout(timeout));

    const raw = await safeReadText(upstream);
    console.log('[generate] Upstream status:', upstream.status);
    console.log('[generate] Upstream raw (first 1000 chars):', raw.slice(0, 1000));

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'Wordware API error',
        detail: raw
      });
    }

    // 1) Try to reconstruct "visible" text from streaming chunks
    const assembled = assembleFromStreamLines(raw);

    // 2) If that fails, fall back to raw or a plain JSON blob
    const visible =
      assembled ||
      extractVisibleFromJsonBlob(raw) ||
      raw ||
      '';

    console.log('[generate] Visible (first 1000 chars):', visible.slice(0, 1000));

    // 3) Grab the last balanced JSON object from the visible text
    const slice = findLastBalancedJson(visible);
    if (!slice) {
      return res.status(422).json({
        error: 'Unable to find JSON in Wordware output',
        preview: visible.slice(-800)
      });
    }

    const cleaned = cleanupJsonSlice(slice);
    const parsed = tryParseJson(cleaned);
    if (!parsed.ok) {
      return res.status(422).json({
        error: 'Unable to parse final JSON',
        detail: parsed.error,
        preview: cleaned.slice(0, 800)
      });
    }

    console.log('[generate] Parsed JSON keys:', Object.keys(parsed.value || {}));

    // Success
    return res.status(200).json({
      json: parsed.value,
      text: cleaned
    });
  } catch (err) {
    console.error('[generate] Server error:', err);
    const msg =
      err && err.name === 'AbortError'
        ? 'Upstream timeout'
        : err?.message || String(err);
    return res.status(500).json({ error: 'Server error', detail: msg });
  }
}

/* -------------------- helpers -------------------- */

async function safeReadText(resp) {
  try {
    return await resp.text();
  } catch {
    if (!resp.body) return '';
    const decoder = new TextDecoder('utf-8');
    let out = '';
    for await (const chunk of resp.body) {
      out += decoder.decode(chunk, { stream: true });
    }
    return out;
  }
}

// Assemble text from NDJSON/SSE lines where each line is JSON like:
// { "type":"chunk", "value": { "type":"chunk", "value":"..." } }
function assembleFromStreamLines(raw) {
  if (!raw) return '';
  let out = '';
  const lines = raw.split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (
        obj?.value?.type === 'chunk' &&
        typeof obj.value.value === 'string'
      ) {
        out += obj.value.value;
      } else if (typeof obj.output === 'string') {
        out += obj.output;
      } else if (typeof obj.text === 'string') {
        out += obj.text;
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return out;
}

// If the response was a single JSON object, try to pull a textual field from it
function extractVisibleFromJsonBlob(raw) {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.output === 'string') return obj.output;
      if (obj.hero || obj.meta || obj.sections) return JSON.stringify(obj);
    }
  } catch {
    // raw wasn't a single JSON object
  }
  return '';
}

// Clean common wrapper artefacts (backticks, fences, BOMs)
function cleanupJsonSlice(s) {
  return s
    .replace(/^\uFEFF/, '')        // strip BOM
    .replace(/^```(?:json)?/i, '') // leading fence
    .replace(/```$/i, '')          // trailing fence
    .trim();
}

// Try to parse JSON with a helpful error
function tryParseJson(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return {
      ok: false,
      error: String(e && e.message ? e.message : e)
    };
  }
}

// Scan for the last balanced {...} object within the string
function findLastBalancedJson(s) {
  let start = -1;
  let depth = 0;
  const segments = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          segments.push([start, i + 1]);
          start = -1;
        }
      }
    }
  }
  if (!segments.length) return null;
  const [a, b] = segments[segments.length - 1];
  return s.slice(a, b).trim();
}