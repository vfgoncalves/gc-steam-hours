/**
 * GC Steam Hours — Options Page Script
 */

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
  const testKeyBtn = document.getElementById('testKeyBtn');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const keyFeedback = document.getElementById('keyFeedback');
  const extensionEnabled = document.getElementById('extensionEnabled');
  const cacheTtl = document.getElementById('cacheTtl');
  const cltHoursLimit = document.getElementById('cltHoursLimit');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const settingsFeedback = document.getElementById('settingsFeedback');
  const saveRangesBtn = document.getElementById('saveRangesBtn');
  const resetRangesBtn = document.getElementById('resetRangesBtn');
  const rangesFeedback = document.getElementById('rangesFeedback');
  const versionEl = document.getElementById('version');

  // Default level ranges for each individual level 1-20
  const DEFAULT_RANGES = [
    { level: 1,  minHours: 0 },
    { level: 2,  minHours: 0 },
    { level: 3,  minHours: 0 },
    { level: 4,  minHours: 0 },
    { level: 5,  minHours: 0 },
    { level: 6,  minHours: 100 },
    { level: 7,  minHours: 200 },
    { level: 8,  minHours: 300 },
    { level: 9,  minHours: 400 },
    { level: 10, minHours: 500 },
    { level: 11, minHours: 600 },
    { level: 12, minHours: 700 },
    { level: 13, minHours: 800 },
    { level: 14, minHours: 900 },
    { level: 15, minHours: 1000 },
    { level: 16, minHours: 1100 },
    { level: 17, minHours: 1200 },
    { level: 18, minHours: 1300 },
    { level: 19, minHours: 1400 },
    { level: 20, minHours: 1500 },
  ];

  // Show version
  const manifest = chrome.runtime.getManifest();
  versionEl.textContent = manifest.version;

  // ─── Load saved settings ─────────────────────────────────────────────────

  chrome.storage.sync.get(['steamApiKey', 'extensionEnabled', 'cacheTtlMinutes', 'cltHoursLimit', 'levelRanges'], (result) => {
    if (result.steamApiKey) {
      apiKeyInput.value = result.steamApiKey;
    }
    if (result.extensionEnabled !== undefined) {
      extensionEnabled.checked = result.extensionEnabled;
    }
    if (result.cacheTtlMinutes !== undefined) {
      cacheTtl.value = result.cacheTtlMinutes;
    } else {
      cacheTtl.value = 720;
    }
    if (result.cltHoursLimit !== undefined) {
      cltHoursLimit.value = result.cltHoursLimit;
    } else {
      cltHoursLimit.value = 3;
    }
    // Load level ranges
    loadRangesToUI(result.levelRanges || DEFAULT_RANGES);
  });

  // ─── Level Ranges helpers ───────────────────────────────────────────────

  const rangesTableBody = document.getElementById('rangesTableBody');

  function loadRangesToUI(ranges) {
    if (!rangesTableBody) return;
    rangesTableBody.innerHTML = '';
    ranges.forEach((range, i) => {
      const levelNum = range.level || (i + 1);
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="options__ranges-label">Nível ${levelNum}</td>
        <td><input type="number" class="options__input options__input--table" id="range${i}Min" min="0" max="99999" value="${range.minHours}"></td>
      `;
      rangesTableBody.appendChild(row);
    });
  }

  function readRangesFromUI() {
    const ranges = [];
    for (let i = 0; i < 20; i++) {
      const minEl = document.getElementById(`range${i}Min`);
      if (minEl) {
        ranges.push({
          level: i + 1,
          minHours: parseInt(minEl.value, 10) || 0,
        });
      }
    }
    return ranges;
  }

  // ─── Toggle key visibility ───────────────────────────────────────────────

  toggleKeyVisibility.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyVisibility.textContent = '🙈';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyVisibility.textContent = '👁️';
    }
  });

  // ─── Feedback helper ─────────────────────────────────────────────────────

  function showFeedback(element, type, message) {
    element.className = `options__feedback options__feedback--visible options__feedback--${type}`;
    element.textContent = message;

    // Auto-hide after 5 seconds for success
    if (type === 'success') {
      setTimeout(() => {
        element.classList.remove('options__feedback--visible');
      }, 5000);
    }
  }

  // ─── Test API Key ────────────────────────────────────────────────────────

  testKeyBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();

    if (!key) {
      showFeedback(keyFeedback, 'error', '❌ Digite uma API Key primeiro');
      return;
    }

    testKeyBtn.disabled = true;
    testKeyBtn.textContent = '⏳ Testando...';
    showFeedback(keyFeedback, 'info', '🔄 Validando a key na Steam API...');

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'validateApiKey',
        apiKey: key
      });

      if (response && response.valid) {
        showFeedback(keyFeedback, 'success', '✅ API Key válida! Pode salvar.');
      } else {
        showFeedback(keyFeedback, 'error', '❌ API Key inválida. Verifique e tente novamente.');
      }
    } catch (error) {
      showFeedback(keyFeedback, 'error', `❌ Erro ao validar: ${error.message}`);
    }

    testKeyBtn.disabled = false;
    testKeyBtn.textContent = '🧪 Testar Key';
  });

  // ─── Save API Key ───────────────────────────────────────────────────────

  saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();

    if (!key) {
      showFeedback(keyFeedback, 'error', '❌ Digite uma API Key');
      return;
    }

    // Basic format validation (Steam API keys are 32 hex characters)
    if (!/^[A-Fa-f0-9]{32}$/.test(key)) {
      showFeedback(keyFeedback, 'error', '⚠️ Formato inválido. A Steam API Key deve ter 32 caracteres hexadecimais.');
      return;
    }

    chrome.storage.sync.set({ steamApiKey: key }, () => {
      showFeedback(keyFeedback, 'success', '✅ API Key salva com sucesso!');
    });
  });

  // ─── Save Settings ──────────────────────────────────────────────────────

  saveSettingsBtn.addEventListener('click', () => {
    const enabled = extensionEnabled.checked;
    const ttl = parseInt(cacheTtl.value, 10);
    const cltLimit = parseFloat(cltHoursLimit.value);

    if (isNaN(ttl) || ttl < 5 || ttl > 1440) {
      showFeedback(settingsFeedback, 'error', '❌ TTL deve ser entre 5 e 1440 minutos');
      return;
    }

    if (isNaN(cltLimit) || cltLimit < 1 || cltLimit > 24) {
      showFeedback(settingsFeedback, 'error', '❌ O limite CLT deve ser entre 1 e 24 horas');
      return;
    }

    chrome.storage.sync.set({
      extensionEnabled: enabled,
      cacheTtlMinutes: ttl,
      cltHoursLimit: cltLimit
    }, () => {
      showFeedback(settingsFeedback, 'success', '✅ Preferências salvas!');
    });
  });

  // ─── Save Level Ranges ──────────────────────────────────────────────────

  saveRangesBtn.addEventListener('click', () => {
    const ranges = readRangesFromUI();

    // Validate
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (r.minHours < 0) {
        showFeedback(rangesFeedback, 'error', `❌ Horas não podem ser negativas (Nível ${r.level})`);
        return;
      }
    }

    chrome.storage.sync.set({ levelRanges: ranges }, () => {
      showFeedback(rangesFeedback, 'success', '✅ Faixas de nível salvas!');
    });
  });

  // ─── Reset Level Ranges ─────────────────────────────────────────────────

  resetRangesBtn.addEventListener('click', () => {
    loadRangesToUI(DEFAULT_RANGES);
    chrome.storage.sync.set({ levelRanges: DEFAULT_RANGES }, () => {
      showFeedback(rangesFeedback, 'success', '🔄 Faixas restauradas para os valores padrão!');
    });
  });
});
