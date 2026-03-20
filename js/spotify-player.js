'use strict';

/**
 * HeartBeat DJ — Spotify Player (Dual Mode)
 *
 * Twee modi:
 * 1. DESKTOP: Spotify Web Playback SDK — muziek speelt in de browser
 * 2. MOBIEL: Spotify Connect — stuurt de Spotify app op het device aan
 *
 * De modus wordt automatisch gedetecteerd.
 * Beide modi bieden dezelfde interface naar de rest van de app.
 */

import { PLAYER, SPOTIFY } from './config.js';

/**
 * Detecteer of we op een mobiel device zitten.
 * @returns {boolean}
 */
function isMobile() {
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  ) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
}

export class SpotifyPlayer {
  /** @type {import('./spotify-auth.js').SpotifyAuth} */
  #auth;

  /** @type {import('./spotify-api.js').SpotifyApi} */
  #api;

  /** @type {Spotify.Player|null} SDK player instance (desktop) */
  #player;

  /** @type {string|null} */
  #deviceId;

  /** @type {boolean} */
  #ready;

  /** @type {boolean} */
  #sdkLoaded;

  /** @type {number} Huidig volume 0.0 - 1.0 */
  #volume;

  /** @type {EventTarget} */
  #eventTarget;

  /** @type {object|null} Huidige track info */
  #currentTrack;

  /** @type {boolean} */
  #isPlaying;

  /** @type {'sdk'|'connect'} Playback modus */
  #mode;

  /** @type {number|null} Polling timer voor Connect modus */
  #pollTimerId;

  /**
   * @param {import('./spotify-auth.js').SpotifyAuth} auth
   * @param {import('./spotify-api.js').SpotifyApi} api
   */
  constructor(auth, api) {
    this.#auth = auth;
    this.#api = api;
    this.#player = null;
    this.#deviceId = null;
    this.#ready = false;
    this.#sdkLoaded = false;
    this.#volume = PLAYER.DEFAULT_VOLUME;
    this.#eventTarget = new EventTarget();
    this.#currentTrack = null;
    this.#isPlaying = false;
    this.#mode = isMobile() ? 'connect' : 'sdk';
    this.#pollTimerId = null;
  }

  /** @returns {boolean} */
  get isReady() {
    return this.#ready;
  }

  /** @returns {string|null} */
  get deviceId() {
    return this.#deviceId;
  }

  /** @returns {object|null} */
  get currentTrack() {
    return this.#currentTrack;
  }

  /** @returns {boolean} */
  get isPlaying() {
    return this.#isPlaying;
  }

  /** @returns {'sdk'|'connect'} */
  get mode() {
    return this.#mode;
  }

  // ── SDK Mode (Desktop) ──────────────────────────────────

  /**
   * Laad de Spotify Web Playback SDK.
   * @returns {Promise<void>}
   */
  async loadSdk() {
    if (this.#mode === 'connect') {
      // Connect mode heeft geen SDK nodig
      return;
    }

    if (this.#sdkLoaded) {
      return;
    }

    return new Promise((resolve, reject) => {
      if (window.Spotify?.Player !== undefined) {
        this.#sdkLoaded = true;
        resolve();
        return;
      }

      window.onSpotifyWebPlaybackSDKReady = () => {
        this.#sdkLoaded = true;
        resolve();
      };

      const script = document.createElement('script');
      script.src = SPOTIFY.PLAYER_SDK_URL;
      script.onerror = () => {
        console.warn('[HeartBeat DJ] SDK laden mislukt, fallback naar Connect mode');
        this.#mode = 'connect';
        resolve();
      };
      document.head.appendChild(script);

      setTimeout(() => {
        if (!this.#sdkLoaded) {
          console.warn('[HeartBeat DJ] SDK timeout, fallback naar Connect mode');
          this.#mode = 'connect';
          resolve();
        }
      }, 10000);
    });
  }

  /**
   * Initialiseer de player (SDK of Connect).
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.#mode === 'connect') {
      await this.#initConnect();
    } else {
      await this.#initSdk();
    }
  }

  /**
   * Initialiseer SDK modus (desktop).
   */
  async #initSdk() {
    if (!this.#sdkLoaded) {
      await this.loadSdk();
    }

    // Als we na loadSdk in connect mode zijn gevallen
    if (this.#mode === 'connect') {
      return this.#initConnect();
    }

    this.#player = new window.Spotify.Player({
      name: PLAYER.DEVICE_NAME,
      getOAuthToken: async (cb) => {
        try {
          const validToken = await this.#auth.getValidToken();
          cb(validToken);
        } catch {
          cb('');
        }
      },
      volume: this.#volume,
    });

    this.#setupSdkListeners();

    const success = await this.#player.connect();
    if (!success) {
      console.warn('[HeartBeat DJ] SDK connect mislukt, fallback naar Connect mode');
      this.#mode = 'connect';
      return this.#initConnect();
    }
  }

  /**
   * Setup event listeners voor SDK modus.
   */
  #setupSdkListeners() {
    this.#player.addListener('ready', ({ device_id: deviceId }) => {
      this.#deviceId = deviceId;
      this.#ready = true;
      console.log(`[HeartBeat DJ] SDK Player gereed, device: ${deviceId}`);
      this.#dispatch('ready', { deviceId, mode: 'sdk' });
    });

    this.#player.addListener('not_ready', () => {
      this.#ready = false;
      this.#dispatch('notready', {});
    });

    this.#player.addListener('player_state_changed', (state) => {
      if (state === null) return;
      this.#handlePlaybackState(state);
    });

    // Error listeners met automatische fallback naar Connect
    const errorHandler = (type) => ({ message }) => {
      console.warn(`[HeartBeat DJ] SDK ${type}: ${message}`);
      this.#dispatch('error', { message });
    };

    this.#player.addListener('initialization_error', errorHandler('init'));
    this.#player.addListener('authentication_error', errorHandler('auth'));
    this.#player.addListener('account_error', errorHandler('account'));
    this.#player.addListener('playback_error', errorHandler('playback'));
  }

  /**
   * Verwerk SDK playback state.
   */
  #handlePlaybackState(state) {
    const track = state.track_window?.current_track;
    this.#isPlaying = !state.paused;

    if (track != null) {
      this.#currentTrack = {
        id: track.id,
        name: track.name,
        artist: track.artists.map((a) => a.name).join(', '),
        album: track.album.name,
        albumArt: track.album.images?.[0]?.url || null,
        durationMs: track.duration_ms,
        uri: track.uri,
      };
    }

    this.#dispatch('statechanged', {
      track: this.#currentTrack,
      isPlaying: this.#isPlaying,
      positionMs: state.position,
      durationMs: state.duration,
    });

    // Detecteer einde van track
    if (state.paused && state.position === 0) {
      this.#dispatch('trackended', { track: this.#currentTrack });
    }
  }

  // ── Connect Mode (Mobiel) ───────────────────────────────

  /**
   * Initialiseer Connect modus — zoek een actief Spotify device.
   */
  async #initConnect() {
    console.log('[HeartBeat DJ] Connect mode: zoeken naar actief Spotify device...');

    try {
      // Zoek een actief device
      const device = await this.#findActiveDevice();

      if (device !== null) {
        this.#deviceId = device.id;
        this.#ready = true;
        console.log(`[HeartBeat DJ] Connect device gevonden: ${device.name}`);
        this.#dispatch('ready', { deviceId: device.id, mode: 'connect', deviceName: device.name });
      } else {
        // Geen actief device — user moet Spotify openen
        this.#ready = true; // Toch ready markeren, we proberen bij play
        this.#deviceId = null;
        console.log('[HeartBeat DJ] Geen actief device, stuur bij eerste play');
        this.#dispatch('ready', { deviceId: null, mode: 'connect' });
      }

      // Start polling voor playback state updates
      this.#startConnectPolling();
    } catch (err) {
      console.error('[HeartBeat DJ] Connect init fout:', err);
      // Toch ready markeren zodat de app bruikbaar is
      this.#ready = true;
      this.#dispatch('ready', { deviceId: null, mode: 'connect' });
    }
  }

  /**
   * Zoek een actief Spotify device.
   * @returns {Promise<{id: string, name: string}|null>}
   */
  async #findActiveDevice() {
    try {
      const state = await this.#api.getPlaybackState();
      if (state?.device?.id) {
        return { id: state.device.id, name: state.device.name };
      }
    } catch {
      // Geen actieve playback
    }

    // Probeer devices endpoint
    try {
      const token = await this.#auth.getValidToken();
      const response = await fetch('https://api.spotify.com/v1/me/player/devices', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        const active = data.devices?.find((d) => d.is_active);
        if (active) {
          return { id: active.id, name: active.name };
        }
        // Pak eerste beschikbare device
        if (data.devices?.length > 0) {
          return { id: data.devices[0].id, name: data.devices[0].name };
        }
      }
    } catch {
      // Geen devices
    }

    return null;
  }

  /**
   * Poll de Spotify playback state in Connect modus.
   * Nodig omdat we geen realtime events krijgen zoals bij de SDK.
   */
  #startConnectPolling() {
    this.#stopConnectPolling();
    this.#pollTimerId = setInterval(async () => {
      try {
        const state = await this.#api.getPlaybackState();
        if (state === null) return;

        this.#isPlaying = state.is_playing;

        if (state.device?.id && this.#deviceId === null) {
          this.#deviceId = state.device.id;
        }

        const track = state.item;
        if (track != null) {
          const newTrack = {
            id: track.id,
            name: track.name,
            artist: track.artists?.map((a) => a.name).join(', ') || '',
            album: track.album?.name || '',
            albumArt: track.album?.images?.[0]?.url || null,
            durationMs: track.duration_ms,
            uri: track.uri,
          };

          // Detecteer track wissel
          const trackChanged = this.#currentTrack?.id !== newTrack.id;
          this.#currentTrack = newTrack;

          this.#dispatch('statechanged', {
            track: newTrack,
            isPlaying: state.is_playing,
            positionMs: state.progress_ms,
            durationMs: track.duration_ms,
          });

          // Detecteer einde van track (progress bijna op duration)
          if (
            !state.is_playing &&
            state.progress_ms != null &&
            track.duration_ms != null &&
            track.duration_ms - state.progress_ms < 1000
          ) {
            this.#dispatch('trackended', { track: newTrack });
          }
        }
      } catch {
        // Poll fout — negeer, probeer opnieuw
      }
    }, 3000);
  }

  /**
   * Stop Connect polling.
   */
  #stopConnectPolling() {
    if (this.#pollTimerId !== null) {
      clearInterval(this.#pollTimerId);
      this.#pollTimerId = null;
    }
  }

  // ── Unified Playback Controls ───────────────────────────

  /**
   * Speel een specifieke track af.
   * @param {string} trackUri
   */
  async playTrack(trackUri) {
    // In connect mode: zoek device als we er nog geen hebben
    if (this.#mode === 'connect' && this.#deviceId === null) {
      const device = await this.#findActiveDevice();
      if (device !== null) {
        this.#deviceId = device.id;
      }
    }

    if (this.#deviceId === null) {
      throw new Error(
        this.#mode === 'connect'
          ? 'Open Spotify op je telefoon en speel iets af, dan kan HeartBeat DJ het overnemen.'
          : 'Player is niet gereed.'
      );
    }

    await this.#api.play(this.#deviceId, { uris: [trackUri] });
  }

  /**
   * Speel meerdere tracks af.
   * @param {string[]} trackUris
   */
  async playTracks(trackUris) {
    if (trackUris.length === 0) return;

    if (this.#mode === 'connect' && this.#deviceId === null) {
      const device = await this.#findActiveDevice();
      if (device !== null) this.#deviceId = device.id;
    }

    if (this.#deviceId === null) {
      throw new Error('Geen Spotify device gevonden. Open Spotify op je telefoon.');
    }

    await this.#api.play(this.#deviceId, { uris: trackUris });
  }

  /**
   * Pauzeer afspelen.
   */
  async pause() {
    if (this.#mode === 'sdk' && this.#player !== null) {
      await this.#player.pause();
    } else if (this.#deviceId !== null) {
      await this.#api.pause(this.#deviceId);
    }
  }

  /**
   * Hervat afspelen.
   */
  async resume() {
    if (this.#mode === 'sdk' && this.#player !== null) {
      await this.#player.resume();
    } else if (this.#deviceId !== null) {
      await this.#api.play(this.#deviceId);
    }
  }

  /**
   * Ga naar het volgende nummer.
   */
  async next() {
    if (this.#mode === 'sdk' && this.#player !== null) {
      await this.#player.nextTrack();
    } else if (this.#deviceId !== null) {
      await this.#api.skipToNext(this.#deviceId);
    }
  }

  /**
   * Stel het volume in.
   * @param {number} volume - 0.0 tot 1.0
   */
  async setVolume(volume) {
    this.#volume = Math.max(0, Math.min(1, volume));
    if (this.#mode === 'sdk' && this.#player !== null) {
      await this.#player.setVolume(this.#volume);
    } else if (this.#deviceId !== null) {
      try {
        await this.#api.setVolume(Math.round(this.#volume * 100), this.#deviceId);
      } catch {
        // Volume control niet altijd beschikbaar via Connect
      }
    }
  }

  /**
   * Crossfade: fade uit, wissel track, fade in.
   * Op mobiel: gewoon direct wisselen (volume control beperkt via Connect).
   * @param {string} trackUri
   * @param {number} [durationMs]
   */
  async crossfadeTo(trackUri, durationMs = PLAYER.CROSSFADE_DURATION_MS) {
    if (this.#mode === 'connect') {
      // Connect mode: directe wissel, geen crossfade
      await this.playTrack(trackUri);
      return;
    }

    const targetVolume = this.#volume;
    const steps = 20;
    const stepDuration = (durationMs / 2) / steps;

    // Fade out
    for (let i = steps; i >= 0; i--) {
      await this.setVolume((i / steps) * targetVolume);
      await this.#sleep(stepDuration);
    }

    await this.playTrack(trackUri);

    // Fade in
    for (let i = 0; i <= steps; i++) {
      await this.setVolume((i / steps) * targetVolume);
      await this.#sleep(stepDuration);
    }
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Dispatch een event.
   */
  #dispatch(type, detail) {
    this.#eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
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
   * Disconnect en cleanup.
   */
  disconnect() {
    this.#stopConnectPolling();
    if (this.#player !== null) {
      this.#player.disconnect();
      this.#player = null;
    }
    this.#ready = false;
    this.#deviceId = null;
    this.#currentTrack = null;
    this.#isPlaying = false;
  }
}
