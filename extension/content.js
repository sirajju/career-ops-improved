/**
 * Career Ops Job Clipper — Content Script
 *
 * Extracts job posting details from job aggregators (LinkedIn, Naukri, Indeed,
 * Glassdoor, Wellfound, Instahyre) and direct ATS platforms (Greenhouse, Ashby,
 * Lever, Workday) with Schema.org JSON-LD and OpenGraph fallbacks.
 */

(function careerOpsContentScript() {
  const MAX_DESCRIPTION_LENGTH = 35000;

  /* ── Text Extraction Helpers ───────────────────────────────── */

  function queryFirst(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent?.trim();
          if (text) return text;
        }
      } catch {
        // ignore invalid selector
      }
    }
    return '';
  }

  function cleanHtmlToText(html) {
    if (!html) return '';
    const temp = document.createElement('div');
    temp.innerHTML = html;
    // Replace breaks and paragraphs with newlines
    temp.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    temp.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6').forEach((block) => {
      block.prepend(document.createTextNode('\n'));
    });
    return temp.textContent
      ?.replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim() || '';
  }

  /* ── Clean & Canonicalize URLs ─────────────────────────────── */

  function cleanUrl(rawUrl) {
    try {
      const u = new URL(rawUrl || window.location.href);

      // LinkedIn job view normalization
      if (u.hostname.includes('linkedin.com')) {
        const currentJobId = u.searchParams.get('currentJobId');
        if (currentJobId) {
          return `https://www.linkedin.com/jobs/view/${currentJobId}/`;
        }
        const viewMatch = u.pathname.match(/\/jobs\/view\/(\d+)/);
        if (viewMatch) {
          return `https://www.linkedin.com/jobs/view/${viewMatch[1]}/`;
        }
      }

      // Indeed job view normalization
      if (u.hostname.includes('indeed.com') || u.hostname.includes('indeed.co')) {
        const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
        if (jk) {
          return `${u.origin}/viewjob?jk=${jk}`;
        }
      }

      // Strip typical tracking and referral query parameters
      const trackingParams = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'refId', 'trackingId', 'midSig', 'sid', 'sp_', 'trk', 'ref', 'source',
        'fbclid', 'gclid', 'f_TPR', 'position', 'pageNum', 'xp', 'src',
      ];
      for (const p of trackingParams) {
        u.searchParams.delete(p);
      }
      return u.toString();
    } catch {
      return rawUrl || window.location.href;
    }
  }

  /* ── Schema.org JSON-LD Extractor ─────────────────────────── */

  function extractJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent || '{}');
        const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const item of items) {
          if (item && (item['@type'] === 'JobPosting' || item['@type']?.includes?.('JobPosting'))) {
            let company = item.hiringOrganization?.name || '';
            let title = item.title || '';
            let description = cleanHtmlToText(item.description || '');
            let location = '';

            if (item.jobLocation) {
              const locs = Array.isArray(item.jobLocation) ? item.jobLocation : [item.jobLocation];
              const parts = [];
              for (const loc of locs) {
                const addr = loc.address;
                if (typeof addr === 'string') parts.push(addr);
                else if (addr && typeof addr === 'object') {
                  const segs = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
                  if (segs.length) parts.push(segs.join(', '));
                }
              }
              location = parts.join('; ');
            }

            if (!location && (item.jobLocationType === 'TELECOMMUTE' || item.applicantLocationRequirements)) {
              location = 'Remote';
            }

            let compensation = '';
            if (item.baseSalary) {
              const val = item.baseSalary.value;
              const cur = item.baseSalary.currency || '';
              if (typeof val === 'number') compensation = `${val} ${cur}`.trim();
              else if (val && typeof val === 'object') {
                const lo = val.minValue ?? val.value;
                const hi = val.maxValue;
                const unit = item.baseSalary.unitText ? `/${item.baseSalary.unitText.toLowerCase()}` : '';
                if (lo && hi && lo !== hi) compensation = `${lo} - ${hi} ${cur}${unit}`.trim();
                else if (lo) compensation = `${lo} ${cur}${unit}`.trim();
              }
            }

            return { title, company, location, compensation, description };
          }
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  /* ── Platform-Specific Extractors ─────────────────────────── */

  function extractLinkedIn() {
    const title = queryFirst([
      '.job-details-jobs-unified-top-card__job-title',
      'h1.t-24',
      '.jobs-unified-top-card__job-title',
      'h1',
    ]);

    const company = queryFirst([
      '.job-details-jobs-unified-top-card__company-name a',
      '.jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name',
      'a[data-tracking-control-name="public_jobs_topcard-org-name"]',
    ]);

    const location = queryFirst([
      '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
      '.jobs-unified-top-card__bullet',
      '.jobs-unified-top-card__workplace-type',
      '.job-details-jobs-unified-top-card__workplace-type',
    ]);

    const compensation = queryFirst([
      '.job-details-jobs-unified-top-card__job-insight:has(svg.ui-icon-money)',
      '.job-details-jobs-unified-top-card__job-insight:has(svg-icon[visual="money"])',
      '.job-details-preference-insight',
      '.salary',
    ]);

    const descEl = document.querySelector('#job-details') ||
                   document.querySelector('.jobs-description__content') ||
                   document.querySelector('.jobs-box__html-content');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation, description, source: 'linkedin' };
  }

  function extractNaukri() {
    const title = queryFirst([
      'h1.styles_jhc__header__k9Lsm',
      '.styles_jd-header-title__J7jY2',
      'h1.title',
      '.jd-header-title',
      'h1',
    ]);

    const company = queryFirst([
      '.styles_jd-header-comp-name__MvqAI a',
      '.styles_jhc__comp-name__swShA a',
      '.jd-header-comp-name a',
      '.styles_jd-header-comp-name__MvqAI',
      '.styles_jhc__comp-name__swShA',
    ]);

    const location = queryFirst([
      '.styles_jhc__loc___O2ho',
      '.location .locWdth',
      '.loc_tru',
      '[class*="location"]',
    ]);

    const compensation = queryFirst([
      '.styles_jhc__salary__jdfEC',
      '.salary .sal',
      '[class*="salary"]',
    ]);

    const descEl = document.querySelector('section.JDC') ||
                   document.querySelector('.styles_JDC__dang-inner-html__h0K4t') ||
                   document.querySelector('.job-desc');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation, description, source: 'naukri' };
  }

  function extractIndeed() {
    const title = queryFirst([
      'h1.jobsearch-JobInfoHeader-title',
      '[data-testid="jobsearch-JobInfoHeader-title"]',
      'h1',
    ]);

    const company = queryFirst([
      '[data-testid="inlineHeader-companyName"] a',
      '[data-testid="inlineHeader-companyName"]',
      '.jobsearch-CompanyInfoContainer a',
      '[data-company-name="true"]',
    ]);

    const location = queryFirst([
      '[data-testid="inlineHeader-companyLocation"]',
      '.jobsearch-JobInfoHeader-subtitle > div:last-child',
    ]);

    const compensation = queryFirst([
      '#salaryInfoAndJobType',
      '[data-testid="attribute_snippet_testid"]',
      '.jobsearch-JobMetadataHeader-itemWithIcon-salary',
    ]);

    const descEl = document.querySelector('#jobDescriptionText') ||
                   document.querySelector('.jobsearch-jobDescriptionText');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation, description, source: 'indeed' };
  }

  function extractGlassdoor() {
    const title = queryFirst([
      '[data-test="job-title"]',
      '.JobDetails_jobTitle__rw_gm',
      'h1',
    ]);

    const company = queryFirst([
      '[data-test="employer-name"]',
      '.EmployerProfile_employerNameContainer__aRmsK',
      '.employer-name',
    ]);

    const location = queryFirst([
      '[data-test="location"]',
      '[data-test="emp-location"]',
    ]);

    const compensation = queryFirst([
      '[data-test="detailSalary"]',
      '.SalaryEstimate_salaryRange__n9x_o',
    ]);

    const descEl = document.querySelector('.JobDetails_jobDescription__uW_fK') ||
                   document.querySelector('[data-test="jobDescription"]');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation, description, source: 'glassdoor' };
  }

  function extractWellfound() {
    const title = queryFirst([
      '[data-test="JobTitle"]',
      'h1.text-xl',
      'h1',
    ]);

    const company = queryFirst([
      '[data-test="StartupName"]',
      'a[href^="/company/"]',
      'h2.text-md',
    ]);

    const location = queryFirst([
      '[data-test="Location"]',
      '.location',
    ]);

    const compensation = queryFirst([
      '[data-test="Compensation"]',
      '.compensation',
    ]);

    const descEl = document.querySelector('[data-test="JobDescription"]') ||
                   document.querySelector('.job-description');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation, description, source: 'wellfound' };
  }

  function extractInstahyre() {
    const title = queryFirst([
      'h1.job-title',
      'h1',
    ]);

    const company = queryFirst([
      '.company-name',
      '.employer-details h2',
      'h2',
    ]);

    const location = queryFirst([
      '.job-locations',
      '.location',
    ]);

    const compensation = queryFirst([
      '.job-salary',
    ]);

    const descEl = document.querySelector('#job-description') ||
                   document.querySelector('.description');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation, description, source: 'instahyre' };
  }

  function extractAshby() {
    const title = queryFirst(['h1', '.ashby-job-posting-heading']);
    const company = document.title.split(' - ')[1]?.split(' | ')[0]?.trim() || '';
    const location = queryFirst(['[data-testid="job-location"]', '.ashby-job-posting-location']);
    const compensation = queryFirst(['[data-testid="job-compensation"]']);
    const descEl = document.querySelector('.ashby-job-posting-description') || document.querySelector('main');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation, description, source: 'ashby' };
  }

  function extractGreenhouse() {
    const title = queryFirst(['.app-title', 'h1.job-title', 'h1']);
    const company = queryFirst(['.company-name']) || document.title.split(' at ')[1]?.trim() || '';
    const location = queryFirst(['.location', '.body--metadata']);
    const descEl = document.querySelector('#content') || document.querySelector('#main');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation: '', description, source: 'greenhouse' };
  }

  function extractLever() {
    const title = queryFirst(['.posting-headline h2', 'h1']);
    const company = document.querySelector('.main-header-logo img')?.getAttribute('alt') ||
                    document.title.split(' - ')[1]?.trim() || '';
    const location = queryFirst(['.posting-category.location', '.sort-by-location']);
    const descEl = document.querySelector('.section-wrapper.page-full-width') || document.querySelector('.content');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';

    return { title, company, location, compensation: '', description, source: 'lever' };
  }

  function extractWorkday() {
    const title = queryFirst(['[data-automation-id="jobPostingHeader"]', 'h1']);
    const location = queryFirst(['[data-automation-id="locations"]']);
    const descEl = document.querySelector('[data-automation-id="jobPostingDescription"]');
    const description = descEl ? cleanHtmlToText(descEl.innerHTML) : '';
    // Extract company from subdomain
    const hostParts = window.location.hostname.split('.');
    const company = hostParts[0] !== 'www' ? hostParts[0] : hostParts[1] || '';

    return { title, company, location, compensation: '', description, source: 'workday' };
  }

  /* ── Master Extraction Strategy ────────────────────────────── */

  function extractJobPosting() {
    const host = window.location.hostname.toLowerCase();
    const url = cleanUrl(window.location.href);

    // 1. Run platform specific extractor
    let extracted = null;
    if (host.includes('linkedin.com')) extracted = extractLinkedIn();
    else if (host.includes('naukri.com')) extracted = extractNaukri();
    else if (host.includes('indeed.com') || host.includes('indeed.co')) extracted = extractIndeed();
    else if (host.includes('glassdoor.com') || host.includes('glassdoor.co')) extracted = extractGlassdoor();
    else if (host.includes('wellfound.com')) extracted = extractWellfound();
    else if (host.includes('instahyre.com')) extracted = extractInstahyre();
    else if (host.includes('ashbyhq.com')) extracted = extractAshby();
    else if (host.includes('greenhouse.io')) extracted = extractGreenhouse();
    else if (host.includes('lever.co')) extracted = extractLever();
    else if (host.includes('myworkdayjobs.com')) extracted = extractWorkday();

    // 2. Query Schema.org JSON-LD (often contains cleanest structured metadata)
    const jsonLd = extractJsonLd();

    // 3. Fallbacks for missing fields
    const title = extracted?.title ||
                  jsonLd?.title ||
                  document.querySelector('meta[property="og:title"]')?.content ||
                  document.querySelector('h1')?.textContent?.trim() ||
                  document.title.split(/[-|—]/)[0]?.trim() || '';

    const company = extracted?.company ||
                    jsonLd?.company ||
                    document.querySelector('meta[property="og:site_name"]')?.content ||
                    '';

    const location = extracted?.location ||
                     jsonLd?.location ||
                     '';

    const compensation = extracted?.compensation ||
                         jsonLd?.compensation ||
                         '';

    let description = extracted?.description ||
                      jsonLd?.description ||
                      cleanHtmlToText(document.querySelector('article, main, [role="main"]')?.innerHTML || '');

    if (description.length > MAX_DESCRIPTION_LENGTH) {
      description = description.slice(0, MAX_DESCRIPTION_LENGTH) + '\n\n[... truncated by Clipper ...]';
    }

    const platformSource = extracted?.source || (jsonLd ? 'schema-org' : 'web');

    return {
      url,
      title,
      company,
      location,
      compensation,
      description,
      source: platformSource,
    };
  }

  // Cache globally on window for direct script evaluation
  window.__careerOpsJobData = extractJobPosting();

  // Handle messages from popup
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CAREER_OPS_GET_JOB') {
      const data = extractJobPosting();
      sendResponse(data);
    }
    return true;
  });
})();
