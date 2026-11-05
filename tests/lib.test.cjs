'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAL = require('../extension/src/lib.js');
const ROOT = path.join(__dirname, '..', 'extension');

test('normalizeConfig returns defaults for invalid input', () => {
  assert.deepEqual(PAL.normalizeConfig(null), {
    mode: 'fixed',
    fixedSeconds: 8,
    minSeconds: 5,
    maxSeconds: 15,
    direction: 'ascending',
  });

  assert.deepEqual(PAL.normalizeConfig({ mode: 'nope' }).mode, 'fixed');
});

test('normalizeConfig validates the direction', () => {
  assert.equal(PAL.normalizeConfig({ direction: 'descending' }).direction, 'descending');
  assert.equal(PAL.normalizeConfig({ direction: 'ascending' }).direction, 'ascending');
  assert.equal(PAL.normalizeConfig({ direction: 'upward' }).direction, 'ascending');
  assert.equal(PAL.normalizeConfig({}).direction, 'ascending');
});

test('describeDirection labels both directions', () => {
  assert.equal(PAL.describeDirection({ direction: 'ascending' }), 'Ascendente');
  assert.equal(PAL.describeDirection({ direction: 'descending' }), 'Descendente');
  assert.equal(PAL.describeDirection(null), 'Ascendente');
});

test('normalizeConfig clamps, rounds and sorts the range', () => {
  const config = PAL.normalizeConfig({
    mode: 'range',
    fixedSeconds: -5,
    minSeconds: 30,
    maxSeconds: 10,
  });

  assert.equal(config.mode, 'range');
  assert.equal(config.fixedSeconds, 1);
  assert.equal(config.minSeconds, 10);
  assert.equal(config.maxSeconds, 30);
});

test('normalizeConfig accepts numeric strings and decimal commas', () => {
  const config = PAL.normalizeConfig({
    mode: 'fixed',
    fixedSeconds: '12,6',
    minSeconds: '2',
    maxSeconds: '3',
  });

  assert.equal(config.fixedSeconds, 13);
  assert.equal(config.minSeconds, 2);
  assert.equal(config.maxSeconds, 3);
});

test('pickIntervalMs returns a fixed interval', () => {
  const config = PAL.normalizeConfig({ mode: 'fixed', fixedSeconds: 7 });
  assert.equal(PAL.pickIntervalMs(config), 7000);
});

test('pickIntervalMs covers both ends of the range', () => {
  const config = PAL.normalizeConfig({
    mode: 'range',
    minSeconds: 5,
    maxSeconds: 8,
  });

  assert.equal(PAL.pickIntervalMs(config, () => 0), 5000);
  assert.equal(PAL.pickIntervalMs(config, () => 0.999999), 8000);
  assert.equal(PAL.pickIntervalMs(config, () => 0.5), 7000);
});

test('pickIntervalMs never leaves the configured range', () => {
  const config = PAL.normalizeConfig({
    mode: 'range',
    minSeconds: 10,
    maxSeconds: 12,
  });

  for (let index = 0; index < 100; index += 1) {
    const value = PAL.pickIntervalMs(config);
    assert.ok(value >= 10000 && value <= 12000);
  }
});

test('parseVideoContext detects a watch page inside a playlist', () => {
  const context = PAL.parseVideoContext(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890&index=3'
  );

  assert.equal(context.isWatch, true);
  assert.equal(context.isPlaylist, true);
  assert.equal(context.videoId, 'dQw4w9WgXcQ');
  assert.equal(context.playlistId, 'PL1234567890');
});

test('parseVideoContext rejects non-playlist and non-watch URLs', () => {
  assert.equal(PAL.parseVideoContext('https://www.youtube.com/').isPlaylist, false);
  assert.equal(
    PAL.parseVideoContext('https://www.youtube.com/watch?v=dQw4w9WgXcQ').isPlaylist,
    false
  );
  assert.equal(
    PAL.parseVideoContext('https://www.youtube.com/playlist?list=PL123').isPlaylist,
    false
  );
  assert.equal(PAL.parseVideoContext('not a url').isPlaylist, false);
});

test('shouldSkipVideo prioritizes the pressed state and history', () => {
  const history = new Map([['liked-before', Date.now()]]);

  assert.equal(
    PAL.shouldSkipVideo({ pressed: true, videoId: 'fresh', history: history }),
    true
  );
  assert.equal(
    PAL.shouldSkipVideo({ pressed: false, videoId: 'liked-before', history: history }),
    true
  );
  assert.equal(
    PAL.shouldSkipVideo({ pressed: false, videoId: 'fresh', history: history }),
    false
  );
  assert.equal(
    PAL.shouldSkipVideo({ pressed: null, videoId: 'fresh', history: history }),
    false
  );
  assert.equal(
    PAL.shouldSkipVideo({ pressed: true, videoId: 'fresh', history: null }),
    true
  );
});

test('formatSeconds renders short and long waits', () => {
  assert.equal(PAL.formatSeconds(8000), '8 s');
  assert.equal(PAL.formatSeconds(65000), '1:05');
  assert.equal(PAL.formatSeconds(0), '0 s');
});

test('manifest references existing files and valid content scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.host_permissions.includes('https://www.youtube.com/*'));

  const referenced = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
  ];

  for (const relativePath of referenced) {
    assert.ok(
      fs.existsSync(path.join(ROOT, relativePath)),
      'Falta el archivo referenciado por el manifest: ' + relativePath
    );
  }
});
