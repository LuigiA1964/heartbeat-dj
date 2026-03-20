'use strict';

/**
 * HeartBeat DJ — Configuration & Constants
 *
 * Alle configureerbare waarden op één plek.
 * Geen magic numbers in de rest van de codebase.
 */

export const APP_NAME = 'HeartBeat DJ';
export const APP_VERSION = '1.0.0';

/**
 * Spotify OAuth configuratie.
 * CLIENT_ID moet door de gebruiker worden ingevuld na registratie op developer.spotify.com.
 * REDIRECT_URI moet overeenkomen met wat in het Spotify Dashboard is geconfigureerd.
 */
export const SPOTIFY = Object.freeze({
  /** Runtime overschrijfbaar via window.__SPOTIFY_CLIENT_ID (sessionStorage) */
  CLIENT_ID: '627bb9cfc6904125adfacad49fae653b',
  REDIRECT_URI: window.location.origin,
  SCOPES: [
    'streaming',
    'user-read-email',
    'user-read-private',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-modify-playback-state',
    'user-read-playback-state',
  ].join(' '),
  AUTH_URL: 'https://accounts.spotify.com/authorize',
  TOKEN_URL: 'https://accounts.spotify.com/api/token',
  API_BASE: 'https://api.spotify.com/v1',
  PLAYER_SDK_URL: 'https://sdk.scdn.co/spotify-player.js',
});

/**
 * Hartslag zones gebaseerd op sportwetenschap (Karvonen methode).
 * Percentages van max hartslag.
 *
 * Elke zone heeft:
 *  - name: weergavenaam
 *  - minPct / maxPct: percentage van max HR
 *  - color: UI kleur (CSS custom property naam)
 *  - description: korte beschrijving voor de gebruiker
 *  - musicProfile: beschrijving van gewenst muziekkarakter
 */
export const HEART_RATE_ZONES = Object.freeze([
  {
    id: 'rest',
    name: 'Rust',
    minPct: 0,
    maxPct: 0.60,
    color: '--zone-rest',
    description: 'Warming up of cooldown',
    musicProfile: 'Rustig, akoestisch, chill',
  },
  {
    id: 'light',
    name: 'Licht',
    minPct: 0.60,
    maxPct: 0.70,
    color: '--zone-light',
    description: 'Lichte inspanning',
    musicProfile: 'Relaxed maar met ritme',
  },
  {
    id: 'moderate',
    name: 'Matig',
    minPct: 0.70,
    maxPct: 0.80,
    color: '--zone-moderate',
    description: 'Stevige inspanning',
    musicProfile: 'Energiek, groovy, uptempo',
  },
  {
    id: 'hard',
    name: 'Intensief',
    minPct: 0.80,
    maxPct: 0.90,
    color: '--zone-hard',
    description: 'Zware inspanning',
    musicProfile: 'High energy, power tracks',
  },
  {
    id: 'maximum',
    name: 'Maximaal',
    minPct: 0.90,
    maxPct: 1.0,
    color: '--zone-maximum',
    description: 'Alles uit de kast',
    musicProfile: 'Volle bak, beast mode',
  },
]);

/**
 * Zone Engine configuratie.
 * Hysteresis voorkomt constant wisselen bij grenswaarden.
 */
export const ZONE_ENGINE = Object.freeze({
  /** Standaard max hartslag (220 - leeftijd). Wordt overschreven door gebruiker. */
  DEFAULT_MAX_HR: 190,

  /** Minimum tijd (ms) in nieuwe zone voordat er gewisseld wordt */
  ZONE_SWITCH_DELAY_MS: 3000,

  /** Hartslag hysteresis in BPM — voorkomt flipfloppen op de grens */
  HYSTERESIS_BPM: 3,

  /** Interval (ms) waarmee de hartslag wordt geëvalueerd */
  EVALUATION_INTERVAL_MS: 1000,
});

/**
 * Hartslag simulator configuratie.
 */
export const SIMULATOR = Object.freeze({
  /** Update interval in ms */
  UPDATE_INTERVAL_MS: 1000,

  /** Maximale BPM variatie per update (realisme) */
  MAX_VARIATION_BPM: 2,

  /** Presets voor simulatie scenarios */
  PRESETS: Object.freeze({
    warmup: { targetBpm: 100, durationMs: 60000, label: 'Warming up' },
    steady: { targetBpm: 140, durationMs: 120000, label: 'Steady state' },
    intervals: { targetBpm: 170, durationMs: 30000, label: 'Interval sprint' },
    cooldown: { targetBpm: 90, durationMs: 90000, label: 'Cooldown' },
  }),
});

/**
 * Player configuratie.
 */
export const PLAYER = Object.freeze({
  /** Volume crossfade duur bij zone-wissel (ms) */
  CROSSFADE_DURATION_MS: 3000,

  /** Standaard volume (0.0 - 1.0) */
  DEFAULT_VOLUME: 0.7,

  /** Naam van de Spotify Connect device */
  DEVICE_NAME: APP_NAME,
});

/**
 * UI configuratie.
 */
export const UI = Object.freeze({
  /** Aantal hartslag datapunten in de grafiek */
  HR_GRAPH_DATA_POINTS: 60,

  /** Toast notificatie duur (ms) */
  TOAST_DURATION_MS: 3000,
});
