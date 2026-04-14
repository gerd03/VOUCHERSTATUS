/* ============================================================
   VOUCHER STATUS — FRONTEND APPLICATION
   Real-time voucher status dashboard with circular timer,
   stat grid, and detail rows.
   ============================================================ */

const form = document.getElementById("voucher-form");
const codeInput = document.getElementById("code");
const searchButton = document.getElementById("search-btn");
const banner = document.getElementById("status-banner");
const resultBody = document.getElementById("result-body");
const speedTestPanel = document.getElementById("speedtest-panel");
const speedTestReloadButton = document.getElementById("speedtest-reload-btn");
const speedTestCloseButton = document.getElementById("speedtest-close-btn");
const heroSsid = document.getElementById("hero-ssid");
const themeToggle = document.getElementById("theme-toggle");
const themeToggleText = document.getElementById("theme-toggle-text");
const rootElement = document.documentElement || null;
const themeColorMeta = typeof document.querySelector === "function"
  ? document.querySelector('meta[name="theme-color"]')
  : null;

const PUBLIC_CONFIG_PATH = "/api/public-config";
const STREAM_PATH = "/api/voucher-status/stream";
const FALLBACK_REFRESH_MS = 1500;
const CLOCK_TICK_MS = 250;
const PAYLOAD_STALE_AFTER_MS = 10000;
const DEFAULT_SPEEDTEST_EMBED_URL = "https://fast.com/";
const MAX_REASONABLE_TIMESTAMP_MS = Date.UTC(2100, 0, 1);
const THEME_STORAGE_KEY = "voucher-ui-theme";
const THEME_QUERY = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const THEME_COLORS = {
  light: "#ffffff",
  dark: "#071120"
};

/* ── State ────────────────────────────────────────────────── */

let liveStream = null;
let fallbackTimer = null;
let clockTimer = null;
let currentCode = "";
let currentPayload = null;
let payloadReceivedAtMs = 0;
let connectionState = "idle";
let liveBindings = {};
let publicConfigPromise = null;
let speedTestLoaded = false;
let speedTestLoading = false;
let speedTestExpanded = false;
let speedTestEmbedUrl = "";
let controlState = createEmptyControlState();
let pauseTransitionUntilMs = 0;
const CLOCK_REMAINDER_MS_KEY = "__clockRemainderMs";

/* ── SVG Ring Constants ───────────────────────────────────── */

const RING_RADIUS = 76;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/* ── Initialize ───────────────────────────────────────────── */

initializeTheme();
initializeForm();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!code) {
    renderIdle();
    return;
  }
  startVoucherLookup(code).catch((error) => {
    renderError(error.message || "Failed to check voucher status.");
  });
});

form.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-speedtest-action]");
  if (!trigger) return;
  event.preventDefault();
  handleSpeedTestAction(trigger.getAttribute("data-speedtest-action"));
});

window.addEventListener("beforeunload", () => { stopLiveUpdates(); });

window.addEventListener("offline", () => {
  if (currentPayload) {
    connectionState = "reconnecting";
    renderVoucherDashboard();
  }
});

window.addEventListener("online", () => {
  if (currentCode && connectionState !== "live") {
    scheduleFallbackPolling(currentCode);
  }
});

speedTestPanel.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  handleSpeedTestAction(trigger.getAttribute("data-action"));
});

const initialCode = new URLSearchParams(window.location.search).get("code");
if (initialCode) {
  codeInput.value = initialCode;
  startVoucherLookup(initialCode).catch((error) => {
    renderError(error.message || "Failed to check voucher status.");
  });
} else {
  renderIdle();
}

/* ── Form Init ────────────────────────────────────────────── */

function initializeForm() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (code) codeInput.value = code;
}

function initializeTheme() {
  applyTheme(getPreferredTheme(), { persist: false });

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const nextTheme = getActiveTheme() === "dark" ? "light" : "dark";
      applyTheme(nextTheme, { persist: true });
    });
  }

  if (THEME_QUERY) {
    const syncWithSystem = (event) => {
      if (getSavedTheme()) return;
      applyTheme(event.matches ? "dark" : "light", { persist: false });
    };

    if (typeof THEME_QUERY.addEventListener === "function") {
      THEME_QUERY.addEventListener("change", syncWithSystem);
    } else if (typeof THEME_QUERY.addListener === "function") {
      THEME_QUERY.addListener(syncWithSystem);
    }
  }
}

function getPreferredTheme() {
  const savedTheme = getSavedTheme();
  if (savedTheme) return savedTheme;
  return THEME_QUERY?.matches ? "dark" : "light";
}

function getSavedTheme() {
  try {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "dark" || storedTheme === "light" ? storedTheme : "";
  } catch (error) {
    return "";
  }
}

function applyTheme(theme, { persist = false } = {}) {
  const resolvedTheme = theme === "dark" ? "dark" : "light";
  if (rootElement) {
    rootElement.dataset.theme = resolvedTheme;
    rootElement.style.colorScheme = resolvedTheme;
  }
  updateThemeToggleUi(resolvedTheme);
  updateThemeColorMeta(resolvedTheme);

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);
    } catch (error) {
      // Ignore storage failures and keep the theme for the current session.
    }
  }
}

function getActiveTheme() {
  if (!rootElement?.dataset) return "light";
  return rootElement.dataset.theme === "dark" ? "dark" : "light";
}

function updateThemeToggleUi(theme) {
  if (!themeToggle) return;
  const isDark = theme === "dark";
  themeToggle.setAttribute("aria-pressed", isDark ? "true" : "false");
  const nextLabel = isDark ? "Switch to light mode" : "Switch to dark mode";
  themeToggle.setAttribute("aria-label", nextLabel);
  themeToggle.setAttribute("title", nextLabel);
  if (themeToggleText) {
    themeToggleText.textContent = isDark ? "Light" : "Dark";
  }
}

function updateThemeColorMeta(theme) {
  if (!themeColorMeta) return;
  themeColorMeta.setAttribute("content", THEME_COLORS[theme] || THEME_COLORS.light);
}

/* ── Lookup Flow ──────────────────────────────────────────── */

async function startVoucherLookup(code) {
  stopLiveUpdates();
  hidePauseModal();
  resetCurrentVoucher();
  speedTestExpanded = false;
  currentCode = code;
  connectionState = "connecting";
  setLookupProgress(true);

  const params = new URLSearchParams(window.location.search);
  params.set("code", code);
  window.history.replaceState({}, "", `/?${params.toString()}`);
  try {
    await loadVoucherStatus(code, { background: false, openStream: true });
  } finally {
    setLookupProgress(false);
  }
}

async function loadVoucherStatus(code, { background = false, openStream = false } = {}) {
  if (!background) renderLoading();

  let response;
  try {
    response = await fetch(`/api/voucher-status?code=${encodeURIComponent(code)}`);
  } catch (networkError) {
    if (background) return; // Silently fail for background polls
    throw new Error("Cannot reach the server. Please check your connection.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch (parseError) {
    if (background) return;
    throw new Error("Server returned an invalid response.");
  }

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  acceptPayload(payload, code);

  if (openStream) openLiveStream(code);
}

function acceptPayload(payload, code) {
  if (!code || code !== currentCode) return;

  const receivedAtMs = Date.now();
  const stabilizedPayload = stabilizeIncomingPayload(payload);
  const clockRemainderMs = Math.max(0, Number(stabilizedPayload?.[CLOCK_REMAINDER_MS_KEY] || 0));
  if (Object.prototype.hasOwnProperty.call(stabilizedPayload, CLOCK_REMAINDER_MS_KEY)) {
    delete stabilizedPayload[CLOCK_REMAINDER_MS_KEY];
  }

  currentPayload = stabilizedPayload;
  payloadReceivedAtMs = Math.max(0, receivedAtMs - clockRemainderMs);

  if (shouldClearPauseTransition(stabilizedPayload)) {
    pauseTransitionUntilMs = 0;
  }

  syncControlStateAfterPayload(stabilizedPayload);

  if (connectionState === "idle") connectionState = "connecting";

  renderVoucherDashboard();
  startClock();
}

function stabilizeIncomingPayload(payload) {
  if (!payload?.voucher || !currentPayload?.voucher) {
    return payload;
  }

  const nowMs = Date.now();
  const previousDisplay = buildDisplayState(currentPayload, nowMs);
  const previousMode = detectVoucherMode(previousDisplay);
  const previousLifecycle = getVoucherLifecycle(previousDisplay, previousMode);
  const nextPayload = {
    ...payload,
    voucher: { ...(payload.voucher || {}) },
    usage: { ...(payload.usage || {}) }
  };
  const nextMode = detectVoucherMode(nextPayload);

  const previousCode = String(previousDisplay?.voucher?.code || "").trim().toUpperCase();
  const nextCode = String(nextPayload?.voucher?.code || "").trim().toUpperCase();

  if (!previousCode || !nextCode || previousCode !== nextCode) {
    return nextPayload;
  }

  if (!previousMode.hasTimeLimit || !nextMode.hasTimeLimit) {
    return nextPayload;
  }

  if (!["active", "offline", "paused", "signing-out"].includes(previousLifecycle)) {
    return nextPayload;
  }

  if (isVoucherActuallyConsumed(nextPayload, nextMode)) {
    return nextPayload;
  }

  const previousLeftSec = Math.max(0, Number(previousDisplay?.voucher?.timeLeftSec || 0));
  const previousUsedSec = Math.max(0, Number(previousDisplay?.voucher?.timeUsedSec || 0));
  const incomingLeftSec = Math.max(0, Number(nextPayload?.voucher?.timeLeftSec || 0));
  const incomingUsedSec = Math.max(0, Number(nextPayload?.voucher?.timeUsedSec || 0));
  const isAutoPauseTimeVoucher = isAutoPauseVoucher(nextPayload?.voucher, nextPayload?.group || {});

  if (isAutoPauseTimeVoucher) {
    // By Usage vouchers must be smooth while active, but Omada remains the source of truth.
    // If the client is offline, accept Omada corrections immediately so time is not inflated.
    if (!isUsageReportedActive(nextPayload?.usage || {})) {
      return nextPayload;
    }

    const shouldPreserveClockRemainder = incomingUsedSec <= previousUsedSec && incomingLeftSec >= previousLeftSec;

    if (incomingUsedSec < previousUsedSec) {
      nextPayload.voucher.timeUsedSec = previousUsedSec;
    }

    if (incomingLeftSec > previousLeftSec) {
      nextPayload.voucher.timeLeftSec = previousLeftSec;
    }

    if (shouldPreserveClockRemainder) {
      nextPayload[CLOCK_REMAINDER_MS_KEY] = Math.max(0, (nowMs - Number(payloadReceivedAtMs || nowMs)) % 1000);
    }

    return nextPayload;
  }

  if (previousLeftSec > 0 && incomingLeftSec > 0 && incomingLeftSec < previousLeftSec - 1) {
    nextPayload.voucher.timeLeftSec = previousLeftSec - 1;
  }

  if (incomingUsedSec < previousUsedSec) {
    nextPayload.voucher.timeUsedSec = previousUsedSec;
  } else if (incomingUsedSec > previousUsedSec + 1) {
    nextPayload.voucher.timeUsedSec = previousUsedSec + 1;
  }

  return nextPayload;
}

/* ── Render: Idle ─────────────────────────────────────────── */

function renderIdle() {
  hidePauseModal();
  resetCurrentVoucher();
  stopLiveUpdates();
  controlState = createEmptyControlState();
  updateHeroNetworkLabel(null);
  setBannerText("Enter your voucher code to check your status.");
  resultBody.innerHTML = buildIdleStateMarkup();
  hideSpeedTestPanel();
}

function buildIdleStateMarkup() {
  return `
    <div class="dashboard dashboard-idle">
      <div class="dashboard-main">
        <div class="dashboard-column dashboard-column-left">
          ${buildIdleSummaryBadgesMarkup()}
          ${buildIdleRingPreviewMarkup()}
          ${buildIdleStatGridMarkup()}
          <div class="detail-section connection-quality-section">
            ${buildIdleConnectionQualityMarkup()}
          </div>
        </div>
        <div class="dashboard-column dashboard-column-right">
          <div class="detail-list">
            ${buildIdlePlaceholderSection(["Total download", "Total upload"])}
            ${buildIdlePlaceholderSection(["Device", "Network", "IP Address"])}
            ${buildIdlePlaceholderSection(["Voucher type", "Start date", "End date", "Devices online"])}
          </div>
        </div>
      </div>
      ${buildIdleSpeedTestPreviewMarkup()}
    </div>
  `;
}

function buildIdleSummaryBadgesMarkup() {
  return `
    <div class="summary-badges summary-badges-2">
      <div class="summary-cell summary-cell-idle summary-cell-idle-intro">
        <span class="summary-cell-inline">
          <span class="summary-cell-inline-dot" aria-hidden="true"></span>
          Enter code
        </span>
      </div>
      <div class="summary-cell summary-cell-idle summary-cell-idle-preview">
        <span class="summary-cell-inline">Status preview</span>
      </div>
    </div>
  `;
}

function buildIdleStatGridMarkup() {
  return `
    <div class="stat-grid stat-grid-2">
      <div class="stat-cell">
        <p class="stat-cell-label">USED</p>
        <p class="stat-cell-value stat-cell-value-waiting">
          ${buildWaitingValueLine("placeholder-line-medium")}
        </p>
      </div>
      <div class="stat-cell">
        <p class="stat-cell-label">STATUS</p>
        <p class="stat-cell-value stat-cell-badge">
          <span class="status-badge status-waiting">Waiting</span>
        </p>
      </div>
    </div>
  `;
}

function buildLoadingStateMarkup() {
  return `
    <div class="dashboard dashboard-loading">
      <div class="dashboard-main">
        <div class="dashboard-column dashboard-column-left">
          ${buildLoadingSummaryBadgesMarkup()}
          ${buildLoadingRingPreviewMarkup()}
          ${buildLoadingStatGridMarkup()}
          <div class="detail-section connection-quality-section">
            ${buildLoadingConnectionQualityMarkup()}
          </div>
        </div>
        <div class="dashboard-column dashboard-column-right">
          <div class="detail-list">
            ${buildLoadingPlaceholderSection(["Total download", "Total upload"])}
            ${buildLoadingPlaceholderSection(["Device", "Network", "IP Address"])}
            ${buildLoadingPlaceholderSection(["Voucher type", "Start date", "End date", "Devices online"])}
          </div>
        </div>
      </div>
      ${buildLoadingSpeedTestPreviewMarkup()}
    </div>
  `;
}

function buildLoadingSummaryBadgesMarkup() {
  return `
    <div class="summary-badges summary-badges-2">
      <div class="summary-cell summary-cell-plan">
        <span class="summary-cell-text summary-cell-text-loading">
          ${buildWaitingValueLine("placeholder-line-medium", "Loading")}
        </span>
      </div>
      <div class="summary-cell summary-cell-dark">
        <span class="summary-cell-text summary-cell-text-loading">
          ${buildWaitingValueLine("placeholder-line-long", "Loading")}
        </span>
      </div>
    </div>
  `;
}

function buildLoadingStatGridMarkup() {
  return `
    <div class="stat-grid stat-grid-2">
      <div class="stat-cell">
        <p class="stat-cell-label">USED</p>
        <p class="stat-cell-value stat-cell-value-waiting">
          ${buildWaitingValueLine("placeholder-line-medium", "Loading")}
        </p>
      </div>
      <div class="stat-cell">
        <p class="stat-cell-label">STATUS</p>
        <p class="stat-cell-value stat-cell-value-waiting">
          ${buildWaitingValueLine("placeholder-line-short", "Loading")}
        </p>
      </div>
    </div>
  `;
}

function buildIdleRingPreviewMarkup() {
  const idleFraction = 0.42;
  const dashOffset = RING_CIRCUMFERENCE * (1 - idleFraction);

  return `
    <div class="ring-section idle-ring-preview">
      <p class="ring-label">TIME REMAINING</p>
      <div class="ring-row">
        <div class="ring-speed ring-speed-left">
          <span class="ring-speed-arrow">↓</span>
          <span class="ring-speed-value ring-speed-value-waiting">--</span>
          <span class="ring-speed-label">Download</span>
        </div>
        <div class="ring-wrap">
          <svg class="ring-svg" viewBox="0 0 ${(RING_RADIUS + 8) * 2} ${(RING_RADIUS + 8) * 2}">
            <circle class="ring-track" cx="${RING_RADIUS + 8}" cy="${RING_RADIUS + 8}" r="${RING_RADIUS}"/>
            <circle class="ring-progress" cx="${RING_RADIUS + 8}" cy="${RING_RADIUS + 8}" r="${RING_RADIUS}"
              stroke-dasharray="${RING_CIRCUMFERENCE}"
              stroke-dashoffset="${dashOffset}"/>
          </svg>
          <div class="ring-center">
            <span class="ring-time ring-time-waiting" data-ring-scale="${escapeHtml(getRingTextScale("Waiting"))}">Waiting</span>
            <span class="ring-badge ring-badge-blue" data-ring-badge-scale="${escapeHtml(getRingBadgeScale("Waiting"))}">Waiting</span>
          </div>
        </div>
        <div class="ring-speed ring-speed-right">
          <span class="ring-speed-arrow">↑</span>
          <span class="ring-speed-value ring-speed-value-waiting">--</span>
          <span class="ring-speed-label">Upload</span>
        </div>
      </div>
    </div>
  `;
}

function buildLoadingRingPreviewMarkup() {
  const dashOffset = RING_CIRCUMFERENCE * (1 - 0.42);

  return `
    <div class="ring-section idle-ring-preview loading-ring-preview">
      <p class="ring-label">TIME REMAINING</p>
      <div class="ring-row">
        <div class="ring-speed ring-speed-left">
          <span class="ring-speed-arrow">↓</span>
          <span class="ring-speed-value ring-speed-value-waiting">
            ${buildWaitingValueLine("placeholder-line-short", "Loading")}
          </span>
          <span class="ring-speed-label">Download</span>
        </div>
        <div class="ring-wrap">
          <svg class="ring-svg" viewBox="0 0 ${(RING_RADIUS + 8) * 2} ${(RING_RADIUS + 8) * 2}">
            <circle class="ring-track" cx="${RING_RADIUS + 8}" cy="${RING_RADIUS + 8}" r="${RING_RADIUS}"/>
            <circle class="ring-progress" cx="${RING_RADIUS + 8}" cy="${RING_RADIUS + 8}" r="${RING_RADIUS}"
              stroke-dasharray="${RING_CIRCUMFERENCE}"
              stroke-dashoffset="${dashOffset}"/>
          </svg>
          <div class="ring-center">
            <span class="ring-time ring-time-skeleton" aria-hidden="true">
              <span class="placeholder-line placeholder-line-ring"></span>
            </span>
            <span class="ring-badge ring-badge-skeleton" aria-hidden="true">
              <span class="placeholder-line placeholder-line-badge"></span>
            </span>
            <span class="sr-only">Loading voucher timer</span>
          </div>
        </div>
        <div class="ring-speed ring-speed-right">
          <span class="ring-speed-arrow">↑</span>
          <span class="ring-speed-value ring-speed-value-waiting">
            ${buildWaitingValueLine("placeholder-line-short", "Loading")}
          </span>
          <span class="ring-speed-label">Upload</span>
        </div>
      </div>
    </div>
  `;
}

function buildIdleConnectionQualityMarkup() {
  return `
    <div class="connection-quality-card connection-quality-card-waiting">
      <div class="connection-quality-body">
        <div class="signal-band-zone">
          <span class="connection-pill signal-band-pill connection-pill-muted connection-pill-placeholder" aria-hidden="true"></span>
        </div>
        <div class="signal-visual idle-signal-visual" aria-hidden="true">
          <span class="signal-bar signal-bar-1"></span>
          <span class="signal-bar signal-bar-2"></span>
          <span class="signal-bar signal-bar-3"></span>
          <span class="signal-bar signal-bar-4"></span>
          <span class="signal-bar signal-bar-5"></span>
        </div>
        <div class="signal-copy signal-info-panel">
          <div class="signal-primary signal-primary-waiting">
            ${buildWaitingValueLine("placeholder-line-short")}
          </div>
          <p class="signal-secondary">Check a voucher code to see live signal.</p>
        </div>
      </div>
    </div>
  `;
}

function buildLoadingConnectionQualityMarkup() {
  return `
    <div class="connection-quality-card connection-quality-card-waiting loading-connection-card">
      <div class="connection-quality-body">
        <div class="signal-band-zone">
          <span class="connection-pill signal-band-pill connection-pill-muted connection-pill-placeholder" aria-hidden="true"></span>
        </div>
        <div class="signal-visual idle-signal-visual" aria-hidden="true">
          <span class="signal-bar signal-bar-1"></span>
          <span class="signal-bar signal-bar-2"></span>
          <span class="signal-bar signal-bar-3"></span>
          <span class="signal-bar signal-bar-4"></span>
          <span class="signal-bar signal-bar-5"></span>
        </div>
        <div class="signal-copy signal-info-panel">
          <div class="signal-primary signal-primary-waiting">
            ${buildWaitingValueLine("placeholder-line-short", "Loading")}
          </div>
          <p class="signal-secondary">Loading live signal data...</p>
        </div>
      </div>
    </div>
  `;
}

function buildIdlePlaceholderSection(labels = []) {
  const rowsHtml = labels.map((label) => `
    <div class="detail-row">
      <span class="detail-row-label${getDetailRowLabelClass(label)}">${escapeHtml(label)}</span>
      <span class="detail-row-value detail-row-value-waiting${getDetailRowValueClass({ field: "", value: "" })}">
        ${buildWaitingValueLine(getIdlePlaceholderSizeClass(label))}
      </span>
    </div>
  `).join("");

  return `<div class="detail-section">${rowsHtml}</div>`;
}

function buildLoadingPlaceholderSection(labels = []) {
  const rowsHtml = labels.map((label) => `
    <div class="detail-row">
      <span class="detail-row-label${getDetailRowLabelClass(label)}">${escapeHtml(label)}</span>
      <span class="detail-row-value detail-row-value-waiting${getDetailRowValueClass({ field: "", value: "" })}">
        ${buildWaitingValueLine(getIdlePlaceholderSizeClass(label), "Loading")}
      </span>
    </div>
  `).join("");

  return `<div class="detail-section">${rowsHtml}</div>`;
}

function buildIdleSpeedTestPreviewMarkup() {
  return `
    <section class="speedtest-panel idle-speedtest-preview" aria-hidden="true">
      <div class="speedtest-shell">
        <div class="speedtest-stage">
          <div class="speedtest-copy">
            <p class="meta-label">Speed Test</p>
            <p class="section-title">Check your internet speed</p>
          </div>
          <div class="speedtest-actions">
            <button type="button" class="speedtest-button" disabled>Start test</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function buildLoadingSpeedTestPreviewMarkup() {
  return `
    <section class="speedtest-panel loading-speedtest-preview" aria-hidden="true">
      <div class="speedtest-shell">
        <div class="speedtest-stage">
          <div class="speedtest-copy">
            <p class="meta-label">Speed Test</p>
            <p class="section-title">Check your internet speed</p>
          </div>
          <div class="speedtest-actions">
            <button type="button" class="speedtest-button" disabled>Start test</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function buildWaitingValueLine(sizeClass = "placeholder-line-medium", assistiveLabel = "Waiting") {
  return `<span class="placeholder-line ${escapeHtml(sizeClass)}" aria-hidden="true"></span><span class="sr-only">${escapeHtml(assistiveLabel)}</span>`;
}

function getIdlePlaceholderSizeClass(label = "") {
  const normalizedLabel = String(label || "").trim().toLowerCase();
  if (normalizedLabel === "devices online") return "placeholder-line-short";
  if (normalizedLabel === "start date" || normalizedLabel === "end date") return "placeholder-line-date";
  if (normalizedLabel === "ip address") return "placeholder-line-long";
  return "placeholder-line-medium";
}

/* ── Render: Loading ──────────────────────────────────────── */

function renderLoading() {
  hidePauseModal();
  updateHeroNetworkLabel(null);
  setBannerText("Checking your voucher...");
  resultBody.innerHTML = buildLoadingStateMarkup();
  hideSpeedTestPanel();
}

function setLookupProgress(active) {
  if (!form || !codeInput || !searchButton) return;
  form.classList.toggle("search-form-checking", active);
  form.setAttribute("aria-busy", active ? "true" : "false");
  codeInput.readOnly = active;
  codeInput.setAttribute("aria-busy", active ? "true" : "false");
  searchButton.disabled = active;
  searchButton.classList.toggle("search-button-busy", active);
  searchButton.setAttribute("aria-label", active ? "Checking voucher code" : "Check voucher code");
  searchButton.textContent = "Check";
}

/* ── Render: Error ────────────────────────────────────────── */

function renderError(message) {
  hidePauseModal();
  resetCurrentVoucher();
  stopLiveUpdates();
  controlState = createEmptyControlState();
  updateHeroNetworkLabel(null);
  setBannerText(message);
  resultBody.innerHTML = `
    <div class="error-state">
      <div class="error-icon">
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <circle cx="24" cy="24" r="20"/>
          <line x1="16" y1="16" x2="32" y2="32"/>
          <line x1="32" y1="16" x2="16" y2="32"/>
        </svg>
      </div>
      <p class="error-title">Voucher not found</p>
      <p class="error-message">${escapeHtml(message)}</p>
    </div>
  `;
  hideSpeedTestPanel();
}

/* ── Render: Dashboard ────────────────────────────────────── */

function renderVoucherDashboard() {
  if (!currentPayload) return;

  const display = buildDisplayState(currentPayload, Date.now());
  const mode = detectVoucherMode(display);
  updateHeroNetworkLabel(display);
  setBannerText(getStatusHeadline(display, mode));

  resultBody.innerHTML = buildDashboardMarkup(display, mode);
  cacheLiveBindings();
  patchLiveBindings(display);
  syncSpeedTestPanel();
}

/* ── Dashboard Markup ─────────────────────────────────────── */

function buildDashboardMarkup(display, mode) {
  // Summary badges
  const summaryBadgesHtml = buildSummaryBadges(display, mode);

  // Ring section
  const ringHtml = buildRingSection(display, mode);

  // Stat grid (3 columns)
  const statHtml = buildStatGrid(display, mode);

  // Detail sections
  const { signalSectionHtml, sideDetailListHtml } = buildDetailRowsV2(display, mode);

  // Control button
  const controlHtml = buildControlSection(display);

  return `
    <div class="dashboard">
      <div class="dashboard-main">
        <div class="dashboard-column dashboard-column-left">
          ${summaryBadgesHtml}
          ${ringHtml}
          ${statHtml}
          ${signalSectionHtml}
        </div>
        <div class="dashboard-column dashboard-column-right">
          ${sideDetailListHtml}
        </div>
      </div>
      ${controlHtml}
    </div>
  `;
}

/* ── Ring Section ─────────────────────────────────────────── */

function buildRingSection(display, mode) {
  const { voucher, group = {} } = display;
  const lifecycle = getVoucherLifecycle(display, mode);
  const hasTrafficOverlay = mode.hasTimeLimit && hasConfiguredTrafficLimit(voucher);

  let ringLabel = "TIME REMAINING";
  let mainValue = "";
  let badgeText = "";
  let badgeTone = "blue";
  let fraction = 0;

  if (mode.hasTimeLimit) {
    const totalSec = getVoucherDurationSeconds(group);
    const leftSec = Math.max(0, Number(voucher.timeLeftSec || 0));

    if (lifecycle === "ready") {
      mainValue = formatRingTime(totalSec);
      badgeText = hasTrafficOverlay ? getTrafficOverlayText(display) : buildRingBadgeText("ready", totalSec);
      badgeTone = getRingBadgeTone("ready");
      fraction = 1;
    } else if (lifecycle === "consumed" && isVoucherTimeConsumed(display, mode)) {
      mainValue = "0s";
      badgeText = hasTrafficOverlay ? getTrafficOverlayText(display) : buildRingBadgeText("consumed", totalSec);
      badgeTone = getRingBadgeTone("consumed");
      fraction = 0;
    } else {
      mainValue = formatRingTime(leftSec);
      badgeText = hasTrafficOverlay ? getTrafficOverlayText(display) : buildRingBadgeText(lifecycle, totalSec);
      badgeTone = getRingBadgeTone(lifecycle);
      fraction = totalSec > 0 ? leftSec / totalSec : 0;
    }
  } else if (mode.hasTrafficLimit) {
    ringLabel = "DATA REMAINING";
    const limitBytes = getTrafficLimitBytes(voucher);
    const unusedBytes = getDisplayTrafficRemainingBytes(display);

    mainValue = formatBytes(unusedBytes);
    badgeText = buildDataRingBadgeText(lifecycle, limitBytes);
    badgeTone = getRingBadgeTone(lifecycle);
    fraction = limitBytes > 0 ? unusedBytes / limitBytes : 0;
  } else {
    ringLabel = "STATUS";
    mainValue = getTopbarChipInfo(lifecycle).label;
    badgeText = buildStatusRingBadgeText(lifecycle);
    badgeTone = getRingBadgeTone(lifecycle);
    fraction = lifecycle === "active" ? 1 : 0;
  }

  fraction = Math.max(0, Math.min(1, fraction));
  const dashOffset = RING_CIRCUMFERENCE * (1 - fraction);
  const ringTextScale = getRingTextScale(mainValue);
  const ringBadgeScale = getRingBadgeScale(badgeText);
  const ringProgressTone = getRingProgressTone(fraction, lifecycle, mode);
  badgeTone = getRingBadgeToneForProgress(lifecycle, ringProgressTone);

  const { usage = {} } = display;
  const dlSpeed = Number(usage.displayLiveDownloadBytesPerSec || 0);
  const ulSpeed = Number(usage.displayLiveUploadBytesPerSec || 0);

  return `
    <div class="ring-section">
      <p class="ring-label">${escapeHtml(ringLabel)}</p>
      <div class="ring-row">
        <div class="ring-speed ring-speed-left">
          <span class="ring-speed-arrow">↓</span>
          <span class="ring-speed-value" data-live-field="ring-dl-speed">${escapeHtml(formatTransferRate(dlSpeed))}</span>
          <span class="ring-speed-label">Download</span>
        </div>
        <div class="ring-wrap">
          <svg class="ring-svg" viewBox="0 0 ${(RING_RADIUS + 8) * 2} ${(RING_RADIUS + 8) * 2}">
            <circle class="ring-track" cx="${RING_RADIUS + 8}" cy="${RING_RADIUS + 8}" r="${RING_RADIUS}"/>
            <circle class="ring-progress ring-progress-${escapeHtml(ringProgressTone)}" cx="${RING_RADIUS + 8}" cy="${RING_RADIUS + 8}" r="${RING_RADIUS}"
              stroke-dasharray="${RING_CIRCUMFERENCE}"
              stroke-dashoffset="${dashOffset}"
              data-live-field="ring-offset"/>
          </svg>
          <div class="ring-center">
            <span class="ring-time" data-live-field="ring-time" data-ring-scale="${escapeHtml(ringTextScale)}">${escapeHtml(mainValue)}</span>
            ${badgeText ? `<span class="ring-badge ring-badge-${escapeHtml(badgeTone)}" data-live-field="ring-badge" data-ring-badge-scale="${escapeHtml(ringBadgeScale)}">${escapeHtml(badgeText)}</span>` : ""}
          </div>
        </div>
        <div class="ring-speed ring-speed-right">
          <span class="ring-speed-arrow">↑</span>
          <span class="ring-speed-value" data-live-field="ring-ul-speed">${escapeHtml(formatTransferRate(ulSpeed))}</span>
          <span class="ring-speed-label">Upload</span>
        </div>
      </div>
    </div>
  `;
}

/* ── Plan Label ───────────────────────────────────────────── */

function buildPlanLabel(display, mode) {
  void mode;
  const { group = {} } = display;
  const parts = [];

  // Price
  const priceLabel = formatShortMoneyAmount(group.unitPrice, group.currency);
  if (priceLabel) parts.push(priceLabel);

  // Duration
  const durationLabel = formatVoucherDuration(group.duration);
  if (durationLabel) parts.push(durationLabel);

  if (!parts.length) return "";

  return parts.join(" - ");
}

function buildSummaryBadges(display, mode) {
  const cells = [];
  const planLabel = buildPlanLabel(display, mode);
  const timingBadge = getTimingModeBadgeInfo(display, mode);

  if (planLabel) {
    cells.push({
      className: "summary-cell summary-cell-plan",
      text: planLabel
    });
  }

  if (timingBadge) {
    cells.push({
      className: `summary-cell summary-cell-${timingBadge.tone}`,
      text: timingBadge.label
    });
  }

  if (!cells.length) return "";

  const cellsHtml = cells.map((cell) => `
    <div class="${escapeHtml(cell.className)}">
      <span class="summary-cell-text" data-summary-scale="${escapeHtml(getSummaryTextScale(cell.text))}">${escapeHtml(cell.text)}</span>
    </div>
  `).join("");

  return `<div class="summary-badges summary-badges-${cells.length}">${cellsHtml}</div>`;
}

/* ── Stat Grid ────────────────────────────────────────────── */

function buildStatGrid(display, mode) {
  const { voucher } = display;
  const lifecycle = getVoucherLifecycle(display, mode);
  const chipInfo = getTopbarChipInfo(lifecycle);

  let col1Label = "USED";
  let col1Value = "";

  if (mode.hasTimeLimit) {
    col1Value = formatDetailedDuration(voucher.timeUsedSec);
  } else if (mode.hasTrafficLimit) {
    col1Value = formatBytes(getDisplayDataUsed(display));
    col1Label = "DATA USED";
  } else {
    col1Value = formatDetailedDuration(voucher.timeUsedSec);
  }

  const col2Value = `<span class="status-badge ${escapeHtml(chipInfo.className)}">${escapeHtml(chipInfo.label)}</span>`;

  return `
    <div class="stat-grid stat-grid-2">
      <div class="stat-cell">
        <p class="stat-cell-label">${escapeHtml(col1Label)}</p>
        <p class="stat-cell-value" data-live-field="stat-used">${escapeHtml(col1Value)}</p>
      </div>
      <div class="stat-cell">
        <p class="stat-cell-label">STATUS</p>
        <p class="stat-cell-value stat-cell-badge" data-live-field="stat-devices">${col2Value}</p>
      </div>
    </div>
  `;
}

/* ── Detail Rows ──────────────────────────────────────────── */

function buildDetailRows(display, mode) {
  const { voucher, usage = {}, group = {} } = display;
  const rows = [];

  // Device
  if (usage.deviceName) {
    rows.push({ label: "Device", value: usage.deviceName, field: "detail-device" });
  }

  // Network / SSID
  if (usage.ssid) {
    rows.push({ label: "Network", value: usage.ssid, field: "detail-network" });
  }

  // Voucher type
  const voucherType = formatVoucherLimitType(group.limitType);
  const usageLimit = formatVoucherLimitDetail(group.limitType, group.limitNum);
  const typeDisplay = usageLimit ? `${voucherType} · ${usageLimit}` : voucherType;
  rows.push({ label: "Voucher type", value: typeDisplay });
  rows.push({ label: "Traffic Limit", value: formatTrafficLimit(voucher), field: "detail-traffic-limit" });
  rows.push({
    label: "Traffic Remaining",
    value: formatDisplayTrafficRemaining(display),
    field: "detail-traffic-remaining"
  });
  rows.push({
    label: "Download Limit",
    value: formatConfiguredSpeedLimit(voucher.downLimit),
    field: "detail-down-limit"
  });
  rows.push({
    label: "Upload Limit",
    value: formatConfiguredSpeedLimit(voucher.upLimit),
    field: "detail-up-limit"
  });

  // IP Address
  if (usage.ip) {
    rows.push({ label: "IP Address", value: usage.ip, field: "detail-ip" });
  }

  // Total Download
  const totalDown = Number(usage.totalDownloadBytes || 0);
  rows.push({ label: "Total Download", value: formatBytes(totalDown), field: "detail-download" });

  // Total Upload
  const totalUp = Number(usage.totalUploadBytes || 0);
  rows.push({ label: "Total Upload", value: formatBytes(totalUp), field: "detail-upload" });

  const rowsHtml = rows.map((r) => `
    <div class="detail-row">
      <span class="detail-row-label${getDetailRowLabelClass(r.label)}">${escapeHtml(r.label)}</span>
      <span class="detail-row-value" ${r.field ? `data-live-field="${escapeHtml(r.field)}"` : ""}>${escapeHtml(r.value)}</span>
    </div>
  `).join("");

  return `<div class="detail-list">${rowsHtml}</div>`;
}

/* ── Control Section ──────────────────────────────────────── */

function buildDetailRowsV2(display, mode) {
  const { voucher, usage = {}, group = {} } = display;
  const onlineCount = Number(usage.onlineClients || 0);
  const totalDown = Number(usage.totalDownloadBytes || 0);
  const totalUp = Number(usage.totalUploadBytes || 0);
  const voucherType = formatVoucherLimitType(group.limitType);
  const usageLimit = formatVoucherLimitDetail(group.limitType, group.limitNum);
  const typeDisplay = usageLimit ? `${voucherType} - ${usageLimit}` : voucherType;
  const startDateDisplay = formatVoucherDate(getVoucherStartDisplayMs(voucher, group));
  const endDateDisplay = formatVoucherDate(getVoucherEndDisplayMs(voucher, group));

  const liveRows = [
    { label: "Total download", value: formatBytes(totalDown), field: "detail-download" },
    { label: "Total upload", value: formatBytes(totalUp), field: "detail-upload" }
  ];

  const connectionRows = [
    usage.deviceName ? { label: "Device", value: usage.deviceName, field: "detail-device" } : null,
    usage.ssid ? { label: "Network", value: usage.ssid, field: "detail-network" } : null,
    usage.ip ? { label: "IP Address", value: usage.ip, field: "detail-ip" } : null
  ].filter(Boolean);

  const voucherRows = [
    { label: "Voucher type", value: typeDisplay },
    startDateDisplay
      ? { label: "Start date", value: startDateDisplay, field: "detail-start-date" }
      : null,
    endDateDisplay
      ? { label: "End date", value: endDateDisplay, field: "detail-end-date" }
      : null,
    hasConfiguredTrafficLimit(voucher)
      ? { label: "Traffic Remaining", value: formatDisplayTrafficRemaining(display), field: "detail-traffic-remaining" }
      : null,
    hasConfiguredTrafficLimit(voucher)
      ? { label: "Traffic Limit", value: formatTrafficLimit(voucher), field: "detail-traffic-limit" }
      : null,
    hasConfiguredSpeedLimit(voucher.downLimit)
      ? { label: "Download Speed Limit", value: formatConfiguredSpeedLimit(voucher.downLimit), field: "detail-down-limit" }
      : null,
    hasConfiguredSpeedLimit(voucher.upLimit)
      ? { label: "Upload Speed Limit", value: formatConfiguredSpeedLimit(voucher.upLimit), field: "detail-up-limit" }
      : null,
    {
      label: "Devices online",
      value: `${onlineCount} ${onlineCount === 1 ? "device" : "devices"}`,
      field: "detail-live-devices"
    }
  ];

  const signalSectionHtml = renderConnectionQualitySection(display);
  const detailListClass = connectionRows.length ? "detail-list" : "detail-list detail-list-compact";
  const sideSectionsHtml = [
    renderDetailSection(liveRows),
    renderDetailSection(connectionRows),
    renderDetailSection(voucherRows)
  ].filter(Boolean).join("");

  return {
    signalSectionHtml,
    sideDetailListHtml: `<div class="${detailListClass}">${sideSectionsHtml}</div>`
  };
}

function renderConnectionQualitySection(display) {
  return `
    <div class="detail-section connection-quality-section" data-live-field="detail-connection-visual">
      ${buildConnectionQualityMarkup(display)}
    </div>
  `;
}

function buildConnectionQualityMarkup(display) {
  const usage = display?.usage || {};
  const online = isDisplayOnline(display);
  const bandInfo = getWifiBandInfo(usage);
  const signalInfo = getSignalStrengthInfo(usage, { online });
  const barsHtml = buildSignalBarsMarkup(signalInfo);
  const bandLabel = bandInfo.label || "";
  const bandToneClass = `connection-pill-${bandInfo.tone}`;
  const signalBadgeHtml = signalInfo.badge && signalInfo.badge !== "Offline"
    ? `<span class="connection-pill signal-quality-pill connection-pill-${escapeHtml(signalInfo.tone)}">${escapeHtml(signalInfo.badge)}</span>`
    : "";

  return `
    <div class="connection-quality-card">
      <div class="connection-quality-body">
        <div class="signal-band-zone">
          ${bandLabel ? `<span class="connection-pill signal-band-pill ${bandToneClass}">${escapeHtml(bandLabel)}</span>` : ""}
        </div>
        <div class="signal-visual" aria-hidden="true">
          ${barsHtml}
        </div>
        <div class="signal-copy signal-info-panel">
          <div class="signal-primary${signalBadgeHtml ? " signal-primary-inline" : ""}">
            <span class="signal-primary-text">${escapeHtml(signalInfo.primary)}</span>
            ${signalBadgeHtml}
          </div>
          <p class="signal-secondary">${escapeHtml(signalInfo.secondary)}</p>
        </div>
      </div>
    </div>
  `;
}

function buildSignalBarsMarkup(signalInfo) {
  const activeBars = Math.max(0, Math.min(5, Number(signalInfo?.barCount || 0)));
  const tone = String(signalInfo?.tone || "muted");

  return Array.from({ length: 5 }, (_, index) => {
    const active = index < activeBars;
    const classes = ["signal-bar", `signal-bar-${index + 1}`];
    if (active) {
      classes.push("signal-bar-active", `signal-bar-tone-${tone}`);
    }
    return `<span class="${classes.join(" ")}"></span>`;
  }).join("");
}

function renderDetailSection(rows = []) {
  const visibleRows = rows.filter(Boolean);
  if (!visibleRows.length) return "";

  const rowsHtml = visibleRows.map((row) => `
    <div class="detail-row">
      <span class="detail-row-label${getDetailRowLabelClass(row.label)}">${escapeHtml(row.label)}</span>
      <span class="detail-row-value${getDetailRowValueClass(row)}" ${row.field ? `data-live-field="${escapeHtml(row.field)}"` : ""}>${escapeHtml(row.value)}</span>
    </div>
  `).join("");

  return `<div class="detail-section">${rowsHtml}</div>`;
}

function getDetailRowLabelClass(label) {
  return String(label || "").trim().length >= 18 ? " detail-row-label-compact" : "";
}

function getDetailRowValueClass(row = {}) {
  const field = String(row?.field || "").trim();
  const valueLength = String(row?.value || "").trim().length;
  if (field === "detail-start-date" || field === "detail-end-date") {
    return " detail-row-value-compact";
  }
  return valueLength >= 22 ? " detail-row-value-compact" : "";
}

function buildControlSection() {
  return "";
}

/* ── Live Bindings ────────────────────────────────────────── */

function cacheLiveBindings() {
  liveBindings = {};
  resultBody.querySelectorAll("[data-live-field]").forEach((el) => {
    const field = el.getAttribute("data-live-field");
    if (!field) return;
    if (!liveBindings[field]) liveBindings[field] = [];
    liveBindings[field].push(el);
  });
}

function patchLiveBindings(display) {
  const mode = detectVoucherMode(display);
  const { voucher, usage = {}, group = {} } = display;

  // Ring
  if (mode.hasTimeLimit) {
    const totalSec = getVoucherDurationSeconds(group);
    const leftSec = Math.max(0, Number(voucher.timeLeftSec || 0));
    const lifecycle = getVoucherLifecycle(display, mode);
    const ringBadgeText = hasConfiguredTrafficLimit(voucher) ? getTrafficOverlayText(display) : buildRingBadgeText(lifecycle, totalSec);

    if (lifecycle === "ready") {
      const ringText = formatRingTime(totalSec);
      const ringBadgeText = hasConfiguredTrafficLimit(voucher) ? getTrafficOverlayText(display) : buildRingBadgeText("ready", totalSec);
      setLiveText("ring-time", ringText);
      setLiveAttr("ring-time", "data-ring-scale", getRingTextScale(ringText));
      setLiveText("ring-badge", ringBadgeText);
      setLiveAttr("ring-badge", "data-ring-badge-scale", getRingBadgeScale(ringBadgeText));
      setLiveAttr("ring-badge", "class", `ring-badge ring-badge-${getRingBadgeToneForProgress("ready", getRingProgressTone(1, "ready", mode))}`);
      setLiveAttr("ring-offset", "stroke-dashoffset", String(0));
      setLiveAttr("ring-offset", "class", `ring-progress ring-progress-${getRingProgressTone(1, "ready", mode)}`);
    } else if (lifecycle === "consumed" && isVoucherTimeConsumed(display, mode)) {
      const ringBadgeText = hasConfiguredTrafficLimit(voucher) ? getTrafficOverlayText(display) : buildRingBadgeText("consumed", totalSec);
      setLiveText("ring-time", "0s");
      setLiveAttr("ring-time", "data-ring-scale", getRingTextScale("0s"));
      setLiveText("ring-badge", ringBadgeText);
      setLiveAttr("ring-badge", "data-ring-badge-scale", getRingBadgeScale(ringBadgeText));
      setLiveAttr("ring-badge", "class", `ring-badge ring-badge-${getRingBadgeToneForProgress("consumed", getRingProgressTone(0, "consumed", mode))}`);
      setLiveAttr("ring-offset", "stroke-dashoffset", String(RING_CIRCUMFERENCE));
      setLiveAttr("ring-offset", "class", `ring-progress ring-progress-${getRingProgressTone(0, "consumed", mode)}`);
    } else {
      const ringText = formatRingTime(leftSec);
      setLiveText("ring-time", ringText);
      setLiveAttr("ring-time", "data-ring-scale", getRingTextScale(ringText));
      setLiveText("ring-badge", ringBadgeText);
      setLiveAttr("ring-badge", "data-ring-badge-scale", getRingBadgeScale(ringBadgeText));
      const fraction = totalSec > 0 ? leftSec / totalSec : 0;
      setLiveAttr("ring-badge", "class", `ring-badge ring-badge-${getRingBadgeToneForProgress(lifecycle, getRingProgressTone(fraction, lifecycle, mode))}`);
      setLiveAttr("ring-offset", "stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - fraction)));
      setLiveAttr("ring-offset", "class", `ring-progress ring-progress-${getRingProgressTone(fraction, lifecycle, mode)}`);
    }
  } else if (mode.hasTrafficLimit) {
    const unusedBytes = getDisplayTrafficRemainingBytes(display);
    const limitBytes = getTrafficLimitBytes(voucher);
    const ringText = formatBytes(unusedBytes);
    const ringBadgeText = buildDataRingBadgeText(getVoucherLifecycle(display, mode), limitBytes);
    setLiveText("ring-time", ringText);
    setLiveAttr("ring-time", "data-ring-scale", getRingTextScale(ringText));
    setLiveText("ring-badge", ringBadgeText);
    setLiveAttr("ring-badge", "data-ring-badge-scale", getRingBadgeScale(ringBadgeText));
    const fraction = limitBytes > 0 ? unusedBytes / limitBytes : 0;
    setLiveAttr("ring-badge", "class", `ring-badge ring-badge-${getRingBadgeToneForProgress(getVoucherLifecycle(display, mode), getRingProgressTone(fraction, getVoucherLifecycle(display, mode), mode))}`);
    setLiveAttr("ring-offset", "stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - fraction)));
    setLiveAttr("ring-offset", "class", `ring-progress ring-progress-${getRingProgressTone(fraction, getVoucherLifecycle(display, mode), mode)}`);
  } else {
    const lifecycle = getVoucherLifecycle(display, mode);
    const ringText = getTopbarChipInfo(lifecycle).label;
    const ringBadgeText = buildStatusRingBadgeText(lifecycle);
    setLiveText("ring-time", ringText);
    setLiveAttr("ring-time", "data-ring-scale", getRingTextScale(ringText));
    setLiveText("ring-badge", ringBadgeText);
    setLiveAttr("ring-badge", "data-ring-badge-scale", getRingBadgeScale(ringBadgeText));
    setLiveAttr("ring-badge", "class", `ring-badge ring-badge-${getRingBadgeToneForProgress(lifecycle, getRingProgressTone(lifecycle === "active" ? 1 : 0, lifecycle, mode))}`);
    setLiveAttr("ring-offset", "class", `ring-progress ring-progress-${getRingProgressTone(lifecycle === "active" ? 1 : 0, lifecycle, mode)}`);
  }

  // Stats
  if (mode.hasTimeLimit) {
    setLiveText("stat-used", formatDetailedDuration(voucher.timeUsedSec));
  } else if (mode.hasTrafficLimit) {
    setLiveText("stat-used", formatBytes(getDisplayDataUsed(display)));
  }

  const onlineCount = Number(usage.onlineClients || 0);
  const chipInfo = getTopbarChipInfo(getVoucherLifecycle(display, mode));
  setLiveHtml(
    "stat-devices",
    `<span class="status-badge ${escapeHtml(chipInfo.className)}">${escapeHtml(chipInfo.label)}</span>`
  );

  // Speed beside ring
  const dlSpeed = Number(usage.displayLiveDownloadBytesPerSec || 0);
  const ulSpeed = Number(usage.displayLiveUploadBytesPerSec || 0);
  setLiveText("ring-dl-speed", formatTransferRate(dlSpeed));
  setLiveText("ring-ul-speed", formatTransferRate(ulSpeed));

  // Detail rows
  setLiveText("detail-live-devices", `${onlineCount} ${onlineCount === 1 ? "device" : "devices"}`);
  setLiveText("detail-live-dl-speed", formatTransferRate(dlSpeed));
  setLiveText("detail-live-ul-speed", formatTransferRate(ulSpeed));
  if (usage.deviceName) setLiveText("detail-device", usage.deviceName);
  if (usage.ssid) setLiveText("detail-network", usage.ssid);
  if (usage.ip) setLiveText("detail-ip", usage.ip);
  setLiveHtml("detail-connection-visual", buildConnectionQualityMarkup(display));
  setLiveText("detail-start-date", formatVoucherDate(getVoucherStartDisplayMs(voucher, group)));
  setLiveText("detail-end-date", formatVoucherDate(getVoucherEndDisplayMs(voucher, group)));
  setLiveText("detail-traffic-limit", formatTrafficLimit(voucher));
  setLiveText("detail-traffic-remaining", formatDisplayTrafficRemaining(display));
  setLiveText("detail-down-limit", formatConfiguredSpeedLimit(voucher.downLimit));
  setLiveText("detail-up-limit", formatConfiguredSpeedLimit(voucher.upLimit));
  setLiveText("detail-download", formatBytes(Number(usage.totalDownloadBytes || 0)));
  setLiveText("detail-upload", formatBytes(Number(usage.totalUploadBytes || 0)));
}

function setLiveText(field, value) {
  const elements = liveBindings[field] || [];
  elements.forEach((el) => {
    if (el.textContent !== value) el.textContent = value;
  });
}

function setLiveHtml(field, html) {
  const elements = liveBindings[field] || [];
  elements.forEach((el) => {
    el.innerHTML = html;
  });
}

function setLiveAttr(field, attr, value) {
  const elements = liveBindings[field] || [];
  elements.forEach((el) => {
    el.setAttribute(attr, value);
  });
}

/* ── Status Chip Mapping ──────────────────────────────────── */

function getTopbarChipInfo(lifecycle) {
  if (lifecycle === "consumed") {
    return { label: "Expired", className: "status-expired" };
  }

  if (lifecycle === "active") {
    return { label: "Active", className: "status-active" };
  }

  return { label: "Offline", className: "status-offline" };
}

/* ── Banner (screen reader) ───────────────────────────────── */

function setBannerText(text) {
  if (banner) banner.textContent = text || "";
}

function updateHeroNetworkLabel(payload) {
  if (!heroSsid) return;

  const ssid = String(payload?.usage?.ssid || "").trim();

  if (!ssid) {
    heroSsid.textContent = "";
    heroSsid.classList.add("hero-ssid-hidden");
    return;
  }

  heroSsid.textContent = ssid;
  heroSsid.classList.remove("hero-ssid-hidden");
}

function hidePauseModal() {
  document.body.classList.remove("modal-open");
}

/* ── Speed Test ───────────────────────────────────────────── */

function renderSpeedTestPanel() {
  if (!currentPayload) { hideSpeedTestPanel(); return; }

  syncSpeedTestViewState();
  speedTestPanel.classList.remove("speedtest-panel-hidden");
  speedTestPanel.innerHTML = `
    <div class="speedtest-shell${speedTestExpanded ? " speedtest-shell-expanded" : ""}">
      ${speedTestExpanded ? "" : `
        <div class="speedtest-stage">
          <div class="speedtest-copy">
            <p class="meta-label">Speed test</p>
            <h3 class="section-title">Check your internet speed</h3>
          </div>
          <div class="speedtest-actions">
            <button type="button" class="speedtest-button" data-action="load-speedtest" ${speedTestLoading ? "disabled" : ""}>
              ${escapeHtml(getSpeedTestButtonLabel())}
            </button>
          </div>
        </div>
      `}
      ${speedTestExpanded && speedTestLoaded ? `
        <div class="speedtest-frame-wrap">
          <iframe class="speedtest-frame" src="${escapeHtml(speedTestEmbedUrl || DEFAULT_SPEEDTEST_EMBED_URL)}" title="Internet speed test" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
        </div>
      ` : speedTestExpanded ? `
        <div class="speedtest-frame-wrap speedtest-frame-wrap-loading">
          <div class="speedtest-loading-state" aria-live="polite">
            <span class="speedtest-loading-pulse" aria-hidden="true"></span>
            <p class="speedtest-loading-title">Preparing Fast.com</p>
            <p class="speedtest-loading-copy">The speed test is opening inside this view.</p>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

function syncSpeedTestPanel() {
  if (speedTestExpanded && speedTestLoaded && speedTestPanel.querySelector(".speedtest-frame")) {
    syncSpeedTestViewState();
    speedTestPanel.classList.remove("speedtest-panel-hidden");
    return;
  }
  renderSpeedTestPanel();
}

function hideSpeedTestPanel() {
  speedTestExpanded = false;
  syncSpeedTestViewState();
  speedTestPanel.classList.add("speedtest-panel-hidden");
  speedTestPanel.innerHTML = "";
}

function getSpeedTestButtonLabel() {
  if (speedTestLoading) return "Loading...";
  if (speedTestLoaded) return speedTestExpanded ? "Reload" : "Open test";
  return "Start test";
}

function handleSpeedTestAction(action) {
  if (action === "close-speedtest") {
    closeSpeedTestView();
    return;
  }
  if (action !== "load-speedtest") return;

  if (speedTestLoaded && !speedTestExpanded) {
    captureSpeedTestDashboardHeight();
    speedTestExpanded = true;
    renderSpeedTestPanel();
    return;
  }

  loadSpeedTestEmbed().catch(() => { renderSpeedTestPanel(); });
}

async function loadSpeedTestEmbed() {
  if (speedTestLoading) return;
  captureSpeedTestDashboardHeight();
  speedTestExpanded = true;
  speedTestLoaded = false;
  speedTestLoading = true;
  renderSpeedTestPanel();
  try {
    const publicConfig = await getPublicConfig();
    speedTestEmbedUrl = publicConfig.speedTestEmbedUrl || DEFAULT_SPEEDTEST_EMBED_URL;
    speedTestLoaded = true;
  } finally {
    speedTestLoading = false;
    renderSpeedTestPanel();
  }
}

function closeSpeedTestView() {
  speedTestExpanded = false;
  if (!currentPayload) {
    hideSpeedTestPanel();
    return;
  }
  renderVoucherDashboard();
}

function syncSpeedTestViewState() {
  const expanded = Boolean(speedTestExpanded && currentPayload);
  if (form?.classList?.toggle) {
    form.classList.toggle("search-form-speedtest-expanded", expanded);
  }
  if (resultBody?.classList?.toggle) {
    resultBody.classList.toggle("result-body-hidden", expanded);
  }
  if (speedTestPanel?.classList?.toggle) {
    speedTestPanel.classList.toggle("speedtest-panel-expanded", expanded);
  }
  updateSpeedTestToolbarState(expanded);
}

function updateSpeedTestToolbarState(expanded = Boolean(speedTestExpanded && currentPayload)) {
  if (speedTestReloadButton) {
    speedTestReloadButton.hidden = !expanded;
    speedTestReloadButton.disabled = Boolean(speedTestLoading);
    speedTestReloadButton.textContent = getSpeedTestButtonLabel();
  }

  if (speedTestCloseButton) {
    speedTestCloseButton.hidden = !expanded;
  }
}

function captureSpeedTestDashboardHeight() {
  if (!resultBody || !speedTestPanel || speedTestExpanded) return;

  const rectHeight = typeof resultBody.getBoundingClientRect === "function"
    ? resultBody.getBoundingClientRect().height
    : 0;
  const measuredHeight = Math.max(resultBody.offsetHeight || 0, rectHeight || 0);
  if (!measuredHeight) return;

  speedTestPanel.style.setProperty("--speedtest-dashboard-height", `${Math.round(measuredHeight)}px`);
}

async function getPublicConfig() {
  if (!publicConfigPromise) {
    publicConfigPromise = fetch(PUBLIC_CONFIG_PATH)
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load public config.");
        return response.json();
      })
      .catch(() => ({
        ok: true,
        speedTestEmbedUrl: DEFAULT_SPEEDTEST_EMBED_URL
      }));
  }
  return publicConfigPromise;
}

/* ── SSE Live Stream ──────────────────────────────────────── */

function openLiveStream(code) {
  closeLiveStream();
  stopFallbackPolling();

  if (!window.EventSource) {
    connectionState = "polling";
    scheduleFallbackPolling(code);
    return;
  }

  connectionState = "connecting";
  liveStream = new EventSource(`${STREAM_PATH}?code=${encodeURIComponent(code)}`);

  liveStream.onopen = () => {
    if (code !== currentCode) return;
    connectionState = "live";
    stopFallbackPolling();
  };

  liveStream.addEventListener("voucher", (event) => {
    if (code !== currentCode) return;
    connectionState = "live";
    stopFallbackPolling();
    acceptPayload(JSON.parse(event.data), code);
  });

  liveStream.addEventListener("voucher-error", (event) => {
    if (code !== currentCode) return;
    const payload = JSON.parse(event.data || "{}");
    if (payload.status === 400 || payload.status === 404) {
      renderError(payload.error || "Unable to continue loading this voucher.");
      return;
    }
    connectionState = "reconnecting";
    scheduleFallbackPolling(code);
  });

  liveStream.onerror = () => {
    if (code !== currentCode) return;
    if (connectionState !== "polling") connectionState = "reconnecting";
    scheduleFallbackPolling(code);
  };
}

function closeLiveStream() {
  if (liveStream) { liveStream.close(); liveStream = null; }
}

function scheduleFallbackPolling(code) {
  if (!code || code !== currentCode || connectionState === "live") return;
  stopFallbackPolling();
  fallbackTimer = window.setTimeout(async () => {
    try {
      await loadVoucherStatus(code, { background: true, openStream: false });
    } catch (error) {
      // Keep current data visible
    } finally {
      if (code === currentCode && connectionState !== "live") {
        scheduleFallbackPolling(code);
      }
    }
  }, FALLBACK_REFRESH_MS);
}

function stopFallbackPolling() {
  if (fallbackTimer) { window.clearTimeout(fallbackTimer); fallbackTimer = null; }
}

/* ── Clock ────────────────────────────────────────────────── */

function startClock() {
  stopClock();
  clockTimer = window.setInterval(() => {
    if (!currentPayload) return;
    const display = buildDisplayState(currentPayload, Date.now());
    patchLiveBindings(display);
  }, CLOCK_TICK_MS);
}

function stopClock() {
  if (clockTimer) { window.clearInterval(clockTimer); clockTimer = null; }
}

function stopLiveUpdates() {
  closeLiveStream();
  stopFallbackPolling();
  stopClock();
  connectionState = "idle";
}

function resetCurrentVoucher() {
  currentPayload = null;
  payloadReceivedAtMs = 0;
  liveBindings = {};
  speedTestLoaded = false;
  speedTestLoading = false;
  speedTestExpanded = false;
  speedTestEmbedUrl = "";
  pauseTransitionUntilMs = 0;
  controlState = createEmptyControlState();
}

function createEmptyControlState() {
  return { loading: false, action: "", message: "", tone: "", pending: false };
}

function syncControlStateAfterPayload(payload) {
  if (!controlState.pending) return;

  const usage = payload?.usage || {};
  const isOffline = !usage.active || Number(usage.onlineClients || 0) <= 0;

  if (isOffline) {
    controlState = {
      loading: false,
      action: "",
      message: "Device offline right now.",
      tone: "success",
      pending: false
    };
    pauseTransitionUntilMs = 0;
    return;
  }

  if (Date.now() > Number(pauseTransitionUntilMs || 0)) {
    controlState = {
      loading: false,
      action: "",
      message: "This device is still online.",
      tone: "error",
      pending: false
    };
  }
}

/* ── Display State Builder ────────────────────────────────── */

function buildDisplayState(payload, nowMs) {
  const voucher = { ...payload.voucher };
  const usage = { ...(payload.usage || {}) };
  const localReceivedAtMs = Number(payloadReceivedAtMs || nowMs);
  const checkedAtMs = getPayloadCheckedAtMs(payload) || Number(usage.controllerCheckedAtMs || 0) || localReceivedAtMs;
  // Use the local receive time for freshness so minor clock drift doesn't zero the speed
  const localAgeMs = Math.max(0, nowMs - localReceivedAtMs);
  const payloadAgeMs = Math.max(0, nowMs - checkedAtMs);

  usage.snapshotAgeMs = payloadAgeMs;
  usage.snapshotFresh = localAgeMs <= PAYLOAD_STALE_AFTER_MS;
  usage.pauseTransitioning = isPauseTransitionActive(nowMs);
  usage.effectiveActive = isUsageEffectivelyActive(payload, usage, { nowMs, checkedAtMs });
  // Show speed as long as the snapshot is fresh — don't require effectiveActive
  // because the controller already reports 0 when client is inactive
  usage.displayLiveDownloadBytesPerSec = usage.snapshotFresh ? Number(usage.liveDownloadBytesPerSec || 0) : 0;
  usage.displayLiveUploadBytesPerSec = usage.snapshotFresh ? Number(usage.liveUploadBytesPerSec || 0) : 0;
  usage.displayTotalBytes = getDisplaySessionBytes(usage, { nowMs, localReceivedAtMs });
  usage.displayVoucherMeterBytes = getDisplayVoucherMeterBytes({ voucher, usage }, { nowMs, localReceivedAtMs });

  const elapsedSincePayloadSec = shouldAdvanceVoucherClock(payload, usage)
    ? Math.max(0, Math.floor((nowMs - localReceivedAtMs) / 1000))
    : 0;

  voucher.timeUsedSec = Math.max(0, Number(voucher.timeUsedSec || 0) + elapsedSincePayloadSec);
  voucher.timeLeftSec = Math.max(0, Number(voucher.timeLeftSec || 0) - elapsedSincePayloadSec);
  voucher.expiresAt = computeVoucherExpiryTime(voucher, payload.group);

  return { ...payload, voucher, usage, checkedAtMs };
}

function detectVoucherMode(display) {
  const voucher = display.voucher || {};
  const group = display.group || {};
  const hasTrafficEvidence = Number(voucher.trafficLimit || 0) > 0 || Number(voucher.trafficUsed || 0) > 0 || Number(voucher.trafficUnused || 0) > 0;
  const hasTimeEvidence = Number(group.duration || 0) > 0 || (!hasTrafficEvidence && (Number(voucher.timeLeftSec || 0) > 0 || Number(voucher.timeUsedSec || 0) > 0));

  return {
    hasTrafficLimit: hasTrafficEvidence,
    hasTimeLimit: hasTimeEvidence,
    trafficOnly: hasTrafficEvidence && !hasTimeEvidence,
    timeOnly: hasTimeEvidence && !hasTrafficEvidence,
    mixed: hasTrafficEvidence && hasTimeEvidence
  };
}

/* ── Status & Lifecycle ───────────────────────────────────── */

function getStatusHeadline(display, mode) {
  const usage = display?.usage || {};
  const lifecycle = getVoucherLifecycle(display, mode);

  if (connectionState === "reconnecting" || !usage.snapshotFresh) return "Checking latest status.";
  if (lifecycle === "paused") return "Device offline right now.";
  if (lifecycle === "ready") return mode.hasTrafficLimit ? "Ready to use." : "Starts on first use.";
  if (lifecycle === "active") return "In use now.";
  if (lifecycle === "offline") return "Device offline right now. Reconnect to Wi-Fi and enter the same code to continue.";
  if (lifecycle === "consumed") return isVoucherTrafficConsumed(display, mode) ? "Data is fully used." : "Time is over.";
  return "Status ready.";
}

function getVoucherLifecycle(display, mode = detectVoucherMode(display)) {
  const usage = display?.usage || {};

  if (usage.pauseTransitioning) return "signing-out";
  if (usage.manualPaused) return "paused";
  if (isVoucherActuallyConsumed(display, mode)) return "consumed";
  if (isDisplayOnline(display)) return "active";
  if (hasVoucherStarted(display)) return "offline";
  return "ready";
}

function getVoucherControlTone(state, usage) {
  if (state?.message) return state.tone || "neutral";
  if (usage?.manualPaused) return "warn";
  return "neutral";
}

/* ── Formatters ───────────────────────────────────────────── */

function formatRingTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";

  const totalSeconds = Math.max(0, Math.floor(seconds));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  }

  if (totalSeconds < 86400) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (totalSeconds < 2592000) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  const months = Math.floor(totalSeconds / 2592000);
  const days = Math.floor((totalSeconds % 2592000) / 86400);
  return days > 0 ? `${months}mo ${days}d` : `${months}mo`;
}

function formatShortDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";

  const totalSeconds = Math.max(0, Math.floor(seconds));
  const months = Math.floor(totalSeconds / 2592000);
  const days = Math.floor((totalSeconds % 2592000) / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts = [];

  if (months > 0) parts.push(`${months}mo`);
  if (days > 0 && parts.length < 2) parts.push(`${days}d`);
  if (hours > 0 && parts.length < 2) parts.push(`${hours}h`);
  if (minutes > 0 && parts.length < 2) parts.push(`${minutes}m`);
  if (secs > 0 && parts.length < 2) parts.push(`${secs}s`);

  return parts.join(" ") || "0s";
}

function getRingTextScale(text) {
  const length = String(text || "").trim().length;
  if (length <= 4) return "normal";
  if (length <= 7) return "wide";
  if (length <= 9) return "tight";
  return "tiny";
}

function getRingBadgeScale(text) {
  const length = String(text || "").trim().length;
  if (length <= 8) return "normal";
  if (length <= 12) return "wide";
  if (length <= 16) return "tight";
  return "tiny";
}

function getSummaryTextScale(text) {
  const length = String(text || "").trim().length;
  if (length <= 14) return "normal";
  if (length <= 22) return "wide";
  if (length <= 30) return "tight";
  return "tiny";
}

function buildRingBadgeText(lifecycle) {
  if (lifecycle === "consumed") {
    return "Expired";
  }

  if (lifecycle === "offline" || lifecycle === "paused" || lifecycle === "signing-out") {
    return "Offline";
  }

  return "Left";
}

function buildDataRingBadgeText(lifecycle) {
  if (lifecycle === "consumed") {
    return "Expired";
  }

  if (lifecycle === "offline" || lifecycle === "paused" || lifecycle === "signing-out") {
    return "Offline";
  }

  return "Remaining";
}

function buildStatusRingBadgeText(lifecycle) {
  return getTopbarChipInfo(lifecycle).label;
}

function getRingBadgeTone(lifecycle) {
  if (lifecycle === "consumed") return "red";
  if (lifecycle === "offline" || lifecycle === "paused" || lifecycle === "signing-out") return "dark";
  return "blue";
}

function getRingProgressTone(fraction, lifecycle, mode = {}) {
  if (lifecycle === "consumed") return "red";

  const hasMeasuredLimit = Boolean(mode?.hasTimeLimit || mode?.hasTrafficLimit);
  if (!hasMeasuredLimit) {
    if (lifecycle === "active" || lifecycle === "ready") return "green";
    if (lifecycle === "offline" || lifecycle === "paused" || lifecycle === "signing-out") return "blue";
    return "red";
  }

  const safeFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
  if (safeFraction >= 0.75) return "green";
  if (safeFraction <= 0.3) return "red";
  return "blue";
}

function getRingBadgeToneForProgress(lifecycle, progressTone) {
  if (lifecycle === "consumed") return "red";
  if (lifecycle === "offline" || lifecycle === "paused" || lifecycle === "signing-out") return "dark";
  return progressTone === "green" || progressTone === "red" ? progressTone : "blue";
}

function formatDetailedDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";

  const totalSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function getWifiBandInfo(usage = {}) {
  const bandLabel = String(usage?.bandLabel || "").trim();
  if (bandLabel === "2.4 GHz") return { label: bandLabel, tone: "teal" };
  if (bandLabel === "5 GHz") return { label: bandLabel, tone: "blue" };
  if (bandLabel === "6 GHz") return { label: bandLabel, tone: "violet" };

  const channel = Number(usage?.channel);
  if (channel >= 1 && channel <= 14) return { label: "2.4 GHz", tone: "teal" };
  if (channel >= 36 && channel <= 177) return { label: "5 GHz", tone: "blue" };
  if (channel >= 1 && channel <= 233) return { label: "6 GHz", tone: "violet" };

  return { label: "", tone: "neutral" };
}

function getSignalStrengthInfo(usage = {}, { online = false } = {}) {
  if (!online) {
    return {
      tone: "dark",
      badge: "Offline",
      primary: "Reconnect to see live signal",
      secondary: "No active Wi-Fi signal right now.",
      barCount: 0
    };
  }

  const rssi = Number(usage?.rssi);
  const signalLevel = Number(usage?.signalLevel);
  const hasRssi = Number.isFinite(rssi) && rssi < 0;
  const percent = hasRssi ? getSignalPercentFromRssi(rssi) : getSignalPercentFromLevel(signalLevel);
  if (!Number.isFinite(percent) || percent <= 0) {
    return {
      tone: "muted",
      badge: "Checking",
      primary: "Waiting for signal data",
      secondary: "Signal details will appear once Omada updates.",
      barCount: 0
    };
  }

  if (percent >= 85) {
    return {
      tone: "green",
      badge: "Excellent",
      primary: hasRssi ? `${Math.round(rssi)} dBm` : `${Math.round(percent)}% signal`,
      secondary: "Excellent signal. This is a strong spot.",
      barCount: 5
    };
  }

  if (percent >= 70) {
    return {
      tone: "blue",
      badge: "Strong",
      primary: hasRssi ? `${Math.round(rssi)} dBm` : `${Math.round(percent)}% signal`,
      secondary: "Strong signal. You should be fine here.",
      barCount: 4
    };
  }

  if (percent >= 50) {
    return {
      tone: "amber",
      badge: "Fair",
      primary: hasRssi ? `${Math.round(rssi)} dBm` : `${Math.round(percent)}% signal`,
      secondary: "Fair signal. Move a little closer.",
      barCount: 3
    };
  }

  if (percent >= 30) {
    return {
      tone: "orange",
      badge: "Weak",
      primary: hasRssi ? `${Math.round(rssi)} dBm` : `${Math.round(percent)}% signal`,
      secondary: "Weak signal. Try moving closer.",
      barCount: 2
    };
  }

  return {
    tone: "red",
    badge: "Very Weak",
    primary: hasRssi ? `${Math.round(rssi)} dBm` : `${Math.round(percent)}% signal`,
    secondary: "Very weak signal. Move much closer.",
    barCount: 1
  };
}

function getSignalPercentFromRssi(rssi) {
  const numericRssi = Number(rssi);
  if (!Number.isFinite(numericRssi)) return 0;
  if (numericRssi >= -55) return 100;
  if (numericRssi <= -95) return 0;
  return Math.max(0, Math.min(100, ((numericRssi + 95) / 40) * 100));
}

function getSignalPercentFromLevel(level) {
  const numericLevel = Number(level);
  if (!Number.isFinite(numericLevel) || numericLevel <= 0) return 0;
  if (numericLevel <= 100) return Math.max(0, Math.min(100, numericLevel));
  return Math.max(0, Math.min(100, numericLevel / 10));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTransferRate(bytesPerSec) {
  const bitsPerSec = Number(bytesPerSec || 0) * 8;
  if (!Number.isFinite(bitsPerSec) || bitsPerSec <= 0) return "0 Kbps";
  return formatBitRate(bitsPerSec, { inputUnit: "bps", minimumUnit: "Kbps" });
}

function formatTrafficLimit(voucher) {
  const limitBytes = getTrafficLimitBytes(voucher);
  if (!limitBytes) return "Unlimited";
  return formatBytes(limitBytes);
}

function formatTrafficRemaining(voucher) {
  const limitBytes = getTrafficLimitBytes(voucher);
  if (!limitBytes) return "Unlimited";
  return formatBytes(Number(voucher?.trafficUnused || 0));
}

function formatDisplayTrafficRemaining(payload) {
  const limitBytes = getTrafficLimitBytes(payload?.voucher);
  if (!limitBytes) return "Unlimited";
  return formatBytes(getDisplayTrafficRemainingBytes(payload));
}

function formatConfiguredSpeedLimit(limitKbps) {
  const numericLimit = Number(limitKbps || 0);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) return "Unlimited";
  return formatBitRate(numericLimit, { inputUnit: "Kbps", minimumUnit: "Kbps" });
}

function hasConfiguredTrafficLimit(voucher) {
  return Number(voucher?.trafficLimit || 0) > 0;
}

function hasConfiguredSpeedLimit(limitKbps) {
  return Number(limitKbps || 0) > 0;
}

function getTrafficLimitBytes(voucher) {
  const limitMb = Number(voucher?.trafficLimit || 0);
  if (!Number.isFinite(limitMb) || limitMb <= 0) return 0;
  return limitMb * 1024 * 1024;
}

function hasVoucherTrafficMeterSignal(payload) {
  const voucher = payload?.voucher || {};
  const usage = payload?.usage || {};
  return (
    Number(voucher?.trafficUsed || 0) > 0 ||
    Number(voucher?.trafficUnused || 0) > 0 ||
    Number(usage?.voucherMeterBytes || 0) > 0 ||
    String(usage?.source || "").trim() === "voucher_meter"
  );
}

function getBaseVoucherTrafficUsedBytes(payload) {
  const voucher = payload?.voucher || {};
  const usage = payload?.usage || {};
  const limitBytes = getTrafficLimitBytes(voucher);
  const voucherUsed = Number(voucher?.trafficUsed || 0);
  const meterUsed = Number(usage?.voucherMeterBytes || 0);
  const unusedBytes = Number(voucher?.trafficUnused || 0);
  const usedFromUnused =
    limitBytes > 0 && Number.isFinite(unusedBytes) && unusedBytes >= 0
      ? Math.max(0, limitBytes - unusedBytes)
      : 0;

  return Math.max(0, voucherUsed, meterUsed, usedFromUnused);
}

function getDisplayTrafficRemainingBytes(payload) {
  const limitBytes = getTrafficLimitBytes(payload?.voucher);
  if (!limitBytes) return 0;
  return Math.max(0, limitBytes - getDisplayDataUsed(payload));
}

function getTrafficOverlayText(payload) {
  const limitBytes = getTrafficLimitBytes(payload?.voucher);
  if (!limitBytes) return "";
  return `${formatBytes(getDisplayTrafficRemainingBytes(payload))} Left`;
}

function formatBitRate(value, { inputUnit = "bps", minimumUnit = "bps" } = {}) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return minimumUnit === "Kbps" ? "0 Kbps" : "0 bps";
  }

  const bitsPerSec = inputUnit === "Kbps" ? numericValue * 1000 : numericValue;
  const units = minimumUnit === "Kbps"
    ? [
        { label: "Gbps", size: 1_000_000_000 },
        { label: "Mbps", size: 1_000_000 },
        { label: "Kbps", size: 1_000 }
      ]
    : [
        { label: "Gbps", size: 1_000_000_000 },
        { label: "Mbps", size: 1_000_000 },
        { label: "Kbps", size: 1_000 },
        { label: "bps", size: 1 }
      ];

  const selected = units.find((unit) => bitsPerSec >= unit.size) || units[units.length - 1];
  const scaled = bitsPerSec / selected.size;
  return `${formatRateNumber(scaled)} ${selected.label}`;
}

function formatRateNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function formatVoucherDuration(minutes) {
  const totalMinutes = Number(minutes || 0);
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "";

  if (totalMinutes % 1440 === 0) {
    const days = totalMinutes / 1440;
    return `${days} Day${days > 1 ? "s" : ""}`;
  }

  if (totalMinutes % 60 === 0) {
    const hours = totalMinutes / 60;
    return `${hours} Hour${hours > 1 ? "s" : ""}`;
  }

  if (totalMinutes < 60) return `${totalMinutes} Minute${totalMinutes > 1 ? "s" : ""}`;

  const hours = Math.floor(totalMinutes / 60);
  const rem = totalMinutes % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (rem > 0) parts.push(`${rem}m`);
  return parts.join(" ");
}

function formatVoucherLimitType(limitType) {
  if (limitType === 0) return "Limited";
  if (limitType === 1) return "Limited Online Users";
  if (limitType === 2) return "Unlimited";
  return "Standard";
}

function formatVoucherLimitDetail(limitType, limitNum) {
  const num = Number(limitNum || 0);
  if (limitType === 0 && num > 0) return `${num} use${num > 1 ? "s" : ""}`;
  if (limitType === 1 && num > 0) return `${num} user${num > 1 ? "s" : ""} at a time`;
  if (limitType === 2) return "Unlimited";
  return "";
}

/* ── Utility: Voucher Logic ───────────────────────────────── */

function formatVoucherDate(value) {
  const timestampMs = getMeaningfulTimestampMs(value);
  if (!timestampMs) return "";

  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    });
    const parts = formatter.formatToParts(timestampMs);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const dayPeriod = values.dayPeriod ? ` ${values.dayPeriod}` : "";
    return `${values.month || ""} ${values.day || ""} ${values.year || ""} ${values.hour || ""}:${values.minute || "00"}:${values.second || "00"}${dayPeriod}`.trim();
  } catch (error) {
    void error;
    return new Date(timestampMs).toLocaleString();
  }
}

function getVoucherStartDisplayMs(voucher = {}, group = {}) {
  void group;
  return getMeaningfulTimestampMs(voucher?.startTime) || 0;
}

function getVoucherEndDisplayMs(voucher = {}, group = {}) {
  return (
    getMeaningfulTimestampMs(voucher?.expiresAt) ||
    getMeaningfulTimestampMs(voucher?.endTime) ||
    getMeaningfulTimestampMs(group?.expirationTime) ||
    0
  );
}

function getVoucherDurationSeconds(group) {
  const minutes = Number(group?.duration || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.max(0, Math.round(minutes * 60));
}

function isAutoPauseVoucher(voucher, group = {}) {
  if (voucher?.timingByClientUsage === true) return true;
  return Number(group?.timingType) === 1;
}

function getTimingModeBadgeInfo(display, mode = detectVoucherMode(display)) {
  const voucher = display?.voucher || {};
  const group = display?.group || {};
  const timingType = Number(group?.timingType);
  const hasTimingMode =
    mode.hasTimeLimit ||
    voucher?.timingByClientUsage === true ||
    Number.isFinite(timingType) ||
    Number(group?.duration || 0) > 0;

  if (!hasTimingMode) return null;

  if (isAutoPauseVoucher(voucher, group)) {
    return {
      label: "Auto pause on idle",
      tone: "green"
    };
  }

  return {
    label: "No auto pause",
    tone: "dark"
  };
}

function isDisplayOnline(display) {
  return Boolean(display?.usage?.effectiveActive);
}

function hasVoucherStarted(display) {
  const voucher = display?.voucher || {};
  const usage = display?.usage || {};
  return (
    Number(voucher.timeUsedSec || 0) > 0 ||
    Number(voucher.trafficUsed || 0) > 0 ||
    getMeaningfulTimestampMs(voucher.startTime) > 0 ||
    Number(usage.matchedClients || 0) > 0 ||
    Number(usage.onlineClients || 0) > 0
  );
}

function isVoucherTimeConsumed(display, mode = detectVoucherMode(display)) {
  if (!mode.hasTimeLimit) return false;
  if (!hasVoucherStarted(display)) return false;
  return Number(display?.voucher?.timeLeftSec || 0) <= 0;
}

function isVoucherTrafficConsumed(display, mode = detectVoucherMode(display)) {
  const voucher = display?.voucher || {};
  if (!mode.hasTrafficLimit) return false;
  if (Number(voucher.trafficLimit || 0) <= 0) return false;
  return Number(voucher.trafficUnused || 0) <= 0;
}

function isVoucherActuallyConsumed(display, mode = detectVoucherMode(display)) {
  if (Number(display?.voucher?.status) === 2) return true;
  return isVoucherTimeConsumed(display, mode) || isVoucherTrafficConsumed(display, mode);
}

function shouldAdvanceVoucherClock(payload, usage = payload?.usage || {}) {
  const group = payload?.group || {};
  const mode = detectVoucherMode(payload);
  if (!mode.hasTimeLimit) return false;
  if (!usage.snapshotFresh || usage.pauseTransitioning) return false;
  if (usage.manualPaused) return false;
  if (isVoucherTimeConsumed(payload, mode)) return false;

  if (isAutoPauseVoucher(payload?.voucher, group)) {
    return Boolean(usage.effectiveActive) && hasVoucherStarted(payload) && (connectionState === "live" || connectionState === "polling");
  }

  return hasVoucherStarted(payload) && (connectionState === "live" || connectionState === "polling");
}

function getPayloadCheckedAtMs(payload) {
  const isoCheckedAtMs = Date.parse(String(payload?.checkedAt || ""));
  if (Number.isFinite(isoCheckedAtMs) && isoCheckedAtMs > 0) return isoCheckedAtMs;
  const usageCheckedAtMs = Number(payload?.usage?.controllerCheckedAtMs || 0);
  return Number.isFinite(usageCheckedAtMs) && usageCheckedAtMs > 0 ? usageCheckedAtMs : 0;
}

function isUsageReportedActive(usage = {}) {
  return Boolean(usage?.active) && Number(usage?.onlineClients || 0) > 0;
}

function isUsageEffectivelyActive(payload, usage, { nowMs, checkedAtMs } = {}) {
  void payload;
  void checkedAtMs;
  void nowMs;

  if (!usage?.snapshotFresh) return false;
  if (usage?.pauseTransitioning || usage?.manualPaused) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  return isUsageReportedActive(usage);
}

function isPauseTransitionActive(nowMs = Date.now()) {
  return Number(pauseTransitionUntilMs || 0) > nowMs;
}

function shouldClearPauseTransition(payload) {
  const usage = payload?.usage || {};
  return !usage.active || Number(usage.onlineClients || 0) <= 0;
}

function getMeaningfulTimestampMs(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0 || numericValue >= MAX_REASONABLE_TIMESTAMP_MS) return 0;
  return numericValue;
}

function computeVoucherExpiryTime(voucher, group) {
  const totalDurationSec = Math.max(getVoucherDurationSeconds(group), Number(voucher?.timeUsedSec || 0) + Number(voucher?.timeLeftSec || 0));
  const calculatedExpiryMs = getMeaningfulTimestampMs(voucher?.startTime) > 0 && totalDurationSec > 0
    ? Number(voucher.startTime) + totalDurationSec * 1000
    : 0;
  const endTimeMs = getMeaningfulTimestampMs(voucher?.endTime);

  if (isAutoPauseVoucher(voucher, group) && calculatedExpiryMs > 0) return calculatedExpiryMs;
  if (endTimeMs) return endTimeMs;
  if (!voucher || !Number.isFinite(Number(voucher.startTime)) || Number(voucher.startTime) <= 0) return null;
  if (!totalDurationSec) return null;
  return Number(voucher.startTime) + totalDurationSec * 1000;
}

function getDisplayDataUsed(payload) {
  const voucher = payload.voucher || {};
  const usage = payload.usage || {};
  if (hasConfiguredTrafficLimit(voucher) && hasVoucherTrafficMeterSignal(payload)) {
    return Number(usage.displayVoucherMeterBytes ?? getBaseVoucherTrafficUsedBytes(payload));
  }
  const voucherUsed = Number(voucher.trafficUsed || 0);
  const sessionUsed = Number(usage.displayTotalBytes || usage.totalBytes || 0);
  return Math.max(voucherUsed, sessionUsed);
}

function getDisplayVoucherMeterBytes(payload, { nowMs = Date.now(), localReceivedAtMs = nowMs } = {}) {
  const baseBytes = getBaseVoucherTrafficUsedBytes(payload);
  const usage = payload?.usage || {};

  if (!usage.snapshotFresh || !usage.effectiveActive) {
    return baseBytes;
  }

  const elapsedSec = Math.max(0, (nowMs - localReceivedAtMs) / 1000);
  const liveRateBytesPerSec =
    Number(usage.displayLiveDownloadBytesPerSec || 0) + Number(usage.displayLiveUploadBytesPerSec || 0);

  return Math.max(0, baseBytes + liveRateBytesPerSec * elapsedSec);
}

function getDisplaySessionBytes(usage = {}, { nowMs = Date.now(), localReceivedAtMs = nowMs } = {}) {
  const baseBytes = Number(usage.totalBytes || 0);
  if (!usage.snapshotFresh || !usage.effectiveActive) return baseBytes;

  const elapsedSec = Math.max(0, (nowMs - localReceivedAtMs) / 1000);
  const liveRateBytesPerSec =
    Number(usage.displayLiveDownloadBytesPerSec || 0) + Number(usage.displayLiveUploadBytesPerSec || 0);

  return baseBytes + liveRateBytesPerSec * elapsedSec;
}

/* ── Utility: Money ───────────────────────────────────────── */

function formatShortMoneyAmount(amount, currency) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return "";

  const hasDecimals = Math.abs(numericAmount - Math.round(numericAmount)) >= 0.001;
  const fractionDigits = hasDecimals ? 2 : 0;
  const formatted = numericAmount.toFixed(fractionDigits);

  if (String(currency || "").trim().toUpperCase() === "PHP") {
    return `P${formatted}`;
  }

  if (currency) {
    return `${currency} ${formatted}`;
  }

  return formatted;
}

/* ── Utility: HTML ────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
