// api/generate.js

export default async function handler(req, res) {
    // Allow CORS so Webflow can call this endpoint
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();
  
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
  
    try {
      const { inputs } = req.body || {};
      if (!inputs) {
        return res.status(400).json({ error: "Missing inputs" });
      }
  
      // Make the POST request to Wordware
      const r = await fetch(
        `https://app.wordware.ai/api/released-app/${process.env.WORDWARE_PROMPT_ID}/run`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            inputs: inputs,
            version: "^2.1" // recommended by Wordware docs
          })
        }
      );
  
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return res.status(r.status).json({ error: "Wordware API error", detail: errText });
      }
  
      const data = await r.json();
  
      // The structure of Wordware's response might vary, so we'll try to extract text
      // If your Wordware prompt returns something like { output: "..." } adjust here
      const textOutput =
        data.output ||
        data.text ||
        JSON.stringify(data, null, 2); // fallback to raw JSON if we don't know the shape
  
      return res.status(200).json({ text: textOutput });
    } catch (err) {
      return res.status(500).json({ error: "Server error", detail: String(err) });
    }
  }  