#!/usr/bin/env node
/**
 * extension-bridge.mjs — Zero-dependency local bridge for Career Ops Browser Extension.
 *
 * Runs a local HTTP server that accepts clipped job postings from the Career Ops
 * browser extension (LinkedIn, Naukri, Indeed, Glassdoor, Wellfound, Instahyre, ATS)
 * and safely writes them into:
 *   - data/pipeline.md (under ## Pending, with file locking)
 *   - data/scan-history.tsv (for deduplication on future automated scans)
 *   - jds/{YYYY-MM-DD}_{company}_{role}.md (verbatim job description archive)
 *
 * Usage:
 *   node scripts/extension-bridge.mjs [--port 3456] [--host 127.0.0.1]
 *   npm run bridge
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { localToday } from '../lib/local-today.mjs';
import {
  appendToPipeline,
  appendToScanHistory,
  loadSeenUrls,
  isOfferSeen,
  formatPipelineOffer,
  PIPELINE_PATH,
  APPLICATIONS_PATH,
} from '../scan.mjs';
import { captureSlug } from '../jd-capture.mjs';
import { parseInbox } from '../web/src/lib/pipeline-table.mjs';
import { parseApplications } from '../web/src/lib/tracker-table.mjs';

const CAREER_OPS = getCareerOpsRoot();
const JDS_DIR = path.join(CAREER_OPS, 'jds');

// Ensure jds directory exists
if (!fs.existsSync(JDS_DIR)) {
  fs.mkdirSync(JDS_DIR, { recursive: true });
}

// Parse command line arguments
const args = process.argv.slice(2);
let port = Number(process.env.CAREER_OPS_BRIDGE_PORT) || 3456;
let host = process.env.CAREER_OPS_BRIDGE_HOST || '127.0.0.1';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--port' && i + 1 < args.length) {
    port = Number(args[++i]);
  } else if (arg.startsWith('--port=')) {
    port = Number(arg.slice(7));
  } else if (arg === '--host' && i + 1 < args.length) {
    host = args[++i];
  } else if (arg.startsWith('--host=')) {
    host = arg.slice(7);
  } else if (arg === '--help' || arg === '-h') {
    console.log('Usage: node scripts/extension-bridge.mjs [--port 3456] [--host 127.0.0.1]');
    process.exit(0);
  }
}

/**
 * Parse raw compensation string into { min, max, currency } for formatCompensation.
 */
export function parseSalary(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && (raw.min != null || raw.max != null)) return raw;
  if (typeof raw !== 'string') return null;
  const str = raw.trim();
  if (!str) return null;

  let currency = '';
  if (str.includes('$')) currency = 'USD';
  else if (str.includes('₹') || /lpa|inr/i.test(str)) currency = 'INR';
  else if (str.includes('€') || /eur/i.test(str)) currency = 'EUR';
  else if (str.includes('£') || /gbp/i.test(str)) currency = 'GBP';
  else if (/\bUSD\b/i.test(str)) currency = 'USD';
  else if (/\bCAD\b/i.test(str)) currency = 'CAD';

  // Check for LPA: e.g. 25-35 LPA or 30 LPA
  const lpaMatch = str.match(/(?:[$₹€£]\s*)?(\d+(?:\.\d+)?)\s*(?:-|to)\s*(?:[$₹€£]\s*)?(\d+(?:\.\d+)?)\s*lpa/i) ||
                   str.match(/(?:[$₹€£]\s*)?(\d+(?:\.\d+)?)\s*lpa/i);
  if (lpaMatch) {
    const min = parseFloat(lpaMatch[1]) * 100000;
    const max = lpaMatch[2] ? parseFloat(lpaMatch[2]) * 100000 : min;
    return { min, max, currency: 'INR' };
  }

  // Check for $120k - $150k or 120k
  const kMatch = str.match(/(?:[$₹€£]\s*)?(\d+(?:\.\d+)?)\s*k\s*(?:-|to)\s*(?:[$₹€£]\s*)?(\d+(?:\.\d+)?)\s*k/i);
  if (kMatch) {
    const min = parseFloat(kMatch[1]) * 1000;
    const max = parseFloat(kMatch[2]) * 1000;
    return { min, max, currency: currency || 'USD' };
  }

  // Check for direct numbers e.g. 100,000 - 150,000
  const numMatch = str.match(/(?:[$₹€£]\s*)?(\d[\d,]*)\s*(?:-|to)\s*(?:[$₹€£]\s*)?(\d[\d,]*)/);
  if (numMatch) {
    const min = parseInt(numMatch[1].replace(/,/g, ''), 10);
    const max = parseInt(numMatch[2].replace(/,/g, ''), 10);
    if (!isNaN(min) && !isNaN(max)) {
      return { min, max, currency: currency || '' };
    }
  }

  return null;
}

/**
 * Save job description markdown to jds/
 */
export function saveJdFile({ url, company, title, location, compensation, description, source, date }) {
  if (!description || typeof description !== 'string' || !description.trim()) {
    return null;
  }

  const companySlug = captureSlug(company) || 'company';
  const roleSlug = captureSlug(title) || 'role';
  const baseName = `${date}_${companySlug}_${roleSlug}`;
  let fileName = `${baseName}.md`;
  let targetPath = path.join(JDS_DIR, fileName);

  // If a file with the exact name already exists, append unique suffix
  let counter = 1;
  while (fs.existsSync(targetPath)) {
    counter++;
    fileName = `${baseName}-${counter}.md`;
    targetPath = path.join(JDS_DIR, fileName);
  }

  const content = `# ${title} — ${company}

- **URL:** ${url}
- **Company:** ${company}
- **Role:** ${title}
- **Location:** ${location || 'Not specified'}
- **Compensation:** ${compensation || 'Not specified'}
- **Source:** ${source || 'extension'}
- **Captured:** ${date}

---

## Job Description

${description.trim()}
`;

  fs.writeFileSync(targetPath, content, 'utf8');
  return path.relative(CAREER_OPS, targetPath);
}

/**
 * Handle incoming requests
 */
export function createBridgeServer() {
  return http.createServer(async (req, res) => {
    // Set permissive CORS headers for extension requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;

    // GET /health or /status
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/status')) {
      let pendingCount = 0;
      let appCount = 0;
      try {
        if (fs.existsSync(PIPELINE_PATH)) {
          const pmd = fs.readFileSync(PIPELINE_PATH, 'utf8');
          pendingCount = parseInbox(pmd).length;
        }
        if (fs.existsSync(APPLICATIONS_PATH)) {
          const amd = fs.readFileSync(APPLICATIONS_PATH, 'utf8');
          appCount = parseApplications(amd).length;
        }
      } catch {
        // Fallback gracefully
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'career-ops-bridge',
        version: '1.0.0',
        root: CAREER_OPS,
        counts: {
          pending: pendingCount,
          applications: appCount,
        },
      }));
      return;
    }

    // POST /clip
    if (req.method === 'POST' && pathname === '/clip') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const rawUrl = String(payload.url || '').trim();
          const rawCompany = String(payload.company || '').trim();
          const rawTitle = String(payload.title || '').trim();
          const rawLocation = String(payload.location || '').trim();
          const rawComp = String(payload.compensation || payload.salary || '').trim();
          const description = String(payload.description || '').trim();
          const source = String(payload.source || 'extension').trim();
          const saveJd = payload.saveJd !== false;

          if (!rawUrl || !rawCompany || !rawTitle) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: 'Missing required fields: url, company, and title are required.',
            }));
            return;
          }

          const parsedSalary = parseSalary(rawComp);
          const offer = {
            url: rawUrl,
            company: rawCompany,
            title: rawTitle,
            location: rawLocation,
            salary: parsedSalary,
            source,
          };

          const expectedRow = formatPipelineOffer(offer);

          // Check for duplicate in pipeline.md and applications.md
          const { seen, identityPromotableUrls } = loadSeenUrls({}, {
            pipelinePath: PIPELINE_PATH,
            applicationsPath: APPLICATIONS_PATH,
          });

          if (isOfferSeen(offer, seen, identityPromotableUrls)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              status: 'duplicate',
              message: 'Posting is already in your pipeline or applications tracker.',
              row: expectedRow,
            }));
            return;
          }

          // Append to pipeline.md with atomic locking
          await appendToPipeline([offer], { pipelinePath: PIPELINE_PATH });

          // Append to scan-history.tsv so future automated scans dedup it
          const today = localToday();
          await appendToScanHistory([offer], today, 'extension');

          // Save JD to jds/ if text is provided
          let jdFile = null;
          if (saveJd && description) {
            jdFile = saveJdFile({
              url: rawUrl,
              company: rawCompany,
              title: rawTitle,
              location: rawLocation,
              compensation: rawComp,
              description,
              source,
              date: today,
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            status: 'added',
            message: 'Successfully added to pipeline.',
            row: expectedRow,
            jdFile,
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: err.message || 'Internal server error while clipping posting.',
          }));
        }
      });
      return;
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' }));
  });
}

// Start server if run as main script
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const server = createBridgeServer();
  server.listen(port, host, () => {
    console.log(`\x1b[32m✔\x1b[0m Career Ops Extension Bridge listening on http://${host}:${port}`);
    console.log(`  Root: ${CAREER_OPS}`);
    console.log(`  Target: data/pipeline.md`);
    console.log(`  Archive: jds/`);
    console.log(`  Ready to clip jobs from Chrome/Edge/Brave extension.`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\x1b[31m✖\x1b[0m Port ${port} is already in use.`);
    } else {
      console.error(`\x1b[31m✖\x1b[0m Bridge error:`, err);
    }
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down Career Ops Extension Bridge...');
    server.close(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
