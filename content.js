/**
 * GC Steam Hours — Content Script
 * 
 * Runs on gamersclub.com.br/lobby pages.
 * Detects player cards, extracts GC IDs and levels,
 * queries background for Steam playtime, and injects hour badges.
 */

(function () {
  'use strict';

  // Track processed players to avoid duplicate processing
  const processedPlayers = new Set();

  // ─── Level vs Hours Analysis ──────────────────────────────────────────────

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

  // Active configurations (loaded from storage)
  let activeRanges = DEFAULT_RANGES;
  let activeCltLimit = 3;

  /**
   * Load settings from chrome.storage.sync.
   */
  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(['levelRanges', 'cltHoursLimit']);
      if (result.levelRanges && Array.isArray(result.levelRanges) && result.levelRanges.length === 20) {
        activeRanges = result.levelRanges;
      }
      if (result.cltHoursLimit !== undefined) {
        activeCltLimit = result.cltHoursLimit;
      }
    } catch (e) {
      console.warn('[GC Steam Hours] Failed to load settings, using defaults');
    }
  }

  // Listen for storage changes to update settings in real-time
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.levelRanges) {
        activeRanges = changes.levelRanges.newValue || DEFAULT_RANGES;
        console.log('[GC Steam Hours] Level ranges updated:', activeRanges);
      }
      if (changes.cltHoursLimit) {
        activeCltLimit = changes.cltHoursLimit.newValue !== undefined ? changes.cltHoursLimit.newValue : 3;
        console.log('[GC Steam Hours] CLT limit updated:', activeCltLimit);
      }
    }
  });

  /**
   * Analyze compatibility between GC level, CS2 hours, KDR, and Steam level to identify potential smurfs.
   * @param {number} level - GC skill level (1-20)
   * @param {number} hours - CS2 hours played
   * @param {number|null} kdr - Player's KDR (Kill/Death Ratio)
   * @param {number|null} steamLevel - Player's Steam account level
   * @returns {{ status: string, label: string, color: string }}
   */
  function analyzeCompatibility(level, hours, kdr, steamLevel) {
    const range = activeRanges.find(r => r.level === level) || activeRanges[activeRanges.length - 1];
    
    const hasKdr = kdr !== null;
    // "próximo de 1 ou superior" -> KDR >= 0.95
    const isKdrNearOneOrHigher = hasKdr && kdr >= 0.95;

    const hasSteamLevel = steamLevel !== null;
    const isSteamLevelSuspect = hasSteamLevel && steamLevel < 10;

    // Check if hours are below minimum expected range
    if (hours < range.minHours) {
      // If KDR is near 1 or higher, OR Steam level is suspect -> Smurf Safado (Red)
      if (isKdrNearOneOrHigher || isSteamLevelSuspect) {
        let label = 'Smurf safado (Poucas horas e KDR regular/alto)';
        if (isSteamLevelSuspect && !isKdrNearOneOrHigher) {
          label = `Smurf safado (Poucas horas e Nível Steam ${steamLevel} suspeito)`;
        }
        return {
          status: 'smurf',
          label: label,
          color: 'red'
        };
      } else {
        // Below minimum expected hours but KDR is low and Steam level is normal -> Possível Smurf (Yellow)
        return {
          status: 'possible_smurf',
          label: 'Possível smurf (Poucas horas)',
          color: 'yellow'
        };
      }
    }

    // Default green: Compatible/Limpo
    return {
      status: 'compatible',
      label: 'Limpo',
      color: 'green'
    };
  }

  /**
   * Format hours for display.
   * @param {number} hours - Hours played
   * @returns {string} Formatted string (e.g. "1.234h" or "856h")
   */
  function formatHours(hours) {
    if (hours >= 1000) {
      return hours.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + 'h';
    }
    return Math.round(hours) + 'h';
  }

  // ─── UI Injection ─────────────────────────────────────────────────────────

  /**
   * Extract KDR from player card attributes (title or data-tip-text).
   * Prioritizes the 'title' attribute since custom tooltip scripts may alter data-tip-text.
   * @param {HTMLElement} playerCard
   * @returns {number|null} KDR or null if not found
   */
  function extractKdr(playerCard) {
    if (playerCard.dataset.originalKdr) {
      return parseFloat(playerCard.dataset.originalKdr);
    }

    const titleText = playerCard.getAttribute('title') || '';
    const tipText = playerCard.getAttribute('data-tip-text') || '';

    // Strategy 1: Check in the title attribute
    let kdrMatch = titleText.match(/KDR:\s*([0-9.]+)/i);
    if (kdrMatch) return parseFloat(kdrMatch[1]);

    // Strategy 2: Fallback to the data-tip-text attribute
    kdrMatch = tipText.match(/KDR:\s*([0-9.]+)/i);
    return kdrMatch ? parseFloat(kdrMatch[1]) : null;
  }

  /**
   * Evaluate a team room container (.LobbyRoom) and apply borders based on player results.
   * @param {HTMLElement} teamElement
   */
  function evaluateTeamBorders(teamElement) {
    if (!teamElement) return;

    // Find all player cards inside this team room
    const players = teamElement.querySelectorAll('a.LobbyPlayerVertical');
    if (players.length === 0) return;

    let hasRed = false;
    let hasYellow = false;
    let processedCount = 0;

    players.forEach(player => {
      const badge = player.querySelector('.gc-hours-badge');
      if (badge && !badge.classList.contains('gc-hours-badge--loading')) {
        processedCount++;
        if (badge.classList.contains('gc-hours-badge--red')) {
          hasRed = true;
        } else if (badge.classList.contains('gc-hours-badge--yellow')) {
          hasYellow = true;
        }
      }
    });

    // Reset styles
    teamElement.classList.remove('gc-team-border--red', 'gc-team-border--green');

    // Apply borders:
    // 1. If at least one red is found, paint it red immediately.
    // 2. If all players are processed and no red/yellow exists, paint it green.
    if (hasRed) {
      teamElement.classList.add('gc-team-border--red');
    } else if (processedCount === players.length && !hasYellow) {
      teamElement.classList.add('gc-team-border--green');
    }
  }

  /**
   * Helper to append a badge and trigger team border evaluation.
   */
  function appendBadgeAndEvaluate(playerCard, badge) {
    playerCard.appendChild(badge);
    const team = playerCard.closest('.LobbyRoom');
    if (team) {
      evaluateTeamBorders(team);
    }
  }

  /**
   * Create and inject the hours badge into a player card.
   * @param {HTMLElement} playerCard - The <a class="LobbyPlayerVertical"> element
   * @param {Object} data - Player data from background
   * @param {number} level - GC level
   */
  function injectHoursBadge(playerCard, data, level) {
    // Remove existing badges/rows if re-processing
    const existing = playerCard.querySelector('.gc-hours-badge');
    if (existing) existing.remove();
    const existingRow = playerCard.querySelector('.gc-badges-row');
    if (existingRow) existingRow.remove();

    const badge = document.createElement('div');
    badge.className = 'gc-hours-badge gc-compatibility-badge';

    if (data.error === 'NO_API_KEY') {
      badge.classList.add('gc-hours-badge--config');
      badge.innerHTML = `<span class="gc-hours-badge__icon">⚙️</span><span class="gc-hours-badge__text">Config</span>`;
      badge.title = 'Configure sua Steam API Key nas opções da extensão';
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ action: 'openOptions' });
      });
      appendBadgeAndEvaluate(playerCard, badge);
      return;
    }

    if (data.error === 'STEAM_ID_NOT_FOUND' || data.error === 'STEAM_ID_NOT_RESOLVED') {
      badge.classList.add('gc-hours-badge--error');
      badge.innerHTML = `<span class="gc-hours-badge__icon">❓</span><span class="gc-hours-badge__text">N/A</span>`;
      badge.title = 'Não foi possível encontrar o perfil Steam deste jogador';
      appendBadgeAndEvaluate(playerCard, badge);
      return;
    }

    if (data.error === 'INVALID_API_KEY') {
      badge.classList.add('gc-hours-badge--config');
      badge.innerHTML = `<span class="gc-hours-badge__icon">🔑</span><span class="gc-hours-badge__text">Key!</span>`;
      badge.title = 'API Key da Steam inválida. Verifique nas opções da extensão.';
      appendBadgeAndEvaluate(playerCard, badge);
      return;
    }

    if (data.error) {
      badge.classList.add('gc-hours-badge--error');
      badge.innerHTML = `<span class="gc-hours-badge__icon">⚠️</span><span class="gc-hours-badge__text">Erro</span>`;
      badge.title = `Erro: ${data.message || data.error}`;
      appendBadgeAndEvaluate(playerCard, badge);
      return;
    }

    if (data.private) {
      badge.classList.add('gc-hours-badge--private');
      badge.classList.add('gc-hours-badge--circle');
      badge.innerHTML = `<span class="gc-hours-badge__icon">🔒</span>`;
      const steamLvlFormatted = data.steamLevel !== null && data.steamLevel !== undefined ? ` | Steam Lvl ${data.steamLevel}` : '';
      badge.title = `Perfil Steam privado — horas de jogo não disponíveis${steamLvlFormatted}`;
      appendBadgeAndEvaluate(playerCard, badge);
      return;
    }

    // Success: show custom icon based on compatibility analysis
    const kdr = (data.kdr !== undefined && data.kdr !== null) ? data.kdr : extractKdr(playerCard);
    const steamLevel = data.steamLevel !== undefined ? data.steamLevel : null;
    const analysis = analyzeCompatibility(level, data.hours, kdr, steamLevel);
    badge.classList.add(`gc-hours-badge--${analysis.color}`);
    badge.classList.add('gc-hours-badge--circle');

    let icon = '';
    let tooltip = '';

    if (analysis.color === 'red') {
      icon = '✖';
      tooltip = 'Smurf safado';
    } else if (analysis.color === 'green') {
      icon = '✔';
      tooltip = 'Limpo';
    } else if (analysis.color === 'yellow') {
      icon = '❓';
      tooltip = 'Possível smurf safado';
    }

    badge.innerHTML = `<span class="gc-hours-badge__icon">${icon}</span>`;
    
    const kdrFormatted = kdr !== null ? ` | KDR ${kdr.toFixed(2)}` : '';
    const steamLvlFormatted = steamLevel !== null ? ` | Steam Lvl ${steamLevel}` : '';
    badge.title = `${tooltip} (${formatHours(data.hours)} | Nível ${level}${kdrFormatted}${steamLvlFormatted})`;

    // New feature: CLT Hours Check (played in the last 2 weeks divided by 14 days)
    const minutes2weeks = data.minutes2weeks || 0;
    const dailyHours = (minutes2weeks / 60) / 14;
    const cltOk = dailyHours <= activeCltLimit;

    const cltBadge = document.createElement('div');
    cltBadge.className = `gc-hours-badge gc-hours-badge--circle gc-clt-badge gc-hours-badge--${cltOk ? 'green' : 'red'}`;
    cltBadge.innerHTML = `<span class="gc-hours-badge__icon">💼</span>`;
    cltBadge.title = cltOk
      ? `Dentro das regras CLT (Média: ${dailyHours.toFixed(1)}h/dia jogados recentemente)`
      : `Fora das regras CLT (Média: ${dailyHours.toFixed(1)}h/dia jogados recentemente)`;

    // Group both badges inside a flex container row
    const row = document.createElement('div');
    row.className = 'gc-badges-row';
    row.appendChild(badge);
    row.appendChild(cltBadge);

    appendBadgeAndEvaluate(playerCard, row);
  }

  /**
   * Show a loading state on a player card.
   * @param {HTMLElement} playerCard - The player card element
   */
  function showLoadingBadge(playerCard) {
    const existing = playerCard.querySelector('.gc-hours-badge');
    if (existing) return; // Already has a badge
    const existingRow = playerCard.querySelector('.gc-badges-row');
    if (existingRow) return; // Already has a row

    const badge = document.createElement('div');
    badge.className = 'gc-hours-badge gc-hours-badge--loading';
    badge.innerHTML = `<span class="gc-hours-badge__spinner"></span>`;
    badge.title = 'Buscando horas de CS2...';
    playerCard.appendChild(badge);
  }

  // ─── Player Processing Queue & Same-Origin Scraper ────────────────────────

  // Limits the number of concurrent network checks from the content script
  const MAX_CONCURRENT_PLAYERS = 3;
  let activePlayerRequests = 0;
  const playerQueue = [];

  function enqueuePlayerTask(fn) {
    return new Promise((resolve, reject) => {
      playerQueue.push({ resolve, reject, fn });
      processPlayerQueue();
    });
  }

  function processPlayerQueue() {
    while (activePlayerRequests < MAX_CONCURRENT_PLAYERS && playerQueue.length > 0) {
      const { resolve, reject, fn } = playerQueue.shift();
      activePlayerRequests++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activePlayerRequests--;
          processPlayerQueue();
        });
    }
  }

  /**
   * Fetch and scrape GC player profile same-origin.
   * Runs in page context, avoiding Cloudflare 403s.
   * @param {string} gcId
   * @param {string} gcPath
   * @returns {Promise<{ steamUrl: string|null, kdr: number|null }>}
   */
  async function scrapeGCProfileSameOrigin(gcId, gcPath = 'jogador') {
    try {
      const response = await fetch(`/${gcPath}/${gcId}`);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const html = await response.text();

      // 1. Extract Steam URL
      let steamUrl = null;
      
      // Strategy 1: Look for Steam Button
      const steamBtnMatch = html.match(
        /href=["'](https?:\/\/steamcommunity\.com\/(profiles\/\d{17}|id\/[^"']+))["'][^>]*class=["'][^"']*Button--steam/
      );
      if (steamBtnMatch) {
        steamUrl = steamBtnMatch[1];
      }

      if (!steamUrl) {
        // Strategy 2: Generic Steam link
        const steamLinkMatch = html.match(
          /href=["'](https?:\/\/steamcommunity\.com\/(profiles\/\d{17}|id\/[^"']+))["']/
        );
        if (steamLinkMatch) {
          steamUrl = steamLinkMatch[1];
        }
      }

      if (!steamUrl) {
        // Strategy 3: Escape slashes or JSON State
        const steamIdMatch = html.match(/steamcommunity\.com(?:\\?\/)(?:profiles(?:\\?\/)(\d{17})|id(?:\\?\/)([^"'\s<&\\/]+))/);
        if (steamIdMatch) {
          if (steamIdMatch[1]) {
            steamUrl = `https://steamcommunity.com/profiles/${steamIdMatch[1]}`;
          } else if (steamIdMatch[2]) {
            steamUrl = `https://steamcommunity.com/id/${steamIdMatch[2]}`;
          }
        }
      }

      // 2. Extract KDR
      const kdrMatch = html.match(/StatsBoxPlayerInfoItem__name">\s*KDR\s*<\/div>(?:[\s\S]*?)StatsBoxPlayerInfoItem__value">\s*([0-9.]+)\s*<\/div>/i);
      const kdr = kdrMatch ? parseFloat(kdrMatch[1]) : null;

      return { steamUrl, kdr };
    } catch (error) {
      console.warn(`[GC Steam Hours] Same-origin fetch failed for player ${gcId}:`, error);
      return null;
    }
  }

  // ─── Iframe-based Steam ID Resolution ──────────────────────────────────────

  // Pool to limit concurrent iframe loads
  const IFRAME_MAX_CONCURRENT = 2;
  let activeIframes = 0;
  const iframeQueue = [];

  function enqueueIframeTask(fn) {
    return new Promise((resolve, reject) => {
      iframeQueue.push({ resolve, reject, fn });
      processIframeQueue();
    });
  }

  function processIframeQueue() {
    while (activeIframes < IFRAME_MAX_CONCURRENT && iframeQueue.length > 0) {
      const { resolve, reject, fn } = iframeQueue.shift();
      activeIframes++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeIframes--;
          processIframeQueue();
        });
    }
  }

  /**
   * Load a GC player profile in a hidden iframe and extract the Steam URL.
   * This works even for SPA-rendered pages because the iframe executes JavaScript.
   * @param {string} gcId - GamersClub player ID
   * @param {string} [gcPath] - Path part of the GC profile ('jogador' or 'player')
   * @returns {Promise<string|null>} Steam community URL or null
   */
  function resolveSteamUrlViaIframe(gcId, gcPath = 'jogador') {
    return enqueueIframeTask(() => new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      iframe.src = `/${gcPath}/${gcId}`;

      const TIMEOUT_MS = 15000; // 15 seconds max
      const POLL_INTERVAL_MS = 500;
      let pollTimer = null;
      let resolved = false;

      function cleanup() {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutTimer);
        clearInterval(pollTimer);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }

      function tryExtract() {
        try {
          const doc = iframe.contentDocument;
          if (!doc) return null;

          // 1. Look for the Steam button
          let steamUrl = null;
          const steamBtn = doc.querySelector('a.Button--steam');
          if (steamBtn) {
            const href = steamBtn.getAttribute('href');
            if (href && href.includes('steamcommunity.com')) {
              steamUrl = href;
            }
          }

          if (!steamUrl) {
            // Fallback: any link to steamcommunity.com
            const steamLinks = doc.querySelectorAll('a[href*="steamcommunity.com"]');
            for (const link of steamLinks) {
              const href = link.getAttribute('href');
              if (href && (href.includes('/profiles/') || href.includes('/id/'))) {
                steamUrl = href;
                break;
              }
            }
          }

          // 2. Look for KDR value from DOM
          let kdr = null;
          const statsBoxes = doc.querySelectorAll('.StatsBoxPlayerInfoItem__Content');
          for (const box of statsBoxes) {
            const nameEl = box.querySelector('.StatsBoxPlayerInfoItem__name');
            if (nameEl && nameEl.textContent.trim().toUpperCase() === 'KDR') {
              const valEl = box.querySelector('.StatsBoxPlayerInfoItem__value');
              if (valEl) {
                kdr = parseFloat(valEl.textContent.trim());
                break;
              }
            }
          }

          // Only return successfully resolved data if we found the Steam URL
          if (steamUrl) {
            return { steamUrl, kdr };
          }

          return null;
        } catch (e) {
          // Cross-origin or access error
          return null;
        }
      }

      // Timeout: give up after TIMEOUT_MS
      const timeoutTimer = setTimeout(() => {
        console.warn(`[GC Steam Hours] Iframe timeout for player ${gcId}`);
        cleanup();
        resolve(null);
      }, TIMEOUT_MS);

      // When iframe loads, start polling for the Steam button
      // (SPA may need extra time to render after initial load)
      iframe.addEventListener('load', () => {
        // Try immediately
        const res = tryExtract();
        if (res) {
          cleanup();
          resolve(res);
          return;
        }

        // Poll until the Steam button appears or we give up
        let pollCount = 0;
        const MAX_POLLS = 20; // 10 seconds of polling
        pollTimer = setInterval(() => {
          pollCount++;
          const res = tryExtract();
          if (res || pollCount >= MAX_POLLS) {
            cleanup();
            resolve(res);
          }
        }, POLL_INTERVAL_MS);
      });

      iframe.addEventListener('error', () => {
        cleanup();
        resolve(null);
      });

      document.body.appendChild(iframe);
    }));
  }

  /**
   * Parse a Steam ID 64 from a Steam community URL.
   * @param {string} url - Steam community URL
   * @returns {string|null} Steam ID 64 or null (vanity URLs need API resolution)
   */
  function parseSteamId64FromUrl(url) {
    if (!url) return null;
    const match = url.match(/steamcommunity\.com\/profiles\/(\d{17})/);
    return match ? match[1] : null;
  }

  // ─── Player Processing ────────────────────────────────────────────────────

  /**
   * Process a single player card: extract data and request Steam hours.
   * Uses background fetch first, falls back to iframe resolution.
   * @param {HTMLElement} playerCard - The <a class="LobbyPlayerVertical"> element
   */
  async function processPlayerCard(playerCard) {
    // Extract GC ID from href (handles /jogador/ID and /player/ID)
    const href = playerCard.getAttribute('href');
    if (!href) return;

    const gcIdMatch = href.match(/\/(jogador|player)\/(\d+)/);
    if (!gcIdMatch) return;

    const gcPath = gcIdMatch[1];
    const gcId = gcIdMatch[2];

    // Skip if already processed
    if (processedPlayers.has(gcId)) {
      // But check if the badge/row is missing (e.g., DOM was rebuilt)
      if (playerCard.querySelector('.gc-hours-badge') || playerCard.querySelector('.gc-badges-row')) return;
    }

    processedPlayers.add(gcId);

    // Extract level from LevelBadge (handles both subscriber and non-subscriber styles)
    const levelContainer = playerCard.querySelector('[class*="LevelBadge"]');
    let level = 0;
    if (levelContainer) {
      const digits = levelContainer.textContent.replace(/\D/g, '');
      level = digits ? parseInt(digits, 10) : 0;
    }

    // Show loading state
    showLoadingBadge(playerCard);

    try {
      // Step 1: Try the background (checks cache only)
      let data = await chrome.runtime.sendMessage({
        action: 'getPlayerData',
        gcId: gcId,
        gcPath: gcPath
      });

      // Step 2: Cache miss -> scrape GC profile directly (same-origin fetch, bypasses Cloudflare)
      if (data && data.error === 'CACHE_MISS') {
        console.log(`[GC Steam Hours] Cache miss for ${gcId}. Scraping profile via same-origin fetch...`);
        const scraped = await scrapeGCProfileSameOrigin(gcId, gcPath);

        if (scraped && scraped.steamUrl) {
          const { steamUrl, kdr } = scraped;
          const steamId64 = parseSteamId64FromUrl(steamUrl);

          if (steamId64) {
            data = await chrome.runtime.sendMessage({
              action: 'getPlayerDataWithSteamId',
              gcId: gcId,
              steamId64: steamId64,
              kdr: kdr
            });
          } else {
            data = await chrome.runtime.sendMessage({
              action: 'getPlayerDataWithSteamUrl',
              gcId: gcId,
              steamUrl: steamUrl,
              kdr: kdr
            });
          }
        } else {
          // If direct fetch fails, fall back to iframe as a last resort
          console.warn(`[GC Steam Hours] Same-origin fetch failed to resolve Steam URL for ${gcId}. Trying iframe fallback...`);
          const iframeResult = await resolveSteamUrlViaIframe(gcId, gcPath);
          if (iframeResult && iframeResult.steamUrl) {
            const { steamUrl, kdr } = iframeResult;
            const steamId64 = parseSteamId64FromUrl(steamUrl);

            if (steamId64) {
              data = await chrome.runtime.sendMessage({
                action: 'getPlayerDataWithSteamId',
                gcId: gcId,
                steamId64: steamId64,
                kdr: kdr
              });
            } else {
              data = await chrome.runtime.sendMessage({
                action: 'getPlayerDataWithSteamUrl',
                gcId: gcId,
                steamUrl: steamUrl,
                kdr: kdr
              });
            }
          } else {
            data = { error: 'STEAM_ID_NOT_FOUND', gcId };
          }
        }
      }

      // Inject the result badge
      injectHoursBadge(playerCard, data, level);
    } catch (error) {
      console.error(`[GC Steam Hours] Error processing player ${gcId}:`, error);
      injectHoursBadge(playerCard, { error: 'UNKNOWN_ERROR', message: error.message }, level);
    } finally {
      playerCard.classList.remove('gc-processing');
    }
  }

  // ─── Page Scanning ────────────────────────────────────────────────────────

  /**
   * Scan the page for player cards and process them.
   */
  function scanForPlayers() {
    const playerCards = document.querySelectorAll('a.LobbyPlayerVertical');
    playerCards.forEach(card => {
      // Capture KDR immediately on scan before GC's tooltip script removes/alters the title attribute
      if (card.dataset.originalKdr === undefined) {
        const kdr = extractKdr(card);
        if (kdr !== null) {
          card.dataset.originalKdr = kdr.toString();
        }
      }

      // Only process cards that don't have a badge or row yet, and are not currently processing
      if (!card.querySelector('.gc-hours-badge') && !card.querySelector('.gc-badges-row') && !card.classList.contains('gc-processing')) {
        card.classList.add('gc-processing');
        enqueuePlayerTask(() => processPlayerCard(card));
      }
    });
  }

  // ─── MutationObserver ─────────────────────────────────────────────────────

  /**
   * Set up a MutationObserver to detect dynamically loaded lobby content.
   */
  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      let hasNewPlayers = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;

            // Check if the added node is a player card
            if (node.matches && node.matches('a.LobbyPlayerVertical')) {
              hasNewPlayers = true;
              break;
            }

            // Check if the added node contains player cards
            if (node.querySelector && node.querySelector('a.LobbyPlayerVertical')) {
              hasNewPlayers = true;
              break;
            }
          }
        }

        if (hasNewPlayers) break;
      }

      if (hasNewPlayers) {
        // Debounce: wait a bit for the DOM to settle
        clearTimeout(scanDebounceTimer);
        scanDebounceTimer = setTimeout(scanForPlayers, 300);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    return observer;
  }

  let scanDebounceTimer = null;

  // ─── Initialization ───────────────────────────────────────────────────────

  async function init() {
    // Check if extension is enabled
    const settings = await chrome.storage.sync.get('extensionEnabled');
    if (settings.extensionEnabled === false) {
      console.log('[GC Steam Hours] Extension is disabled');
      return;
    }

    console.log('[GC Steam Hours] Extension loaded on lobby page');

    // Load settings from storage
    await loadSettings();

    // Initial scan
    scanForPlayers();

    // Watch for dynamic content changes
    setupObserver();

    // Re-scan periodically as a fallback (every 5 seconds)
    setInterval(() => {
      const cards = document.querySelectorAll('a.LobbyPlayerVertical:not(:has(.gc-hours-badge))');
      if (cards.length > 0) {
        scanForPlayers();
      }
    }, 5000);
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
