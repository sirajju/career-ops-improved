/**
 * Career Ops Job Clipper — Popup Controller
 */

function $(id) {
  return document.getElementById(id);
}

const state = {
  activeTab: null,
  jobData: null,
  bridgeConnected: false,
  activeBridgeUrl: 'http://127.0.0.1:3456',
};

/* ── UI Helpers ──────────────────────────────────────────────── */

function setAlert(message, type = '') {
  const el = $('alertBox');
  if (!message) {
    el.textContent = '';
    el.className = 'alert hidden';
    return;
  }
  el.textContent = message;
  el.className = `alert alert-${type}`;
}

function updateConnectionUi(connected, info = null) {
  state.bridgeConnected = connected;
  const statusEl = $('connectionStatus');
  const labelEl = $('connectionLabel');
  const bannerEl = $('offlineBanner');
  const addBtn = $('addPipelineBtn');

  if (connected) {
    statusEl.className = 'connection-status connected';
    const portMatch = (state.activeBridgeUrl || '').match(/:(\d+)/);
    const portStr = portMatch ? ` (${portMatch[1]})` : '';
    labelEl.textContent = `Connected${portStr}`;
    bannerEl.classList.add('hidden');
    addBtn.disabled = false;

    if (info?.counts) {
      $('pipelineCountText').textContent = `Pending: ${info.counts.pending} | Tracked: ${info.counts.applications}`;
    }
  } else {
    statusEl.className = 'connection-status offline';
    labelEl.textContent = 'Bridge Offline';
    bannerEl.classList.remove('hidden');
    $('pipelineCountText').textContent = 'Bridge Offline';
  }
}

function setPlatformBadge(source) {
  const badge = $('platformBadge');
  const map = {
    linkedin: 'LinkedIn',
    naukri: 'Naukri',
    indeed: 'Indeed',
    glassdoor: 'Glassdoor',
    wellfound: 'Wellfound',
    instahyre: 'Instahyre',
    ashby: 'Ashby ATS',
    greenhouse: 'Greenhouse',
    lever: 'Lever ATS',
    workday: 'Workday',
    'schema-org': 'Schema.org',
    web: 'Web Page',
  };
  badge.textContent = map[source] || source || 'Job Page';
}

function updateJdCount(text) {
  const chars = (text || '').length;
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  $('jdCharCount').textContent = chars > 0 ? `${words} words (${chars} chars)` : '0 chars';
}

function formatCurrentRow() {
  const url = ($('jobUrl').value || '').trim();
  const company = ($('companyName').value || '').trim();
  const title = ($('jobTitle').value || '').trim();
  const location = ($('jobLocation').value || '').trim();
  const comp = ($('jobCompensation').value || '').trim();

  if (!url && !company && !title) {
    return '- [ ] (fill details above)';
  }

  let row = `- [ ] ${url} | ${company} | ${title}`;
  if (comp) {
    row = `${row} | ${location} | ${comp}`;
  } else if (location) {
    row = `${row} | ${location}`;
  }
  return row;
}

function refreshRowPreview() {
  $('rowPreview').textContent = formatCurrentRow();
}

/* ── Connection Discovery ────────────────────────────────────── */

async function checkBridge() {
  $('connectionLabel').textContent = 'Connecting...';
  chrome.runtime.sendMessage({ type: 'CAREER_OPS_DISCOVER' }, (res) => {
    if (res && res.ok) {
      state.activeBridgeUrl = res.baseUrl;
      updateConnectionUi(true, res.info);
    } else {
      updateConnectionUi(false);
    }
  });
}

/* ── Extraction from Active Tab ──────────────────────────────── */

async function extractFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  state.activeTab = tab;

  // Try messaging existing content script
  chrome.tabs.sendMessage(tab.id, { type: 'CAREER_OPS_GET_JOB' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // Content script not yet injected: inject programmatically
      injectAndExtract(tab.id);
    } else {
      populateFields(response);
    }
  });
}

function injectAndExtract(tabId) {
  chrome.scripting.executeScript(
    {
      target: { tabId },
      files: ['content.js'],
    },
    () => {
      if (chrome.runtime.lastError) {
        setAlert('Cannot read this page (browser restricted page).', 'error');
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: 'CAREER_OPS_GET_JOB' }, (response) => {
        if (response) {
          populateFields(response);
        }
      });
    }
  );
}

function populateFields(data) {
  if (!data) return;
  state.jobData = data;

  $('jobTitle').value = data.title || '';
  $('companyName').value = data.company || '';
  $('jobLocation').value = data.location || '';
  $('jobCompensation').value = data.compensation || '';
  $('jobUrl').value = data.url || state.activeTab?.url || '';
  $('jobDescription').value = data.description || '';

  setPlatformBadge(data.source);
  updateJdCount(data.description);
  refreshRowPreview();
}

/* ── Actions ─────────────────────────────────────────────────── */

async function handleAddPipeline() {
  const addBtn = $('addPipelineBtn');
  const spinner = $('btnSpinner');
  const addText = $('btnAddText');

  const url = ($('jobUrl').value || '').trim();
  const company = ($('companyName').value || '').trim();
  const title = ($('jobTitle').value || '').trim();
  const location = ($('jobLocation').value || '').trim();
  const compensation = ($('jobCompensation').value || '').trim();
  const description = ($('jobDescription').value || '').trim();
  const saveJd = $('saveJdCheckbox').checked;

  if (!url || !company || !title) {
    setAlert('Job Title, Company, and URL are required to clip.', 'error');
    return;
  }

  addBtn.disabled = true;
  spinner.classList.remove('hidden');
  addText.textContent = 'Clipping...';
  setAlert('');

  const payload = {
    url,
    company,
    title,
    location,
    compensation,
    description,
    source: state.jobData?.source || 'extension',
    saveJd,
  };

  chrome.runtime.sendMessage(
    {
      type: 'CAREER_OPS_CLIP',
      payload,
      baseUrl: state.activeBridgeUrl,
    },
    (res) => {
      addBtn.disabled = false;
      spinner.classList.add('hidden');
      addText.textContent = '+ Add to Pipeline';

      if (!res || !res.ok) {
        const errorMsg = res?.data?.error || res?.error || 'Failed to connect to local Career Ops bridge.';
        setAlert(errorMsg, 'error');
        return;
      }

      const data = res.data;
      if (data.status === 'duplicate') {
        setAlert('Already tracked in pipeline.md or applications.md.', 'duplicate');
      } else if (data.status === 'added') {
        const archiveMsg = data.jdFile ? ` (JD saved to ${data.jdFile})` : '';
        setAlert(`✔ Added to pipeline!${archiveMsg}`, 'success');
        // Refresh counts
        checkBridge();
      }
    }
  );
}

function copyToClipboard(text, button, successLabel = 'Copied!') {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const originalText = button.innerHTML;
    button.innerHTML = `<span>✔ ${successLabel}</span>`;
    setTimeout(() => {
      button.innerHTML = originalText;
    }, 1500);
  });
}

/* ── Event Listeners ─────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  // Live field updates
  ['jobTitle', 'companyName', 'jobLocation', 'jobCompensation', 'jobUrl'].forEach((id) => {
    $(id).addEventListener('input', refreshRowPreview);
  });

  $('jobDescription').addEventListener('input', (e) => {
    updateJdCount(e.target.value);
  });

  // Action buttons
  $('addPipelineBtn').addEventListener('click', handleAddPipeline);

  $('copyRowBtn').addEventListener('click', (e) => {
    copyToClipboard(formatCurrentRow(), e.currentTarget, 'Row Copied!');
  });

  $('copyJdBtn').addEventListener('click', (e) => {
    const jd = ($('jobDescription').value || '').trim();
    if (!jd) {
      setAlert('No JD text extracted to copy.', 'error');
      return;
    }
    copyToClipboard(jd, e.currentTarget, 'JD Copied!');
  });

  $('copyCmdBtn').addEventListener('click', (e) => {
    copyToClipboard('npm run bridge', e.currentTarget, 'Copied!');
  });

  // Settings panel toggle
  $('settingsToggleBtn').addEventListener('click', () => {
    const panel = $('settingsPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      $('bridgeUrlInput').value = state.activeBridgeUrl;
    }
  });

  $('saveSettingsBtn').addEventListener('click', async () => {
    const customUrl = ($('bridgeUrlInput').value || '').trim().replace(/\/$/, '');
    if (customUrl) {
      await chrome.storage.local.set({ careerOpsBaseUrl: customUrl });
      state.activeBridgeUrl = customUrl;
      $('settingsPanel').classList.add('hidden');
      checkBridge();
    }
  });

  // Init
  await checkBridge();
  await extractFromTab();
});
