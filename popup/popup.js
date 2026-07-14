/**
 * GC Steam Hours — Popup Script
 */

document.addEventListener('DOMContentLoaded', () => {
  const versionEl = document.getElementById('version');
  const apiStatusEl = document.getElementById('apiStatus');
  const apiStatusIcon = document.getElementById('apiStatusIcon');
  const apiStatusText = document.getElementById('apiStatusText');
  const cachedPlayers = document.getElementById('cachedPlayers');
  const cachedHours = document.getElementById('cachedHours');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const optionsBtn = document.getElementById('optionsBtn');

  // Show version
  const manifest = chrome.runtime.getManifest();
  versionEl.textContent = `v${manifest.version}`;

  // Check API key status
  chrome.storage.sync.get('steamApiKey', (result) => {
    if (result.steamApiKey) {
      apiStatusEl.classList.add('popup__status--ok');
      apiStatusIcon.textContent = '✅';
      apiStatusText.textContent = 'API Key configurada';
    } else {
      apiStatusEl.classList.add('popup__status--error');
      apiStatusIcon.textContent = '⚠️';
      apiStatusText.textContent = 'API Key não configurada';
    }
  });

  // Load cache stats
  chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
    if (response) {
      cachedPlayers.textContent = response.cachedSteamIds || 0;
      cachedHours.textContent = response.cachedPlaytimes || 0;
    }
  });

  // Clear cache button
  clearCacheBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearCache' }, (response) => {
      if (response) {
        cachedPlayers.textContent = '0';
        cachedHours.textContent = '0';
        clearCacheBtn.textContent = '✅ Limpo!';
        setTimeout(() => {
          clearCacheBtn.textContent = '🗑️ Limpar Cache';
        }, 1500);
      }
    });
  });

  // Options button
  optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
