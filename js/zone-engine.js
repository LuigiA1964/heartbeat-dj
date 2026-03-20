'use strict';

/**
 * HeartBeat DJ — Zone Engine
 *
 * Verantwoordelijk voor:
 * 1. Hartslag → zone mapping met hysteresis
 * 2. Zone-change detectie met debounce (voorkomt flipfloppen)
 * 3. Event dispatching bij zone-wisseling
 *
 * Gebruikt het Observer pattern via CustomEvents.
 */

import { HEART_RATE_ZONES, ZONE_ENGINE } from './config.js';

export class ZoneEngine {
  /** @type {number} */
  #maxHr;

  /** @type {object|null} Huidige actieve zone */
  #currentZone;

  /** @type {object|null} Kandidaat zone (nog niet bevestigd) */
  #candidateZone;

  /** @type {number} Timestamp waarop kandidaat zone voor het eerst gedetecteerd werd */
  #candidateEnteredAt;

  /** @type {number} Hysteresis in BPM */
  #hysteresisBpm;

  /** @type {number} Minimale tijd in kandidaat zone voordat switch plaatsvindt */
  #switchDelayMs;

  /** @type {EventTarget} Voor event dispatching */
  #eventTarget;

  /** @type {number[]} Berekende zone grenzen in absolute BPM */
  #zoneBoundaries;

  /**
   * @param {object} options
   * @param {number} [options.maxHr] - Maximale hartslag van de gebruiker
   * @param {number} [options.hysteresisBpm] - Hysteresis in BPM
   * @param {number} [options.switchDelayMs] - Minimale tijd in nieuwe zone
   */
  constructor({
    maxHr = ZONE_ENGINE.DEFAULT_MAX_HR,
    hysteresisBpm = ZONE_ENGINE.HYSTERESIS_BPM,
    switchDelayMs = ZONE_ENGINE.ZONE_SWITCH_DELAY_MS,
  } = {}) {
    this.#maxHr = maxHr;
    this.#hysteresisBpm = hysteresisBpm;
    this.#switchDelayMs = switchDelayMs;
    this.#currentZone = null;
    this.#candidateZone = null;
    this.#candidateEnteredAt = 0;
    this.#eventTarget = new EventTarget();
    this.#zoneBoundaries = [];

    this.#calculateBoundaries();
  }

  /**
   * Bereken absolute BPM grenzen op basis van maxHr.
   * Wordt herberekend als maxHr wijzigt.
   */
  #calculateBoundaries() {
    this.#zoneBoundaries = HEART_RATE_ZONES.map((zone) => ({
      ...zone,
      minBpm: Math.round(zone.minPct * this.#maxHr),
      maxBpm: Math.round(zone.maxPct * this.#maxHr),
    }));
  }

  /**
   * Update de maximale hartslag en herbereken grenzen.
   * @param {number} maxHr
   */
  setMaxHr(maxHr) {
    if (typeof maxHr !== 'number' || maxHr < 100 || maxHr > 250) {
      throw new RangeError(`maxHr moet tussen 100 en 250 liggen, kreeg: ${maxHr}`);
    }
    this.#maxHr = maxHr;
    this.#calculateBoundaries();
  }

  /** @returns {number} */
  get maxHr() {
    return this.#maxHr;
  }

  /** @returns {object|null} */
  get currentZone() {
    return this.#currentZone;
  }

  /** @returns {object[]} Zone definities met absolute BPM grenzen */
  get zones() {
    return [...this.#zoneBoundaries];
  }

  /**
   * Bepaal de zone voor een gegeven hartslag.
   * Houdt rekening met hysteresis als er al een actieve zone is.
   *
   * @param {number} bpm - Huidige hartslag
   * @returns {object} De zone die bij deze hartslag hoort
   */
  #resolveZone(bpm) {
    if (typeof bpm !== 'number' || bpm < 0 || bpm > 250) {
      return this.#currentZone || this.#zoneBoundaries[0];
    }

    // Zonder huidige zone: directe lookup
    if (this.#currentZone === null) {
      return this.#findZoneForBpm(bpm);
    }

    // Met huidige zone: pas hysteresis toe
    // De BPM moet duidelijk buiten de huidige zone vallen
    // voordat we een zone-wissel overwegen
    const currentIdx = this.#zoneBoundaries.findIndex(
      (z) => z.id === this.#currentZone.id
    );
    const current = this.#zoneBoundaries[currentIdx];

    if (current === undefined) {
      return this.#findZoneForBpm(bpm);
    }

    const lowerBound = current.minBpm - this.#hysteresisBpm;
    const upperBound = current.maxBpm + this.#hysteresisBpm;

    // Binnen hysteresis marge: blijf in huidige zone
    if (bpm >= lowerBound && bpm <= upperBound) {
      return current;
    }

    // Buiten marge: bepaal nieuwe zone
    return this.#findZoneForBpm(bpm);
  }

  /**
   * Directe zone lookup zonder hysteresis.
   * @param {number} bpm
   * @returns {object}
   */
  #findZoneForBpm(bpm) {
    for (const zone of this.#zoneBoundaries) {
      if (bpm >= zone.minBpm && bpm < zone.maxBpm) {
        return zone;
      }
    }
    // Boven alle zones: maximale zone
    if (bpm >= this.#zoneBoundaries.at(-1).maxBpm) {
      return this.#zoneBoundaries.at(-1);
    }
    // Onder alle zones: rust zone
    return this.#zoneBoundaries[0];
  }

  /**
   * Verwerk een nieuwe hartslag meting.
   * Dit is de hoofdmethode die elke seconde aangeroepen wordt.
   *
   * Implementeert debounced zone-switching:
   * 1. Bepaal welke zone bij de huidige BPM hoort (met hysteresis)
   * 2. Als dat een andere zone is dan de huidige:
   *    a. Eerste keer: registreer als kandidaat
   *    b. Kandidaat al actief en zelfde zone: check of delay verstreken is
   *    c. Kandidaat is weer een andere zone: reset kandidaat
   * 3. Als delay verstreken: bevestig zone-wissel en fire event
   *
   * @param {number} bpm - Huidige hartslag in BPM
   * @returns {{ zone: object, changed: boolean }}
   */
  evaluate(bpm) {
    const resolvedZone = this.#resolveZone(bpm);
    const now = Date.now();

    // Eerste evaluatie: zet initiële zone zonder delay
    if (this.#currentZone === null) {
      this.#currentZone = resolvedZone;
      this.#dispatchZoneChange(resolvedZone, null, bpm);
      return { zone: resolvedZone, changed: true };
    }

    // Zelfde zone als huidige: reset kandidaat
    if (resolvedZone.id === this.#currentZone.id) {
      this.#candidateZone = null;
      this.#candidateEnteredAt = 0;
      return { zone: this.#currentZone, changed: false };
    }

    // Andere zone: kandidaat logica
    if (this.#candidateZone === null || this.#candidateZone.id !== resolvedZone.id) {
      // Nieuwe kandidaat
      this.#candidateZone = resolvedZone;
      this.#candidateEnteredAt = now;
      return { zone: this.#currentZone, changed: false };
    }

    // Zelfde kandidaat: check of delay verstreken is
    const elapsed = now - this.#candidateEnteredAt;
    if (elapsed >= this.#switchDelayMs) {
      const previousZone = this.#currentZone;
      this.#currentZone = resolvedZone;
      this.#candidateZone = null;
      this.#candidateEnteredAt = 0;
      this.#dispatchZoneChange(resolvedZone, previousZone, bpm);
      return { zone: resolvedZone, changed: true };
    }

    // Nog in wachttijd
    return { zone: this.#currentZone, changed: false };
  }

  /**
   * Dispatch een zone-change event.
   * @param {object} newZone
   * @param {object|null} previousZone
   * @param {number} bpm
   */
  #dispatchZoneChange(newZone, previousZone, bpm) {
    this.#eventTarget.dispatchEvent(
      new CustomEvent('zonechange', {
        detail: {
          zone: newZone,
          previousZone,
          bpm,
          timestamp: Date.now(),
        },
      })
    );
  }

  /**
   * Registreer een listener voor zone-wisselingen.
   * @param {function} callback - Ontvangt { zone, previousZone, bpm, timestamp }
   * @returns {function} Unsubscribe functie
   */
  onZoneChange(callback) {
    const handler = (event) => callback(event.detail);
    this.#eventTarget.addEventListener('zonechange', handler);
    return () => this.#eventTarget.removeEventListener('zonechange', handler);
  }

  /**
   * Reset de engine naar initiële staat.
   */
  reset() {
    this.#currentZone = null;
    this.#candidateZone = null;
    this.#candidateEnteredAt = 0;
  }
}
