// Monetization & Tax Configuration Constants
const PAGE_VIEW_VALUE = 0.0025;
const SEARCH_VALUE = 0.015;
const TIME_VALUE_PER_MIN = 0.001;

// Default Estimated Tax Rates (Fallback if location cannot be resolved)
let userTaxConfig = {
  country: 'US',
  state: 'UNKNOWN',
  federalTaxRate: 0.15, // Default estimated withholding rate (15%)
  isTaxApplicable: true
};

// Helper: Get Today's Date Key
function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

// Determine User Location & Applicable Tax Rate
async function detectLocationAndTaxRate() {
  try {
    let data = null;

    // Try primary API (ipapi.co)
    let response = await fetch('https://ipapi.co/json/');
    
    // Check if the response is actually valid JSON
    const contentType = response.headers.get('content-type');
    if (response.ok && contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      console.warn("ipapi.co did not return JSON. Trying fallback API...");
      // Fallback API (ip-api.com)
      const fallbackResponse = await fetch('http://ip-api.com/json/');
      if (fallbackResponse.ok) {
        const fallbackData = await fallbackResponse.json();
        data = {
          country_code: fallbackData.countryCode,
          region_code: fallbackData.region
        };
      }
    }

    if (data) {
      userTaxConfig.country = data.country_code || 'US';
      userTaxConfig.state = data.region_code || 'UNKNOWN';

      if (userTaxConfig.country === 'US') {
        userTaxConfig.isTaxApplicable = true;
        userTaxConfig.federalTaxRate = 0.15; // 15% estimated federal withholding
      } else {
        userTaxConfig.isTaxApplicable = false;
        userTaxConfig.federalTaxRate = 0.00;
      }
    }

    await chrome.storage.local.set({ userTaxConfig });
    console.log("Location & Tax Config set:", userTaxConfig);

  } catch (err) {
    console.error("Location detection failed completely, using defaults:", err);
    // Persist defaults on total failure
    await chrome.storage.local.set({ userTaxConfig });
  }
}

// Run location detection on startup
chrome.runtime.onInstalled.addListener(detectLocationAndTaxRate);
chrome.runtime.onStartup.addListener(detectLocationAndTaxRate);

// Initialize daily storage structure
async function initTodayStorage() {
  const today = getTodayKey();
  const data = await chrome.storage.local.get([today]);
  
  if (!data[today]) {
    await chrome.storage.local.set({
      [today]: {
        pagesVisited: 0,
        searchesPerformed: 0,
        timeSpentSeconds: 0,
        grossEarnings: 0.0,
        taxDeductions: 0.0,
        netEarnings: 0.0
      }
    });
  }
  return today;
}

// Record Activity & Calculate Tax Split
async function recordActivity(type, value = 1) {
  const today = await initTodayStorage();
  const res = await chrome.storage.local.get([today, 'userTaxConfig']);
  const stats = res[today];
  const taxConfig = res.userTaxConfig || userTaxConfig;

  let earnedAmount = 0.0;
  if (type === 'page') earnedAmount = value * PAGE_VIEW_VALUE;
  else if (type === 'search') earnedAmount = value * SEARCH_VALUE;
  else if (type === 'time') earnedAmount = (value / 60) * TIME_VALUE_PER_MIN;

  // Calculate gross, tax deduction, and net payout
  const taxAmount = taxConfig.isTaxApplicable ? (earnedAmount * taxConfig.federalTaxRate) : 0.0;
  const netAmount = earnedAmount - taxAmount;

  // Update cumulative totals
  if (type === 'page') stats.pagesVisited += value;
  if (type === 'search') stats.searchesPerformed += value;
  if (type === 'time') stats.timeSpentSeconds += value;

  stats.grossEarnings += earnedAmount;
  stats.taxDeductions += taxAmount;
  stats.netEarnings += netAmount;

  await chrome.storage.local.set({ [today]: stats });

  // Trigger Automatic Direct Deposit / Bank Transfer Webhook
  triggerAutomatedPayout(netAmount, taxAmount);
}

// Send Net Earnings & Tax Amounts to Backend Payout API (Stripe/PayPal)
async function triggerAutomatedPayout(netAmount, taxAmount) {
  if (netAmount <= 0) return;

  try {
    // Replace with your actual backend payment service endpoint (e.g., Stripe Connect API)
    await fetch('https://hail.thepolka.cloud/api/payout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        netEarningsToAccount: netAmount,
        taxWithheldToEscrow: taxAmount,
        currency: 'USD',
        timestamp: new Date().toISOString()
      })
    });
  } catch (e) {
    // Endpoint placeholder
  }
}

// Web Event Tracking
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    recordActivity('page', 1);
    const url = new URL(tab.url);
    if (url.searchParams.has('q')) {
      recordActivity('search', 1);
    }
  }
});

// Active Time Pulse (Every 10 seconds)
setInterval(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && tabs[0].url && tabs[0].url.startsWith('http')) {
    recordActivity('time', 10);
  }
}, 10000);
