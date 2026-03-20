'use strict';

/**
 * HeartBeat DJ — Workout Planner
 *
 * Laat de gebruiker een interval-training schema definiëren.
 * De muziek wordt dan PROACTIEF geselecteerd op basis van het schema,
 * in plaats van reactief op basis van hartslag.
 *
 * Twee modi:
 * 1. REACTIVE mode — muziek volgt de hartslag (standaard)
 * 2. PLANNED mode — muziek volgt het workout schema
 *
 * In PLANNED mode wordt de hartslag nog steeds gemonitord,
 * maar de muziekkeuze is gebaseerd op het interval-schema.
 *
 * Het schema bestaat uit segmenten met:
 * - duurMs: duur van het segment in milliseconden
 * - zoneId: de hartslag-zone (bepaalt welke playlist wordt gebruikt)
 * - label: optioneel label voor de UI
 */

import { HEART_RATE_ZONES } from './config.js';

/**
 * @typedef {object} WorkoutSegment
 * @property {number} durationMs - Duur in milliseconden
 * @property {string} zoneId - Hartslag zone ID
 * @property {string} [label] - Optioneel label
 */

/**
 * @typedef {object} WorkoutPlan
 * @property {string} name - Naam van het workout plan
 * @property {WorkoutSegment[]} segments - Array van segmenten
 * @property {number} totalDurationMs - Totale duur
 */

export class WorkoutPlanner {
  /** @type {WorkoutPlan|null} Actief workout plan */
  #activePlan;

  /** @type {number} Index van huidig segment */
  #currentSegmentIndex;

  /** @type {number} Timestamp waarop huidig segment startte */
  #segmentStartedAt;

  /** @type {boolean} Is het workout plan actief */
  #running;

  /** @type {number|null} Timer ID */
  #timerId;

  /** @type {EventTarget} */
  #eventTarget;

  /** @type {boolean} Is het plan gepauzeerd */
  #paused;

  /** @type {number} Verstreken tijd in pauze */
  #pausedElapsed;

  constructor() {
    this.#activePlan = null;
    this.#currentSegmentIndex = -1;
    this.#segmentStartedAt = 0;
    this.#running = false;
    this.#timerId = null;
    this.#eventTarget = new EventTarget();
    this.#paused = false;
    this.#pausedElapsed = 0;
  }

  /** @returns {boolean} */
  get isRunning() {
    return this.#running;
  }

  /** @returns {boolean} */
  get isPaused() {
    return this.#paused;
  }

  /** @returns {WorkoutPlan|null} */
  get activePlan() {
    return this.#activePlan;
  }

  /** @returns {WorkoutSegment|null} */
  get currentSegment() {
    if (this.#activePlan === null || this.#currentSegmentIndex < 0) {
      return null;
    }
    return this.#activePlan.segments[this.#currentSegmentIndex] || null;
  }

  /** @returns {number} Huidige segment index */
  get currentSegmentIndex() {
    return this.#currentSegmentIndex;
  }

  /**
   * Resterende tijd in het huidige segment (ms).
   * @returns {number}
   */
  get segmentRemainingMs() {
    const segment = this.currentSegment;
    if (segment === null) {
      return 0;
    }

    const elapsed = this.#paused
      ? this.#pausedElapsed
      : Date.now() - this.#segmentStartedAt;

    return Math.max(0, segment.durationMs - elapsed);
  }

  /**
   * Totale resterende tijd van het hele plan (ms).
   * @returns {number}
   */
  get totalRemainingMs() {
    if (this.#activePlan === null) {
      return 0;
    }

    let remaining = this.segmentRemainingMs;
    for (let i = this.#currentSegmentIndex + 1; i < this.#activePlan.segments.length; i++) {
      remaining += this.#activePlan.segments[i].durationMs;
    }
    return remaining;
  }

  /**
   * Maak een workout plan van een array segmenten.
   * @param {string} name
   * @param {Array<{durationMinutes: number, zoneId: string, label?: string}>} segments
   * @returns {WorkoutPlan}
   */
  static createPlan(name, segments) {
    if (segments.length === 0) {
      throw new Error('Een workout plan moet minimaal één segment bevatten.');
    }

    const processedSegments = segments.map((seg, idx) => {
      const zone = HEART_RATE_ZONES.find((z) => z.id === seg.zoneId);
      if (zone === undefined) {
        throw new Error(`Ongeldige zone "${seg.zoneId}" in segment ${idx + 1}.`);
      }

      return {
        durationMs: seg.durationMinutes * 60 * 1000,
        zoneId: seg.zoneId,
        label: seg.label || `${zone.name} — ${seg.durationMinutes} min`,
      };
    });

    const totalDurationMs = processedSegments.reduce((sum, s) => sum + s.durationMs, 0);

    return { name, segments: processedSegments, totalDurationMs };
  }

  /**
   * Voorgedefinieerde workout templates.
   * @returns {Array<{name: string, description: string, segments: Array}>}
   */
  static getTemplates() {
    return [
      {
        name: 'Interval 30/30',
        description: '5 min warmup, dan 30s hard / 30s rust (10x), 5 min cooldown',
        segments: [
          { durationMinutes: 5, zoneId: 'light', label: 'Warming up' },
          ...Array.from({ length: 10 }, (_, i) => [
            { durationMinutes: 0.5, zoneId: 'hard', label: `Sprint ${i + 1}` },
            { durationMinutes: 0.5, zoneId: 'light', label: `Herstel ${i + 1}` },
          ]).flat(),
          { durationMinutes: 5, zoneId: 'rest', label: 'Cooldown' },
        ],
      },
      {
        name: 'Piramide',
        description: 'Opbouwend: 2-3-4-3-2 minuten met rust ertussen',
        segments: [
          { durationMinutes: 5, zoneId: 'light', label: 'Warming up' },
          { durationMinutes: 2, zoneId: 'moderate', label: 'Tempo 1' },
          { durationMinutes: 1, zoneId: 'light', label: 'Herstel' },
          { durationMinutes: 3, zoneId: 'hard', label: 'Tempo 2' },
          { durationMinutes: 1, zoneId: 'light', label: 'Herstel' },
          { durationMinutes: 4, zoneId: 'maximum', label: 'Piek' },
          { durationMinutes: 1, zoneId: 'light', label: 'Herstel' },
          { durationMinutes: 3, zoneId: 'hard', label: 'Tempo 3' },
          { durationMinutes: 1, zoneId: 'light', label: 'Herstel' },
          { durationMinutes: 2, zoneId: 'moderate', label: 'Tempo 4' },
          { durationMinutes: 5, zoneId: 'rest', label: 'Cooldown' },
        ],
      },
      {
        name: 'Custom interval',
        description: 'Configureerbare intervallen — bijv. 3.75 min traag / 3.75 min hard',
        segments: [
          { durationMinutes: 5, zoneId: 'light', label: 'Warming up' },
          { durationMinutes: 3.75, zoneId: 'rest', label: 'Traag' },
          { durationMinutes: 3.75, zoneId: 'hard', label: 'Hard' },
          { durationMinutes: 3.75, zoneId: 'rest', label: 'Traag' },
          { durationMinutes: 3.75, zoneId: 'hard', label: 'Hard' },
          { durationMinutes: 3.75, zoneId: 'rest', label: 'Traag' },
          { durationMinutes: 3.75, zoneId: 'hard', label: 'Hard' },
          { durationMinutes: 5, zoneId: 'rest', label: 'Cooldown' },
        ],
      },
      {
        name: 'Steady State',
        description: '5 min warmup, 30 min matig tempo, 5 min cooldown',
        segments: [
          { durationMinutes: 5, zoneId: 'light', label: 'Warming up' },
          { durationMinutes: 30, zoneId: 'moderate', label: 'Steady state' },
          { durationMinutes: 5, zoneId: 'rest', label: 'Cooldown' },
        ],
      },
    ];
  }

  /**
   * Start een workout plan.
   * @param {WorkoutPlan} plan
   */
  start(plan) {
    if (plan === null || plan.segments.length === 0) {
      throw new Error('Geen geldig workout plan.');
    }

    this.#activePlan = plan;
    this.#running = true;
    this.#paused = false;
    this.#currentSegmentIndex = -1;

    this.#dispatch('planstarted', { plan });
    this.#advanceSegment();
    this.#startTimer();
  }

  /**
   * Pauzeer het workout plan.
   */
  pause() {
    if (!this.#running || this.#paused) {
      return;
    }

    this.#paused = true;
    this.#pausedElapsed = Date.now() - this.#segmentStartedAt;
    this.#stopTimer();
    this.#dispatch('planpaused', {});
  }

  /**
   * Hervat het workout plan.
   */
  resume() {
    if (!this.#running || !this.#paused) {
      return;
    }

    this.#paused = false;
    this.#segmentStartedAt = Date.now() - this.#pausedElapsed;
    this.#startTimer();
    this.#dispatch('planresumed', {});
  }

  /**
   * Stop het workout plan.
   */
  stop() {
    this.#running = false;
    this.#paused = false;
    this.#stopTimer();
    this.#dispatch('planstopped', {});
    this.#activePlan = null;
    this.#currentSegmentIndex = -1;
  }

  /**
   * Ga naar het volgende segment.
   */
  #advanceSegment() {
    this.#currentSegmentIndex++;

    if (this.#currentSegmentIndex >= this.#activePlan.segments.length) {
      // Workout compleet
      this.#running = false;
      this.#stopTimer();
      this.#dispatch('plancompleted', { plan: this.#activePlan });
      return;
    }

    const segment = this.#activePlan.segments[this.#currentSegmentIndex];
    this.#segmentStartedAt = Date.now();

    this.#dispatch('segmentchanged', {
      segment,
      segmentIndex: this.#currentSegmentIndex,
      totalSegments: this.#activePlan.segments.length,
    });
  }

  /**
   * Start de timer die controleert of segmenten afgelopen zijn.
   */
  #startTimer() {
    this.#stopTimer();
    this.#timerId = setInterval(() => this.#tick(), 250);
  }

  /**
   * Stop de timer.
   */
  #stopTimer() {
    if (this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
  }

  /**
   * Timer tick — check of huidig segment afgelopen is.
   */
  #tick() {
    if (!this.#running || this.#paused || this.#activePlan === null) {
      return;
    }

    const segment = this.currentSegment;
    if (segment === null) {
      return;
    }

    const elapsed = Date.now() - this.#segmentStartedAt;

    // Dispatch progress voor de UI
    this.#dispatch('segmentprogress', {
      elapsed,
      remaining: Math.max(0, segment.durationMs - elapsed),
      progress: Math.min(1, elapsed / segment.durationMs),
      segment,
      segmentIndex: this.#currentSegmentIndex,
    });

    if (elapsed >= segment.durationMs) {
      this.#advanceSegment();
    }
  }

  /**
   * Dispatch een event.
   * @param {string} type
   * @param {object} detail
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
}
