'use strict';

/**
 * HeartBeat DJ — Playlist Manager
 *
 * Beheert de koppeling tussen hartslag-zones en Spotify playlists.
 * Verantwoordelijk voor:
 * - Zone ↔ playlist mapping (CRUD)
 * - Track queue per zone (shuffle)
 * - Volgende track selectie bij zone-wissel
 * - Track history (voorkomen van herhalingen)
 */

import { HEART_RATE_ZONES } from './config.js';

export class PlaylistManager {
  /** @type {import('./spotify-api.js').SpotifyApi} */
  #api;

  /**
   * Zone → playlist mapping.
   * @type {Map<string, {playlistId: string, playlistName: string}>}
   */
  #zonePlaylistMap;

  /**
   * Gecachte tracks per playlist.
   * @type {Map<string, Array>}
   */
  #playlistTracks;

  /**
   * Shuffle queue per zone — tracks in willekeurige volgorde.
   * @type {Map<string, Array>}
   */
  #shuffleQueues;

  /**
   * Recent afgespeelde track IDs (voorkomen herhalingen).
   * @type {Set<string>}
   */
  #recentlyPlayed;

  /** @type {number} Max aantal tracks in recently played */
  #recentlyPlayedMax;

  /** @type {EventTarget} */
  #eventTarget;

  /**
   * @param {import('./spotify-api.js').SpotifyApi} api
   */
  constructor(api) {
    this.#api = api;
    this.#zonePlaylistMap = new Map();
    this.#playlistTracks = new Map();
    this.#shuffleQueues = new Map();
    this.#recentlyPlayed = new Set();
    this.#recentlyPlayedMax = 50;
    this.#eventTarget = new EventTarget();
  }

  /**
   * Koppel een playlist aan een zone.
   * @param {string} zoneId
   * @param {string} playlistId
   * @param {string} playlistName
   */
  async assignPlaylist(zoneId, playlistId, playlistName) {
    const validZone = HEART_RATE_ZONES.find((z) => z.id === zoneId);
    if (validZone === undefined) {
      throw new Error(`Ongeldige zone: ${zoneId}`);
    }

    this.#zonePlaylistMap.set(zoneId, { playlistId, playlistName });

    // Pre-load tracks voor deze playlist
    await this.#loadPlaylistTracks(playlistId);

    // Maak shuffle queue
    this.#buildShuffleQueue(zoneId);

    this.#eventTarget.dispatchEvent(
      new CustomEvent('playlistassigned', {
        detail: { zoneId, playlistId, playlistName },
      })
    );
  }

  /**
   * Verwijder de playlist koppeling van een zone.
   * @param {string} zoneId
   */
  removePlaylist(zoneId) {
    this.#zonePlaylistMap.delete(zoneId);
    this.#shuffleQueues.delete(zoneId);
  }

  /**
   * Haal de playlist op die aan een zone gekoppeld is.
   * @param {string} zoneId
   * @returns {{playlistId: string, playlistName: string}|null}
   */
  getPlaylistForZone(zoneId) {
    return this.#zonePlaylistMap.get(zoneId) || null;
  }

  /**
   * Check of alle zones een playlist hebben.
   * @returns {boolean}
   */
  get allZonesMapped() {
    return HEART_RATE_ZONES.every((zone) => this.#zonePlaylistMap.has(zone.id));
  }

  /**
   * Haal de huidige zone-playlist mappings op.
   * @returns {Array<{zoneId: string, zoneName: string, playlistId: string|null, playlistName: string|null}>}
   */
  getMappings() {
    return HEART_RATE_ZONES.map((zone) => {
      const mapping = this.#zonePlaylistMap.get(zone.id);
      return {
        zoneId: zone.id,
        zoneName: zone.name,
        playlistId: mapping?.playlistId || null,
        playlistName: mapping?.playlistName || null,
      };
    });
  }

  /**
   * Haal het volgende track uit de shuffle queue voor een zone.
   * @param {string} zoneId
   * @returns {object|null} Spotify track object
   */
  getNextTrack(zoneId) {
    const queue = this.#shuffleQueues.get(zoneId);
    if (queue === undefined || queue.length === 0) {
      // Queue leeg: herbouw
      this.#buildShuffleQueue(zoneId);
      const rebuilt = this.#shuffleQueues.get(zoneId);
      if (rebuilt === undefined || rebuilt.length === 0) {
        return null;
      }
    }

    const currentQueue = this.#shuffleQueues.get(zoneId);

    // Zoek eerste track die niet recent is afgespeeld
    let track = null;
    let attempts = 0;
    const maxAttempts = currentQueue.length;

    while (attempts < maxAttempts) {
      track = currentQueue.shift();
      if (track === undefined) {
        break;
      }

      if (!this.#recentlyPlayed.has(track.id)) {
        this.#addToRecentlyPlayed(track.id);
        return track;
      }

      // Track recent afgespeeld, leg achteraan
      currentQueue.push(track);
      attempts++;
    }

    // Alle tracks recent afgespeeld: reset en pak de eerste
    if (currentQueue.length > 0) {
      this.#recentlyPlayed.clear();
      track = currentQueue.shift();
      if (track !== undefined) {
        this.#addToRecentlyPlayed(track.id);
      }
      return track;
    }

    return null;
  }

  /**
   * Haal meerdere tracks op voor pre-buffering.
   * @param {string} zoneId
   * @param {number} count
   * @returns {Array}
   */
  peekNextTracks(zoneId, count = 3) {
    const queue = this.#shuffleQueues.get(zoneId);
    if (queue === undefined) {
      return [];
    }
    return queue.slice(0, count);
  }

  /**
   * Haal alle playlists van de gebruiker op (voor de setup UI).
   * @returns {Promise<Array<{id: string, name: string, imageUrl: string|null, trackCount: number}>>}
   */
  async fetchUserPlaylists() {
    const playlists = await this.#api.getMyPlaylists(50);
    return playlists.map((pl) => ({
      id: pl.id,
      name: pl.name,
      imageUrl: pl.images?.[0]?.url || null,
      trackCount: pl.tracks?.total || pl.items?.total || 0,
    }));
  }

  /**
   * Laad tracks van een playlist.
   * @param {string} playlistId
   */
  async #loadPlaylistTracks(playlistId) {
    if (this.#playlistTracks.has(playlistId)) {
      return; // Al gecacht
    }

    const tracks = await this.#api.getPlaylistTracks(playlistId);
    this.#playlistTracks.set(playlistId, tracks);
  }

  /**
   * Bouw een shuffle queue voor een zone op basis van de gekoppelde playlist.
   * Fisher-Yates shuffle voor eerlijke willekeurige volgorde.
   * @param {string} zoneId
   */
  #buildShuffleQueue(zoneId) {
    const mapping = this.#zonePlaylistMap.get(zoneId);
    if (mapping === undefined) {
      return;
    }

    const tracks = this.#playlistTracks.get(mapping.playlistId);
    if (tracks === undefined || tracks.length === 0) {
      return;
    }

    // Fisher-Yates shuffle
    const shuffled = [...tracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    this.#shuffleQueues.set(zoneId, shuffled);
  }

  /**
   * Voeg een track ID toe aan de recently played set.
   * Verwijdert de oudste als max bereikt is.
   * @param {string} trackId
   */
  #addToRecentlyPlayed(trackId) {
    this.#recentlyPlayed.add(trackId);
    if (this.#recentlyPlayed.size > this.#recentlyPlayedMax) {
      const oldest = this.#recentlyPlayed.values().next().value;
      this.#recentlyPlayed.delete(oldest);
    }
  }

  /**
   * @param {string} event
   * @param {function} callback
   * @returns {function} Unsubscribe
   */
  on(event, callback) {
    const handler = (e) => callback(e.detail);
    this.#eventTarget.addEventListener(event, handler);
    return () => this.#eventTarget.removeEventListener(event, handler);
  }

  /**
   * Reset alle state.
   */
  reset() {
    this.#zonePlaylistMap.clear();
    this.#playlistTracks.clear();
    this.#shuffleQueues.clear();
    this.#recentlyPlayed.clear();
  }
}
