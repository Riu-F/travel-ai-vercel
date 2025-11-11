// api/generate.js
//
// Simple proxy to Wordware "released app".
// - Expects { inputs, version? } in the request body
// - Forwards to Wordware
// - Returns { json, text } to the client

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
    process.env.NEXT_PUBLIC_WORDWARE_API_KEY; // just in case

  if (!apiKey) {
    return res.status(500).json({ error: 'WORDWARE_API_KEY not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const inputs = body.inputs;
    const version = body.version || '^1.0';

    if (!inputs || typeof inputs !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid inputs' });
    }

    // NOTE:
    // New app fields are:
    // name, destination, country_origin, trip_dates, length_of_stay,
    // age_range, occupation, travel_purpose, travel_experience,
    // interests, budget_level, group_type
    // (No more Persona_TravelHistory / Persona_* stuff.)

    // Prefer env var if you want; otherwise fall back to the hard-coded ID
    const appId =
      process.env.WORDWARE_APP_ID ||
      process.env.WORDWARE_PROMPT_ID || // if you reuse the same var
      '54801f70-9c87-438e-872a-be47eb1eb222';

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

    if (!upstream.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.error || parsed.message || text;
      } catch {
        // ignore parse errors
      }
      return res
        .status(upstream.status)
        .json({ error: 'Wordware API error', detail });
    }

    // Try to interpret response as JSON and pull out the useful payload.
    if (contentType.includes('application/json')) {
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        // If parsing fails for some reason, just pass raw text.
        return res.status(200).json({ json: null, text });
      }

      // Your sample output looks like the "payload" already:
      // { title, intro_paragraph, sections[], closing_line, hidden_note }
      // But just in case Wordware wraps it, try common patterns.
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
        text: JSON.stringify(payload, null, 2)
      });
    }

    // Non-JSON response: just pass text through
    return res.status(200).json({ json: null, text });
  } catch (err) {
    console.error('generate.js error:', err);
    return res.status(500).json({
      error: 'Server error',
      detail: err?.message || String(err)
    });
  }
}
