# Drug Interaction Checker

Insert a prescription or report (photo or PDF) → the app reads the drug names → screens them for interactions using FDA label text and RxNorm.

- **Report reading happens in the browser** (Tesseract.js OCR, pdf.js for PDFs). The file and its text are never uploaded. Only the drug names the user confirms are sent to `/api/check`.
- **`/api/check`** (Vercel serverless function) resolves names via RxNorm, pulls each drug's `drug_interactions` label text from OpenFDA, and looks for each drug (and its class, e.g. "NSAID") inside the other drugs' label text.
- Severity is **keyword-based** on the snippet around the match. It is a screening aid, not a clinical rating, and a missing warning never means a combination is safe.

## Deploy on Vercel

**Option A: GitHub (easiest, auto-redeploys on every push)**
1. Create a new GitHub repo and push this folder.
2. On vercel.com: **Add New → Project → Import** the repo.
3. Framework Preset: **Other**. Leave the build command empty. Click **Deploy**.

**Option B: CLI**
```bash
npm i -g vercel
vercel          # first deploy (preview)
vercel --prod   # production
```

**Optional but recommended:** add an environment variable `OPENFDA_API_KEY` (free key at https://open.fda.gov/apis/authentication/) in Project → Settings → Environment Variables. Without a key OpenFDA allows about 240 requests/min per IP, which shared serverless IPs can hit under heavy use.

## Run locally

```bash
npx vercel dev      # serves the site and the /api route at http://localhost:3000
npm test            # engine, extraction and API tests (no network needed)
```

## Project layout

```
public/
  index.html, styles.css   UI
  app.js                   upload, OCR/PDF reading, drug list, results, exports
  extract.js               finds drug names in OCR text (exact, brand, fuzzy)
  drugs.json               vocabulary, class aliases, brand→generic map (edit this!)
  vendor/pdfjs/            pdf.js (Apache-2.0), self-hosted so PDF reading works reliably
api/check.js               POST /api/check  { "drugs": ["warfarin","aspirin"] }
lib/engine.js              RxNorm + OpenFDA lookups, cross-matching, severity
test/                      node:test suites
vercel.json                serves public/, sets function timeout
```

## Customising

- **Add drugs / brands / classes:** edit `public/drugs.json`. `vocab` is what the reader recognises, `aliases` are the class words searched for inside label text, `brands` maps brand names to generics (a combination brand can map to an array).
- Class-level mentions are the main gap: if a label says "serotonergic drugs" and that word isn't in the drug's `aliases`, the pair is missed.

## Known limits

- OCR can misread; the UI makes the user confirm drug names before checking.
- Only drugs in `drugs.json` are recognised from a report; others can be typed in manually.
- NLM's structured interaction API was retired in 2024, so interactions come from label text only.
- The OCR engine (Tesseract.js) is loaded from the jsDelivr CDN and downloads English language data on first use, so the first scan needs an internet connection.
- Educational use only. Verify with a pharmacist or a clinical reference.
