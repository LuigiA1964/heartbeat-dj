'use strict';

/**
 * HeartBeat DJ — Spotify OAuth 2.0 PKCE Flow
 *
 * Implementeert de Authorization Code with PKCE flow.
 * Geen backend nodig — alles draait in de browser.
 *
 * PKCE (Proof Key for Code Exchange) werkt als volgt:
 * 1. Genereer een random code_verifier
 * 2. Hash die tot een code_challenge (SHA-256)
 * 3. Stuur code_challenge mee in de auth request
 * 4. Bij token exchange: stuur de originele code_verifier mee
 * 5. Spotify verifieert dat de challenge bij de verifier hoort
 *
 * Dit voorkomt dat een onderschept auth code bruikbaar is zonder de verifier.
 */

import { SPOTIFY } from './config.js';

const STORAGE_KEYS = Object.freeze({
  ACCESS_TOKEN: 'hbdj_access_token',
  REFRESH_TOKEN: 'hbdj_refresh_token',
  TOKEN_EXPIRY: 'hbdj_token_expiry',
  CODE_VERIFIER: 'hbdj_code_verifier',
});

/**
 * Genereer een cryptografisch random string.
 * @param {number} length
 * @returns {string}
 */
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => possible[v % possible.length]).join('');
}

/**
 * Genereer een SHA-256 hash en encode als base64url.
 * @param {string} plain
 * @returns {Promise<string>}
 */
async function sha256Base64url(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const digest = await crypto.subtle.digest('SHA-256', data);

  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class SpotifyAuth {
  /** @type {string|null} */
  #accessToken;

  /** @type {string|null} */
  #refreshToken;

  /** @type {number} Token expiry timestamp in ms */
  #tokenExpiry;

  /** @type {EventTarget} */
  #eventTarget;

  constructor() {
    this.#accessToken = sessionStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    this.#refreshToken = sessionStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    this.#tokenExpiry = Number(sessionStorage.getItem(STORAGE_KEYS.TOKEN_EXPIRY)) || 0;
    this.#eventTarget = new EventTarget();
  }

  /** @returns {boolean} */
  get isAuthenticated() {
    return this.#accessToken !== null && Date.now() < this.#tokenExpiry;
  }

  /** @returns {string|null} Geldig access token, of null als verlopen */
  get accessToken() {
    if (this.isAuthenticated) {
      return this.#accessToken;
    }
    return null;
  }

  /**
   * Start de OAuth login flow.
   * Redirect de browser naar Spotify's autorisatiepagina.
   */
  async login() {
    if (SPOTIFY.CLIENT_ID === '') {
      throw new Error(
        'Spotify Client ID is niet geconfigureerd. ' +
        'Registreer een app op developer.spotify.com en vul de CLIENT_ID in config.js in.'
      );
    }

    const codeVerifier = generateRandomString(64);
    sessionStorage.setItem(STORAGE_KEYS.CODE_VERIFIER, codeVerifier);

    const codeChallenge = await sha256Base64url(codeVerifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: SPOTIFY.CLIENT_ID,
      scope: SPOTIFY.SCOPES,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
      redirect_uri: SPOTIFY.REDIRECT_URI,
      show_dialog: 'true',
    });

    const spotifyAuthUrl = `${SPOTIFY.AUTH_URL}?${params.toString()}`;

    // Op mobiel: gebruik een tussenliggende redirect-pagina om te voorkomen
    // dat iOS Universal Links de Spotify app opent in plaats van in Safari te blijven.
    // De redirect-pagina gebruikt <meta http-equiv="refresh"> die niet wordt
    // onderschept door Universal Links.
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      window.location.href = `auth-redirect.html#${encodeURIComponent(spotifyAuthUrl)}`;
    } else {
      window.location.href = spotifyAuthUrl;
    }
  }

  /**
   * Verwerk de OAuth callback.
   * Wisselt de authorization code in voor tokens.
   *
   * @returns {Promise<boolean>} true als authenticatie succesvol
   */
  async handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');

    if (error !== null) {
      this.#dispatchError(`Spotify autorisatie geweigerd: ${error}`);
      return false;
    }

    if (code === null) {
      return false; // Geen callback, gewone page load
    }

    const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.CODE_VERIFIER);
    if (codeVerifier === null) {
      this.#dispatchError('Code verifier niet gevonden. Start de login opnieuw.');
      return false;
    }

    try {
      const response = await fetch(SPOTIFY.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: SPOTIFY.CLIENT_ID,
          grant_type: 'authorization_code',
          code,
          redirect_uri: SPOTIFY.REDIRECT_URI,
          code_verifier: codeVerifier,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error_description || `Token request mislukt: ${response.status}`);
      }

      const data = await response.json();
      this.#storeTokens(data);

      // Verwijder code uit URL zonder page reload
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);

      sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);

      this.#eventTarget.dispatchEvent(new CustomEvent('authenticated'));
      return true;
    } catch (err) {
      this.#dispatchError(`Token exchange mislukt: ${err.message}`);
      return false;
    }
  }

  /**
   * Vernieuw het access token met het refresh token.
   * @returns {Promise<boolean>}
   */
  async refreshAccessToken() {
    if (this.#refreshToken === null) {
      this.#dispatchError('Geen refresh token beschikbaar. Log opnieuw in.');
      return false;
    }

    try {
      const response = await fetch(SPOTIFY.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: SPOTIFY.CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: this.#refreshToken,
        }),
      });

      if (!response.ok) {
        throw new Error(`Token refresh mislukt: ${response.status}`);
      }

      const data = await response.json();
      this.#storeTokens(data);

      this.#eventTarget.dispatchEvent(new CustomEvent('tokenrefreshed'));
      return true;
    } catch (err) {
      this.#dispatchError(`Token refresh mislukt: ${err.message}`);
      return false;
    }
  }

  /**
   * Haal een geldig access token op.
   * Refresht automatisch als het huidige token bijna verlopen is.
   * @returns {Promise<string>}
   */
  async getValidToken() {
    // Token nog geldig voor meer dan 60 seconden
    if (this.#accessToken !== null && Date.now() < this.#tokenExpiry - 60000) {
      return this.#accessToken;
    }

    // Probeer te refreshen
    const refreshed = await this.refreshAccessToken();
    if (refreshed && this.#accessToken !== null) {
      return this.#accessToken;
    }

    throw new Error('Geen geldig Spotify token. Log opnieuw in.');
  }

  /**
   * Sla tokens op in sessionStorage.
   * sessionStorage wordt automatisch gewist bij het sluiten van de browser tab.
   * @param {object} tokenData
   */
  #storeTokens(tokenData) {
    this.#accessToken = tokenData.access_token;
    this.#tokenExpiry = Date.now() + tokenData.expires_in * 1000;

    sessionStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, this.#accessToken);
    sessionStorage.setItem(STORAGE_KEYS.TOKEN_EXPIRY, String(this.#tokenExpiry));

    if (tokenData.refresh_token !== undefined) {
      this.#refreshToken = tokenData.refresh_token;
      sessionStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, this.#refreshToken);
    }
  }

  /**
   * Log uit — verwijder alle tokens.
   */
  logout() {
    this.#accessToken = null;
    this.#refreshToken = null;
    this.#tokenExpiry = 0;

    Object.values(STORAGE_KEYS).forEach((key) => sessionStorage.removeItem(key));

    this.#eventTarget.dispatchEvent(new CustomEvent('loggedout'));
  }

  /**
   * Dispatch een error event.
   * @param {string} message
   */
  #dispatchError(message) {
    this.#eventTarget.dispatchEvent(
      new CustomEvent('autherror', { detail: { message } })
    );
  }

  /**
   * @param {'authenticated'|'tokenrefreshed'|'loggedout'|'autherror'} event
   * @param {function} callback
   * @returns {function} Unsubscribe
   */
  on(event, callback) {
    const handler = (e) => callback(e.detail);
    this.#eventTarget.addEventListener(event, handler);
    return () => this.#eventTarget.removeEventListener(event, handler);
  }
}
