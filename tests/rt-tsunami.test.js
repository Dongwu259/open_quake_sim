// ================================================================
//  Unit tests for RTTsunami — JMA realtime tsunami-information layer
//  Run with:  node --test tests/rt-tsunami.test.js
//  (no DOM / Leaflet required — module must load cleanly under node)
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/rt-tsunami.js');

// ---------------------------------------------------------------
//  Injected-global helpers (each state-machine test sets what it
//  needs and cleans up after itself — module state resets via stop)
// ---------------------------------------------------------------
async function silenceWarn(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try {
    fn();
    // flush microtasks so async fetch rejections land while warn is silenced
    await new Promise(r => setTimeout(r, 0));
  } finally { console.warn = orig; }
}

function cleanGlobals() {
  delete global.playEEWSound;
  delete global.document;
  delete global.window;
  delete global.RTData;
  delete global.fetch;
  delete global.localStorage;
}

// 'YYYY/MM/DD HH:mm' JST stamp for firstHeight.arrivalTime fields
function jstStamp(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ================================================================
//  NODE SAFETY / MODULE SHAPE
// ================================================================

test('module loads under node without DOM/Leaflet and start() is a safe no-op', () => {
  assert.ok(T, 'module should export');
  assert.strictEqual(typeof T.start, 'function');
  assert.strictEqual(typeof T.handleEvent, 'function');
  assert.strictEqual(typeof T.demo, 'function');
  assert.strictEqual(T.isActive(), false);
  assert.strictEqual(T.start(), false, 'start() must no-op without window');
  assert.strictEqual(T.isActive(), false);
  T.stop(); // must not throw on fresh state
  const s = T.getState();
  assert.deepStrictEqual(Object.keys(s).sort(), ['active', 'areaCount', 'demoActive', 'issuedAt', 'maxGrade']);
  assert.strictEqual(s.active, false);
  assert.strictEqual(s.areaCount, 0);
  assert.strictEqual(s.maxGrade, null);
  assert.strictEqual(s.issuedAt, null);
});

// ================================================================
//  parseTsunamiAreas
// ================================================================

test('parseTsunamiAreas — full fields parsed', () => {
  const out = T.parseTsunamiAreas([
    { name: '北海道太平洋沿岸東部', grade: 'MajorWarning',
      firstHeight: { arrivalTime: '2024/01/01 13:00' },
      maxHeight: { description: '巨大' } },
    { name: '岩手県', grade: 'Warning',
      firstHeight: { arrivalTime: '2024/01/01 13:30', condition: 'ただちに津波来襲と予想' },
      maxHeight: { description: '高い', height: '3m' } },
    { name: '宮城県', grade: 'Watch', maxHeight: { height: '1m' } }
  ]);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].name, '北海道太平洋沿岸東部');
  assert.strictEqual(out[0].grade, 'MajorWarning');
  assert.strictEqual(out[0].firstArrivalMs, Date.UTC(2024, 0, 1, 4, 0, 0));
  assert.strictEqual(out[0].maxHeightText, '巨大');
  assert.strictEqual(out[1].firstArrivalMs, Date.UTC(2024, 0, 1, 4, 30, 0));
  assert.strictEqual(out[1].maxHeightText, '高い (3m)', 'description + distinct height combine');
  assert.strictEqual(out[2].firstArrivalMs, null, 'missing firstHeight -> null');
  assert.strictEqual(out[2].maxHeightText, '1m');
});

test('parseTsunamiAreas — grade mapping case-insensitive, unknown stays Unknown', async () => {
  await silenceWarn(() => {
    const out = T.parseTsunamiAreas([
      { name: 'A', grade: 'MajorWarning' },
      { name: 'B', grade: 'majorwarning' },
      { name: 'C', grade: 'WARNING' },
      { name: 'D', grade: 'warning' },
      { name: 'E', grade: 'Watch' },
      { name: 'F', grade: 'watch' },
      { name: 'G', grade: 'Bogus' },
      { name: 'H' }
    ]);
    assert.deepStrictEqual(out.map(a => a.grade), [
      'MajorWarning', 'MajorWarning', 'Warning', 'Warning',
      'Watch', 'Watch', 'Unknown', 'Unknown'
    ]);
  });
});

test('normalizeGrade — unknown never re-graded: no alert, no coloring, logged once', async () => {
  T.stop();
  cleanGlobals();
  const sounds = [];
  global.playEEWSound = (n) => sounds.push(n);
  const toastEl = { id: '', style: {}, textContent: '' };
  global.document = {
    hidden: false,
    getElementById: () => null,
    createElement: () => toastEl,
    body: { appendChild() {} }
  };
  global.fetch = () => Promise.reject(new Error('offline'));
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(String(a[0]));
  try {
    assert.strictEqual(T.normalizeGrade('MajorWarning'), 'MajorWarning');
    assert.strictEqual(T.normalizeGrade('majorwarning'), 'MajorWarning');
    assert.strictEqual(T.normalizeGrade('WARNING'), 'Warning');
    assert.strictEqual(T.normalizeGrade('watch'), 'Watch');
    assert.strictEqual(T.normalizeGrade('Bogus'), 'Unknown');
    assert.strictEqual(T.normalizeGrade(undefined), 'Unknown');
    assert.strictEqual(T.gradeRank('Unknown'), 0, 'ungraded ranks below Watch');
    // an ungradeable bulletin raises no alert...
    T.handleEvent({
      id: 'ug1', code: 552, type: '津波情報', serial: 1,
      time: new Date().toISOString(),
      tsunamiAreas: [{ name: '宮城県', grade: 'Bogus' }]
    });
    assert.strictEqual(T.getState().areaCount, 1, 'area kept, grade unknown');
    assert.strictEqual(T.getState().maxGrade, null);
    assert.deepStrictEqual(sounds, [], 'no alert sound for an ungraded area');
    assert.strictEqual(toastEl.textContent, '', 'no alert toast for an ungraded area');
    // ...and an unknown grade never recolors the coastline
    assert.deepStrictEqual(T.featureStyle({ properties: { name: '宮城県' } }),
      { color: '#888', weight: 0.5, opacity: 0.15 }, 'unknown grade keeps the base style');
    // same unknown value logs once, however it is reached
    T.normalizeGrade('Bogus');
    T.normalizeGrade('bogus');
    assert.strictEqual(warns.filter(w => /Bogus/.test(w)).length, 1, 'same value logs once');
    // flush microtasks so the geojson fetch rejection lands while warn is captured
    await new Promise(r => setTimeout(r, 0));
  } finally { console.warn = origWarn; }
  T.stop();
  cleanGlobals();
});

test('parseTsunamiAreas — defensive on junk input', async () => {
  await silenceWarn(() => {
    assert.deepStrictEqual(T.parseTsunamiAreas(null), []);
    assert.deepStrictEqual(T.parseTsunamiAreas(undefined), []);
    assert.deepStrictEqual(T.parseTsunamiAreas('x'), []);
    assert.deepStrictEqual(T.parseTsunamiAreas([null, 42, {}, { name: '' }]), []);
    // unparsable arrival time -> null, not NaN
    const out = T.parseTsunamiAreas([{ name: 'A', grade: 'Watch', firstHeight: { arrivalTime: 'soon' } }]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].firstArrivalMs, null);
    assert.strictEqual(out[0].maxHeightText, '');
  });
});

// ================================================================
//  gradeRank
// ================================================================

test('gradeRank — Watch=1, Warning=2, MajorWarning=3, else 0', () => {
  assert.strictEqual(T.gradeRank('Watch'), 1);
  assert.strictEqual(T.gradeRank('Warning'), 2);
  assert.strictEqual(T.gradeRank('MajorWarning'), 3);
  assert.strictEqual(T.gradeRank('bogus'), 0);
  assert.strictEqual(T.gradeRank(''), 0);
  assert.strictEqual(T.gradeRank(null), 0);
});

// ================================================================
//  parseJstMs
// ================================================================

test('parseJstMs — exact epoch, JST (UTC+9)', () => {
  assert.strictEqual(T.parseJstMs('2024/01/01 13:00'), Date.UTC(2024, 0, 1, 4, 0, 0));
  assert.strictEqual(T.parseJstMs('2024/01/01 13:00:30'), Date.UTC(2024, 0, 1, 4, 0, 30));
  // JST midnight wraps into the previous UTC day
  assert.strictEqual(T.parseJstMs('2024/01/01 00:30'), Date.UTC(2023, 11, 31, 15, 30, 0));
  assert.strictEqual(T.parseJstMs('2024-01-01 13:00'), Date.UTC(2024, 0, 1, 4, 0, 0));
  assert.ok(Number.isNaN(T.parseJstMs('not a time')));
  assert.ok(Number.isNaN(T.parseJstMs('')));
  assert.ok(Number.isNaN(T.parseJstMs(null)));
  assert.ok(Number.isNaN(T.parseJstMs(42)));
});

test('parseJstMs — HH:mm-only resolves to today in JST, rolling forward past -12h', () => {
  const now = Date.now();
  const jstNow = new Date(now + 9 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' : '') + n;
  // ~1h ago in JST -> stays today (within the last 2h, not rolled).
  // Between JST 00:00 and 01:00 the "1h ago" clock time belongs to yesterday,
  // so the same HH:mm legitimately resolves ~23h in the FUTURE (today's
  // clock) — assert that instead, keeping the test deterministic at any hour.
  const crossedMidnight = jstNow.getUTCHours() === 0;
  const ago1 = new Date(jstNow.getTime() - 3600 * 1000);
  const t1 = T.parseJstMs(p(ago1.getUTCHours()) + ':' + p(ago1.getUTCMinutes()));
  assert.ok(!Number.isNaN(t1));
  if (crossedMidnight) {
    assert.ok(t1 > now + 22 * 3600 * 1000 && t1 <= now + 24 * 3600 * 1000, 'HH:mm 1h ago crossing JST midnight resolves to today (~23h ahead)');
  } else {
    assert.ok(t1 <= now && now - t1 <= 2 * 3600 * 1000, 'HH:mm 1h ago stays today');
  }
  // ~13h ago in JST -> rolled to the next day (lands ~11h in the future)
  const ago13 = new Date(jstNow.getTime() - 13 * 3600 * 1000);
  const t2 = T.parseJstMs(p(ago13.getUTCHours()) + ':' + p(ago13.getUTCMinutes()));
  assert.ok(t2 > now + 9 * 3600 * 1000 && t2 <= now + 12 * 3600 * 1000, 'HH:mm 13h ago rolls to tomorrow');
  // full-width colon tolerated; clock-only junk still NaN
  assert.ok(!Number.isNaN(T.parseJstMs(p(ago1.getUTCHours()) + '：' + p(ago1.getUTCMinutes()))));
  assert.ok(Number.isNaN(T.parseJstMs('13')));
  assert.ok(Number.isNaN(T.parseJstMs('ab:cd')));
  // flows through parseTsunamiAreas -> firstArrivalMs instead of a missing ETA
  const out = T.parseTsunamiAreas([{ name: 'A', grade: 'Watch', firstHeight: { arrivalTime: '13:05' } }]);
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].firstArrivalMs !== null && Number.isFinite(out[0].firstArrivalMs));
});

// ================================================================
//  summarize551
// ================================================================

test('summarize551 — sorted by rank desc, int/scale variants', () => {
  const out = T.summarize551({
    maxInt: '5+',
    prefectures: [
      { name: '福島県', int: '3' },
      { name: '宮城県', int: '5-' },
      { name: '岩手県', scale: '4' },
      { name: '茨城県', scale: '5+' },
      { name: '青森県', int: 2 },       // numeric tolerated
      { name: 'no-intensity' },          // skipped
      'junk'                             // skipped
    ]
  });
  assert.deepStrictEqual(out, [
    { name: '茨城県', int: '5+' },
    { name: '宮城県', int: '5-' },
    { name: '岩手県', int: '4' },
    { name: '福島県', int: '3' },
    { name: '青森県', int: '2' }
  ]);
});

test('summarize551 — defensive on missing/junk detail', () => {
  assert.deepStrictEqual(T.summarize551(null), []);
  assert.deepStrictEqual(T.summarize551(undefined), []);
  assert.deepStrictEqual(T.summarize551({}), []);
  assert.deepStrictEqual(T.summarize551({ prefectures: 'x' }), []);
});

// ================================================================
//  detectDowngrade
// ================================================================

test('detectDowngrade — grade drops and silent removals; upgrades excluded', () => {
  const a = (grade, name) => ({ name, grade });
  const prev = [a('MajorWarning', '岩手県'), a('Warning', '宮城県'), a('Watch', '福島県')];
  assert.strictEqual(T.detectDowngrade(prev,
    [a('Warning', '岩手県'), a('Warning', '宮城県'), a('Watch', '福島県')]), true, 'MajorWarning->Warning');
  assert.strictEqual(T.detectDowngrade(prev,
    [a('MajorWarning', '岩手県'), a('Watch', '宮城県'), a('Watch', '福島県')]), true, 'Warning->Watch');
  assert.strictEqual(T.detectDowngrade(prev,
    [a('MajorWarning', '岩手県'), a('Warning', '宮城県')]), true, 'warned area removed');
  assert.strictEqual(T.detectDowngrade(prev,
    [a('MajorWarning', '岩手県'), a('Warning', '宮城県'), a('Watch', '福島県'), a('Watch', '千葉県')]),
    false, 'area added is not a downgrade');
  assert.strictEqual(T.detectDowngrade(prev, prev.map(x => ({ ...x }))), false, 'unchanged');
  assert.strictEqual(T.detectDowngrade([a('Watch', '福島県')], [a('Warning', '福島県')]), false, 'upgrade');
  assert.strictEqual(T.detectDowngrade(prev,
    [a('Unknown', '岩手県'), a('Warning', '宮城県'), a('Watch', '福島県')]),
    true, 'warned -> ungradeable counts as dropped');
  assert.strictEqual(T.detectDowngrade([], [a('Watch', '福島県')]), false, 'first issuance');
  assert.strictEqual(T.detectDowngrade(prev, []), false, 'empty next list is the cancel path');
  assert.strictEqual(T.detectDowngrade(null, null), false);
});

// ================================================================
//  handleEvent — 552 state machine with injected stubs
// ================================================================

test('handleEvent — issue -> upgrade -> update -> downgrade -> cancel', async () => {
  T.stop();
  cleanGlobals();
  const sounds = [];
  global.playEEWSound = (n) => sounds.push(n);
  // minimal document so toast() works; map container stays absent
  const toastEl = { id: '', style: {}, textContent: '' };
  global.document = {
    hidden: false,
    getElementById: () => null,
    createElement: () => toastEl,
    body: { appendChild() {} }
  };
  global.fetch = () => Promise.reject(new Error('offline')); // geojson fetch stays quiet-ish
  await silenceWarn(() => {
    const area = (grade, name) => ({ name, grade });

    // first issuance (Watch + Warning -> max Warning)
    assert.strictEqual(T.handleEvent({
      id: 'e1', code: 552, type: '津波情報', serial: 1,
      time: '2024-01-01T04:00:00.000Z',
      tsunamiAreas: [area('Watch', '福島県'), area('Warning', '宮城県')]
    }), true);
    let s = T.getState();
    assert.strictEqual(s.areaCount, 2);
    assert.strictEqual(s.maxGrade, 'Warning');
    assert.strictEqual(s.issuedAt, Date.parse('2024-01-01T04:00:00.000Z'));
    assert.deepStrictEqual(sounds, ['Tsunami_2']);
    assert.match(toastEl.textContent, /津波警報/);

    // grade upgrade -> toast + Tsunami_3
    assert.strictEqual(T.handleEvent({
      id: 'e1', code: 552, type: '津波情報', serial: 2,
      time: '2024-01-01T04:03:00.000Z',
      tsunamiAreas: [area('Watch', '福島県'), area('MajorWarning', '宮城県')]
    }), true);
    s = T.getState();
    assert.strictEqual(s.maxGrade, 'MajorWarning');
    assert.strictEqual(s.issuedAt, Date.parse('2024-01-01T04:03:00.000Z'));
    assert.deepStrictEqual(sounds, ['Tsunami_2', 'Tsunami_3']);
    assert.match(toastEl.textContent, /大津波警報/);

    // same-grade update (area added) -> state replaced, no new sound
    T.handleEvent({
      id: 'e1', code: 552, type: '津波情報', serial: 3,
      tsunamiAreas: [area('Watch', '福島県'), area('MajorWarning', '宮城県'), area('Warning', '岩手県')]
    });
    assert.strictEqual(T.getState().areaCount, 3);
    assert.strictEqual(sounds.length, 2, 'same max grade must not re-alert');

    // downgrade -> state replaced silently
    T.handleEvent({
      id: 'e1', code: 552, type: '津波情報', serial: 4,
      tsunamiAreas: [area('Watch', '福島県')]
    });
    assert.strictEqual(T.getState().maxGrade, 'Watch');
    assert.strictEqual(sounds.length, 2, 'downgrade must not alert');

    // cancel via cancelled:true -> all clear + lifted sound/toast
    assert.strictEqual(T.handleEvent({
      id: 'e1', code: 552, type: '津波情報取消', serial: 5, cancelled: true
    }), true);
    s = T.getState();
    assert.strictEqual(s.areaCount, 0);
    assert.strictEqual(s.maxGrade, null);
    assert.strictEqual(s.issuedAt, null);
    assert.deepStrictEqual(sounds, ['Tsunami_2', 'Tsunami_3', 'Tsunami_lifted']);
    assert.strictEqual(toastEl.textContent, '津波情報は取り消されました');

    // cancel via zero areas + type containing 取消
    T.handleEvent({
      id: 'e2', code: 552, type: '津波情報', serial: 1,
      tsunamiAreas: [area('Warning', '宮城県')]
    });
    assert.strictEqual(T.getState().areaCount, 1);
    assert.strictEqual(sounds[sounds.length - 1], 'Tsunami_2', 'fresh issuance after cancel re-alerts');
    T.handleEvent({ id: 'e2', code: 552, type: '津波情報取消', serial: 2, tsunamiAreas: [] });
    assert.strictEqual(T.getState().areaCount, 0);
    assert.strictEqual(sounds[sounds.length - 1], 'Tsunami_lifted');

    // zero areas WITHOUT cancel indication -> ignored
    T.handleEvent({ id: 'e3', code: 552, type: '津波情報', serial: 1, tsunamiAreas: [] });
    assert.strictEqual(T.getState().areaCount, 0);
  });
  T.stop();
  cleanGlobals();
});

// ================================================================
//  handleEvent — downgrade notice (quiet toast, no sound/TTS)
// ================================================================

test('handleEvent — downgrade toasts quietly, upgrade path unchanged', async () => {
  T.stop();
  cleanGlobals();
  const sounds = [];
  global.playEEWSound = (n) => sounds.push(n);
  const ttsCalls = [];
  global.window = { _enqueueSrevSpeech: (m) => ttsCalls.push(m) };
  const toastEl = { id: '', style: {}, textContent: '' };
  global.document = {
    hidden: false,
    getElementById: () => null,
    createElement: () => toastEl,
    body: { appendChild() {} }
  };
  global.fetch = () => Promise.reject(new Error('offline'));
  await silenceWarn(() => {
    const area = (grade, name) => ({ name, grade });
    T.handleEvent({
      id: 'dg1', code: 552, type: '津波情報', serial: 1,
      time: '2024-01-01T04:00:00.000Z',
      tsunamiAreas: [area('MajorWarning', '岩手県'), area('Warning', '宮城県'), area('Watch', '福島県')]
    });
    assert.deepStrictEqual(sounds, ['Tsunami_3']);
    assert.strictEqual(ttsCalls.length, 1);

    // MajorWarning -> Warning: quiet switch toast, no sound/TTS
    T.handleEvent({
      id: 'dg1', code: 552, type: '津波情報', serial: 2,
      tsunamiAreas: [area('Warning', '岩手県'), area('Warning', '宮城県'), area('Watch', '福島県')]
    });
    assert.strictEqual(sounds.length, 1, 'downgrade plays no sound');
    assert.strictEqual(ttsCalls.length, 1, 'downgrade speaks no TTS');
    assert.strictEqual(toastEl.textContent, '大津波警報が津波警報に切り替わりました');

    // warned area silently removed, max grade unchanged: partial-lift toast
    T.handleEvent({
      id: 'dg1', code: 552, type: '津波情報', serial: 3,
      tsunamiAreas: [area('Warning', '宮城県'), area('Watch', '福島県')]
    });
    assert.strictEqual(sounds.length, 1, 'removal plays no sound');
    assert.strictEqual(toastEl.textContent, '一部地域の津波警報・注意報が解除されました');

    // upgrade after the downgrade re-alerts with sound + TTS
    T.handleEvent({
      id: 'dg1', code: 552, type: '津波情報', serial: 4,
      tsunamiAreas: [area('MajorWarning', '宮城県'), area('Watch', '福島県')]
    });
    assert.deepStrictEqual(sounds, ['Tsunami_3', 'Tsunami_3']);
    assert.strictEqual(ttsCalls.length, 2);
    assert.match(toastEl.textContent, /大津波警報が発表されました/);
  });
  T.stop();
  cleanGlobals();
});

// ================================================================
//  ttsIssuedMessages — first-issuance ETA speech
// ================================================================

test('ttsIssuedMessages — first issuance speaks the earliest first-wave ETA (JST)', () => {
  const list = [
    { name: '岩手県', grade: 'MajorWarning', firstArrivalMs: Date.UTC(2024, 0, 1, 4, 30) }, // 13:30 JST
    { name: '宮城県', grade: 'Warning', firstArrivalMs: Date.UTC(2024, 0, 1, 3, 40) },      // 12:40 JST
    { name: '福島県', grade: 'Watch', firstArrivalMs: null }
  ];
  assert.deepStrictEqual(T.ttsIssuedMessages('MajorWarning', list, { withEta: true }), [
    '大津波警報が発表されました。',
    '対象地域： 岩手県。',
    '第一波の到達予想時刻は、早いところで、12時40分です。'
  ], 'earliest arrival across all warned areas, not just the top grade');
  // exact-hour ETA drops the 分
  const onHour = T.ttsIssuedMessages('Warning', [
    { name: '宮城県', grade: 'Warning', firstArrivalMs: Date.UTC(2024, 0, 1, 4, 0) } // 13:00 JST
  ], { withEta: true });
  assert.strictEqual(onHour[2], '第一波の到達予想時刻は、早いところで、13時です。');
  // update speech unchanged — no ETA sentence without the flag
  assert.deepStrictEqual(T.ttsIssuedMessages('MajorWarning', list), [
    '大津波警報が発表されました。',
    '対象地域： 岩手県。'
  ]);
  // no parseable arrival -> no ETA sentence even on first issuance
  assert.deepStrictEqual(T.ttsIssuedMessages('Watch', [{ name: '福島県', grade: 'Watch' }], { withEta: true }),
    ['津波注意報が発表されました。', '対象地域： 福島県。']);
  // ungradeable areas contribute neither names nor ETAs
  assert.deepStrictEqual(T.ttsIssuedMessages('Unknown', [
    { name: '謎区域', grade: 'Unknown', firstArrivalMs: Date.UTC(2024, 0, 1, 4, 0) }
  ], { withEta: true }), ['津波注意報が発表されました。']);
});

// ================================================================
//  toast — RTData.toastQueued routing
// ================================================================

test('toast — RTData.toastQueued wins over the local div when present', async () => {
  T.stop();
  cleanGlobals();
  const queued = [];
  global.RTData = { isActive: () => true, toastQueued: (m, o) => queued.push([m, o]) };
  const toastEl = { id: '', style: {}, textContent: '' };
  global.document = {
    hidden: false,
    getElementById: () => null,
    createElement: () => toastEl,
    body: { appendChild() {} }
  };
  global.fetch = () => Promise.reject(new Error('offline'));
  await silenceWarn(() => {
    T.handleEvent({
      id: 'tq1', code: 552, type: '津波情報', serial: 1,
      time: new Date().toISOString(),
      tsunamiAreas: [{ name: '宮城県', grade: 'Warning' }]
    });
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(queued[0][0], '津波警報が発表されました');
    assert.strictEqual(toastEl.textContent, '', 'local fallback unused while the queue is live');
  });
  T.stop();
  cleanGlobals();
});

// ================================================================
//  handleEvent — 551 detail dedupe
// ================================================================

test('handleEvent — 551 shows once per id, requires intensityDetail', () => {
  T.stop();
  cleanGlobals();
  const evt = {
    id: 'q1', code: 551, mag: 6.4, place: '三陸沖', depth: 40, maxShindo: '5-',
    intensityDetail: { maxInt: '5-', prefectures: [{ name: '宮城県', int: '5-' }] }
  };
  assert.strictEqual(T.handleEvent(evt), true);
  assert.strictEqual(T.handleEvent(evt), false, 'same id must not re-show');
  assert.strictEqual(T.handleEvent(Object.assign({}, evt, { id: 'q2' })), true);
  assert.strictEqual(T.handleEvent({ id: 'q3', code: 551 }), false, 'no intensityDetail -> ignored');
  assert.strictEqual(T.handleEvent({ code: 999 }), false, 'unknown code -> ignored');
  assert.strictEqual(T.handleEvent(null), false);
  assert.strictEqual(T.handleEvent(undefined), false);
  assert.strictEqual(T.handleEvent('junk'), false);
  // SSE wrapper tolerated
  assert.strictEqual(T.handleEvent({ type: 'p2pquake', event: Object.assign({}, evt, { id: 'q4' }) }), true);
  T.stop();
  cleanGlobals();
});

// ================================================================
//  demo() guard
// ================================================================

test('demo() — no-op false unless RTData.isActive()', async () => {
  T.stop();
  cleanGlobals();
  await silenceWarn(() => {
    assert.strictEqual(T.demo(), false, 'RTData absent -> false');
    global.RTData = { isActive: () => false };
    assert.strictEqual(T.demo(), false, 'realtime off -> false');
    assert.strictEqual(T.getState().areaCount, 0);
    global.RTData = { isActive: () => true };
    assert.strictEqual(T.demo(), true);
    const s = T.getState();
    assert.strictEqual(s.areaCount, 3);
    assert.strictEqual(s.maxGrade, 'MajorWarning');
    assert.ok(s.issuedAt > 0);
  });
  T.stop(); // clears the scheduled demo-cancel timer + state
  assert.strictEqual(T.getState().areaCount, 0);
  cleanGlobals();
});

test('demo() — refused while a real warning is active; real data aborts a running demo', async () => {
  T.stop();
  cleanGlobals();
  global.RTData = { isActive: () => true };
  await silenceWarn(() => {
    // live warning -> demo refused, state untouched
    T.handleEvent({
      id: 'real1', code: 552, type: '津波情報', serial: 1,
      time: new Date().toISOString(),
      tsunamiAreas: [{ name: '宮城県', grade: 'Warning' }]
    });
    assert.strictEqual(T.demo(), false, 'demo must not stomp a live warning');
    assert.strictEqual(T.getState().maxGrade, 'Warning');
    assert.strictEqual(T.getState().demoActive, false);

    // cleared -> demo runs
    T.handleEvent({ id: 'real1', code: 552, type: '津波情報取消', serial: 2, cancelled: true });
    assert.strictEqual(T.demo(), true);
    assert.strictEqual(T.getState().demoActive, true);
    assert.strictEqual(T.getState().maxGrade, 'MajorWarning');

    // real 552 mid-demo: demo aborted, real state wins
    T.handleEvent({
      id: 'real2', code: 552, type: '津波情報', serial: 1,
      time: new Date().toISOString(),
      tsunamiAreas: [{ name: '岩手県', grade: 'Watch' }]
    });
    let s = T.getState();
    assert.strictEqual(s.demoActive, false, 'demo aborted by real data');
    assert.strictEqual(s.areaCount, 1);
    assert.strictEqual(s.maxGrade, 'Watch');
    assert.strictEqual(T.demo(), false, 'demo stays refused while the real warning stands');

    // real 551 mid-demo also aborts and drops the fake state
    T.handleEvent({ id: 'real2', code: 552, type: '津波情報取消', serial: 2, cancelled: true });
    assert.strictEqual(T.demo(), true);
    T.handleEvent({
      id: 'q1', code: 551, mag: 5.9, place: '三陸沖',
      intensityDetail: { prefectures: [{ name: '宮城県', int: '3' }] }
    });
    s = T.getState();
    assert.strictEqual(s.demoActive, false);
    assert.strictEqual(s.areaCount, 0, 'fake demo state cleared on abort');

    // after a clean demo lifecycle the demo's own cancel still works
    assert.strictEqual(T.demo(), true);
    T.handleEvent({
      id: 'demo_tsunami_cancel_1', code: 552, type: '津波情報取消',
      cancelled: true, serial: 2, time: new Date().toISOString()
    });
    assert.strictEqual(T.getState().areaCount, 0);
    assert.strictEqual(T.getState().demoActive, false);
  });
  T.stop();
  cleanGlobals();
});

// ================================================================
//  featureStyle — coastline blink phase
// ================================================================

test('featureStyle — Warning/MajorWarning blink with the phase, Watch stays solid', () => {
  T.stop();
  cleanGlobals();
  T.handleEvent({
    id: 'fs1', code: 552, type: '津波情報', serial: 1,
    time: new Date().toISOString(),
    tsunamiAreas: [
      { name: '岩手県', grade: 'MajorWarning' },
      { name: '宮城県', grade: 'Warning' },
      { name: '福島県', grade: 'Watch' }
    ]
  });
  const feat = (name) => ({ properties: { name } });
  T._setFlashPhaseForTest(true);
  assert.deepStrictEqual(T.featureStyle(feat('岩手県')), { color: '#8b0000', weight: 4, opacity: 0.95 });
  assert.deepStrictEqual(T.featureStyle(feat('宮城県')), { color: '#e74c3c', weight: 4, opacity: 0.95 });
  assert.deepStrictEqual(T.featureStyle(feat('福島県')), { color: '#f1c40f', weight: 4, opacity: 0.95 }, 'Watch solid while phase on');
  T._setFlashPhaseForTest(false);
  assert.deepStrictEqual(T.featureStyle(feat('岩手県')), { color: '#8b0000', weight: 2.5, opacity: 0.25 }, 'MajorWarning dims while phase off');
  assert.deepStrictEqual(T.featureStyle(feat('宮城県')), { color: '#e74c3c', weight: 2.5, opacity: 0.25 }, 'Warning dims while phase off');
  assert.deepStrictEqual(T.featureStyle(feat('福島県')), { color: '#f1c40f', weight: 4, opacity: 0.95 }, 'Watch solid while phase off');
  assert.deepStrictEqual(T.featureStyle(feat('房総半島沖')), { color: '#888', weight: 0.5, opacity: 0.15 }, 'ungraded segment keeps base style');
  assert.deepStrictEqual(T.featureStyle(null), { color: '#888', weight: 0.5, opacity: 0.15 });
  T.stop();
  cleanGlobals();
});

test('featureStyle — stop() resets the flash phase', () => {
  T.stop();
  cleanGlobals();
  T._setFlashPhaseForTest(true);
  T.stop();
  T.handleEvent({
    id: 'fs2', code: 552, type: '津波情報', serial: 1,
    time: new Date().toISOString(),
    tsunamiAreas: [{ name: '宮城県', grade: 'Warning' }]
  });
  const s = T.featureStyle({ properties: { name: '宮城県' } });
  assert.strictEqual(s.weight, 2.5, 'phase back to off after stop()');
  assert.strictEqual(s.opacity, 0.25);
  T.stop();
  cleanGlobals();
});

// ================================================================
//  countdownText
// ================================================================

test('countdownText — あと X時間Y分 / あと X分 / 到達, zh fallback', () => {
  T.stop();
  cleanGlobals();
  const now = Date.now();
  assert.strictEqual(T.countdownText(now + 25 * 60000, now), 'あと 25分');
  assert.strictEqual(T.countdownText(now + 60 * 60000, now), 'あと 1時間');
  assert.strictEqual(T.countdownText(now + 90 * 60000, now), 'あと 1時間30分');
  assert.strictEqual(T.countdownText(now + 30 * 1000, now), 'あと 1分', 'sub-minute rounds up');
  assert.strictEqual(T.countdownText(now, now), '到達');
  assert.strictEqual(T.countdownText(now - 60000, now), '到達');
  global.localStorage = { getItem: () => 'zh' };
  assert.strictEqual(T.countdownText(now + 25 * 60000, now), '还有 25分钟');
  assert.strictEqual(T.countdownText(now + 90 * 60000, now), '还有 1小时30分');
  assert.strictEqual(T.countdownText(now - 1, now), '已到达');
  T.stop();
  cleanGlobals();
});

// ================================================================
//  panelHTML — per-area first-wave forecast table
// ================================================================

test('panelHTML — forecast table sorted, countdown, height, chips', () => {
  T.stop();
  cleanGlobals();
  const now = Date.now();
  T.handleEvent({
    id: 'pt1', code: 552, type: '津波情報', serial: 1,
    time: new Date(now).toISOString(),
    tsunamiAreas: [
      { name: '岩手県', grade: 'MajorWarning',
        firstHeight: { arrivalTime: jstStamp(now + 25 * 60000) },
        maxHeight: { description: '巨大' } },
      { name: '青森県', grade: 'MajorWarning',
        firstHeight: { arrivalTime: jstStamp(now + 95 * 60000) } },
      { name: '宮城県', grade: 'Warning',
        firstHeight: { arrivalTime: jstStamp(now + 85 * 60000) },
        maxHeight: { description: '高い', height: '3m' } },
      { name: '福島県', grade: 'Watch',
        firstHeight: { arrivalTime: jstStamp(now - 5 * 60000) },
        maxHeight: { height: '1m' } },
      { name: '茨城県', grade: 'Watch',
        firstHeight: { arrivalTime: jstStamp(now + 10 * 60000) } },
      { name: '千葉県', grade: 'Watch' }
    ]
  });
  const html = T.panelHTML();
  // grade-grouped name lists above the table stay unchanged
  assert.ok(html.indexOf('大津波警報') !== -1 && html.indexOf('津波注意報') !== -1);
  assert.ok(html.indexOf('福島県、茨城県、千葉県') !== -1, 'name list keeps areas order within a grade');
  assert.strictEqual(html.indexOf('到達予想'), -1, 'old plain ETA lines are gone');
  const ti = html.indexOf('<table');
  assert.ok(ti !== -1, 'forecast table rendered');
  const table = html.slice(ti);
  // sort: grade rank desc first (青森 +95min still precedes 宮城 +85min), then arrival asc
  assert.ok(table.indexOf('岩手県') < table.indexOf('青森県'));
  assert.ok(table.indexOf('青森県') < table.indexOf('宮城県'), 'grade rank beats later arrival');
  assert.ok(table.indexOf('宮城県') < table.indexOf('福島県'));
  assert.ok(table.indexOf('福島県') < table.indexOf('茨城県'), 'same grade sorts by arrival asc');
  assert.strictEqual(table.indexOf('千葉県'), -1, 'area without ETA gets no row');
  // chip, JST HH:mm, live countdown, expected height
  assert.ok(table.indexOf('background:#8b0000') !== -1, 'grade color chip');
  assert.ok(table.indexOf(jstStamp(now + 25 * 60000).slice(11)) !== -1, 'JST HH:mm arrival');
  assert.ok(table.indexOf('あと 25分') !== -1);
  assert.ok(table.indexOf('あと 1時間35分') !== -1);
  assert.ok(table.indexOf('あと 10分') !== -1);
  assert.ok(table.indexOf('到達') !== -1, 'past arrival shows 到達');
  assert.ok(table.indexOf('予想高さ 巨大') !== -1);
  assert.ok(table.indexOf('予想高さ 高い (3m)') !== -1);
  assert.ok(table.indexOf('予想高さ 1m') !== -1);
  T.stop();
  cleanGlobals();
});

test('panelHTML — forecast table capped at 8 rows with 他N footer', () => {
  T.stop();
  cleanGlobals();
  const now = Date.now();
  const mk = [];
  for (let i = 1; i <= 9; i++) {
    mk.push({ name: '予報区' + i, grade: 'Warning',
      firstHeight: { arrivalTime: jstStamp(now + i * 5 * 60000) } });
  }
  T.handleEvent({
    id: 'pt2', code: 552, type: '津波情報', serial: 1,
    time: new Date(now).toISOString(),
    tsunamiAreas: mk
  });
  const html = T.panelHTML();
  const rows = html.match(/<tr>/g) || [];
  assert.strictEqual(rows.length, 8, 'table capped at 8 rows');
  assert.ok(html.indexOf('他1') !== -1, '他N footer for overflow rows');
  const table = html.slice(html.indexOf('<table'));
  assert.strictEqual(table.indexOf('予報区9'), -1, 'overflow area not in the table');
  T.stop();
  cleanGlobals();
});

test('ttsIssuedMessages — brevity: at most 3 area names (+他N)', () => {
  const list = [
    { name: '岩手県', grade: 'Warning' }, { name: '宮城県', grade: 'Warning' },
    { name: '福島県', grade: 'Warning' }, { name: '茨城県', grade: 'Warning' },
    { name: '千葉県', grade: 'Warning' }
  ];
  const msgs = T.ttsIssuedMessages('Warning', list);
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs[1].indexOf('岩手県') >= 0 && msgs[1].indexOf('宮城県') >= 0 && msgs[1].indexOf('福島県') >= 0);
  assert.ok(msgs[1].indexOf('茨城県') === -1, '4th area not spoken');
  assert.ok(msgs[1].indexOf('他2') >= 0, 'remainder counted: ' + msgs[1]);
});
