// Vercel serverless function: receives extracted 10-K text, calls Claude, returns a structured
// JSON strategic analysis that the frontend renders as visuals.
// The API key is read from ANTHROPIC_API_KEY (set in the Vercel dashboard). It is never sent to
// the browser. Do not put your key in this file or in GitHub.

const SYSTEM_PROMPT = require("./instructions.js");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6"; // "claude-opus-4-8" for top quality, "claude-haiku-4-5-20251001" for cheapest/fastest
const MAX_CHARS = 240000; // ~60k tokens of input; keeps latency under the 60s function limit

// 10-Ks can be huge. If the text is very long, keep the front matter (Item 1 Business, Item 1A Risk
// Factors) plus the MD&A region (around the last "Item 7") so the model sees the prioritized sections.
function prepareDocument(raw) {
  const text = String(raw).replace(/\u0000/g, "").replace(/[ \t]{3,}/g, " ").trim();
  if (text.length <= MAX_CHARS) return text;
  const matches = [...text.matchAll(/item\s*7[\.\s:\-]/gi)];
  let mda = "";
  if (matches.length) {
    const start = matches[matches.length - 1].index;
    mda = text.slice(start, start + Math.floor(MAX_CHARS / 2));
  }
  const front = text.slice(0, MAX_CHARS - mda.length);
  return mda
    ? front + "\n\n[... document truncated for length; Item 7 / MD&A region follows ...]\n\n" + mda
    : text.slice(0, MAX_CHARS);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Pull the JSON object out of the model text defensively.
function extractJson(prefill, text) {
  let combined = (prefill + text).trim();
  const first = combined.indexOf("{");
  const last = combined.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) throw new Error("No JSON object found");
  return JSON.parse(combined.slice(first, last + 1));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.statusCode = 405; return res.end("Method not allowed"); }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.statusCode = 500;
    return res.end("Server is missing ANTHROPIC_API_KEY. Set it in the Vercel project's Environment Variables.");
  }

  try {
    const body = await readBody(req);
    let text = "";
    try { text = (JSON.parse(body || "{}").text) || ""; } catch (_) {}
    if (!text || text.trim().length < 200) {
      res.statusCode = 400;
      return res.end("Could not read enough text from the PDF. Make sure it is a text-based 10-K (not a scan).");
    }

    const doc = prepareDocument(text);
    const PREFILL = "{";

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: "Analyze this company's 10-K and return only the JSON object defined in your instructions.\n\n<10-K>\n" + doc + "\n</10-K>" },
          { role: "assistant", content: PREFILL },
        ],
      }),
    });

    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => "");
      res.statusCode = 502;
      return res.end("Model API error (" + upstream.status + "): " + errTxt.slice(0, 600));
    }

    const payload = await upstream.json();
    const modelText = (payload && payload.content && payload.content[0] && payload.content[0].text) || "";

    let data;
    try {
      data = extractJson(PREFILL, modelText);
    } catch (e) {
      res.statusCode = 502;
      return res.end("The model did not return valid JSON. Try again. (" + (e.message || e) + ")");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(data));
  } catch (e) {
    try {
      if (!res.headersSent) res.statusCode = 500;
      res.end("Server error: " + (e && e.message ? e.message : String(e)));
    } catch (_) {}
  }
};
