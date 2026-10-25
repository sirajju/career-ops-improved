/**
 * Career Ops Job Clipper — Background Service Worker
 *
 * Coordinates connectivity with local Career Ops instances (daemon on 3456
 * or Next.js web dashboard on 3000) and proxies clipping requests.
 */

const DEFAULT_TARGETS = [
  'http://127.0.0.1:3456',
  'http://localhost:3456',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
];

async function getSavedBaseUrl() {
  const data = await chrome.storage.local.get(['careerOpsBaseUrl']);
  return data.careerOpsBaseUrl || null;
}

/**
 * Probe a candidate base URL
 */
async function probeBaseUrl(baseUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);

    // Try /health or /api/clip
    const probePath = baseUrl.includes(':3000') ? '/api/clip' : '/health';
    const res = await fetch(`${baseUrl}${probePath}`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const json = await res.json();
      return { ok: true, baseUrl, info: json };
    }
  } catch {
    // offline or unreachable
  }
  return { ok: false, baseUrl };
}

/**
 * Discover the active Career Ops local endpoint
 */
async function discoverEndpoint() {
  const saved = await getSavedBaseUrl();
  const candidates = saved ? [saved, ...DEFAULT_TARGETS.filter((t) => t !== saved)] : DEFAULT_TARGETS;

  for (const candidate of candidates) {
    const probe = await probeBaseUrl(candidate);
    if (probe.ok) {
      await chrome.storage.local.set({ careerOpsBaseUrl: candidate });
      return probe;
    }
  }

  return { ok: false, baseUrl: saved || DEFAULT_TARGETS[0] };
}

// Message Dispatcher
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === 'CAREER_OPS_DISCOVER') {
    discoverEndpoint()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (type === 'CAREER_OPS_CLIP') {
    (async () => {
      try {
        const payload = message.payload;
        let activeBase = message.baseUrl || (await getSavedBaseUrl());

        if (!activeBase) {
          const discovery = await discoverEndpoint();
          if (discovery.ok) {
            activeBase = discovery.baseUrl;
          } else {
            activeBase = 'http://127.0.0.1:3456';
          }
        }

        const endpoint = activeBase.includes(':3000') ? `${activeBase}/api/clip` : `${activeBase}/clip`;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        sendResponse({ ok: res.ok, status: res.status, data });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err.message || 'Failed to connect to Career Ops bridge. Ensure bridge or web server is running.',
        });
      }
    })();
    return true;
  }
});
