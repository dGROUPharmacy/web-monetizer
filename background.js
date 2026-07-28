const PAGE_VIEW_VALUE = 0.0025;
const SEARCH_VALUE = 0.015;
const TIME_VALUE_PER_MIN = 0.001;
const ACTIVITY_ALARM = 'record-active-minute';
const LOCATION_ALARM = 'refresh-location';
const PAYOUT_ALARM = 'submit-pending-earnings';
const PAYOUT_ENDPOINT = 'https://hail.thepolka.cloud/api/payout';
const DEFAULT_PAYOUT_THRESHOLD = 1;

const DEFAULT_TAX_CONFIG = {
  country: 'US',
  state: 'UNKNOWN',
  federalTaxRate: 0.15,
  isTaxApplicable: true
};

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function emptyStats() {
  return {
    pagesVisited: 0,
    searchesPerformed: 0,
    timeSpentSeconds: 0,
    grossEarnings: 0,
    taxDeductions: 0,
    netEarnings: 0
  };
}

async function ensureInitialized() {
  const today = getTodayKey();
  const stored = await chrome.storage.local.get([
    today,
    'userTaxConfig',
    'installId',
    'pendingPayout',
    'payoutThreshold'
  ]);
  const updates = {};

  if (!stored[today]) updates[today] = emptyStats();
  if (!stored.userTaxConfig) updates.userTaxConfig = DEFAULT_TAX_CONFIG;
  if (!stored.installId) updates.installId = crypto.randomUUID();
  if (!stored.pendingPayout) {
    updates.pendingPayout = { netAmount: 0, taxAmount: 0 };
  }
  if (typeof stored.payoutThreshold !== 'number') {
    updates.payoutThreshold = DEFAULT_PAYOUT_THRESHOLD;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);

  await chrome.alarms.create(ACTIVITY_ALARM, { periodInMinutes: 1 });
  await chrome.alarms.create(PAYOUT_ALARM, { periodInMinutes: 15 });
  await chrome.alarms.create(LOCATION_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: 24 * 60
  });
}

async function detectLocationAndTaxRate() {
  let taxConfig = { ...DEFAULT_TAX_CONFIG };

  try {
    const response = await fetch('https://ipapi.co/json/');
    if (!response.ok) throw new Error(`Location lookup returned ${response.status}`);

    const data = await response.json();
    taxConfig.country = data.country_code || DEFAULT_TAX_CONFIG.country;
    taxConfig.state = data.region_code || DEFAULT_TAX_CONFIG.state;
    taxConfig.isTaxApplicable = taxConfig.country === 'US';
    taxConfig.federalTaxRate = taxConfig.isTaxApplicable ? 0.15 : 0;
  } catch (error) {
    console.warn('Location lookup failed; using the saved/default estimate.', error);
    const stored = await chrome.storage.local.get('userTaxConfig');
    taxConfig = stored.userTaxConfig || taxConfig;
  }

  await chrome.storage.local.set({
    userTaxConfig: taxConfig,
    locationUpdatedAt: new Date().toISOString()
  });
}

// Serializes read-modify-write operations while this worker is alive. Activity
// events are combined where possible so page/search updates cannot overwrite one another.
let activityQueue = Promise.resolve();

function recordActivity(activity) {
  activityQueue = activityQueue.then(async () => {
    const today = getTodayKey();
    const stored = await chrome.storage.local.get([
      today,
      'userTaxConfig',
      'pendingPayout'
    ]);
    const stats = stored[today] || emptyStats();
    const taxConfig = stored.userTaxConfig || DEFAULT_TAX_CONFIG;

    const pages = activity.pages || 0;
    const searches = activity.searches || 0;
    const seconds = activity.seconds || 0;
    const earned =
      pages * PAGE_VIEW_VALUE +
      searches * SEARCH_VALUE +
      (seconds / 60) * TIME_VALUE_PER_MIN;
    const tax = taxConfig.isTaxApplicable
      ? earned * taxConfig.federalTaxRate
      : 0;

    stats.pagesVisited += pages;
    stats.searchesPerformed += searches;
    stats.timeSpentSeconds += seconds;
    stats.grossEarnings += earned;
    stats.taxDeductions += tax;
    stats.netEarnings += earned - tax;

    const pendingPayout = stored.pendingPayout || { netAmount: 0, taxAmount: 0 };
    pendingPayout.netAmount += earned - tax;
    pendingPayout.taxAmount += tax;

    await chrome.storage.local.set({ [today]: stats, pendingPayout });
  }).catch((error) => console.error('Activity update failed.', error));

  return activityQueue;
}

async function submitPendingPayout() {
  await activityQueue;
  const stored = await chrome.storage.local.get([
    'installId',
    'pendingPayout',
    'payoutThreshold'
  ]);
  const pending = stored.pendingPayout || { netAmount: 0, taxAmount: 0 };
  const threshold = stored.payoutThreshold || DEFAULT_PAYOUT_THRESHOLD;

  if (pending.netAmount < threshold) {
    await chrome.storage.local.set({
      payoutStatus: {
        state: 'accumulating',
        message: `$${pending.netAmount.toFixed(4)} pending; submits at $${threshold.toFixed(2)}.`,
        updatedAt: new Date().toISOString()
      }
    });
    return;
  }

  try {
    const settlementId = crypto.randomUUID();
    const response = await fetch(PAYOUT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': settlementId
      },
      body: JSON.stringify({
        installId: stored.installId,
        settlementId,
        netEarningsToAccount: pending.netAmount,
        taxWithheldToEscrow: pending.taxAmount,
        currency: 'USD',
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) throw new Error(`Payout endpoint returned ${response.status}`);

    const latest = await chrome.storage.local.get('pendingPayout');
    const latestPending = latest.pendingPayout || pending;
    await chrome.storage.local.set({
      pendingPayout: {
        netAmount: Math.max(0, latestPending.netAmount - pending.netAmount),
        taxAmount: Math.max(0, latestPending.taxAmount - pending.taxAmount)
      },
      payoutStatus: {
        state: 'submitted',
        message: 'Pending earnings were accepted by the payout service.',
        updatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    await chrome.storage.local.set({
      payoutStatus: {
        state: 'pending',
        message: 'Earnings remain pending; payout service is unavailable.',
        updatedAt: new Date().toISOString()
      }
    });
    console.warn('Payout is pending.', error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureInitialized();
  await detectLocationAndTaxRate();
});

chrome.runtime.onStartup.addListener(ensureInitialized);

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === LOCATION_ALARM) {
    await detectLocationAndTaxRate();
    return;
  }

  if (name === ACTIVITY_ALARM) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url?.startsWith('http')) await recordActivity({ seconds: 60 });
    return;
  }

  if (name === PAYOUT_ALARM) await submitPendingPayout();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url?.startsWith('http')) return;

  const url = new URL(tab.url);
  const isSearch = ['q', 'query', 'search'].some((key) => url.searchParams.has(key));
  void recordActivity({ pages: 1, searches: isSearch ? 1 : 0 });
});

void ensureInitialized();
