'use strict';

/**
 * HeartBeat DJ — Main Application Orchestrator
 *
 * Verbindt alle modules en beheert de applicatie flow:
 * 1. Login → Spotify authenticatie
 * 2. Setup → Zone-playlist mapping + workout plan
 * 3. Workout → Hartslag monitoring + muziek switching
 *
 * Twee werkingsmodi:
 * - REACTIVE: muziek volgt de gemeten hartslag
 * - PLANNED: muziek volgt het interval-schema
 */

import { HEART_RATE_ZONES, UI, PLAYER } from './config.js';
import { SpotifyAuth } from './spotify-auth.js';
import { SpotifyApi } from './spotify-api.js';
import { SpotifyPlayer } from './spotify-player.js';
import { PlaylistManager } from './playlist-manager.js';
import { ZoneEngine } from './zone-engine.js';
import { HeartRateSimulator } from './heart-rate-simulator.js';
import { WorkoutPlanner } from './workout-planner.js';

class App {
  /** @type {SpotifyAuth} */
  #auth;
  /** @type {SpotifyApi} */
  #api;
  /** @type {SpotifyPlayer} */
  #player;
  /** @type {PlaylistManager} */
  #playlistManager;
  /** @type {ZoneEngine} */
  #zoneEngine;
  /** @type {HeartRateSimulator} */
  #hrSimulator;
  /** @type {WorkoutPlanner} */
  #workoutPlanner;

  /** @type {'login'|'setup'|'workout'} */
  #currentScreen;
  /** @type {'reactive'|'planned'} */
  #workoutMode;
  /** @type {boolean} */
  #workoutActive;
  /** @type {number[]} HR history voor grafiek */
  #hrHistory;
  /** @type {number|null} */
  #hrEvalInterval;

  /** Achtergrond beelden */
  #bgImages;
  #bgCurrentIndex;
  #bgIntervalId;

  constructor() {
    this.#currentScreen = 'login';
    this.#workoutMode = 'reactive';
    this.#workoutActive = false;
    this.#hrHistory = [];
    this.#hrEvalInterval = null;
    this.#bgImages = [];
    this.#bgCurrentIndex = 0;
    this.#bgIntervalId = null;
  }

  /**
   * Initialiseer de applicatie.
   */
  async init() {
    this.#auth = new SpotifyAuth();

    // Check of we terugkomen van een OAuth callback
    let isCallback = false;
    try {
      isCallback = await this.#auth.handleCallback();
    } catch (err) {
      console.error('[HeartBeat DJ] Callback afhandeling mislukt:', err);
      sessionStorage.clear();
    }

    if (this.#auth.isAuthenticated || isCallback) {
      try {
        await this.#initSpotifyModules();
        this.#showScreen('setup');
        await this.#loadUserData();
      } catch (err) {
        console.error('[HeartBeat DJ] Init mislukt, terug naar login:', err);
        sessionStorage.clear();
        this.#showScreen('login');
      }
    } else {
      this.#showScreen('login');
    }

    this.#bindGlobalEvents();
    this.#initBackgroundImages();

    // Vul opgeslagen Client ID in
    const savedId = sessionStorage.getItem('hbdj_client_id');
    const clientInput = this.#el('client-id-input');
    if (savedId && clientInput) {
      clientInput.value = savedId;
    }
  }

  /**
   * Initialiseer Spotify-afhankelijke modules.
   */
  async #initSpotifyModules() {
    this.#api = new SpotifyApi(this.#auth);
    this.#player = new SpotifyPlayer(this.#auth, this.#api);
    this.#playlistManager = new PlaylistManager(this.#api);
    this.#zoneEngine = new ZoneEngine();
    this.#hrSimulator = new HeartRateSimulator();
    this.#workoutPlanner = new WorkoutPlanner();

    this.#bindModuleEvents();
  }

  /**
   * Bind events van alle modules.
   */
  #bindModuleEvents() {
    // Hartslag → Zone evaluatie
    this.#hrSimulator.onHeartRate(({ bpm }) => {
      this.#hrHistory.push(bpm);
      if (this.#hrHistory.length > UI.HR_GRAPH_DATA_POINTS) {
        this.#hrHistory.shift();
      }
      this.#updateHrDisplay(bpm);
      this.#updateHrGraph();

      // Sync slider met actuele BPM
      const slider = this.#el('hr-slider');
      const sliderValue = this.#el('hr-slider-value');
      if (slider) slider.value = bpm;
      if (sliderValue) sliderValue.textContent = bpm;

      // In reactive mode: evalueer zone
      if (this.#workoutMode === 'reactive' && this.#workoutActive) {
        const { zone, changed } = this.#zoneEngine.evaluate(bpm);
        this.#updateZoneDisplay(zone);
        if (changed) {
          console.log(`[HeartBeat DJ] ZONE WISSEL: ${zone.name} (${zone.id}) bij ${bpm} BPM`);
          this.#showToast(`Zone: ${zone.name}`, 'info');
          this.#handleZoneChange(zone);
        }
      }
    });

    // Zone change → muziek wissel
    this.#zoneEngine.onZoneChange(({ zone, previousZone }) => {
      this.#updateZoneDisplay(zone);
      if (previousZone !== null) {
        this.#showToast(`Zone: ${zone.name}`, 'info');
      }
    });

    // Workout planner events
    this.#workoutPlanner.on('segmentchanged', ({ segment, segmentIndex, totalSegments }) => {
      this.#updateWorkoutTimeline(segmentIndex);
      if (this.#workoutMode === 'planned') {
        this.#handleZoneChange({ id: segment.zoneId });
      }
    });

    this.#workoutPlanner.on('segmentprogress', ({ remaining, progress, segmentIndex }) => {
      this.#updateWorkoutTimer(remaining);
      this.#updateSegmentProgress(segmentIndex, progress);
    });

    this.#workoutPlanner.on('plancompleted', () => {
      this.#showToast('Workout voltooid!', 'success');
      this.#stopWorkout();
    });

    // Player events
    this.#player.on('statechanged', ({ track, isPlaying }) => {
      this.#updateNowPlaying(track, isPlaying);
    });

    this.#player.on('trackended', () => {
      this.#playNextTrackForCurrentZone();
    });

    this.#player.on('error', ({ message }) => {
      this.#showToast(message, 'error');
    });

    // Auth events
    this.#auth.on('autherror', ({ message }) => {
      this.#showToast(message, 'error');
    });
  }

  /**
   * Bind DOM events.
   */
  #bindGlobalEvents() {
    // Login button
    this.#el('login-btn')?.addEventListener('click', () => this.#handleLogin());

    // Setup: max HR input
    this.#el('max-hr-input')?.addEventListener('change', (e) => {
      const maxHr = parseInt(e.target.value, 10);
      if (!Number.isNaN(maxHr) && this.#zoneEngine) {
        this.#zoneEngine.setMaxHr(maxHr);
        this.#renderZoneSetup();
      }
    });

    // Setup: age → calculate max HR
    this.#el('age-input')?.addEventListener('change', (e) => {
      const age = parseInt(e.target.value, 10);
      if (!Number.isNaN(age) && age > 0 && age < 120) {
        const maxHr = 220 - age;
        const maxHrInput = this.#el('max-hr-input');
        if (maxHrInput) {
          maxHrInput.value = maxHr;
          maxHrInput.dispatchEvent(new Event('change'));
        }
      }
    });

    // Setup: Start workout button
    this.#el('start-workout-btn')?.addEventListener('click', () => this.#startWorkout());

    // Workout controls
    this.#el('stop-workout-btn')?.addEventListener('click', () => this.#stopWorkout());
    this.#el('pause-workout-btn')?.addEventListener('click', () => this.#togglePause());

    // Mode toggle
    document.querySelectorAll('.mode-toggle__option').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.#workoutMode = btn.dataset.mode;
        document.querySelectorAll('.mode-toggle__option').forEach((b) =>
          b.classList.toggle('mode-toggle__option--active', b.dataset.mode === this.#workoutMode)
        );
        this.#togglePlannerVisibility();
        // Update mode beschrijving
        const desc = this.#el('mode-description');
        if (desc) {
          desc.textContent = this.#workoutMode === 'reactive'
            ? 'Muziek volgt je hartslag in realtime.'
            : 'Muziek volgt een vooraf gekozen interval-schema.';
        }
      });
    });

    // Simulator slider
    this.#el('hr-slider')?.addEventListener('input', (e) => {
      const bpm = parseInt(e.target.value, 10);
      this.#hrSimulator?.setTargetBpm(bpm);
      this.#el('hr-slider-value').textContent = bpm;
    });

    // Simulator scenario buttons
    document.querySelectorAll('[data-scenario]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.#hrSimulator?.startScenario(btn.dataset.scenario);
      });
    });

    // Workout template cards
    document.querySelectorAll('.planner__template-card').forEach((card) => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.planner__template-card').forEach((c) =>
          c.classList.remove('planner__template-card--selected')
        );
        card.classList.add('planner__template-card--selected');
      });
    });

    // Player controls
    this.#el('player-pause')?.addEventListener('click', () => {
      if (this.#player?.isPlaying) {
        this.#player.pause();
      } else {
        this.#player?.resume();
      }
    });

    this.#el('player-next')?.addEventListener('click', () => {
      this.#playNextTrackForCurrentZone();
    });

    // Volume slider
    this.#el('volume-slider')?.addEventListener('input', (e) => {
      const vol = parseInt(e.target.value, 10) / 100;
      this.#player?.setVolume(vol);
    });

    // Logout
    this.#el('logout-btn')?.addEventListener('click', () => {
      this.#auth?.logout();
      this.#showScreen('login');
    });
  }

  // ── Login ───────────────────────────────────────────────

  async #handleLogin() {
    const clientIdInput = this.#el('client-id-input');
    const clientId = clientIdInput?.value?.trim();

    if (!clientId) {
      this.#showToast('Voer je Spotify Client ID in.', 'error');
      return;
    }

    // Sla Client ID op in sessionStorage voor hergebruik
    sessionStorage.setItem('hbdj_client_id', clientId);

    // Update de config runtime (SPOTIFY is frozen, dus we gebruiken een override)
    window.__SPOTIFY_CLIENT_ID = clientId;

    try {
      await this.#auth.login();
    } catch (err) {
      this.#showToast(err.message, 'error');
    }
  }

  // ── Setup ───────────────────────────────────────────────

  async #loadUserData() {
    // Stap 1: User profiel laden
    try {
      const user = await this.#api.getMe();
      this.#updateUserInfo(user);
      const userInfoEl = this.#el('user-info');
      if (userInfoEl) userInfoEl.style.display = 'flex';

      if (user.product !== 'premium') {
        this.#showToast('Spotify Premium is vereist voor in-browser afspelen.', 'warning');
      }
    } catch (err) {
      this.#showToast(`Profiel laden mislukt: ${err.message}`, 'error');
      return;
    }

    // Stap 2: Playlists laden (onafhankelijk van player)
    try {
      console.log('[HeartBeat DJ] Playlists ophalen...');
      const playlists = await this.#playlistManager.fetchUserPlaylists();
      console.log('[HeartBeat DJ] Playlists gevonden:', playlists.length, playlists);
      this.#renderZoneSetup();
      this.#renderPlaylistSelectors(playlists);
      this.#renderWorkoutTemplates();
    } catch (err) {
      console.error('[HeartBeat DJ] Playlists fout:', err);
      this.#showToast(`Playlists laden mislukt: ${err.message}`, 'error');
    }

    // Stap 3: Player initialiseren (mag falen zonder playlists te blokkeren)
    try {
      console.log('[HeartBeat DJ] Player SDK laden...');
      await this.#player.loadSdk();
      console.log('[HeartBeat DJ] Player initialiseren...');
      await this.#player.initialize();
      console.log('[HeartBeat DJ] Player gereed, device:', this.#player.deviceId);
    } catch (err) {
      console.error('[HeartBeat DJ] Player init fout:', err);
      this.#showToast(`Player init: ${err.message}`, 'error');
    }

    // Toon player mode info
    const modeInfo = this.#el('player-mode-info');
    if (modeInfo && this.#player) {
      const mode = this.#player.mode;
      const modeLabel = mode === 'sdk' ? 'Web Playback (Desktop)' : 'Spotify Connect (Mobiel)';
      modeInfo.innerHTML = `<span class="player-mode-badge player-mode-badge--${mode}">${modeLabel}</span>`;
    }
  }

  #renderZoneSetup() {
    const container = this.#el('zone-setup-list');
    if (!container) return;

    const zones = this.#zoneEngine.zones;
    container.innerHTML = zones.map((zone) => `
      <div class="setup__zone-row" style="--zone-color: var(${zone.color})">
        <div class="setup__zone-info">
          <div class="setup__zone-name">${zone.name}</div>
          <div class="setup__zone-range">${zone.minBpm}–${zone.maxBpm} BPM</div>
        </div>
        <select class="select setup__zone-select" data-zone-id="${zone.id}" id="zone-select-${zone.id}">
          <option value="">— Kies een playlist —</option>
        </select>
      </div>
    `).join('');

    // Bind change events
    container.querySelectorAll('select').forEach((select) => {
      select.addEventListener('change', (e) => {
        const zoneId = e.target.dataset.zoneId;
        const playlistId = e.target.value;
        const playlistName = e.target.options[e.target.selectedIndex]?.text || '';

        if (playlistId) {
          console.log(`[HeartBeat DJ] Playlist "${playlistName}" toewijzen aan zone "${zoneId}"`);
          this.#playlistManager.assignPlaylist(zoneId, playlistId, playlistName)
            .then(() => {
              console.log(`[HeartBeat DJ] Playlist toegewezen, tracks geladen`);
              this.#updateStartButton();
            })
            .catch((err) => {
              console.error(`[HeartBeat DJ] Playlist toewijzen mislukt:`, err);
              this.#showToast(err.message, 'error');
            });
        } else {
          this.#playlistManager.removePlaylist(zoneId);
          this.#updateStartButton();
        }
      });
    });
  }

  #renderPlaylistSelectors(playlists) {
    const selects = document.querySelectorAll('.setup__zone-select');
    const optionsHtml = playlists.map((pl) =>
      `<option value="${pl.id}">${pl.name} (${pl.trackCount} tracks)</option>`
    ).join('');

    selects.forEach((select) => {
      const firstOption = select.querySelector('option');
      select.innerHTML = firstOption.outerHTML + optionsHtml;
    });
  }

  #renderWorkoutTemplates() {
    const container = this.#el('workout-templates');
    if (!container) return;

    const zoneColors = {
      rest: 'var(--zone-rest)',
      light: 'var(--zone-light)',
      moderate: 'var(--zone-moderate)',
      hard: 'var(--zone-hard)',
      maximum: 'var(--zone-maximum)',
    };

    const templates = WorkoutPlanner.getTemplates();
    container.innerHTML = templates.map((tpl, idx) => {
      const totalMin = tpl.segments.reduce((sum, s) => sum + s.durationMinutes, 0);
      const preview = tpl.segments.map((seg) => {
        const pct = (seg.durationMinutes / totalMin) * 100;
        return `<div style="flex:${pct};height:8px;background:${zoneColors[seg.zoneId] || '#333'};border-radius:2px;"></div>`;
      }).join('');

      return `
        <div class="planner__template-card" data-template-index="${idx}">
          <div class="planner__template-name">${tpl.name}</div>
          <div class="planner__template-desc">${tpl.description}</div>
          <div style="display:flex;gap:2px;margin-top:8px;">${preview}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">${totalMin} minuten</div>
        </div>
      `;
    }).join('');

    // Re-bind click events
    container.querySelectorAll('.planner__template-card').forEach((card) => {
      card.addEventListener('click', () => {
        container.querySelectorAll('.planner__template-card').forEach((c) =>
          c.classList.remove('planner__template-card--selected')
        );
        card.classList.add('planner__template-card--selected');
      });
    });
  }

  #updateStartButton() {
    const btn = this.#el('start-workout-btn');
    if (btn) {
      // Minimaal 1 zone moet gemapped zijn
      const hasMappings = this.#playlistManager.getMappings().some((m) => m.playlistId !== null);
      btn.disabled = !hasMappings;
    }
  }

  #togglePlannerVisibility() {
    const planner = this.#el('planner-section');
    if (planner) {
      planner.style.display = this.#workoutMode === 'planned' ? 'block' : 'none';
    }
  }

  // ── Workout ─────────────────────────────────────────────

  async #startWorkout() {
    this.#workoutActive = true;
    this.#hrHistory = [];
    this.#showScreen('workout');

    // Start simulator
    this.#hrSimulator.start();

    // Start achtergrond slideshow
    this.#startBackgroundSlideshow();

    // Timeline container visibility
    const timelineContainer = this.#el('workout-timeline-container');

    // In planned mode: start het geselecteerde workout plan
    if (this.#workoutMode === 'planned') {
      if (timelineContainer) timelineContainer.style.display = 'block';

      const selectedCard = document.querySelector('.planner__template-card--selected');
      if (selectedCard) {
        const templateIdx = parseInt(selectedCard.dataset.templateIndex, 10);
        const templates = WorkoutPlanner.getTemplates();
        const template = templates[templateIdx];
        const plan = WorkoutPlanner.createPlan(template.name, template.segments);
        this.#workoutPlanner.start(plan);
        this.#renderWorkoutTimelineBar(plan);
      }
    } else {
      if (timelineContainer) timelineContainer.style.display = 'none';
    }

    // Speel eerste track
    const currentZoneId = this.#workoutMode === 'planned'
      ? this.#workoutPlanner.currentSegment?.zoneId
      : 'rest';

    if (currentZoneId) {
      await this.#playNextTrackForZone(currentZoneId);
    }
  }

  #stopWorkout() {
    this.#workoutActive = false;
    this.#hrSimulator.stop();
    this.#workoutPlanner.stop();
    this.#player.pause();
    this.#stopBackgroundSlideshow();
    this.#showScreen('setup');
  }

  #togglePause() {
    if (!this.#workoutActive) return;

    if (this.#workoutPlanner.isRunning && !this.#workoutPlanner.isPaused) {
      this.#workoutPlanner.pause();
      this.#player.pause();
      this.#hrSimulator.stop();
      this.#el('pause-workout-btn').textContent = 'Hervat';
    } else if (this.#workoutPlanner.isPaused) {
      this.#workoutPlanner.resume();
      this.#player.resume();
      this.#hrSimulator.start();
      this.#el('pause-workout-btn').textContent = 'Pauze';
    } else {
      // Reactive mode
      if (this.#player.isPlaying) {
        this.#player.pause();
        this.#hrSimulator.stop();
        this.#el('pause-workout-btn').textContent = 'Hervat';
      } else {
        this.#player.resume();
        this.#hrSimulator.start();
        this.#el('pause-workout-btn').textContent = 'Pauze';
      }
    }
  }

  /**
   * Handle zone change — wissel naar track uit juiste playlist.
   * @param {object} zone
   */
  async #handleZoneChange(zone) {
    const zoneId = zone.id;
    await this.#playNextTrackForZone(zoneId);
  }

  /**
   * Speel het volgende nummer voor een specifieke zone.
   * Als de zone geen playlist heeft, zoek de dichtstbijzijnde zone die er wel een heeft.
   * @param {string} zoneId
   */
  async #playNextTrackForZone(zoneId) {
    let track = this.#playlistManager.getNextTrack(zoneId);

    // Fallback: zoek dichtstbijzijnde zone met tracks
    if (track === null) {
      const mappings = this.#playlistManager.getMappings();
      const zonesWithPlaylist = mappings.filter((m) => m.playlistId !== null);
      if (zonesWithPlaylist.length > 0) {
        for (const m of zonesWithPlaylist) {
          track = this.#playlistManager.getNextTrack(m.zoneId);
          if (track !== null) {
            console.log(`[HeartBeat DJ] Fallback: zone "${zoneId}" heeft geen playlist, gebruik "${m.zoneId}"`);
            break;
          }
        }
      }
    }

    if (track === null) {
      this.#showToast(`Geen tracks beschikbaar`, 'error');
      return;
    }

    try {
      await this.#player.crossfadeTo(track.uri);
    } catch (err) {
      // Fallback: directe play zonder crossfade
      try {
        await this.#player.playTrack(track.uri);
      } catch (fallbackErr) {
        this.#showToast(`Kan track niet afspelen: ${fallbackErr.message}`, 'error');
      }
    }
  }

  /**
   * Speel volgend nummer in huidige zone.
   */
  async #playNextTrackForCurrentZone() {
    const currentZoneId = this.#workoutMode === 'planned'
      ? this.#workoutPlanner.currentSegment?.zoneId
      : this.#zoneEngine.currentZone?.id;

    if (currentZoneId) {
      await this.#playNextTrackForZone(currentZoneId);
    }
  }

  // ── Background Images ──────────────────────────────────

  #initBackgroundImages() {
    // Directe Unsplash foto URLs — high-quality sportfotografie
    // Unsplash Source API is deprecated, maar directe foto links werken nog
    this.#bgImages = [
      // Hardlopen bij zonsondergang
      'https://images.unsplash.com/photo-1552674605-db6ffd4facb5?w=1920&h=1080&fit=crop&q=80',
      // Gym training
      'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1920&h=1080&fit=crop&q=80',
      // Wielrennen
      'https://images.unsplash.com/photo-1517649763962-0c623066013b?w=1920&h=1080&fit=crop&q=80',
      // Yoga bij zonsopgang
      'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=1920&h=1080&fit=crop&q=80',
      // Zwemmen
      'https://images.unsplash.com/photo-1530549387789-4c1017266635?w=1920&h=1080&fit=crop&q=80',
      // CrossFit / functioneel trainen
      'https://images.unsplash.com/photo-1517963879433-6ad2b056d712?w=1920&h=1080&fit=crop&q=80',
      // Boksen
      'https://images.unsplash.com/photo-1549719386-74dfcbf7dbed?w=1920&h=1080&fit=crop&q=80',
      // Gewichten / kracht
      'https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=1920&h=1080&fit=crop&q=80',
      // Trail running in natuur
      'https://images.unsplash.com/photo-1476480862126-209bfaa8edc8?w=1920&h=1080&fit=crop&q=80',
      // Stretching / recovery
      'https://images.unsplash.com/photo-1518611012118-696072aa579a?w=1920&h=1080&fit=crop&q=80',
    ];
  }

  #startBackgroundSlideshow() {
    const bgEl = this.#el('workout-bg');
    if (!bgEl) return;

    bgEl.classList.add('workout-bg--active');
    this.#showNextBackground();

    this.#bgIntervalId = setInterval(() => {
      this.#showNextBackground();
    }, 15000); // Wissel elke 15 seconden
  }

  #showNextBackground() {
    const bgEl = this.#el('workout-bg');
    const bgOverlay = this.#el('workout-bg-next');
    if (!bgEl || !bgOverlay) return;

    this.#bgCurrentIndex = (this.#bgCurrentIndex + 1) % this.#bgImages.length;
    const url = this.#bgImages[this.#bgCurrentIndex];

    // Preload image
    const img = new Image();
    img.onload = () => {
      bgOverlay.style.backgroundImage = `url(${url})`;
      bgOverlay.classList.add('workout-bg__layer--visible');

      setTimeout(() => {
        bgEl.style.backgroundImage = `url(${url})`;
        bgOverlay.classList.remove('workout-bg__layer--visible');
      }, 1500);
    };
    img.src = url;
  }

  #stopBackgroundSlideshow() {
    if (this.#bgIntervalId !== null) {
      clearInterval(this.#bgIntervalId);
      this.#bgIntervalId = null;
    }
    const bgEl = this.#el('workout-bg');
    if (bgEl) {
      bgEl.classList.remove('workout-bg--active');
    }
  }

  // ── UI Updates ──────────────────────────────────────────

  #showScreen(screen) {
    this.#currentScreen = screen;
    document.querySelectorAll('.screen').forEach((el) => {
      el.classList.toggle('screen--active', el.id === `screen-${screen}`);
    });
  }

  #updateHrDisplay(bpm) {
    const bpmEl = this.#el('hr-bpm');
    if (bpmEl) bpmEl.textContent = bpm;

    // Hart-icoon animatiesnelheid aanpassen aan BPM
    const icon = this.#el('hr-icon');
    if (icon) {
      icon.className = 'hr-display__icon';
      if (bpm < 100) icon.classList.add('hr-display__icon--slow');
      else if (bpm < 140) icon.classList.add('hr-display__icon--normal');
      else if (bpm < 170) icon.classList.add('hr-display__icon--fast');
      else icon.classList.add('hr-display__icon--extreme');
    }

    // BPM kleur op basis van zone
    const display = this.#el('hr-display');
    if (display && this.#zoneEngine?.currentZone) {
      display.className = 'hr-display';
      display.classList.add(`hr-display--zone-${this.#zoneEngine.currentZone.id}`);

      const zone = this.#zoneEngine.currentZone;
      if (bpmEl) bpmEl.style.color = `var(${zone.color})`;
    }
  }

  #updateZoneDisplay(zone) {
    const nameEl = this.#el('hr-zone-name');
    if (nameEl) {
      nameEl.textContent = zone.name;
      nameEl.style.backgroundColor = `var(${zone.color})`;
      nameEl.style.color = 'var(--bg-primary)';
    }
  }

  #updateHrGraph() {
    const canvas = this.#el('hr-graph-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const w = rect.width;
    const h = rect.height;
    const data = this.#hrHistory;

    ctx.clearRect(0, 0, w, h);

    if (data.length < 2) return;

    // Teken zone achtergrond banden
    if (this.#zoneEngine) {
      const zones = this.#zoneEngine.zones;
      const minBpm = 40;
      const maxBpm = 220;

      zones.forEach((zone) => {
        const y1 = h - ((zone.maxBpm - minBpm) / (maxBpm - minBpm)) * h;
        const y2 = h - ((zone.minBpm - minBpm) / (maxBpm - minBpm)) * h;
        const color = getComputedStyle(document.documentElement).getPropertyValue(zone.color).trim();
        ctx.fillStyle = color + '15'; // 15 = ~8% opacity hex
        ctx.fillRect(0, y1, w, y2 - y1);
      });
    }

    // Teken hartslag lijn
    const minBpm = 40;
    const maxBpm = 220;
    const stepX = w / (UI.HR_GRAPH_DATA_POINTS - 1);

    ctx.beginPath();
    ctx.strokeStyle = '#1db954';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    data.forEach((bpm, i) => {
      const x = (data.length - 1 - (data.length - 1 - i)) * stepX;
      const y = h - ((bpm - minBpm) / (maxBpm - minBpm)) * h;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();

    // Gradient fill onder de lijn
    ctx.lineTo((data.length - 1) * stepX, h);
    ctx.lineTo(0, h);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(29, 185, 84, 0.3)');
    gradient.addColorStop(1, 'rgba(29, 185, 84, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  #updateNowPlaying(track, isPlaying) {
    if (!track) return;

    const titleEl = this.#el('now-playing-title');
    const artistEl = this.#el('now-playing-artist');
    const artEl = this.#el('now-playing-art');
    const pauseBtn = this.#el('player-pause');

    if (titleEl) titleEl.textContent = track.name;
    if (artistEl) artistEl.textContent = track.artist;
    if (artEl && track.albumArt) artEl.src = track.albumArt;
    if (pauseBtn) pauseBtn.textContent = isPlaying ? '⏸' : '▶';
  }

  #updateUserInfo(user) {
    const nameEl = this.#el('user-name');
    const avatarEl = this.#el('user-avatar');

    if (nameEl) nameEl.textContent = user.display_name || user.id;
    if (avatarEl && user.images?.[0]?.url) {
      avatarEl.src = user.images[0].url;
    }
  }

  #renderWorkoutTimelineBar(plan) {
    const bar = this.#el('workout-timeline-bar');
    if (!bar) return;

    const zoneColors = {};
    HEART_RATE_ZONES.forEach((z) => {
      zoneColors[z.id] = `var(${z.color})`;
    });

    bar.innerHTML = plan.segments.map((seg, idx) => {
      const widthPct = (seg.durationMs / plan.totalDurationMs) * 100;
      return `<div class="workout-timeline__segment"
                   data-segment-index="${idx}"
                   style="width: ${widthPct}%; background-color: ${zoneColors[seg.zoneId] || 'var(--bg-tertiary)'}">
                ${widthPct > 5 ? seg.label : ''}
              </div>`;
    }).join('');
  }

  #updateWorkoutTimeline(activeIndex) {
    document.querySelectorAll('.workout-timeline__segment').forEach((el, idx) => {
      el.classList.toggle('workout-timeline__segment--active', idx === activeIndex);
      el.classList.toggle('workout-timeline__segment--completed', idx < activeIndex);
    });
  }

  #updateSegmentProgress(segmentIndex, progress) {
    const segment = document.querySelector(
      `.workout-timeline__segment[data-segment-index="${segmentIndex}"]`
    );
    if (segment) {
      segment.style.background = `linear-gradient(
        to right,
        rgba(0,0,0,0.3) ${progress * 100}%,
        transparent ${progress * 100}%
      ), ${segment.style.backgroundColor}`;
    }
  }

  #updateWorkoutTimer(remainingMs) {
    const timerEl = this.#el('workout-timer');
    if (!timerEl) return;

    const totalSec = Math.ceil(remainingMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    timerEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // ── Toast Notifications ─────────────────────────────────

  #showToast(message, type = 'info') {
    const container = document.querySelector('.toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(16px)';
      toast.style.transition = 'opacity 300ms, transform 300ms';
      setTimeout(() => toast.remove(), 300);
    }, UI.TOAST_DURATION_MS);
  }

  // ── Helpers ─────────────────────────────────────────────

  /**
   * Shorthand voor document.getElementById.
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  #el(id) {
    return document.getElementById(id);
  }
}

// ── Config Override ─────────────────────────────────────
// Spotify CLIENT_ID kan runtime worden ingesteld via sessionStorage
// Dit wordt geladen voordat de auth module het nodig heeft
const savedClientId = sessionStorage.getItem('hbdj_client_id');
if (savedClientId) {
  window.__SPOTIFY_CLIENT_ID = savedClientId;
}

// ── Bootstrap ───────────────────────────────────────────
const app = new App();
app.init().catch((err) => {
  console.error('App initialisatie mislukt:', err);
});
