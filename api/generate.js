// api/generate.js
//
// Simple proxy to Wordware "released app".
// - Expects { inputs, version? } in the request body
// - Forwards to Wordware
// - Returns { json, text, raw } to the client

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

    const inputs = body.inputs;
    const version = body.version || '^1.0';

    if (!inputs || typeof inputs !== 'object') {
      console.error('[generate] Missing or invalid inputs:', body);
      return res.status(400).json({ error: 'Missing or invalid inputs' });
    }

    // 🔒 HARD-CODE the correct released app ID
    const appId = '54801f70-9c87-438e-872a-be47eb1eb222';

    console.log('[generate] Calling Wordware app:', appId, 'version:', version);
    console.log('[generate] Inputs:', inputs);

    const upstream = await fetch(
      `https://app.wordware.ai/api/released-app/${appId}/run`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs, version })
      }
    );

    const contentType = upstream.headers.get('content-type') || '';
    const text = await upstream.text();

    console.log('[generate] Upstream status:', upstream.status);
    console.log('[generate] Upstream raw body:', text.slice(0, 1000));

    if (!upstream.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.error || parsed.message || parsed || text;
      } catch {
        // ignore parse error, keep raw text
      }
      return res
        .status(upstream.status)
        .json({ error: 'Wordware API error', detail });
    }

    if (contentType.includes('application/json')) {
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        console.error('[generate] JSON parse error:', e);
        return res.status(200).json({ json: null, text, raw: null });
      }

      // In your sample, raw already looks like:
      // { title, intro_paragraph, sections[], closing_line, hidden_note }
      let payload = raw;
      if (raw && typeof raw === 'object') {
        if (raw.output && typeof raw.output === 'object') {
          payload = raw.output;
        } else if (raw.json && typeof raw.json === 'object') {
          payload = raw.json;
        }
      }

      return res.status(200).json({
        json: payload,
        text: JSON.stringify(payload, null, 2),
        raw
      });
    }

    // Non-JSON: just pass text through
    return res.status(200).json({ json: null, text, raw: null });
  } catch (err) {
    console.error('[generate] Server error:', err);
    return res.status(500).json({
      error: 'Server error',
      detail: err?.message || String(err)
    });
  }
}