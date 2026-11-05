/*
 * Playlist Auto-Liker - content script.
 *
 * Runs on youtube.com, keeps a small state machine and exposes it to the
 * popup through chrome.runtime messages. All actions are performed through
 * the regular YouTube UI (like button / next button), never through private
 * APIs.
 */
(function () {
  'use strict';

  const PAL = globalThis.PAL;
  if (!PAL) return;
  if (globalThis.__playlistAutoLikerLoaded) return;
  globalThis.__playlistAutoLikerLoaded = true;

  const KEY = PAL.STORAGE_KEYS;
  const LIMITS = {
    readyTimeoutMs: 35000,
    adTimeoutMs: 10 * 60 * 1000,
    advanceTimeoutMs: 25000,
    maxActions: 1000,
    historyLimit: 5000,
  };

  const PHASE_LABEL = {
    idle: 'Inactivo',
    starting: 'Iniciando',
    preparing: 'Preparando',
    waiting: 'Esperando intervalo',
    waiting_ad: 'Anuncio en curso',
    liking: 'Aplicando Me Gusta',
    running: 'En ejecución',
    advancing: 'Avanzando',
    paused: 'Pausado',
    done: 'Recorrido completado',
    stopped: 'Detenido',
    error: 'Error',
  };

  let config = PAL.normalizeConfig();
  let history = new Map();
  let historyLoaded = false;
  let currentRun = null;
  let runSequence = 0;
  let hud = null;
  let hudRaf = 0;
  let hudHideTimer = 0;
  let hudCollapsed = false;

  const runtime = {
    active: false,
    paused: false,
    phase: 'idle',
    playlistId: null,
    playlistName: '',
    videoId: null,
    videoTitle: '',
    indexLabel: '',
    action: '',
    nextStep: '',
    error: '',
    countdown: null,
    intervalMs: 0,
    direction: null,
    stats: { liked: 0, skipped: 0, errors: 0 },
    startedAt: null,
    finishedAt: null,
  };

  class AbortRun extends Error {
    constructor() {
      super('Proceso cancelado.');
      this.name = 'AbortRun';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bootstrap                                                          */
  /* ------------------------------------------------------------------ */

  init();

  async function init() {
    try {
      const stored = await chrome.storage.local.get(KEY.config);
      config = PAL.normalizeConfig(stored[KEY.config]);
    } catch (_error) {
      config = PAL.normalizeConfig();
    }

    buildHud();
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onMessage);
    document.addEventListener('yt-navigate-finish', onNavigation, true);
    document.addEventListener('yt-page-data-updated', onNavigation, true);
    renderHud();
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes[KEY.config]) return;

    const previous = config;
    config = PAL.normalizeConfig(changes[KEY.config].newValue);

    if (currentRun && currentRun.active) {
      const intervalChanged =
        previous.mode !== config.mode ||
        previous.fixedSeconds !== config.fixedSeconds ||
        previous.minSeconds !== config.minSeconds ||
        previous.maxSeconds !== config.maxSeconds;

      if (intervalChanged) {
        currentRun.intervalMs = PAL.pickIntervalMs(config);
        runtime.intervalMs = currentRun.intervalMs;
        if (runtime.phase === 'waiting') {
          runtime.nextStep =
            'Intervalo actualizado a ' + PAL.formatSeconds(currentRun.intervalMs) + '.';
        }
      }
      renderSoon();
    }
  }

  function onNavigation() {
    if (!runtime.active) return;
    const context = PAL.parseVideoContext(location.href);
    if (!context.isPlaylist && currentRun) {
      finishRun(currentRun, 'done', 'La playlist dejó de estar activa. Proceso finalizado.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Messaging                                                          */
  /* ------------------------------------------------------------------ */

  function onMessage(message, _sender, sendResponse) {
    const type = message && message.type;
    if (typeof type !== 'string' || type.indexOf('PAL_') !== 0) return undefined;

    if (type === 'PAL_GET_STATE') {
      sendResponse({ ok: true, state: buildSnapshot() });
      return undefined;
    }

    if (type === 'PAL_START') {
      startRun()
        .then(function () {
          sendResponse({ ok: true, state: buildSnapshot() });
        })
        .catch(function (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'No se pudo iniciar.',
            state: buildSnapshot(),
          });
        });
      return true;
    }

    if (type === 'PAL_PAUSE') {
      pauseRun();
      sendResponse({ ok: true, state: buildSnapshot() });
      return undefined;
    }

    if (type === 'PAL_RESUME') {
      resumeRun();
      sendResponse({ ok: true, state: buildSnapshot() });
      return undefined;
    }

    if (type === 'PAL_STOP') {
      stopRun();
      sendResponse({ ok: true, state: buildSnapshot() });
      return undefined;
    }

    return undefined;
  }

  function buildSnapshot() {
    const context = PAL.parseVideoContext(location.href);
    return {
      active: runtime.active,
      paused: runtime.paused,
      phase: runtime.phase,
      playlistId: runtime.playlistId,
      playlistName: runtime.playlistName,
      videoId: runtime.videoId,
      videoTitle: runtime.videoTitle,
      indexLabel: runtime.indexLabel,
      action: runtime.action,
      nextStep: runtime.nextStep,
      error: runtime.error,
      countdown: runtime.countdown,
      intervalMs: runtime.intervalMs,
      direction: runtime.direction || config.direction,
      stats: {
        liked: runtime.stats.liked,
        skipped: runtime.stats.skipped,
        errors: runtime.stats.errors,
      },
      historyCount: history.size,
      startedAt: runtime.startedAt,
      finishedAt: runtime.finishedAt,
      config: Object.assign({}, config),
      context: {
        isWatch: context.isWatch,
        isPlaylist: context.isPlaylist,
        videoId: context.videoId,
        playlistId: context.playlistId,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Run lifecycle                                                      */
  /* ------------------------------------------------------------------ */

  async function startRun() {
    if (currentRun && currentRun.active) {
      throw new Error('Ya hay un proceso en curso en esta pestaña.');
    }

    const context = PAL.parseVideoContext(location.href);
    if (!context.isPlaylist) {
      throw new Error('Abre un video dentro de una playlist de YouTube para empezar.');
    }

    await ensureHistoryLoaded();

    const run = {
      id: ++runSequence,
      active: true,
      paused: false,
      intervalMs: PAL.pickIntervalMs(config),
      direction: config.direction === 'descending' ? 'descending' : 'ascending',
      processed: new Set(),
      failures: 0,
      phaseBeforePause: 'preparing',
    };
    currentRun = run;

    resetRuntime();
    runtime.active = true;
    runtime.playlistId = context.playlistId;
    runtime.intervalMs = run.intervalMs;
    runtime.direction = run.direction;
    runtime.startedAt = Date.now();
    runtime.phase = 'preparing';
    runtime.action = 'Preparando la playlist…';
    runtime.nextStep = 'Esperando a que el reproductor esté listo…';
    runtime.videoTitle = getVideoTitle();
    runtime.playlistName = getPlaylistPanelInfo().name;
    updatePlaylistMeta();

    clearTimeout(hudHideTimer);
    hudCollapsed = false;
    showHud();

    runLoop(run).catch(function (error) {
      if (!isLive(run) || error instanceof AbortRun) return;
      finishRun(run, 'error', error instanceof Error ? error.message : 'Error inesperado.');
    });

    return true;
  }

  function resetRuntime() {
    runtime.active = false;
    runtime.paused = false;
    runtime.phase = 'idle';
    runtime.playlistId = null;
    runtime.playlistName = '';
    runtime.videoId = null;
    runtime.videoTitle = '';
    runtime.indexLabel = '';
    runtime.action = '';
    runtime.nextStep = '';
    runtime.error = '';
    runtime.countdown = null;
    runtime.intervalMs = 0;
    runtime.direction = null;
    runtime.stats = { liked: 0, skipped: 0, errors: 0 };
    runtime.startedAt = null;
    runtime.finishedAt = null;
  }

  function pauseRun() {
    if (!currentRun || !currentRun.active || currentRun.paused) return;
    currentRun.phaseBeforePause = runtime.phase === 'paused' ? 'running' : runtime.phase;
    currentRun.paused = true;
    runtime.paused = true;
    runtime.phase = 'paused';
    runtime.action = 'Proceso en pausa.';
    runtime.nextStep = 'Pulsa Reanudar para continuar.';
    renderSoon();
  }

  function resumeRun() {
    if (!currentRun || !currentRun.active || !currentRun.paused) return;
    currentRun.paused = false;
    runtime.paused = false;
    runtime.phase = currentRun.phaseBeforePause || 'running';
    runtime.action = 'Proceso reanudado.';
    runtime.nextStep = 'Continuando con el recorrido…';
    renderSoon();
  }

  function stopRun() {
    if (!currentRun) {
      if (runtime.phase !== 'idle') {
        runtime.phase = 'stopped';
        runtime.active = false;
        runtime.paused = false;
        runtime.countdown = null;
        runtime.action = 'Proceso detenido.';
        runtime.nextStep = '';
        showHud();
        scheduleHudHide(6000);
      }
      return;
    }

    const run = currentRun;
    run.active = false;
    run.cancelled = true;
    currentRun = null;

    runtime.active = false;
    runtime.paused = false;
    runtime.phase = 'stopped';
    runtime.countdown = null;
    runtime.action = 'Proceso detenido por el usuario.';
    runtime.nextStep = '';
    runtime.finishedAt = Date.now();
    showHud();
    scheduleHudHide(6000);
  }

  function finishRun(run, phase, message) {
    if (!isLive(run)) return;

    run.active = false;
    currentRun = null;
    runtime.active = false;
    runtime.paused = false;
    runtime.phase = phase;
    runtime.countdown = null;
    runtime.action = message;
    runtime.nextStep = phase === 'error' ? 'Revisa el estado y vuelve a iniciar el proceso.' : '';
    runtime.finishedAt = Date.now();
    if (phase === 'error') {
      runtime.error = message;
      runtime.stats.errors += 1;
    }

    showHud();
    scheduleHudHide(phase === 'done' ? 15000 : 0);
  }

  function isLive(run) {
    return Boolean(run) && run === currentRun && run.active === true;
  }

  function checkLive(run) {
    if (!isLive(run)) throw new AbortRun();
  }

  async function waitWhilePaused(run) {
    while (isLive(run) && run.paused) {
      await sleep(200);
    }
    checkLive(run);
  }

  /* ------------------------------------------------------------------ */
  /* Main loop                                                          */
  /* ------------------------------------------------------------------ */

  async function runLoop(run) {
    const ready = await waitForValue(
      run,
      function () {
        const context = PAL.parseVideoContext(location.href);
        if (!context.isPlaylist) return null;
        if (!document.querySelector('ytd-playlist-panel-renderer') && !document.querySelector('.ytp-next-button')) {
          return null;
        }
        return context;
      },
      20000,
      300
    );

    if (!ready) {
      throw new Error('No se encontró una playlist activa en esta página.');
    }

    runtime.playlistId = ready.playlistId;
    let actions = 0;

    while (isLive(run)) {
      await waitWhilePaused(run);

      const context = PAL.parseVideoContext(location.href);
      if (!context.isPlaylist) {
        finishRun(run, 'done', 'La playlist terminó.');
        return;
      }

      updatePlaylistMeta();

      if (++actions > LIMITS.maxActions) {
        finishRun(run, 'error', 'Se alcanzó el límite de seguridad de acciones. Proceso detenido.');
        return;
      }

      setPhase(
        'preparing',
        'Evaluando “' + (runtime.videoTitle || 'el video actual') + '”…',
        'Comprobando el estado del video…'
      );

      const playerReady = await waitUntilReady(run, LIMITS.readyTimeoutMs);
      if (!isLive(run)) return;
      await waitWhilePaused(run);

      if (!playerReady.ok) {
        runtime.error =
          playerReady.reason === 'unavailable'
            ? 'El video actual no está disponible.'
            : 'El video no cargó a tiempo.';
        runtime.stats.errors += 1;
        runtime.action = 'No se pudo procesar el video actual.';
        runtime.nextStep = 'Intentando avanzar al siguiente video…';

        const advanceResult = await advance(run);
        if (advanceResult === 'end') {
          finishRun(run, 'done', 'No quedan más videos en la playlist.');
          return;
        }
        if (advanceResult !== 'advanced') {
          finishRun(run, 'error', 'No se pudo avanzar al siguiente video.');
          return;
        }
        continue;
      }

      const videoId = PAL.parseVideoContext(location.href).videoId;
      if (!videoId) {
        finishRun(run, 'error', 'No se pudo identificar el video actual.');
        return;
      }

      runtime.videoId = videoId;
      runtime.videoTitle = getVideoTitle();

      if (run.processed.has(videoId)) {
        // This happens only if the playlist did not advance or came back to a
        // video already handled. Never like it twice.
        runtime.action = 'Este video ya fue procesado en esta ejecución.';
        runtime.nextStep = goingText(run);
        const result = await advance(run);
        if (result === 'end') {
          finishRun(run, 'done', endText(run));
          return;
        }
        if (result !== 'advanced') {
          finishRun(run, 'error', advanceErrorText(run));
          return;
        }
        continue;
      }

      run.processed.add(videoId);
      updatePlaylistMeta();
      const atEndAtStart = isAtEndOfRun(videoId, run.direction);
      const likeState = readLikeState();
      const wasAlreadyLiked = PAL.shouldSkipVideo({
        pressed: likeState.pressed,
        videoId: videoId,
        history: history,
      });

      if (wasAlreadyLiked) {
        runtime.stats.skipped += 1;
        setPhase(
          'running',
          likeState.pressed === true
            ? 'Omitido: el video ya tenía Me Gusta.'
            : 'Omitido: la extensión ya dio Me Gusta a este video antes.',
          atEndAtStart ? boundaryText(run) : goingText(run)
        );
        runtime.countdown = null;
        renderSoon();
        await sleep(180);
      } else {
        run.intervalMs = PAL.pickIntervalMs(config);
        runtime.intervalMs = run.intervalMs;
        setPhase(
          'waiting',
          'El video no tiene Me Gusta.',
          'Esperando ' + PAL.formatSeconds(run.intervalMs) + ' antes de aplicarlo…'
        );

        const playback = maybePausePlayback(run);
        try {
          await waitInterval(run);
        } finally {
          restorePlayback(playback);
        }

        if (!isLive(run)) return;
        await waitWhilePaused(run);

        if (!isSameVideo(videoId)) {
          runtime.action = 'El video cambió durante la espera; no se aplicó Me Gusta.';
          runtime.nextStep = 'Procesando el video nuevo…';
          runtime.countdown = null;
          renderSoon();
          continue;
        }

        if (isAdShowing()) {
          setPhase(
            'waiting_ad',
            'Comenzó un anuncio; esperando a que termine…',
            'El video se reevaluará al terminar el anuncio.'
          );
          const afterAd = await waitUntilReady(run, LIMITS.adTimeoutMs);
          if (!isLive(run)) return;
          await waitWhilePaused(run);
          if (!afterAd.ok || !isSameVideo(videoId)) continue;
        }

        if (readLikeState().pressed === true) {
          runtime.stats.skipped += 1;
          setPhase('running', 'Omitido: el video ya tenía Me Gusta.', goingText(run));
        } else {
          setPhase('liking', 'Aplicando Me Gusta…', 'Verificando que YouTube lo registre…');
          const result = await applyLike(run, videoId);
          if (!isLive(run)) return;

          if (result === 'liked') {
            runtime.stats.liked += 1;
            runtime.error = '';
            await rememberLiked(videoId);
            setPhase('running', 'Me Gusta aplicado.', goingText(run));
          } else if (result === 'changed') {
            runtime.action = 'El video cambió antes de aplicar Me Gusta.';
            runtime.nextStep = 'Procesando el video nuevo…';
            runtime.countdown = null;
            renderSoon();
            continue;
          } else {
            runtime.stats.errors += 1;
            runtime.error =
              'No se pudo confirmar el Me Gusta. Comprueba que has iniciado sesión en YouTube.';
            setPhase(
              'running',
              'No se pudo aplicar Me Gusta.',
              goingText(run)
            );
          }
        }
      }

      if (!isLive(run)) return;
      runtime.countdown = null;

      if (atEndAtStart || isAtEndOfRun(videoId, run.direction)) {
        finishRun(run, 'done', endText(run));
        return;
      }

      setPhase('advancing', goingText(run), goingHint(run));
      const advanceResult = await advance(run);
      if (!isLive(run)) return;

      if (advanceResult === 'end') {
        finishRun(run, 'done', endText(run));
        return;
      }

      if (advanceResult === 'advanced') {
        run.failures = 0;
        continue;
      }

      run.failures += 1;
      if (run.failures >= 2) {
        finishRun(run, 'error', 'No se pudo avanzar al siguiente video.');
        return;
      }

      // One retry before giving up.
      const retry = await advance(run);
      if (!isLive(run)) return;
      if (retry === 'end') {
        finishRun(run, 'done', endText(run));
        return;
      }
      if (retry !== 'advanced') {
        finishRun(run, 'error', advanceErrorText(run));
        return;
      }
      run.failures = 0;
    }
  }

  function isDescending(run) {
    return Boolean(run) && run.direction === 'descending';
  }

  function goingText(run) {
    return isDescending(run)
      ? 'Retrocediendo al video anterior…'
      : 'Avanzando al siguiente video…';
  }

  function goingHint(run) {
    return isDescending(run)
      ? 'Esperando a que cargue el video anterior…'
      : 'Esperando a que cargue el siguiente video…';
  }

  function endText(run) {
    return isDescending(run)
      ? 'Se llegó al inicio de la playlist.'
      : 'Playlist terminada.';
  }

  function boundaryText(run) {
    return isDescending(run)
      ? 'Es el primer video de la playlist.'
      : 'Es el último video de la playlist.';
  }

  function advanceErrorText(run) {
    return isDescending(run)
      ? 'No se pudo retroceder al video anterior.'
      : 'No se pudo avanzar al siguiente video.';
  }

  /* ------------------------------------------------------------------ */
  /* Player and playlist inspection                                     */
  /* ------------------------------------------------------------------ */

  function isSameVideo(videoId) {
    return PAL.parseVideoContext(location.href).videoId === videoId;
  }

  function getDomVideoId() {
    const flexy = document.querySelector('ytd-watch-flexy');
    return flexy ? flexy.getAttribute('video-id') : null;
  }

  function isVisible(element) {
    if (!element) return false;
    return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  function isAdShowing() {
    const player = document.querySelector('#movie_player');
    if (!player) return false;
    if (player.classList.contains('ad-showing')) return true;

    const overlay = player.querySelector('.ytp-ad-player-overlay');
    return isVisible(overlay);
  }

  function isUnavailable() {
    const player = document.querySelector('#movie_player');
    if (!player) return false;
    if (player.classList.contains('ytp-unavailable')) return true;

    const error = player.querySelector('.ytp-error');
    return isVisible(error);
  }

  function getVideoTitle() {
    const selectors = [
      'ytd-watch-metadata h1 yt-formatted-string',
      'ytd-watch-metadata #title h1',
      'h1.ytd-watch-metadata yt-formatted-string',
      '#title h1 yt-formatted-string',
      'h1.title yt-formatted-string',
    ];

    for (let index = 0; index < selectors.length; index += 1) {
      const element = document.querySelector(selectors[index]);
      const text = element && element.textContent ? element.textContent.trim() : '';
      if (text) return text;
    }

    return document.title.replace(/\s*-\s*YouTube$/, '').trim();
  }

  function getPlaylistPanel() {
    return document.querySelector('ytd-playlist-panel-renderer');
  }

  function getPlaylistPanelInfo() {
    const panel = getPlaylistPanel();
    const currentId = PAL.parseVideoContext(location.href).videoId;
    const position = getPlaylistPosition();
    const items = [];

    const nodes = document.querySelectorAll('ytd-playlist-panel-video-renderer');
    for (let index = 0; index < nodes.length; index += 1) {
      const element = nodes[index];
      const anchor = element.querySelector('a#wc-endpoint, a#thumbnail, a[href*="/watch"]');
      let videoId = element.getAttribute('video-id') || element.getAttribute('data-video-id');

      if (!videoId && anchor) {
        const href = anchor.getAttribute('href') || '';
        const match = /[?&]v=([^&]+)/.exec(href);
        if (match) {
          try {
            videoId = decodeURIComponent(match[1]);
          } catch (_error) {
            videoId = match[1];
          }
        }
      }

      if (!videoId) continue;

      const selected =
        element.hasAttribute('selected') ||
        element.getAttribute('aria-selected') === 'true' ||
        Boolean(anchor && anchor.getAttribute('aria-current') === 'true');

      items.push({ element: element, anchor: anchor, videoId: videoId, selected: selected });
    }

    let currentIndex = items.findIndex(function (item) {
      return item.selected;
    });
    if (currentIndex === -1 && currentId) {
      currentIndex = items.findIndex(function (item) {
        return item.videoId === currentId;
      });
    }

    let name = '';
    const nameElement =
      document.querySelector(
        'ytd-playlist-panel-renderer #header-description > h3:first-of-type a'
      ) ||
      document.querySelector(
        'ytd-playlist-panel-renderer #header-description > h3:first-of-type'
      ) ||
      document.querySelector('ytd-playlist-panel-renderer yt-formatted-string.byline-title') ||
      document.querySelector('ytd-playlist-panel-renderer #playlist-title');
    if (nameElement && nameElement.textContent) {
      name = nameElement.textContent.trim();
    }
    if (!name) {
      name = document.title.replace(/\s*-\s*YouTube$/, '').trim();
    }

    return {
      panel: panel,
      items: items,
      currentIndex: currentIndex,
      position: position,
      name: name,
    };
  }

  /**
   * YouTube's playlist panel is virtualized for large playlists: only a window
   * of items is rendered, so items.length is not the playlist length. The
   * header index ("201 / 940") is the reliable global position.
   */
  function getPlaylistPosition() {
    const panel = getPlaylistPanel();
    if (!panel) return null;

    const element =
      panel.querySelector('.index-message') ||
      panel.querySelector('#header-description .index-message');
    if (!element) return null;

    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    const match = /(\d[\d.,\s]*)\s*\/\s*(\d[\d.,\s]*)/.exec(text);
    if (!match) return null;

    const parseCount = function (raw) {
      const digits = String(raw).replace(/\D/g, '');
      return digits ? Number.parseInt(digits, 10) : NaN;
    };

    const current = parseCount(match[1]);
    const total = parseCount(match[2]);
    if (!Number.isFinite(current) || !Number.isFinite(total) || current <= 0 || total <= 0) {
      return null;
    }

    return { current: current, total: total };
  }

  function updatePlaylistMeta() {
    const context = PAL.parseVideoContext(location.href);
    const info = getPlaylistPanelInfo();

    runtime.playlistId = context.playlistId || runtime.playlistId;
    runtime.playlistName = info.name || runtime.playlistName;
    runtime.videoId = context.videoId || runtime.videoId;
    runtime.videoTitle = getVideoTitle();
    runtime.indexLabel = info.position
      ? String(info.position.current) + ' de ' + String(info.position.total)
      : info.currentIndex >= 0 && info.items.length > 0
        ? String(info.currentIndex + 1) + ' de ' + String(info.items.length)
        : '';
    renderSoon();
  }

  function isAtEndOfRun(videoId, direction) {
    const info = getPlaylistPanelInfo();

    if (info.position) {
      return direction === 'descending'
        ? info.position.current <= 1
        : info.position.current >= info.position.total;
    }

    if (!info.panel || info.items.length === 0) return false;

    let index = info.items.findIndex(function (item) {
      return item.selected;
    });
    if (index === -1) {
      index = info.items.findIndex(function (item) {
        return item.videoId === videoId;
      });
    }
    if (index === -1) return false;

    return direction === 'descending' ? index === 0 : index === info.items.length - 1;
  }

  function getAdjacentPlaylistItem(info, direction) {
    if (!info || info.currentIndex < 0) return null;
    const targetIndex =
      direction === 'descending' ? info.currentIndex - 1 : info.currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= info.items.length) return null;
    return info.items[targetIndex];
  }

  function elementIsDisabled(element) {
    if (!element) return true;
    if (element.hasAttribute('disabled')) return true;
    if (element.getAttribute('aria-disabled') === 'true') return true;
    return (
      element.classList.contains('ytp-next-button-disabled') ||
      element.classList.contains('ytp-prev-button-disabled')
    );
  }

  function isPlaylistEndedUi() {
    const player = document.querySelector('#movie_player');
    if (!player) return false;
    return (
      player.classList.contains('ytp-playlist-ended') ||
      Boolean(player.querySelector('.ytp-playlist-ended'))
    );
  }

  function findLikeButton() {
    const directSelectors = [
      'like-button-view-model button',
      '#segmented-like-button button',
      'ytd-toggle-button-renderer#like-button button',
      '#like-button button',
      'ytd-watch-metadata #top-level-buttons-computed ytd-toggle-button-renderer:first-of-type button',
    ];

    const found = [];
    for (let index = 0; index < directSelectors.length; index += 1) {
      const nodes = document.querySelectorAll(directSelectors[index]);
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        found.push(nodes[nodeIndex]);
      }
    }

    // YouTube renders extra like buttons for the fullscreen quick actions and
    // hidden responsive variants. Always interact with the visible one.
    for (let index = 0; index < found.length; index += 1) {
      if (isVisible(found[index])) return found[index];
    }

    if (found.length > 0) return found[0];

    // Last resort for DOM variants: find a pressed-state button whose label
    // refers to "like", excluding the dislike button.
    const root = document.querySelector('ytd-watch-metadata') || document;
    const candidates = root.querySelectorAll('button[aria-pressed]');
    for (let index = 0; index < candidates.length; index += 1) {
      const button = candidates[index];
      if (!isVisible(button)) continue;

      const label = (
        (button.getAttribute('aria-label') || '') +
        ' ' +
        (button.getAttribute('title') || '')
      ).toLowerCase();

      if (/dislike|no me gusta|no me gustan/.test(label)) continue;
      if (/like|me gusta|gusta/.test(label)) return button;
    }

    return null;
  }

  function readLikeState() {
    const button = findLikeButton();
    if (!button) return { pressed: null, button: null };

    const pressed = button.getAttribute('aria-pressed');
    if (pressed === 'true') return { pressed: true, button: button };
    if (pressed === 'false') return { pressed: false, button: button };

    return { pressed: null, button: button };
  }

  /* ------------------------------------------------------------------ */
  /* Waits and actions                                                  */
  /* ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function waitForValue(run, predicate, timeoutMs, intervalMs) {
    const step = intervalMs || 250;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      checkLive(run);
      const value = predicate();
      if (value) return value;
      await sleep(step);
    }

    return null;
  }

  async function waitUntilReady(run, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let reason = 'loading';
    let adAnnounced = false;

    while (Date.now() < deadline) {
      checkLive(run);

      if (isAdShowing()) {
        reason = 'ad';
        if (!adAnnounced) {
          adAnnounced = true;
          setPhase(
            'waiting_ad',
            'Anuncio en curso; esperando a que termine…',
            'El proceso continuará automáticamente.'
          );
        }
        await sleep(500);
        continue;
      }

      if (isUnavailable()) {
        return { ok: false, reason: 'unavailable' };
      }

      const context = PAL.parseVideoContext(location.href);
      if (!context.isPlaylist || !context.videoId) {
        return { ok: false, reason: 'not-playlist' };
      }

      const domVideoId = getDomVideoId();
      if (domVideoId && domVideoId !== context.videoId) {
        reason = 'loading';
        await sleep(250);
        continue;
      }

      const like = readLikeState();
      if (like.pressed === null) {
        reason = 'like-unavailable';
        await sleep(250);
        continue;
      }

      runtime.videoId = context.videoId;
      runtime.videoTitle = getVideoTitle();
      runtime.countdown = null;
      return { ok: true, reason: 'ready' };
    }

    return { ok: false, reason: reason };
  }

  async function waitInterval(run) {
    let elapsed = 0;
    runtime.countdown = Math.ceil(run.intervalMs / 1000);
    renderSoon();

    while (elapsed < run.intervalMs) {
      checkLive(run);

      if (run.paused) {
        await sleep(150);
        continue;
      }

      const remaining = run.intervalMs - elapsed;
      const step = Math.min(200, remaining);
      await sleep(step);
      checkLive(run);

      elapsed += step;
      runtime.countdown = Math.max(0, Math.ceil((run.intervalMs - elapsed) / 1000));
      renderSoon();
    }

    runtime.countdown = null;
    renderSoon();
  }

  function maybePausePlayback(run) {
    const video = document.querySelector('video');
    if (!video || video.paused) return null;

    const remainingMs = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - video.currentTime) * 1000
      : Infinity;
    const needsPause = document.hidden || remainingMs < run.intervalMs + 2000;
    if (!needsPause) return null;

    try {
      video.pause();
    } catch (_error) {
      return null;
    }

    runtime.nextStep =
      'Video pausado temporalmente para que no termine antes de aplicar Me Gusta.';
    renderSoon();
    return { video: video };
  }

  function restorePlayback(playback) {
    if (!playback || !playback.video) return;
    if (playback.video.paused) {
      const promise = playback.video.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(function () {});
      }
    }
  }

  async function applyLike(run, videoId) {
    checkLive(run);
    if (!isSameVideo(videoId)) return 'changed';

    if (isAdShowing()) {
      const ready = await waitUntilReady(run, LIMITS.adTimeoutMs);
      if (!ready.ok) return 'failed';
      if (!isSameVideo(videoId)) return 'changed';
    }

    const state = readLikeState();
    if (state.pressed === true) return 'liked';
    if (!state.button) return 'failed';

    // A single click only: a second click on a like button that already
    // registered (but whose DOM had not updated yet) would remove the like.
    state.button.click();

    const result = await waitForValue(
      run,
      function () {
        if (!isSameVideo(videoId)) return 'changed';
        return readLikeState().pressed === true ? 'liked' : null;
      },
      6000,
      250
    );

    if (result === 'liked' || result === 'changed') return result;
    return 'failed';
  }

  async function advance(run) {
    checkLive(run);

    const before = PAL.parseVideoContext(location.href);
    if (!before.playlistId) return 'end';

    const direction = isDescending(run) ? 'descending' : 'ascending';
    const info = getPlaylistPanelInfo();

    if (info.panel && info.currentIndex >= 0) {
      if (info.position) {
        if (direction === 'descending' ? info.position.current <= 1 : info.position.current >= info.position.total) {
          return 'end';
        }
      } else if (direction === 'descending' ? info.currentIndex <= 0 : info.currentIndex >= info.items.length - 1) {
        return 'end';
      }
    }

    let clicked = false;

    if (direction === 'descending') {
      // YouTube's player "previous" button restarts the current video when it
      // has been playing for more than a few seconds. The playlist panel item
      // always navigates to the previous video, so use it first.
      const adjacentItem = getAdjacentPlaylistItem(info, 'descending');
      const adjacentTarget = adjacentItem && (adjacentItem.anchor || adjacentItem.element);
      if (adjacentTarget) {
        adjacentTarget.click();
        clicked = true;
      }

      if (!clicked) {
        const prevButton = document.querySelector('.ytp-prev-button');
        if (prevButton && !elementIsDisabled(prevButton)) {
          prevButton.click();
          clicked = true;
        }
      }
    } else {
      const nextButton = document.querySelector('.ytp-next-button');
      if (nextButton && !elementIsDisabled(nextButton)) {
        nextButton.click();
        clicked = true;
      }

      if (!clicked) {
        const adjacentItem = getAdjacentPlaylistItem(info, 'ascending');
        const adjacentTarget = adjacentItem && (adjacentItem.anchor || adjacentItem.element);
        if (adjacentTarget) {
          adjacentTarget.click();
          clicked = true;
        }
      }
    }

    if (!clicked) return 'end';

    const changed = await waitForValue(
      run,
      function () {
        const context = PAL.parseVideoContext(location.href);
        return context.videoId && context.videoId !== before.videoId ? true : null;
      },
      LIMITS.advanceTimeoutMs,
      300
    );

    if (!changed) {
      if (!PAL.parseVideoContext(location.href).playlistId) return 'end';
      if (isPlaylistEndedUi()) return 'end';
      return 'timeout';
    }

    // Wait until the DOM reflects the new video. Ads can delay this, so the
    // next loop iteration still does the full readiness check.
    await waitForValue(
      run,
      function () {
        const context = PAL.parseVideoContext(location.href);
        const domVideoId = getDomVideoId();
        if (!context.videoId || context.videoId === before.videoId) return null;
        if (domVideoId && domVideoId !== context.videoId) return null;
        return true;
      },
      15000,
      250
    ).catch(function () {
      return null;
    });

    return 'advanced';
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                        */
  /* ------------------------------------------------------------------ */

  async function ensureHistoryLoaded() {
    if (historyLoaded) return;
    try {
      const stored = await chrome.storage.local.get(KEY.history);
      const raw = stored[KEY.history];
      const next = new Map();
      if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach(function (videoId) {
          if (typeof videoId === 'string' && Number.isFinite(raw[videoId])) {
            next.set(videoId, raw[videoId]);
          }
        });
      }
      history = next;
    } catch (_error) {
      history = new Map();
    }
    historyLoaded = true;
    runtime.historyCount = history.size;
  }

  async function rememberLiked(videoId) {
    history.set(videoId, Date.now());

    const entries = Array.from(history.entries()).slice(-LIMITS.historyLimit);
    history = new Map(entries);

    const serialized = {};
    entries.forEach(function (entry) {
      serialized[entry[0]] = entry[1];
    });

    try {
      await chrome.storage.local.set({ [KEY.history]: serialized });
    } catch (_error) {
      // Storage errors must not stop the run.
    }
  }

  /* ------------------------------------------------------------------ */
  /* Status helpers                                                     */
  /* ------------------------------------------------------------------ */

  function setPhase(phase, action, nextStep) {
    if (!runtime.active && phase !== 'done' && phase !== 'error' && phase !== 'stopped') return;

    if (runtime.paused && runtime.phase === 'paused') {
      if (typeof nextStep === 'string') runtime.nextStep = nextStep;
      renderSoon();
      return;
    }

    runtime.phase = phase;
    if (typeof action === 'string') runtime.action = action;
    if (typeof nextStep === 'string') runtime.nextStep = nextStep;
    renderSoon();
  }

  /* ------------------------------------------------------------------ */
  /* On-page HUD (shadow DOM)                                           */
  /* ------------------------------------------------------------------ */

  function buildHud() {
    const host = document.createElement('div');
    host.id = 'playlist-auto-liker-hud';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = [
      '<style>',
      ':host{all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;display:none;font-family:"YouTube Sans","Roboto",system-ui,sans-serif;}',
      ':host(.visible){display:block;}',
      '.card{width:310px;border-radius:14px;background:rgba(15,15,15,.94);border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 32px rgba(0,0,0,.5);color:#f1f1f1;overflow:hidden;backdrop-filter:blur(14px);}',
      '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(255,255,255,.04);}',
      '.dot{width:8px;height:8px;border-radius:50%;background:#909090;flex:0 0 auto;}',
      '.dot.running{background:#2ecc71;box-shadow:0 0 8px rgba(46,204,113,.8);}',
      '.dot.waiting{background:#f1c40f;}',
      '.dot.paused{background:#f39c12;}',
      '.dot.error{background:#e74c3c;}',
      '.dot.done{background:#3498db;}',
      '.brand{font-size:12px;font-weight:700;letter-spacing:.02em;}',
      '.head .countdown{margin-left:auto;font-size:12px;font-variant-numeric:tabular-nums;color:#f1c40f;font-weight:700;}',
      '.mini{border:0;background:transparent;color:#aaa;font:inherit;font-size:14px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px;}',
      '.mini:hover{background:rgba(255,255,255,.1);color:#fff;}',
      '.body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:7px;}',
      '.phase{font-size:11px;color:#f1c40f;font-weight:700;text-transform:uppercase;letter-spacing:.05em;}',
      '.video{font-size:12px;font-weight:600;line-height:1.35;max-height:2.7em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
      '.meta{font-size:11px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.action{font-size:11px;color:#ddd;line-height:1.35;}',
      '.next{font-size:11px;color:#9a9a9a;line-height:1.35;}',
      '.stats{display:flex;gap:12px;font-size:11px;color:#bbb;border-top:1px solid rgba(255,255,255,.08);padding-top:7px;}',
      '.stats b{color:#fff;font-variant-numeric:tabular-nums;}',
      '.stats .ok b{color:#2ecc71;}',
      '.stats .err b{color:#e74c3c;}',
      '.error{display:none;font-size:11px;color:#ff8a80;line-height:1.35;background:rgba(231,76,60,.12);border:1px solid rgba(231,76,60,.35);border-radius:8px;padding:6px 8px;}',
      '.error.visible{display:block;}',
      '.buttons{display:flex;gap:8px;margin-top:2px;}',
      '.buttons button{flex:1;border:0;border-radius:8px;padding:7px 10px;font:inherit;font-size:11px;font-weight:700;cursor:pointer;background:#272727;color:#f1f1f1;}',
      '.buttons button:hover{background:#3a3a3a;}',
      '.buttons button.danger{background:#c0392b;color:#fff;}',
      '.buttons button.danger:hover{background:#e74c3c;}',
      '.buttons button[hidden]{display:none;}',
      ':host(.collapsed) .body{display:none;}',
      ':host(.collapsed) .head{border-radius:14px;}',
      '</style>',
      '<div class="card">',
      '  <div class="head">',
      '    <span class="dot" data-ref="dot"></span>',
      '    <span class="brand">Auto-Liker</span>',
      '    <span class="countdown" data-ref="headCountdown"></span>',
      '    <button class="mini" data-ref="collapse" title="Minimizar" aria-label="Minimizar panel">▾</button>',
      '    <button class="mini" data-ref="dismiss" title="Cerrar" aria-label="Cerrar panel">✕</button>',
      '  </div>',
      '  <div class="body">',
      '    <div class="phase" data-ref="phase">Inactivo</div>',
      '    <div class="video" data-ref="video"></div>',
      '    <div class="meta" data-ref="meta"></div>',
      '    <div class="action" data-ref="action"></div>',
      '    <div class="next" data-ref="next"></div>',
      '    <div class="stats">',
      '      <span class="ok">Me Gusta <b data-ref="liked">0</b></span>',
      '      <span>Omitidos <b data-ref="skipped">0</b></span>',
      '      <span class="err">Errores <b data-ref="errors">0</b></span>',
      '    </div>',
      '    <div class="error" data-ref="error"></div>',
      '    <div class="buttons">',
      '      <button data-ref="toggle">Pausar</button>',
      '      <button class="danger" data-ref="stop">Detener</button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');

    document.documentElement.appendChild(host);

    const refs = {};
    shadow.querySelectorAll('[data-ref]').forEach(function (element) {
      refs[element.getAttribute('data-ref')] = element;
    });

    refs.collapse.addEventListener('click', function () {
      hudCollapsed = !hudCollapsed;
      host.classList.toggle('collapsed', hudCollapsed);
      renderHud();
    });

    refs.dismiss.addEventListener('click', function () {
      if (!runtime.active) hideHud();
    });

    refs.toggle.addEventListener('click', function () {
      if (!currentRun || !currentRun.active) return;
      if (currentRun.paused) resumeRun();
      else pauseRun();
    });

    refs.stop.addEventListener('click', function () {
      stopRun();
    });

    hud = { host: host, refs: refs };
  }

  function showHud() {
    if (!hud) return;
    hud.host.classList.add('visible');
    hud.host.classList.toggle('collapsed', hudCollapsed);
    renderHud();
  }

  function hideHud() {
    if (!hud) return;
    hud.host.classList.remove('visible');
  }

  function scheduleHudHide(ms) {
    clearTimeout(hudHideTimer);
    if (!ms) return;
    hudHideTimer = setTimeout(function () {
      if (!runtime.active) hideHud();
    }, ms);
  }

  function renderSoon() {
    if (hudRaf) return;
    hudRaf = requestAnimationFrame(function () {
      hudRaf = 0;
      renderHud();
    });
  }

  function renderHud() {
    if (!hud) return;

    const refs = hud.refs;
    const label = runtime.paused ? PHASE_LABEL.paused : PHASE_LABEL[runtime.phase] || PHASE_LABEL.idle;
    const dotClass = runtime.paused
      ? 'paused'
      : runtime.phase === 'waiting' || runtime.phase === 'waiting_ad'
        ? 'waiting'
        : runtime.phase === 'error'
          ? 'error'
          : runtime.phase === 'done'
            ? 'done'
            : runtime.active
              ? 'running'
              : '';

    refs.dot.className = 'dot ' + dotClass;
    refs.phase.textContent = label;
    refs.video.textContent = runtime.videoTitle || '';
    refs.meta.textContent = [
      runtime.playlistName,
      runtime.indexLabel,
      PAL.describeDirection(runtime.direction ? { direction: runtime.direction } : config),
    ]
      .filter(Boolean)
      .join(' · ');
    refs.action.textContent = runtime.action || '';
    refs.next.textContent = runtime.nextStep || '';
    refs.liked.textContent = String(runtime.stats.liked);
    refs.skipped.textContent = String(runtime.stats.skipped);
    refs.errors.textContent = String(runtime.stats.errors);

    const countdown = runtime.countdown != null ? String(runtime.countdown) + ' s' : '';
    refs.headCountdown.textContent = countdown;

    refs.error.textContent = runtime.error || '';
    refs.error.classList.toggle('visible', Boolean(runtime.error));

    refs.toggle.hidden = !runtime.active;
    refs.stop.hidden = !runtime.active;
    refs.dismiss.hidden = Boolean(runtime.active);
    refs.toggle.textContent = runtime.paused ? 'Reanudar' : 'Pausar';
    refs.collapse.textContent = hudCollapsed ? '▸' : '▾';
  }
})();
