'use strict';

/**
 * HeartBeat DJ — Spotify API Wrapper
 *
 * Thin wrapper rond de Spotify Web API.
 * Handelt:
 * - Automatische token refresh bij 401
 * - Rate limiting (429)
 * - Consistente error handling
 * - Alleen de endpoints die we daadwerkelijk gebruiken
 */

import { SPOTIFY } from './config.js';

export class SpotifyApi {
  /** @type {import('./spotify-auth.js').SpotifyAuth} */
  #auth;

  /**
   * @param {import('./spotify-auth.js').SpotifyAuth} auth
   */
  constructor(auth) {
    if (auth === undefined || auth === null) {
      throw new Error('SpotifyApi vereist een SpotifyAuth instantie.');
    }
    this.#auth = auth;
  }

  /**
   * Maak een API request met automatische token handling.
   * @param {string} endpoint - Relatief pad (bijv. '/me/playlists')
   * @param {object} [options]
   * @param {string} [options.method='GET']
   * @param {object} [options.body]
   * @param {URLSearchParams} [options.params]
   * @returns {Promise<object|null>}
   */
  async #request(endpoint, { method = 'GET', body, params } = {}) {
    const token = await this.#auth.getValidToken();

    let url = `${SPOTIFY.API_BASE}${endpoint}`;
    if (params !== undefined) {
      url += `?${params.toString()}`;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const fetchOptions = { method, headers };
    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    // Token verlopen: probeer te refreshen en retry
    if (response.status === 401) {
      const refreshed = await this.#auth.refreshAccessToken();
      if (!refreshed) {
        throw new Error('Spotify sessie verlopen. Log opnieuw in.');
      }
      const retryToken = await this.#auth.getValidToken();
      headers.Authorization = `Bearer ${retryToken}`;
      const retryResponse = await fetch(url, { method, headers, body: fetchOptions.body });

      if (!retryResponse.ok) {
        throw new Error(`Spotify API fout na retry: ${retryResponse.status}`);
      }
      return retryResponse.status === 204 ? null : retryResponse.json();
    }

    // Rate limited
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After')) || 1;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return this.#request(endpoint, { method, body, params });
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        errorData.error?.message || `Spotify API fout: ${response.status}`
      );
    }

    return response.status === 204 ? null : response.json();
  }

  // ── User Profile ──────────────────────────────────────────────

  /**
   * Haal het profiel van de ingelogde gebruiker op.
   * @returns {Promise<{id: string, display_name: string, email: string, product: string, images: Array}>}
   */
  async getMe() {
    return this.#request('/me');
  }

  // ── Playlists ─────────────────────────────────────────────────

  /**
   * Haal alle playlists van de gebruiker op (met paginatie).
   * @param {number} [limit=50]
   * @returns {Promise<Array>}
   */
  async getMyPlaylists(limit = 50) {
    const allPlaylists = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: String(Math.min(limit - allPlaylists.length, 50)),
        offset: String(offset),
      });

      const data = await this.#request('/me/playlists', { params });
      allPlaylists.push(...data.items);

      hasMore = data.next !== null && allPlaylists.length < limit;
      offset += data.items.length;
    }

    return allPlaylists;
  }

  /**
   * Haal de tracks van een playlist op.
   * @param {string} playlistId
   * @param {number} [limit=100]
   * @returns {Promise<Array>} Array van track objecten
   */
  async getPlaylistTracks(playlistId, limit = 100) {
    const allTracks = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: String(Math.min(limit - allTracks.length, 100)),
        offset: String(offset),
      });

      const data = await this.#request(`/playlists/${playlistId}/items`, { params });

      // Debug: toon volledige response structuur
      const dbg = window.__debugLog || console.log;
      dbg('RAW response keys: ' + Object.keys(data).join(', '));
      if (data.items && data.items.length > 0) {
        dbg('Eerste item keys: ' + Object.keys(data.items[0]).join(', '));
        dbg('Eerste item: ' + JSON.stringify(data.items[0]).slice(0, 300));
      } else {
        dbg('Geen items in response. Volledige response: ' + JSON.stringify(data).slice(0, 300));
      }

      const items = data.items || [];
      if (items.length === 0) {
        break;
      }

      // Flexibele track extractie: Feb 2026 hernoemde 'track' naar 'item'
      const validTracks = [];
      for (const entry of items) {
        // Format 2026: { item: { id, name, ... } }
        const trackObj = entry?.item || entry?.track;
        if (trackObj?.id && trackObj?.uri) {
          validTracks.push(trackObj);
        }
      }

      dbg(`Gevonden: ${validTracks.length} geldige tracks van ${items.length} items`);
      allTracks.push(...validTracks);
      hasMore = data.next != null && allTracks.length < limit;
      offset += items.length;
    }

    console.log(`[HeartBeat DJ] Totaal tracks geladen: ${allTracks.length}`);
    return allTracks;
  }

  // ── Search ────────────────────────────────────────────────────

  /**
   * Zoek tracks op Spotify.
   * @param {string} query
   * @param {number} [limit=20]
   * @returns {Promise<Array>}
   */
  async searchTracks(query, limit = 10) {
    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: String(Math.min(limit, 10)), // Feb 2026: max verlaagd naar 10
    });

    const data = await this.#request('/search', { params });
    return data.tracks.items;
  }

  // ── Playback Control ──────────────────────────────────────────

  /**
   * Start of hervat afspelen op een specifiek device.
   * @param {string} deviceId
   * @param {object} [options]
   * @param {string[]} [options.uris] - Track URIs om af te spelen
   * @param {string} [options.contextUri] - Playlist/album URI
   * @param {number} [options.positionMs] - Start positie
   */
  async play(deviceId, { uris, contextUri, positionMs } = {}) {
    const body = {};
    if (uris !== undefined) body.uris = uris;
    if (contextUri !== undefined) body.context_uri = contextUri;
    if (positionMs !== undefined) body.position_ms = positionMs;

    const params = new URLSearchParams({ device_id: deviceId });
    await this.#request('/me/player/play', { method: 'PUT', body, params });
  }

  /**
   * Pauzeer afspelen.
   * @param {string} deviceId
   */
  async pause(deviceId) {
    const params = new URLSearchParams({ device_id: deviceId });
    await this.#request('/me/player/pause', { method: 'PUT', params });
  }

  /**
   * Ga naar het volgende nummer.
   * @param {string} deviceId
   */
  async skipToNext(deviceId) {
    const params = new URLSearchParams({ device_id: deviceId });
    await this.#request('/me/player/next', { method: 'POST', params });
  }

  /**
   * Stel het volume in.
   * @param {number} volumePercent - 0-100
   * @param {string} deviceId
   */
  async setVolume(volumePercent, deviceId) {
    const params = new URLSearchParams({
      volume_percent: String(Math.round(volumePercent)),
      device_id: deviceId,
    });
    await this.#request('/me/player/volume', { method: 'PUT', params });
  }

  /**
   * Zet de actieve playback naar een specifiek device.
   * @param {string} deviceId
   */
  async transferPlayback(deviceId) {
    await this.#request('/me/player', {
      method: 'PUT',
      body: { device_ids: [deviceId], play: false },
    });
  }

  /**
   * Haal de huidige playback state op.
   * @returns {Promise<object|null>}
   */
  async getPlaybackState() {
    return this.#request('/me/player');
  }

  /**
   * Voeg tracks toe aan de wachtrij.
   * @param {string} trackUri
   * @param {string} deviceId
   */
  async addToQueue(trackUri, deviceId) {
    const params = new URLSearchParams({
      uri: trackUri,
      device_id: deviceId,
    });
    await this.#request('/me/player/queue', { method: 'POST', params });
  }
}
