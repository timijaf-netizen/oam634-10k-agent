// Vercel serverless function — receives extracted 10-K text, calls Claude, streams back the analysis.
// The API key is read from the ANTHROPIC_API_KEY environment variable (set in the Vercel dashboard).
// It is NEVER sent to the browser. Do not put your key in this file or in GitHub.

const SYSTEM_PROMPT = require("./instructions.js");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6"; // switch to "claude-opus-4-8" for max quality
const MAX_CHARS = 350000; // ~85k tokens of input; keeps cost/latency sane and fits Claude's context

// 10-Ks can be huge. If the text is very long, keep the front matter (Item 1 Business, Item 1A Risk
// Factors usually live here) plus the MD&A region (around the last "Item 7") so the model still sees
// the sections the instructions tell it to prioritize.
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }
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
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              "Here is the company's 10-K. Produce the full four-section strategic analysis exactly as specified in your instructions. Do not ask any questions first.\n\n<10-K>\n" +
              doc +
              "\n</10-K>",
          },
        ],
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errTxt = await upstream.text().catch(() => "");
      res.statusCode = 502;
      return res.end("Model API error (" + upstream.status + "): " + errTxt.slice(0, 600));
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
            res.write(evt.delta.text);
          }
        } catch (_) { /* ignore keep-alive / non-JSON lines */ }
      }
    }
    res.end();
  } catch (e) {
    try {
      if (!res.headersSent) res.statusCode = 500;
      res.end("\n[Server error: " + (e && e.message ? e.message : String(e)) + "]");
    } catch (_) {}
  }
};
