// Vercel serverless function: receives extracted 10-K text, calls Claude with a forced tool schema
// (structured output), and returns a guaranteed-valid JSON analysis object. Using the model's
// tool/structured-output mode removes JSON parsing failures entirely. Haiku is fast enough to run
// non-streaming inside the 60s function limit.
// The API key is read from ANTHROPIC_API_KEY (set in Vercel). It is never sent to the browser.

const SYSTEM_PROMPT = require("./instructions.js");

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001"; // fast + cheap; set CLAUDE_MODEL to "claude-sonnet-4-6" for top quality
const MAX_CHARS = 150000;

// JSON Schema for the structured output. The model fills this exactly, so the result is always valid JSON.
const S = { type: "string" };
const N = { type: "number" };
const obj = (props, required) => ({ type: "object", properties: props, required: required || Object.keys(props) });
const list = (items, min, max) => { const a = { type: "array", items }; if (min != null) a.minItems = min; if (max != null) a.maxItems = max; return a; };
const PE = obj({ point: S, evidence: S });

const SCHEMA = obj({
  company: S, fiscalYear: S, summary: S, valueProposition: S, pricePosition: S,
  strategyStatement: obj({
    objectives: list(PE, 1),
    where: obj({ customers: S, geography: S, products: S, notServing: S }),
    how: list(PE, 3),
  }),
  strategyMap: obj({
    resources: list(obj({ id: S, name: S, detail: S, evidence: S }), 3),
    activities: list(obj({ id: S, name: S, detail: S, kind: S, evidence: S }), 5),
    valuePropositions: list(obj({ id: S, name: S, detail: S, evidence: S }), 2),
    intermediateObjectives: list(obj({ id: S, name: S, kind: S, detail: S, evidence: S }), 2, 2),
    objective: obj({ name: S, detail: S }),
    links: list(obj({ from: S, to: S, why: S }), 6),
  }),
  valueStick: obj({
    wtpScore: N, priceScore: N, wtsScore: N,
    wtp: obj({ level: S, signal: S, evidence: S }),
    price: obj({ position: S }),
    wts: obj({ level: S, signal: S, evidence: S }),
    advantageType: S,
    sourcesResources: list(PE, 1),
    sourcesMarket: list(PE, 1),
    verdict: S, verdictEvidence: S,
  }),
  swot: obj({
    strengths: list(PE, 3),
    weaknesses: list(PE, 2),
    opportunities: list(PE, 2),
    threats: list(obj({ point: S, type: S, evidence: S }), 3),
  }),
  fiveForces: list(obj({ force: S, intensity: S, score: N, reason: S, evidence: S }), 5, 5),
  financials: obj({ metrics: list(obj({ name: S, value: S, prior: S, note: S, evidence: S }, ["name", "value", "note"]), 4) }),
  strategicImplications: S,
});

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
        temperature: 0,
        system: SYSTEM_PROMPT,
        tools: [{ name: "emit_analysis", description: "Return the structured OAM-634 strategic analysis of this 10-K.", input_schema: SCHEMA }],
        tool_choice: { type: "tool", name: "emit_analysis" },
        messages: [{ role: "user", content: "Analyze this company's 10-K using your instructions and return the analysis via the emit_analysis tool.\n\n<10-K>\n" + doc + "\n</10-K>" }],
      }),
    });

    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => "");
      res.statusCode = 502;
      return res.end("Model API error (" + upstream.status + "): " + errTxt.slice(0, 600));
    }

    const payload = await upstream.json();
    const block = (payload.content || []).find((c) => c.type === "tool_use");
    if (!block || !block.input) {
      res.statusCode = 502;
      return res.end("The model did not return a structured analysis. Please try again.");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(block.input));
  } catch (e) {
    try {
      if (!res.headersSent) res.statusCode = 500;
      res.end("Server error: " + (e && e.message ? e.message : String(e)));
    } catch (_) {}
  }
};
