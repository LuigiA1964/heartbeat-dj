'use strict';

/**
 * HeartBeat DJ — Heart Rate Simulator
 *
 * Simuleert realistische hartslag data voor development en demo.
 * Implementeert hetzelfde interface als toekomstige BLE/HealthKit providers.
 *
 * Bevat:
 * - Handmatige slider control
 * - Preset workout scenario's (warmup → steady → intervals → cooldown)
 * - Realistische variatie (geen exacte constante waarden)
 */

import { SIMULATOR } from './config.js';

export class HeartRateSimulator {
  /** @type {number} Huidige gesimuleerde BPM */
  #currentBpm;

  /** @type {number} Doel-BPM waar we naartoe bewegen */
  #targetBpm;

  /** @type {number|null} Interval timer ID */
  #intervalId;

  /** @type {EventTarget} */
  #eventTarget;

  /** @type {boolean} */
  #running;

  /** @type {Array<{targetBpm: number, durationMs: number, label: string}>} */
  #scenarioQueue;

  /** @type {number} Timestamp waarop huidig scenario segment startte */
  #segmentStartedAt;

  /** @type {number} Duur van huidig segment */
  #segmentDurationMs;

  constructor() {
    this.#currentBpm = 72;
    this.#targetBpm = 72;
    this.#intervalId = null;
    this.#eventTarget = new EventTarget();
    this.#running = false;
    this.#scenarioQueue = [];
    this.#segmentStartedAt = 0;
    this.#segmentDurationMs = 0;
  }

  /** @returns {number} */
  get currentBpm() {
    return this.#currentBpm;
  }

  /** @returns {boolean} */
  get isRunning() {
    return this.#running;
  }

  /**
   * Stel de doel-BPM handmatig in (slider mode).
   * De hartslag beweegt geleidelijk naar dit doel.
   * @param {number} bpm
   */
  setTargetBpm(bpm) {
    if (typeof bpm !== 'number' || bpm < 40 || bpm > 220) {
      throw new RangeError(`BPM moet tussen 40 en 220 liggen, kreeg: ${bpm}`);
    }
    this.#targetBpm = bpm;
    this.#scenarioQueue = []; // Cancel running scenario
  }

  /**
   * Start een vooraf gedefinieerd workout scenario.
   * @param {'full_workout'|'intervals'|'steady_state'} scenarioName
   */
  startScenario(scenarioName) {
    const scenarios = {
      full_workout: [
        SIMULATOR.PRESETS.warmup,
        SIMULATOR.PRESETS.steady,
        SIMULATOR.PRESETS.intervals,
        SIMULATOR.PRESETS.steady,
        SIMULATOR.PRESETS.intervals,
        SIMULATOR.PRESETS.cooldown,
      ],
      intervals: [
        SIMULATOR.PRESETS.warmup,
        SIMULATOR.PRESETS.intervals,
        SIMULATOR.PRESETS.steady,
        SIMULATOR.PRESETS.intervals,
        SIMULATOR.PRESETS.steady,
        SIMULATOR.PRESETS.intervals,
        SIMULATOR.PRESETS.cooldown,
      ],
      steady_state: [
        SIMULATOR.PRESETS.warmup,
        SIMULATOR.PRESETS.steady,
        SIMULATOR.PRESETS.steady,
        SIMULATOR.PRESETS.cooldown,
      ],
    };

    const scenario = scenarios[scenarioName];
    if (scenario === undefined) {
      throw new Error(`Onbekend scenario: ${scenarioName}. Kies uit: ${Object.keys(scenarios).join(', ')}`);
    }

    this.#scenarioQueue = [...scenario];
    this.#advanceScenario();
  }

  /**
   * Ga naar het volgende segment in het scenario.
   */
  #advanceScenario() {
    if (this.#scenarioQueue.length === 0) {
      return;
    }

    const segment = this.#scenarioQueue.shift();
    this.#targetBpm = segment.targetBpm;
    this.#segmentStartedAt = Date.now();
    this.#segmentDurationMs = segment.durationMs;

    this.#eventTarget.dispatchEvent(
      new CustomEvent('scenariosegment', {
        detail: { label: segment.label, targetBpm: segment.targetBpm, durationMs: segment.durationMs },
      })
    );
  }

  /**
   * Start de simulator.
   * Dispatcht 'heartrate' events op elk interval.
   */
  start() {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#intervalId = setInterval(() => {
      this.#tick();
    }, SIMULATOR.UPDATE_INTERVAL_MS);

    // Eerste waarde direct dispatchen
    this.#dispatchHeartRate();
  }

  /**
   * Stop de simulator.
   */
  stop() {
    if (!this.#running) {
      return;
    }

    this.#running = false;
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
    this.#scenarioQueue = [];
  }

  /**
   * Eén tick van de simulatie.
   * Beweegt currentBpm geleidelijk naar targetBpm met natuurlijke variatie.
   */
  #tick() {
    // Check of huidig scenario segment afgelopen is
    if (
      this.#scenarioQueue.length > 0 &&
      this.#segmentDurationMs > 0 &&
      Date.now() - this.#segmentStartedAt >= this.#segmentDurationMs
    ) {
      this.#advanceScenario();
    }

    // Beweeg naar target met maximale variatie
    const diff = this.#targetBpm - this.#currentBpm;
    const maxStep = SIMULATOR.MAX_VARIATION_BPM;

    let change;
    if (Math.abs(diff) <= maxStep) {
      // Dicht bij target: kleine willekeurige variatie
      change = (Math.random() - 0.5) * maxStep;
    } else {
      // Beweeg richting target + natuurlijke variatie
      const direction = diff > 0 ? 1 : -1;
      change = direction * (maxStep * 0.7 + Math.random() * maxStep * 0.6);
    }

    this.#currentBpm = Math.round(
      Math.max(40, Math.min(220, this.#currentBpm + change))
    );

    this.#dispatchHeartRate();
  }

  /**
   * Dispatch de huidige hartslag.
   */
  #dispatchHeartRate() {
    this.#eventTarget.dispatchEvent(
      new CustomEvent('heartrate', {
        detail: {
          bpm: this.#currentBpm,
          timestamp: Date.now(),
          source: 'simulator',
        },
      })
    );
  }

  /**
   * Registreer een listener voor hartslag updates.
   * @param {function} callback - Ontvangt { bpm, timestamp, source }
   * @returns {function} Unsubscribe functie
   */
  onHeartRate(callback) {
    const handler = (event) => callback(event.detail);
    this.#eventTarget.addEventListener('heartrate', handler);
    return () => this.#eventTarget.removeEventListener('heartrate', handler);
  }

  /**
   * Registreer een listener voor scenario segment wisselingen.
   * @param {function} callback
   * @returns {function} Unsubscribe functie
   */
  onScenarioSegment(callback) {
    const handler = (event) => callback(event.detail);
    this.#eventTarget.addEventListener('scenariosegment', handler);
    return () => this.#eventTarget.removeEventListener('scenariosegment', handler);
  }

  /**
   * Reset naar rust hartslag.
   */
  reset() {
    this.stop();
    this.#currentBpm = 72;
    this.#targetBpm = 72;
    this.#scenarioQueue = [];
  }
}
