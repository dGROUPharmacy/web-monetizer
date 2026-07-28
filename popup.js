document.addEventListener('DOMContentLoaded', async () => {
  const today = new Date().toISOString().split('T')[0];
  const data = await chrome.storage.local.get([today, 'userTaxConfig']);
  
  const stats = data[today] || { grossEarnings: 0, taxDeductions: 0, netEarnings: 0 };
  const config = data.userTaxConfig || { country: 'US', federalTaxRate: 0.15 };

  document.getElementById('net-earnings').textContent = `$${stats.netEarnings.toFixed(3)}`;
  document.getElementById('gross-earnings').textContent = `$${stats.grossEarnings.toFixed(3)}`;
  document.getElementById('tax-deductions').textContent = `-$${stats.taxDeductions.toFixed(3)}`;
  document.getElementById('user-location').textContent = `${config.country} (${(config.federalTaxRate * 100)}% Tax)`;
});
