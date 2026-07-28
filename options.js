document.addEventListener('DOMContentLoaded', async () => {
  const input = document.getElementById('payout-token');
  const status = document.getElementById('status');
  const stored = await chrome.storage.local.get('payoutApiToken');

  input.value = stored.payoutApiToken || '';

  document.getElementById('save').addEventListener('click', async () => {
    const token = input.value.trim();
    if (token.length < 24) {
      status.textContent = 'Enter a valid token of at least 24 characters.';
      return;
    }

    await chrome.storage.local.set({ payoutApiToken: token });
    status.textContent = 'Token saved.';
  });
});
