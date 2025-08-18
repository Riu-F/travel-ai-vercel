// api/generate.js
//
// Filters Wordware's multi-step output so ONLY the final JSON (between
// __FINAL_JSON_START__ and __FINAL_JSON_END__) is returned to the client.

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { inputs } = req.body || {};
    if (!inputs) return res.status(400).json({ error: 'Missing inputs' });

    // So Wordware schema validations don't fail
    if (!inputs.Persona_TravelHistory || !inputs.Persona_TravelHistory.trim()) {
      inputs.Persona_TravelHistory = 'None';
    }

    // --- Call Wordware (allow streaming or JSON) ---
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000 * 300); // 5 min
    const r = await fetch(
      `https://app.wordware.ai/api/released-app/${process.env.WORDWARE_PROMPT_ID}/run`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
          'Content-Type': 'application/json',
          // Prefer JSON, but many Wordware apps stream NDJSON lines:
          Accept: 'text/event-stream, application/json;q=0.9, */*;q=0.8'
        },
        body: JSON.stringify({ inputs, version: '^3.2' }),
        signal: controller.signal
      }
    ).finally(() => clearTimeout(timeout));

    if (!r.ok) {
      const errText = await safeReadText(r);
      return res.status(r.status).json({ error: 'Wordware API error', detail: errText });
    }

    // Read the entire response body as text
    const raw = await safeReadText(r);

    // Try to reconstruct the "visible" content from stream lines (if any)
    const assembled = assembleFromStreamLines(raw);

    // Prefer assembled stream text; otherwise fall back to raw JSON/text
    const visible = assembled || extractVisibleFromJsonBlob(raw) || raw || '';

    // Extract only the final JSON between markers
    const finalSlice = extractBetweenMarkers(visible, '__FINAL_JSON_START__', '__FINAL_JSON_END__');

    if (!finalSlice) {
      // As a fallback, try to find the last balanced JSON object in the visible text
      const guessed = findLastBalancedJson(visible);
      if (!guessed) {
        return res.status(422).json({
          error: 'FINAL markers not found',
          detail: 'Expected __FINAL_JSON_START__ ... __FINAL_JSON_END__ in the final step output.',
          preview: visible.slice(-800) // tail preview for debugging
        });
      }
      // Attempt to parse guessed JSON
      const parsed = tryParseJson(guessed);
      if (!parsed.ok) {
        return res.status(422).json({
          error: 'Unable to parse final JSON (fallback)',
          detail: parsed.error,
          preview: guessed.slice(0, 800)
        });
      }
      return res.status(200).json({ json: parsed.value, text: guessed });
    }

    // Clean and parse the marked JSON slice
    const cleaned = cleanupJsonSlice(finalSlice);
    const parsed = tryParseJson(cleaned);
    if (!parsed.ok) {
      return res.status(422).json({
        error: 'Unable to parse final JSON (marked)',
        detail: parsed.error,
        preview: cleaned.slice(0, 800)
      });
    }

    // Success: return both machine- and human-friendly forms
    return res.status(200).json({ json: parsed.value, text: cleaned });
  } catch (err) {
    const msg = String(err && err.name === 'AbortError' ? 'Upstream timeout' : err);
    return res.status(500).json({ error: 'Server error', detail: msg });
  }
}

/* -------------------- helpers -------------------- */

async function safeReadText(resp) {
  try {
    return await resp.text();
  } catch {
    // Undici edge-case: if .text() fails, try stream manual read
    if (!resp.body) return '';
    const decoder = new TextDecoder('utf-8');
    let out = '';
    for await (const chunk of resp.body) out += decoder.decode(chunk, { stream: true });
    return out;
  }
}

// Assemble text from NDJSON/SSE lines where each line is JSON with { value: { type:"chunk", value:"..." } }
function assembleFromStreamLines(raw) {
  if (!raw) return '';
  let out = '';
  const lines = raw.split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj?.value?.type === 'chunk' && typeof obj.value.value === 'string') {
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
      // Sometimes the object IS already the final JSON:
      if (obj.hero || obj.meta || obj.sections) return JSON.stringify(obj);
    }
  } catch {}
  return '';
}

// Extract text between markers (first match)
function extractBetweenMarkers(s, startTag, endTag) {
  const a = s.indexOf(startTag);
  if (a === -1) return null;
  const b = s.indexOf(endTag, a + startTag.length);
  if (b === -1) return null;
  return s.slice(a + startTag.length, b).trim();
}

// Clean common wrapper artefacts (backticks, stray code fences, BOMs)
function cleanupJsonSlice(s) {
  return s
    .replace(/^\uFEFF/, '')            // strip BOM
    .replace(/^```(?:json)?/i, '')     // leading fence
    .replace(/```$/i, '')              // trailing fence
    .trim();
}

// Try to parse JSON with a helpful error
function tryParseJson(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
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
