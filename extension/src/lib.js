/*
 * Playlist Auto-Liker - shared helpers.
 * Loaded as a classic script in the content script and popup, and exposed as
 * CommonJS for the unit tests.
 */
(function (root, factory) {
  'use strict';

  const api = factory();
  root.PAL = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({ minSeconds: 1, maxSeconds: 3600 });
  const DEFAULT_CONFIG = Object.freeze({
    mode: 'fixed',
    fixedSeconds: 8,
    minSeconds: 5,
    maxSeconds: 15,
    direction: 'ascending',
  });
  const STORAGE_KEYS = Object.freeze({
    config: 'pal.config',
    history: 'pal.history',
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function toNumber(value, fallback) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : fallback;
    }
    const parsed = Number.parseFloat(String(value == null ? '' : value).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function toSeconds(value, fallback) {
    const seconds = Math.round(toNumber(value, fallback));
    return clamp(seconds, LIMITS.minSeconds, LIMITS.maxSeconds);
  }

  /**
   * Accepts anything and returns a safe, complete configuration.
   */
  function normalizeConfig(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const mode = input.mode === 'range' ? 'range' : 'fixed';
    const direction = input.direction === 'descending' ? 'descending' : 'ascending';

    let minSeconds = toSeconds(input.minSeconds, DEFAULT_CONFIG.minSeconds);
    let maxSeconds = toSeconds(input.maxSeconds, DEFAULT_CONFIG.maxSeconds);
    if (minSeconds > maxSeconds) {
      const swap = minSeconds;
      minSeconds = maxSeconds;
      maxSeconds = swap;
    }

    return {
      mode,
      fixedSeconds: toSeconds(input.fixedSeconds, DEFAULT_CONFIG.fixedSeconds),
      minSeconds,
      maxSeconds,
      direction,
    };
  }

  /**
   * Returns the wait before a like, in milliseconds.
   * Range mode picks a whole number of seconds, inclusive on both ends.
   */
  function pickIntervalMs(config, random) {
    const normalized = normalizeConfig(config);
    const nextRandom = typeof random === 'function' ? random : Math.random;
    let seconds;

    if (normalized.mode === 'range') {
      const span = normalized.maxSeconds - normalized.minSeconds;
      const sample = clamp(nextRandom(), 0, 0.999999);
      seconds = normalized.minSeconds + Math.floor(sample * (span + 1));
    } else {
      seconds = normalized.fixedSeconds;
    }

    return clamp(seconds, LIMITS.minSeconds, LIMITS.maxSeconds) * 1000;
  }

  function parseVideoContext(href) {
    let url;
    try {
      url = new URL(String(href || ''), 'https://www.youtube.com');
    } catch (_error) {
      return { isWatch: false, videoId: null, playlistId: null, isPlaylist: false };
    }

    const isWatch = url.pathname === '/watch';
    const videoId = url.searchParams.get('v') || null;
    const playlistId = url.searchParams.get('list') || null;

    return {
      isWatch,
      videoId,
      playlistId,
      isPlaylist: isWatch && Boolean(videoId) && Boolean(playlistId),
    };
  }

  /**
   * A video is skipped when YouTube already shows it as liked or when this
   * extension liked it in a previous run. `history` may be a Map, Set or
   * plain object.
   */
  function shouldSkipVideo(options) {
    const opts = options || {};
    if (opts.pressed === true) return true;
    if (!opts.videoId || !opts.history) return false;

    const history = opts.history;
    if (typeof history.has === 'function') return history.has(opts.videoId);
    if (typeof history === 'object') {
      return Object.prototype.hasOwnProperty.call(history, opts.videoId);
    }
    return false;
  }

  function formatSeconds(ms) {
    const total = Math.max(0, Math.ceil(toNumber(ms, 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes === 0) return seconds + ' s';
    return minutes + ':' + String(seconds).padStart(2, '0');
  }

  function describeInterval(config) {
    const normalized = normalizeConfig(config);
    if (normalized.mode === 'range') {
      return normalized.minSeconds + '-' + normalized.maxSeconds + ' s';
    }
    return normalized.fixedSeconds + ' s';
  }

  function describeDirection(config) {
    return normalizeConfig(config).direction === 'descending' ? 'Descendente' : 'Ascendente';
  }

  return {
    LIMITS,
    DEFAULT_CONFIG,
    STORAGE_KEYS,
    clamp,
    toNumber,
    normalizeConfig,
    pickIntervalMs,
    parseVideoContext,
    shouldSkipVideo,
    formatSeconds,
    describeInterval,
    describeDirection,
  };
});
