/**
 * GC Steam Hours — Background Service Worker
 * 
 * Handles:
 * 1. Fetching GC player profile pages to extract Steam IDs
 * 2. Querying Steam API for CS2 playtime
 * 3. Caching results in chrome.storage.local
 * 4. Responding to content script messages
 */

// Import steam-api utilities inline (service workers can't use ES modules without type:module)
// We inline the key functions here since MV3 service workers have import limitations.

const CS2_APP_ID = 730;
const STEAM_API_BASE = 'https://api.steampowered.com';

// Cache TTLs (in milliseconds)
const STEAM_ID_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PLAYTIME_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

// Throttle: max concurrent requests
const MAX_CONCURRENT = 3;
let activeRequests = 0;
const requestQueue = [];

// ─── Steam API Functions ────────────────────────────────────────────────────

async function getCS2Playtime(apiKey, steamId64) {
  const url = new URL(`${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamid', steamId64);
  url.searchParams.set('include_played_free_games', 'true');
  url.searchParams.set('appids_filter[0]', CS2_APP_ID.toString());
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString());

  if (!response.ok) {
    if (response.status === 403) throw new Error('INVALID_API_KEY');
    throw new Error(`Steam API error: ${response.status}`);
  }

  const data = await response.json();

  if (!data.response || !data.response.games || data.response.games.length === 0) {
    return null; // Private profile or CS2 not found
  }

  const cs2 = data.response.games.find(g => g.appid === CS2_APP_ID);
  if (!cs2) return null;

  const minutes = cs2.playtime_forever || 0;
  if (minutes === 0) {
    return null; // Treat 0 minutes as private/hidden playtime (common Steam privacy option)
  }
  const minutes2weeks = cs2.playtime_2weeks || 0;

  return {
    minutes,
    hours: Math.round((minutes / 60) * 10) / 10,
    minutes2weeks
  };
}

async function getSteamLevel(apiKey, steamId64) {
  const url = new URL(`${STEAM_API_BASE}/IPlayerService/GetSteamLevel/v1/`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamid', steamId64);
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString());
  if (!response.ok) {
    if (response.status === 403) throw new Error('INVALID_API_KEY');
    return null;
  }
  const data = await response.json();
  return (data.response && typeof data.response.player_level === 'number') ? data.response.player_level : null;
}

async function getSteamUserData(apiKey, steamId64) {
  const [playtimeResult, levelResult] = await Promise.allSettled([
    getCS2Playtime(apiKey, steamId64),
    getSteamLevel(apiKey, steamId64)
  ]);

  const playtime = playtimeResult.status === 'fulfilled' ? playtimeResult.value : null;
  const steamLevel = levelResult.status === 'fulfilled' ? levelResult.value : null;

  if (playtime === null) {
    return { private: true, steamLevel };
  }

  return {
    minutes: playtime.minutes,
    hours: playtime.hours,
    minutes2weeks: playtime.minutes2weeks,
    steamLevel
  };
}

async function resolveVanityUrl(apiKey, vanityName) {
  const url = new URL(`${STEAM_API_BASE}/ISteamUser/ResolveVanityURL/v1/`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('vanityurl', vanityName);
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Steam API error: ${response.status}`);

  const data = await response.json();
  return (data.response && data.response.success === 1) ? data.response.steamid : null;
}

async function validateApiKey(apiKey) {
  try {
    const url = new URL(`${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('steamids', '76561197960435530');
    url.searchParams.set('format', 'json');
    const response = await fetch(url.toString());
    return response.ok;
  } catch {
    return false;
  }
}

async function extractSteamId64FromUrl(steamUrl, apiKey) {
  if (!steamUrl) return null;

  const profileMatch = steamUrl.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (profileMatch) return profileMatch[1];

  const vanityMatch = steamUrl.match(/steamcommunity\.com\/id\/([^/?#]+)/);
  if (vanityMatch && apiKey) return await resolveVanityUrl(apiKey, vanityMatch[1]);

  return null;
}

// ─── Cache Functions ────────────────────────────────────────────────────────

function getCacheKey(type, id) {
  return `cache_${type}_${id}`;
}

async function getCached(type, id) {
  const key = getCacheKey(type, id);
  const result = await chrome.storage.local.get(key);
  const entry = result[key];

  if (!entry) return null;

  let ttl = STEAM_ID_CACHE_TTL;
  if (type !== 'steamId') {
    const settings = await chrome.storage.sync.get('cacheTtlMinutes');
    const customTtl = settings.cacheTtlMinutes ? settings.cacheTtlMinutes * 60 * 1000 : PLAYTIME_CACHE_TTL;
    ttl = customTtl;
  }

  if (Date.now() - entry.timestamp > ttl) {
    // Cache expired
    await chrome.storage.local.remove(key);
    return null;
  }

  return entry.data;
}

async function setCache(type, id, data) {
  const key = getCacheKey(type, id);
  await chrome.storage.local.set({
    [key]: {
      data,
      timestamp: Date.now()
    }
  });
}

// ─── GC Profile Scraping ────────────────────────────────────────────────────

/**
 * Scrape a GC player's profile page to extract Steam URL and KDR.
 * @param {string} gcId - GamersClub player ID
 * @param {string} [gcPath] - GamersClub path ('jogador' or 'player')
 * @returns {Promise<{ steamUrl: string|null, kdr: number|null }>} Scraped data
 */
async function scrapeGCProfile(gcId, gcPath = 'jogador') {
  try {
    const response = await fetch(`https://gamersclub.com.br/${gcPath}/${gcId}`, {
      credentials: 'include', // Include cookies for authenticated access
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
      }
    });

    if (!response.ok) {
      console.warn(`[GC Steam Hours] Failed to fetch GC profile ${gcId} via ${gcPath}: ${response.status}`);
      return { steamUrl: null, kdr: null };
    }

    const html = await response.text();

    // 1. Extract Steam URL
    let steamUrl = null;

    // Strategy 1: Look for the Steam button (class="Button--steam")
    // DOM: <a href="http://steamcommunity.com/profiles/XXXXX" class="Button Button--steam">
    const steamBtnMatch = html.match(
      /href=["'](https?:\/\/steamcommunity\.com\/(profiles\/\d{17}|id\/[^"']+))["'][^>]*class=["'][^"']*Button--steam/
    );
    if (steamBtnMatch) {
      steamUrl = steamBtnMatch[1];
    }

    if (!steamUrl) {
      // Strategy 2: Generic steamcommunity.com href links
      const steamLinkMatch = html.match(
        /href=["'](https?:\/\/steamcommunity\.com\/(profiles\/\d{17}|id\/[^"']+))["']/
      );
      if (steamLinkMatch) {
        steamUrl = steamLinkMatch[1];
      }
    }

    if (!steamUrl) {
      // Strategy 3: Steam URL anywhere in the page (JSON data, script tags, etc.)
      // Matches both regular / and escaped \/ slashes
      const steamIdMatch = html.match(/steamcommunity\.com(?:\\?\/)(?:profiles(?:\\?\/)(\d{17})|id(?:\\?\/)([^"'\s<&\\/]+))/);
      if (steamIdMatch) {
        if (steamIdMatch[1]) {
          steamUrl = `https://steamcommunity.com/profiles/${steamIdMatch[1]}`;
        } else if (steamIdMatch[2]) {
          steamUrl = `https://steamcommunity.com/id/${steamIdMatch[2]}`;
        }
      }
    }

    // 2. Extract KDR from profile DOM
    // Structure: StatsBoxPlayerInfoItem__name">KDR</div> ... StatsBoxPlayerInfoItem__value">1.25</div>
    const kdrMatch = html.match(/StatsBoxPlayerInfoItem__name">\s*KDR\s*<\/div>(?:[\s\S]*?)StatsBoxPlayerInfoItem__value">\s*([0-9.]+)\s*<\/div>/i);
    const kdr = kdrMatch ? parseFloat(kdrMatch[1]) : null;

    return { steamUrl, kdr };
  } catch (error) {
    console.error(`[GC Steam Hours] Error scraping GC profile ${gcId}:`, error);
    return { steamUrl: null, kdr: null };
  }
}

// ─── Throttled Request Processing ───────────────────────────────────────────

function processQueue() {
  while (activeRequests < MAX_CONCURRENT && requestQueue.length > 0) {
    const { resolve, reject, fn } = requestQueue.shift();
    activeRequests++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeRequests--;
        processQueue();
      });
  }
}

function enqueueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, fn });
    processQueue();
  });
}

// ─── Main Player Data Resolution ────────────────────────────────────────────

/**
 * Get complete player data: Steam ID + CS2 playtime.
 * Uses cache when available.
 * @param {string} gcId - GamersClub player ID
 * @param {string} [gcPath] - Path part of the GC profile ('jogador' or 'player')
 * @returns {Promise<Object>} Player data object
 */
async function getPlayerData(gcId, gcPath) {
  // Get API key from storage
  const settings = await chrome.storage.sync.get('steamApiKey');
  const apiKey = settings.steamApiKey;

  if (!apiKey) {
    return { error: 'NO_API_KEY', gcId };
  }

  // Step 1: Resolve GC ID → Steam ID 64
  let steamIdCache = await getCached('steamId', gcId);
  let steamId64 = null;
  let kdr = null;

  if (steamIdCache) {
    if (typeof steamIdCache === 'string') {
      steamId64 = steamIdCache;
    } else {
      steamId64 = steamIdCache.steamId64;
      kdr = steamIdCache.kdr;
    }
  }

  if (!steamId64) {
    return { error: 'CACHE_MISS', gcId };
  }

  // Step 2: Get CS2 playtime and Steam level
  let playtime = await getCached('playtime', steamId64);

  if (playtime === null || playtime === undefined) {
    try {
      playtime = await getSteamUserData(apiKey, steamId64);
      await setCache('playtime', steamId64, playtime);
    } catch (error) {
      if (error.message === 'INVALID_API_KEY') {
        return { error: 'INVALID_API_KEY', gcId };
      }
      return { error: 'STEAM_API_ERROR', gcId, message: error.message };
    }
  }

  if (playtime.private) {
    return { gcId, steamId64, private: true, steamLevel: playtime.steamLevel, kdr };
  }

  return {
    gcId,
    steamId64,
    hours: playtime.hours,
    minutes: playtime.minutes,
    minutes2weeks: playtime.minutes2weeks,
    steamLevel: playtime.steamLevel,
    kdr
  };
}

// ─── Message Listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getPlayerData') {
    // Enqueue the request with throttling
    enqueueRequest(() => getPlayerData(message.gcId, message.gcPath))
      .then(data => sendResponse(data))
      .catch(error => sendResponse({ error: 'UNKNOWN_ERROR', message: error.message }));
    return true; // Keep message channel open for async response
  }

  // New action: content script already resolved the Steam ID (via iframe)
  if (message.action === 'getPlayerDataWithSteamId') {
    const { gcId, steamId64, kdr } = message;
    // Cache the resolved Steam ID and KDR
    setCache('steamId', gcId, { steamId64, kdr })
      .then(() => {
        // Now get the playtime and level
        return chrome.storage.sync.get('steamApiKey');
      })
      .then(async (settings) => {
        const apiKey = settings.steamApiKey;
        if (!apiKey) return { error: 'NO_API_KEY', gcId };

        let playtime = await getCached('playtime', steamId64);

        if (playtime === null || playtime === undefined) {
          try {
            playtime = await getSteamUserData(apiKey, steamId64);
            await setCache('playtime', steamId64, playtime);
          } catch (error) {
            if (error.message === 'INVALID_API_KEY') {
              return { error: 'INVALID_API_KEY', gcId };
            }
            return { error: 'STEAM_API_ERROR', gcId, message: error.message };
          }
        }

        if (playtime.private) {
          return { gcId, steamId64, private: true, steamLevel: playtime.steamLevel, kdr };
        }

        return { gcId, steamId64, hours: playtime.hours, minutes: playtime.minutes, minutes2weeks: playtime.minutes2weeks, steamLevel: playtime.steamLevel, kdr };
      })
      .then(data => sendResponse(data))
      .catch(error => sendResponse({ error: 'UNKNOWN_ERROR', message: error.message }));
    return true;
  }

  // New action: content script resolved a Steam URL (may be vanity URL)
  if (message.action === 'getPlayerDataWithSteamUrl') {
    const { gcId, steamUrl, kdr } = message;

    (async () => {
      const settings = await chrome.storage.sync.get('steamApiKey');
      const apiKey = settings.steamApiKey;
      if (!apiKey) return { error: 'NO_API_KEY', gcId };

      const steamId64 = await extractSteamId64FromUrl(steamUrl, apiKey);
      if (!steamId64) return { error: 'STEAM_ID_NOT_RESOLVED', gcId };

      await setCache('steamId', gcId, { steamId64, kdr });

      let playtime = await getCached('playtime', steamId64);
      if (playtime === null || playtime === undefined) {
        try {
          playtime = await getSteamUserData(apiKey, steamId64);
          await setCache('playtime', steamId64, playtime);
        } catch (error) {
          if (error.message === 'INVALID_API_KEY') return { error: 'INVALID_API_KEY', gcId };
          return { error: 'STEAM_API_ERROR', gcId, message: error.message };
        }
      }

      if (playtime.private) return { gcId, steamId64, private: true, steamLevel: playtime.steamLevel, kdr };
      return { gcId, steamId64, hours: playtime.hours, minutes: playtime.minutes, minutes2weeks: playtime.minutes2weeks, steamLevel: playtime.steamLevel, kdr };
    })()
      .then(data => sendResponse(data))
      .catch(error => sendResponse({ error: 'UNKNOWN_ERROR', message: error.message }));
    return true;
  }

  if (message.action === 'validateApiKey') {
    validateApiKey(message.apiKey)
      .then(valid => sendResponse({ valid }))
      .catch(() => sendResponse({ valid: false }));
    return true;
  }

  if (message.action === 'clearCache') {
    chrome.storage.local.get(null, (items) => {
      const cacheKeys = Object.keys(items).filter(k => k.startsWith('cache_'));
      chrome.storage.local.remove(cacheKeys, () => {
        sendResponse({ cleared: cacheKeys.length });
      });
    });
    return true;
  }

  if (message.action === 'getStats') {
    chrome.storage.local.get(null, (items) => {
      const cacheKeys = Object.keys(items).filter(k => k.startsWith('cache_'));
      const steamIdKeys = cacheKeys.filter(k => k.startsWith('cache_steamId_'));
      const playtimeKeys = cacheKeys.filter(k => k.startsWith('cache_playtime_'));
      sendResponse({
        cachedSteamIds: steamIdKeys.length,
        cachedPlaytimes: playtimeKeys.length,
        totalCacheEntries: cacheKeys.length
      });
    });
    return true;
  }
});

// ─── Extension Install/Update ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open options page on first install
    chrome.runtime.openOptionsPage();
  }
});
