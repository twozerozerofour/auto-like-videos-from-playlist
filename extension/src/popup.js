/* Playlist Auto-Liker - popup controller. */
(function () {
  'use strict';

  const PAL = globalThis.PAL;
  if (!PAL) return;

  const KEY = PAL.STORAGE_KEYS;
  const els = {};
  let config = PAL.normalizeConfig();
  let lastTabId = null;
  let injectionAttemptedForTab = null;
  let pollTimer = 0;
  let saveTimer = 0;
  let saveFlashTimer = 0;
  let toastTimer = 0;

  const PHASES = {
    idle: { label: 'Inactivo', className: 'idle' },
    starting: { label: 'Iniciando', className: '' },
    preparing: { label: 'Preparando', className: '' },
    waiting: { label: 'Esperando intervalo', className: '' },
    waiting_ad: { label: 'Anuncio en curso', className: '' },
    liking: { label: 'Aplicando Me Gusta', className: 'running' },
    running: { label: 'En ejecución', className: 'running' },
    advancing: { label: 'Avanzando', className: '' },
    paused: { label: 'Pausado', className: 'paused' },
    done: { label: 'Recorrido completado', className: 'done' },
    stopped: { label: 'Detenido', className: 'idle' },
    error: { label: 'Error', className: 'error' },
  };

  start();

  function start() {
    cacheElements();
    bindEvents();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }

  function cacheElements() {
    [
      'conn-dot',
      'context-line',
      'playlist-name',
      'phase',
      'direction-label',
      'index-label',
      'video-title',
      'action',
      'next-step',
      'countdown',
      'liked-count',
      'skipped-count',
      'errors-count',
      'error',
      'start',
      'pause',
      'resume',
      'stop',
      'control-hint',
      'save-state',
      'fixed-row',
      'range-row',
      'fixed-seconds',
      'min-seconds',
      'max-seconds',
      'history-count',
      'toast',
    ].forEach(function (id) {
      els[toCamel(id)] = document.getElementById(id);
    });
  }

  function toCamel(id) {
    return id.replace(/-([a-z])/g, function (_match, letter) {
      return letter.toUpperCase();
    });
  }

  async function init() {
    try {
      const stored = await chrome.storage.local.get(KEY.config);
      config = PAL.normalizeConfig(stored[KEY.config]);
    } catch (_error) {
      config = PAL.normalizeConfig();
    }

    syncForm(config);
    await refresh();
    pollTimer = setInterval(refresh, 600);
  }

  function bindEvents() {
    els.start.addEventListener('click', function () {
      sendCommand('PAL_START');
    });

    els.pause.addEventListener('click', function () {
      sendCommand('PAL_PAUSE');
    });

    els.resume.addEventListener('click', function () {
      sendCommand('PAL_RESUME');
    });

    els.stop.addEventListener('click', function () {
      sendCommand('PAL_STOP');
    });

    document.querySelectorAll('input[name="mode"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        updateModeVisibility();
        const next = readForm();
        if (next) {
          scheduleSave(next, 0);
        }
        (getMode() === 'range' ? els.minSeconds : els.fixedSeconds).focus();
      });
    });

    document.querySelectorAll('input[name="direction"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        const next = readForm();
        if (next) scheduleSave(next, 0);
      });
    });

    [els.fixedSeconds, els.minSeconds, els.maxSeconds].forEach(function (input) {
      input.addEventListener('input', function () {
        const next = readForm();
        markInputValidity(next !== null);
        if (next) scheduleSave(next, 320);
      });

      input.addEventListener('blur', function () {
        const next = readForm();
        if (next) {
          scheduleSave(next, 0);
          window.setTimeout(function () {
            syncForm(config);
          }, 0);
        } else {
          markInputValidity(false);
          syncForm(config);
        }
      });

      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          const next = readForm();
          if (next) scheduleSave(next, 0);
          syncForm(config);
        }
      });
    });

    window.addEventListener('unload', function () {
      clearInterval(pollTimer);
      clearTimeout(saveTimer);
      clearTimeout(saveFlashTimer);
      clearTimeout(toastTimer);
    });
  }

  function updateModeVisibility() {
    const mode = getMode();
    els.fixedRow.hidden = mode !== 'fixed';
    els.rangeRow.hidden = mode !== 'range';
    els.fixedSeconds.disabled = mode !== 'fixed';
    els.minSeconds.disabled = mode !== 'range';
    els.maxSeconds.disabled = mode !== 'range';
  }

  function getMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked && checked.value === 'range' ? 'range' : 'fixed';
  }

  function getDirection() {
    const checked = document.querySelector('input[name="direction"]:checked');
    return checked && checked.value === 'descending' ? 'descending' : 'ascending';
  }

  function parseInput(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const parsed = Number.parseFloat(String(raw).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function readForm() {
    const mode = getMode();
    const fixed = parseInput(els.fixedSeconds.value);
    const min = parseInput(els.minSeconds.value);
    const max = parseInput(els.maxSeconds.value);

    if (mode === 'fixed' && fixed === null) return null;
    if (mode === 'range' && (min === null || max === null)) return null;

    return PAL.normalizeConfig({
      mode: mode,
      fixedSeconds: fixed === null ? config.fixedSeconds : fixed,
      minSeconds: min === null ? config.minSeconds : min,
      maxSeconds: max === null ? config.maxSeconds : max,
      direction: getDirection(),
    });
  }

  function markInputValidity(valid) {
    const mode = getMode();
    const targets =
      mode === 'fixed' ? [els.fixedSeconds] : [els.minSeconds, els.maxSeconds];
    targets.forEach(function (input) {
      input.classList.toggle('invalid', !valid);
    });
    if (valid) {
      els.fixedSeconds.classList.remove('invalid');
      els.minSeconds.classList.remove('invalid');
      els.maxSeconds.classList.remove('invalid');
    }
  }

  function syncForm(nextConfig) {
    const normalized = PAL.normalizeConfig(nextConfig);
    config = normalized;

    document.querySelectorAll('input[name="mode"]').forEach(function (radio) {
      radio.checked = radio.value === normalized.mode;
    });

    document.querySelectorAll('input[name="direction"]').forEach(function (radio) {
      radio.checked = radio.value === normalized.direction;
    });

    els.fixedSeconds.value = String(normalized.fixedSeconds);
    els.minSeconds.value = String(normalized.minSeconds);
    els.maxSeconds.value = String(normalized.maxSeconds);
    els.fixedSeconds.classList.remove('invalid');
    els.minSeconds.classList.remove('invalid');
    els.maxSeconds.classList.remove('invalid');
    updateModeVisibility();
  }

  function scheduleSave(nextConfig, delayMs) {
    clearTimeout(saveTimer);
    const wait = typeof delayMs === 'number' ? delayMs : 300;

    if (wait <= 0) {
      persistConfig(nextConfig);
      return;
    }

    saveTimer = setTimeout(function () {
      persistConfig(nextConfig);
    }, wait);
  }

  async function persistConfig(nextConfig) {
    const normalized = PAL.normalizeConfig(nextConfig);
    config = normalized;

    try {
      await chrome.storage.local.set({ [KEY.config]: normalized });
      flashSaved('Guardado');
    } catch (_error) {
      flashSaved('No se pudo guardar', true);
    }
  }

  function flashSaved(text, isError) {
    clearTimeout(saveFlashTimer);
    els.saveState.textContent = text;
    els.saveState.style.color = isError ? 'var(--danger)' : 'var(--green)';
    els.saveState.classList.add('visible');
    saveFlashTimer = setTimeout(function () {
      els.saveState.classList.remove('visible');
    }, 1400);
  }

  /* ------------------------------------------------------------------ */
  /* State polling                                                      */
  /* ------------------------------------------------------------------ */

  async function getActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs.length ? tabs[0] : null;
    } catch (_error) {
      return null;
    }
  }

  async function sendMessageToTab(tabId, type) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: type });
      return response || null;
    } catch (_error) {
      return null;
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function injectContentScript(tabId) {
    if (injectionAttemptedForTab === tabId) return false;
    injectionAttemptedForTab = tabId;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['src/lib.js', 'src/content.js'],
      });
    } catch (_error) {
      return false;
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await delay(150);
      const response = await sendMessageToTab(tabId, 'PAL_GET_STATE');
      if (response) return true;
    }

    return false;
  }

  async function refresh() {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) {
      renderDisconnected();
      return;
    }

    if (lastTabId !== tab.id) {
      lastTabId = tab.id;
      injectionAttemptedForTab = null;
    }

    let response = await sendMessageToTab(tab.id, 'PAL_GET_STATE');
    if (!response) {
      const injected = await injectContentScript(tab.id);
      if (injected) {
        response = await sendMessageToTab(tab.id, 'PAL_GET_STATE');
      }
    }

    if (response && response.state) {
      render(response.state);
    } else {
      renderDisconnected();
    }
  }

  async function sendCommand(type) {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) {
      showToast('No hay una pestaña activa.', true);
      return;
    }

    if (lastTabId !== tab.id) {
      lastTabId = tab.id;
      injectionAttemptedForTab = null;
    }

    let response = await sendMessageToTab(tab.id, type);

    if (!response) {
      const injected = await injectContentScript(tab.id);
      if (injected) {
        response = await sendMessageToTab(tab.id, type);
      }
    }

    if (!response) {
      showToast('No se pudo conectar con esta pestaña. Abre una playlist de YouTube y recárgala.', true);
      await refresh();
      return;
    }

    if (!response.ok) {
      showToast(response.error || 'No se pudo ejecutar la acción.', true);
      if (response.state) render(response.state);
      return;
    }

    if (response.state) render(response.state);
    await refresh();
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function render(state) {
    const context = state.context || {};
    const onPlaylist = Boolean(context.isPlaylist);
    const phase = PHASES[state.phase] || PHASES.idle;
    const active = Boolean(state.active);

    const connClass = state.phase === 'error' ? 'error' : onPlaylist ? 'on' : 'warn';
    els.connDot.className = 'conn-dot ' + connClass;

    els.contextLine.textContent = onPlaylist ? 'Playlist detectada' : 'Esta pestaña no es una playlist';
    els.contextLine.classList.toggle('on-playlist', onPlaylist);
    els.playlistName.textContent =
      state.playlistName || (onPlaylist ? 'Playlist de YouTube' : 'Abre un video dentro de una playlist.');

    els.phase.textContent = phase.label;
    els.phase.className = 'phase ' + phase.className;
    els.indexLabel.textContent = state.indexLabel || '';

    const direction =
      state.direction === 'descending' || state.direction === 'ascending'
        ? state.direction
        : (state.config && state.config.direction) || config.direction;
    els.directionLabel.textContent = onPlaylist
      ? direction === 'descending'
        ? 'Descendente'
        : 'Ascendente'
      : '';

    els.videoTitle.textContent = state.videoTitle || (onPlaylist ? 'Esperando el video actual…' : '—');
    els.action.textContent =
      state.action || (onPlaylist ? 'Listo para empezar.' : 'Abre un video dentro de una playlist de YouTube.');
    els.nextStep.textContent = state.nextStep || '';

    if (state.countdown != null) {
      els.countdown.hidden = false;
      els.countdown.textContent = 'Próximo Me Gusta en ' + state.countdown + ' s';
    } else {
      els.countdown.hidden = true;
      els.countdown.textContent = '';
    }

    els.likedCount.textContent = String(state.stats ? state.stats.liked : 0);
    els.skippedCount.textContent = String(state.stats ? state.stats.skipped : 0);
    els.errorsCount.textContent = String(state.stats ? state.stats.errors : 0);

    if (state.error) {
      els.error.hidden = false;
      els.error.textContent = state.error;
    } else {
      els.error.hidden = true;
      els.error.textContent = '';
    }

    els.start.hidden = active;
    els.start.disabled = !onPlaylist || active;
    els.start.textContent =
      state.phase === 'done' || state.phase === 'stopped' ? 'Iniciar de nuevo' : 'Iniciar';
    els.pause.hidden = !active || Boolean(state.paused);
    els.resume.hidden = !active || !state.paused;
    els.stop.disabled = !active;

    els.historyCount.textContent = Number.isFinite(state.historyCount)
      ? state.historyCount + ' videos con Me Gusta recordado'
      : '';

    if (!onPlaylist) {
      els.controlHint.textContent =
        'La extensión solo se activa en videos que forman parte de una playlist.';
    } else if (active) {
      els.controlHint.textContent =
        'El intervalo se aplica al instante; la dirección se aplica al iniciar el próximo recorrido.';
    } else if (direction === 'descending') {
      els.controlHint.textContent =
        'Se empieza por el video actual y se retrocede hasta el inicio de la playlist.';
    } else {
      els.controlHint.textContent =
        'Se empieza por el video actual y se avanza hasta el final de la playlist.';
    }
  }

  function renderDisconnected() {
    els.connDot.className = 'conn-dot warn';
    els.contextLine.textContent = 'Sin conexión con esta pestaña';
    els.contextLine.classList.remove('on-playlist');
    els.playlistName.textContent = 'Abre un video dentro de una playlist de YouTube.';

    els.phase.textContent = 'Inactivo';
    els.phase.className = 'phase idle';
    els.directionLabel.textContent = '';
    els.indexLabel.textContent = '';
    els.videoTitle.textContent = '—';
    els.action.textContent = 'Esta pestaña no es una playlist o la extensión aún no está lista.';
    els.nextStep.textContent = '';
    els.countdown.hidden = true;
    els.countdown.textContent = '';

    els.likedCount.textContent = '0';
    els.skippedCount.textContent = '0';
    els.errorsCount.textContent = '0';
    els.error.hidden = true;
    els.error.textContent = '';

    els.start.hidden = false;
    els.start.disabled = true;
    els.start.textContent = 'Iniciar';
    els.pause.hidden = true;
    els.resume.hidden = true;
    els.stop.disabled = true;
    els.historyCount.textContent = '';
    els.controlHint.textContent =
      'La extensión solo se activa en videos que forman parte de una playlist.';
  }

  function showToast(message, isError) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.hidden = false;
    els.toast.classList.toggle('error', Boolean(isError));
    toastTimer = setTimeout(function () {
      els.toast.hidden = true;
    }, 4200);
  }
})();
