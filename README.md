# OAM-634 · 10-K Strategy Agent

A tiny web app: a grader opens the link, uploads a company's **10-K PDF**, and gets a structured
strategic analysis (Strategy Statement → Strategy Map → Value Stick → SWOT), with every claim cited
to the 10-K. No login or setup required for the person using it.

- **Frontend** (`index.html`): reads the PDF text in the browser (pdf.js), sends the text to the backend.
- **Backend** (`api/analyze.js`): a Vercel serverless function that calls the **Anthropic Claude API**
  with the course instructions baked in, and streams the analysis back.
- **Instructions** (`api/instructions.js` / `CUSTOM_INSTRUCTIONS.md`): the agent's system prompt.

Your API key lives **only** in a Vercel environment variable on the server — it is never exposed to
the browser or committed to GitHub.

---

## Deploy in ~15 minutes (no coding required)

### 1. Get an Anthropic API key
1. Go to **console.anthropic.com** → sign in → **API keys** → **Create key**. Copy it (starts with `sk-ant-`).
2. Add a little credit under **Billing** (new accounts usually include free starter credit). $5 is plenty
   for this assignment — see cost estimates below.

### 2. Put this code on GitHub
**Easiest (no Git):** create a free account at **github.com** → **New repository** → name it
`oam634-10k-agent` → on the repo page click **Add file → Upload files** → drag in **all** the files in
this folder (keep the `api/` folder structure) → **Commit**.

### 3. Deploy on Vercel
1. Go to **vercel.com** → sign up **with GitHub** (free "Hobby" plan).
2. **Add New… → Project** → **Import** your `oam634-10k-agent` repo.
3. Before clicking Deploy, open **Environment Variables** and add:
   - `ANTHROPIC_API_KEY` = your `sk-ant-...` key
   - *(optional)* `CLAUDE_MODEL` = `claude-sonnet-4-6`
4. Click **Deploy**. After ~1 minute you'll get a public URL like
   `https://oam634-10k-agent.vercel.app`.

### 4. Test it
Open the URL, upload a 10-K PDF (grab one from **sec.gov/edgar** or the company's investor-relations
page), and confirm you get the four-section analysis. **That URL is your shareable submission link.**

---

## Cost (you pay per use, via your Anthropic key)

Cost scales with the size of the uploaded 10-K (input is capped at ~85k tokens). Rough per-analysis cost:

| Model (`CLAUDE_MODEL`)        | ~Cost per 10-K | Notes |
|-------------------------------|----------------|-------|
| `claude-haiku-4-5-20251001`   | ~$0.05–0.11    | Cheapest; solid quality |
| `claude-sonnet-4-6` (default) | ~$0.15–0.33    | Best balance — recommended |
| `claude-opus-4-8`             | ~$0.80–1.60    | Overkill for this assignment |

A grader running it a few times costs well under $1. To change models, edit the `CLAUDE_MODEL`
environment variable in Vercel (Settings → Environment Variables) and redeploy — no code change needed.

---

## Troubleshooting
- **"Could not read enough text from the PDF"** — the PDF is a scanned image. Use a text-based 10-K
  (the SEC EDGAR version is always text-based).
- **Timeout on very large filings** — the free Vercel plan caps a request at 60s. The app already
  trims huge filings to the key sections; if you still hit it, switch `CLAUDE_MODEL` to Haiku (faster)
  or upgrade the Vercel plan.
- **"Server is missing ANTHROPIC_API_KEY"** — add the env var in Vercel and redeploy.

---

## Security
- Never commit your real key. `.env` is git-ignored; the key belongs in Vercel's env vars only.
- If a key is ever exposed, rotate it at console.anthropic.com.

*Built for OAM-634 Strategic Management, Emory Goizueta Business School.*
