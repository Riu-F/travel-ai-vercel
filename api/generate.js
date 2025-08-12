// api/generate.js

export default async function handler(req, res) {
    // CORS so Webflow (or curl) can call this
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();
  
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
  
    try {
      const { inputs } = req.body || {};
      if (!inputs) return res.status(400).json({ error: "Missing inputs" });
  
      // Ensure required strings aren't empty (Wordware schema)
      if (!inputs.Persona_TravelHistory || !inputs.Persona_TravelHistory.trim()) {
        inputs.Persona_TravelHistory = "None";
      }
  
      // Ask for JSON; if the API still streams, we’ll fall back to parsing lines
      const r = await fetch(
        `https://app.wordware.ai/api/released-app/${process.env.WORDWARE_PROMPT_ID}/run`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({
            inputs,
            version: "^2.1"
          })
        }
      );
  
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return res.status(r.status).json({ error: "Wordware API error", detail: errText });
      }
  
      const ct = r.headers.get("content-type") || "";
  
      // Case A: proper JSON response
      if (ct.includes("application/json")) {
        const data = await r.json();
        const textOutput =
          data.output ||
          data.text ||
          data.value ||
          JSON.stringify(data, null, 2);
        return res.status(200).json({ text: textOutput });
      }
  
      // Case B: streamed/evented response (NDJSON lines)
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let output = "";
  
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Try to parse each line as JSON
          try {
            const obj = JSON.parse(trimmed);
            // Common Wordware stream shape: { value: { type: "chunk", value: "..." } }
            if (obj?.value?.type === "chunk" && typeof obj.value.value === "string") {
              output += obj.value.value;
            } else if (typeof obj.output === "string") {
              output += obj.output;
            } else if (typeof obj.text === "string") {
              output += obj.text;
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      }
  
      // Fallback: if nothing was accumulated, return whatever trailing buffer we have
      const finalText = output || buffer || "(no output)";
      return res.status(200).json({ text: finalText });
    } catch (err) {
      return res.status(500).json({ error: "Server error", detail: String(err) });
    }
  }
  