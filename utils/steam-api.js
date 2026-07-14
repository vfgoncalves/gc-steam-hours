/**
 * Steam Web API helper utilities.
 * Used by the background service worker to query player data.
 */

const CS2_APP_ID = 730;
const STEAM_API_BASE = 'https://api.steampowered.com';

/**
 * Get CS2 playtime for a given Steam ID 64.
 * @param {string} apiKey - Steam Web API key
 * @param {string} steamId64 - 64-bit Steam ID
 * @returns {Promise<{hours: number, minutes: number} | null>}
 *   Returns playtime object or null if profile is private / game not found.
 */
async function getCS2Playtime(apiKey, steamId64) {
  const url = new URL(`${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamid', steamId64);
  url.searchParams.set('include_played_free_games', 'true');
  url.searchParams.set('appids_filter[0]', CS2_APP_ID.toString());
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString());

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error('INVALID_API_KEY');
    }
    throw new Error(`Steam API error: ${response.status}`);
  }

  const data = await response.json();

  // Empty response means private profile or no games visible
  if (!data.response || !data.response.games || data.response.games.length === 0) {
    return null;
  }

  const cs2 = data.response.games.find(g => g.appid === CS2_APP_ID);
  if (!cs2) return null;

  const minutes = cs2.playtime_forever || 0;
  return {
    minutes,
    hours: Math.round((minutes / 60) * 10) / 10 // 1 decimal place
  };
}

/**
 * Resolve a Steam vanity URL name to a Steam ID 64.
 * @param {string} apiKey - Steam Web API key
 * @param {string} vanityName - The custom URL name (e.g. "gaben")
 * @returns {Promise<string|null>} The 64-bit Steam ID or null if not found
 */
async function resolveVanityUrl(apiKey, vanityName) {
  const url = new URL(`${STEAM_API_BASE}/ISteamUser/ResolveVanityURL/v1/`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('vanityurl', vanityName);
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Steam API error: ${response.status}`);
  }

  const data = await response.json();

  if (data.response && data.response.success === 1) {
    return data.response.steamid;
  }

  return null;
}

/**
 * Validate a Steam Web API key by making a lightweight request.
 * @param {string} apiKey - Steam Web API key to validate
 * @returns {Promise<boolean>} true if the key is valid
 */
async function validateApiKey(apiKey) {
  try {
    // Use a known Steam ID (Valve's) for a quick test
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

/**
 * Extract a Steam ID 64 from a Steam community URL.
 * Handles both /profiles/STEAMID64 and /id/VANITYNAME formats.
 * @param {string} steamUrl - Full Steam community URL
 * @param {string} [apiKey] - Required for vanity URL resolution
 * @returns {Promise<string|null>} Steam ID 64 or null
 */
async function extractSteamId64FromUrl(steamUrl, apiKey) {
  if (!steamUrl) return null;

  // Match /profiles/76561198XXXXXXXXX
  const profileMatch = steamUrl.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (profileMatch) {
    return profileMatch[1];
  }

  // Match /id/vanityname
  const vanityMatch = steamUrl.match(/steamcommunity\.com\/id\/([^/?#]+)/);
  if (vanityMatch && apiKey) {
    return await resolveVanityUrl(apiKey, vanityMatch[1]);
  }

  return null;
}
