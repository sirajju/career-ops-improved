# Career Ops Job Clipper (Browser Extension)

A lightweight, zero-cloud browser extension built for [Career Ops](https://github.com/sirajju/career-ops) to clip job listings from any job board or corporate ATS directly into your local `data/pipeline.md` and archive JDs into `jds/`.

---

## Supported Portals & ATS Boards

- **LinkedIn** (`linkedin.com/jobs/*`, collections, and split-view cards)
- **Naukri** (`naukri.com/job-listings-*`, search results, and direct job views)
- **Indeed** (`indeed.com/viewjob*`, `indeed.co.in/*`)
- **Glassdoor** (`glassdoor.com/job-listing/*`, `glassdoor.co.in/*`)
- **Wellfound** (`wellfound.com/jobs/*`)
- **Instahyre** (`instahyre.com/job-*`)
- **Ashby** (`jobs.ashbyhq.com/*`)
- **Greenhouse** (`boards.greenhouse.io/*`, `job-boards.greenhouse.io/*`)
- **Lever** (`jobs.lever.co/*`)
- **Workday** (`*.myworkdayjobs.com/*`)
- **Universal Fallback:** Any webpage with Schema.org `JobPosting` JSON-LD metadata or standard OpenGraph tags.

---

## Quick Installation

### 1. Chrome / Chromium / Brave / Edge

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Toggle **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `extension/` folder inside your `career-ops` repository:
   ```
   /home/sirajju/Desktop/learn/career-ops/extension
   ```
5. Pin the **Career Ops** icon to your browser toolbar for quick access.

---

## How to Use

### 1. Start the Local Bridge (or Web Dashboard)

In your terminal inside `career-ops`:
```bash
# Option A: Lightweight zero-dependency bridge daemon (port 3456)
npm run bridge

# Option B: Career Ops Web dashboard (port 3000)
npm run ui
```

The extension auto-detects whichever server is active.

### 2. Clip Any Job

1. Browse to any job posting on LinkedIn, Naukri, Indeed, or an ATS board.
2. Click the **Career Ops** extension icon in your browser toolbar.
3. The extension extracts:
   - Job Title
   - Company Name
   - Location & Workplace Type (Remote / Hybrid / On-site)
   - Stated Compensation (if provided)
   - Clean canonical URL (stripped of tracking/referral IDs)
   - Full Job Description text
4. Click **[+ Add to Pipeline]**.

### 3. What Happens on Clip

- The posting is appended to `data/pipeline.md` under `## Pending` in canonical format:
  ```markdown
  - [ ] https://www.linkedin.com/jobs/view/123456789/ | Company | Title | Location
  ```
- The posting is recorded in `data/scan-history.tsv` so future automated scans never duplicate it.
- The full job description is archived to `jds/YYYY-MM-DD_company_role.md` with complete frontmatter metadata for downstream CV tailoring (`batch-tailor.mjs`) and evaluation (`batch-evaluate-gemini.mjs`).

### Offline Mode

If the bridge is not running, the popup UI still works:
- Edit any extracted field.
- Click **📋 Copy Row** to copy the formatted pipeline markdown row directly to your clipboard.
- Paste it straight into `data/pipeline.md`.
- Click **📄 Copy JD** to copy the clean text.

---

## File Structure

```
extension/
├── manifest.json       # Manifest V3 extension configuration
├── content.js          # Platform extractors & Schema.org JSON-LD parser
├── background.js       # Service worker connecting to local bridge
├── popup.html          # Extension popup user interface
├── popup.css           # Styling with Career Ops brand theme
├── popup.js            # Ingestion, validation, and clipboard controller
├── icons/              # Extension icons (16px, 32px, 48px, 128px)
└── README.md           # Documentation
```
