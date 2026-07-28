document.addEventListener('DOMContentLoaded', async () => {
  const today = new Date().toISOString().split('T')[0];
  const data = await chrome.storage.local.get([today, 'userTaxConfig', 'payoutStatus']);
  
  const stats = data[today] || { grossEarnings: 0, taxDeductions: 0, netEarnings: 0 };
  const config = data.userTaxConfig || { country: 'US', federalTaxRate: 0.15 };

  document.getElementById('net-earnings').textContent = `$${Number(stats.netEarnings || 0).toFixed(4)}`;
  document.getElementById('gross-earnings').textContent = `$${Number(stats.grossEarnings || 0).toFixed(4)}`;
  document.getElementById('tax-deductions').textContent = `-$${Number(stats.taxDeductions || 0).toFixed(4)}`;
  document.getElementById('user-location').textContent = `${config.country} (${(config.federalTaxRate * 100)}% Tax)`;
  document.getElementById('payout-status').textContent =
    data.payoutStatus?.message || 'No payout attempt yet.';
});
