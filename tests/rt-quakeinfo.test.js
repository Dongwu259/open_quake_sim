// ================================================================
//  Unit tests for RTQuakeInfo — realtime 551 bulletin helpers
//  Run with:  node --test tests/rt-quakeinfo.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../public/rt-quakeinfo.js');

// ================================================================
//  scaleToShindo / shindoJp / shindoCoarseNum
// ================================================================

test('scaleToShindo — P2P integer scales', () => {
  assert.strictEqual(Q.scaleToShindo(10), '1');
  assert.strictEqual(Q.scaleToShindo(30), '3');
  assert.strictEqual(Q.scaleToShindo(45), '5-');
  assert.strictEqual(Q.scaleToShindo(50), '5+');
  assert.strictEqual(Q.scaleToShindo(55), '6-');
  assert.strictEqual(Q.scaleToShindo(60), '6+');
  assert.strictEqual(Q.scaleToShindo(70), '7');
  assert.strictEqual(Q.scaleToShindo(0), '', 'unknown scale');
  assert.strictEqual(Q.scaleToShindo(-1), '');
});

test('shindoJp / shindoCoarseNum', () => {
  assert.strictEqual(Q.shindoJp('5-'), '5弱');
  assert.strictEqual(Q.shindoJp('6+'), '6強');
  assert.strictEqual(Q.shindoJp('4'), '4');
  assert.strictEqual(Q.shindoCoarseNum('5-'), 5);
  assert.strictEqual(Q.shindoCoarseNum('6+'), 6);
  assert.strictEqual(Q.shindoCoarseNum('7'), 7);
  assert.strictEqual(Q.shindoCoarseNum(''), 0);
});

// ================================================================
//  prefMaxPoints — per-pref max shindo, sorted desc, capped
// ================================================================

test('prefMaxPoints — groups by pref, keeps max, sorts desc, caps', () => {
  const points = [
    { pref: '宮城県', addr: 'a', scale: 30, isArea: true },
    { pref: '宮城県', addr: 'b', scale: 40, isArea: true },
    { pref: '福島県', addr: 'c', scale: 45, isArea: true },
    { pref: '岩手県', addr: 'd', scale: 40, isArea: true },
    { pref: '青森県', addr: 'e', scale: 20, isArea: true },
    { pref: '秋田県', addr: 'f', scale: 10, isArea: true },
    { pref: '山形県', addr: 'g', scale: 10, isArea: true }
  ];
  const out = Q.prefMaxPoints(points, 5);
  assert.strictEqual(out.length, 5, 'cap at 5');
  assert.deepStrictEqual(out[0], { pref: '福島県', shindo: '5-' });
  assert.strictEqual(out[1].shindo, '4');
  assert.strictEqual(out.filter(p => p.pref === '宮城県')[0].shindo, '4', 'per-pref max kept');
});

test('prefMaxPoints — skips unknown scales and empty prefs', () => {
  const out = Q.prefMaxPoints([{ pref: '', scale: 30 }, { pref: 'x', scale: 0 }], 5);
  assert.strictEqual(out.length, 0);
  assert.deepStrictEqual(Q.prefMaxPoints(null, 5), []);
});

// ================================================================
//  buildTtsMessages — per bulletin type
// ================================================================

test('ScalePrompt — prefs + max shindo', () => {
  const msgs = Q.buildTtsMessages({
    issueType: 'ScalePrompt', maxIntensity: 40,
    points: [{ pref: '宮城県', scale: 40 }, { pref: '福島県', scale: 30 }]
  });
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].indexOf('震度速報') === 0);
  assert.ok(msgs[0].indexOf('宮城県') >= 0);
  assert.ok(msgs[0].indexOf('最大震度4') >= 0);
});

test('Destination — hypocenter + no-tsunami line', () => {
  const msgs = Q.buildTtsMessages({
    issueType: 'Destination', place: '宮城県沖', mag: 5.4, depth: 50,
    domesticTsunami: 'None'
  });
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs[0].indexOf('震源情報') === 0);
  assert.ok(msgs[0].indexOf('宮城県沖') >= 0);
  assert.ok(msgs[0].indexOf('5.4') >= 0);
  assert.ok(msgs[0].indexOf('50キロ') >= 0);
  assert.strictEqual(msgs[1], '津波の心配はありません。');
});

test('Destination — very shallow depth wording', () => {
  const msgs = Q.buildTtsMessages({ issueType: 'Destination', place: 'x', mag: 3, depth: 0, domesticTsunami: 'Unknown' });
  assert.ok(msgs[0].indexOf('ごく浅い') >= 0);
  assert.strictEqual(msgs.length, 1, 'no tsunami line for Unknown');
});

test('ScaleAndDestination — combined bulletin', () => {
  const msgs = Q.buildTtsMessages({
    issueType: 'ScaleAndDestination', maxIntensity: 55, place: '福島県沖', mag: 7.3, depth: 55,
    points: [{ pref: '宮城県', scale: 55 }],
    domesticTsunami: 'Checking'
  });
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs[0].indexOf('最大震度6弱') >= 0);
  assert.ok(msgs[0].indexOf('福島県沖') >= 0);
  assert.ok(msgs[1].indexOf('調査中') >= 0);
});

test('DetailScale / Foreign / unknown', () => {
  const d = Q.buildTtsMessages({ issueType: 'DetailScale', maxIntensity: 50 });
  assert.ok(d[0].indexOf('最大震度は5強') >= 0);
  const f = Q.buildTtsMessages({ issueType: 'Foreign', place: 'ハワイ', mag: 6.1 });
  assert.ok(f[0].indexOf('遠地地震') >= 0 && f[0].indexOf('6.1') >= 0);
  assert.deepStrictEqual(Q.buildTtsMessages({ issueType: 'Other' }), []);
  assert.deepStrictEqual(Q.buildTtsMessages({ issueType: 'ScalePrompt', maxIntensity: 0 }), [], 'no speech when scale unknown');
});

// ================================================================
//  dedupKey — stable content addressing
// ================================================================

test('dedupKey — identical bulletins collide, serial bumps do not', () => {
  const a = { issueType: 'ScalePrompt', originTime: '2026/08/11 08:45:00', place: 'x', maxIntensity: 40, serial: 1 };
  const b = Object.assign({}, a);
  assert.strictEqual(Q.dedupKey(a), Q.dedupKey(b));
  const c = Object.assign({}, a, { serial: 2 });
  assert.notStrictEqual(Q.dedupKey(a), Q.dedupKey(c));
});

// ================================================================
//  rt-tsunami TTS builder (lives in RTTsunami, exercised here too)
// ================================================================

test('RTTsunami.ttsIssuedMessages — grade line + areas', () => {
  const T = require('../public/rt-tsunami.js');
  const msgs = T.ttsIssuedMessages('MajorWarning', [
    { name: '岩手県', grade: 'MajorWarning' },
    { name: '宮城県', grade: 'Warning' },
    { name: '福島県', grade: 'Watch' }
  ]);
  assert.ok(msgs[0].indexOf('大津波警報') === 0);
  assert.ok(msgs[1].indexOf('岩手県') >= 0);
  const w = T.ttsIssuedMessages('Watch', [{ name: '福島県', grade: 'Watch' }]);
  assert.ok(w[0].indexOf('津波注意報') === 0);
});


// ================================================================
//  observedFills / fillScope — 551 map coloring inputs
// ================================================================

test('fillScope — bulletin type to map scope', () => {
  assert.strictEqual(Q.fillScope({ issueType: 'ScalePrompt' }), 'pref');
  assert.strictEqual(Q.fillScope({ issueType: 'ScaleAndDestination' }), 'pref');
  assert.strictEqual(Q.fillScope({ issueType: 'DetailScale' }), 'area');
  assert.strictEqual(Q.fillScope({ issueType: 'Destination' }), null);
  assert.strictEqual(Q.fillScope({ issueType: 'Foreign' }), null);
});

test('observedFills pref scope — per-prefecture max shindo', () => {
  const evt = {
    issueType: 'ScalePrompt',
    points: [
      { pref: '宮城県', addr: 'a', scale: 30, isArea: true },
      { pref: '宮城県', addr: 'b', scale: 40, isArea: true },
      { pref: '福島県', addr: 'c', scale: 45, isArea: true },
      { pref: '岩手県', addr: 'd', scale: 0, isArea: true }
    ]
  };
  const fills = Q.observedFills(evt, 'pref');
  assert.strictEqual(fills['宮城県'], '4', 'keeps the higher scale');
  assert.strictEqual(fills['福島県'], '5-');
  assert.strictEqual(fills['岩手県'], undefined, 'unknown scale skipped');
});

test('observedFills area scope — isArea only, keyed by normalized addr', () => {
  const evt = {
    issueType: 'DetailScale',
    points: [
      { pref: '宮城県', addr: '宮城県北部', scale: 50, isArea: true },
      { pref: '宮城県', addr: '仙台市宮城野区', scale: 45, isArea: false },
      { pref: '宮城県', addr: '宮城県南部', scale: 45, isArea: true },
      { pref: '宮城県', addr: '宮城県 中部', scale: 40, isArea: true }
    ]
  };
  const fills = Q.observedFills(evt, 'area');
  assert.strictEqual(fills['宮城県北部'], '5+');
  assert.strictEqual(fills['仙台市宮城野区'], undefined, 'city points skipped at area scope');
  assert.strictEqual(fills['宮城県南部'], '5-');
  assert.strictEqual(fills['宮城県中部'], '4', 'whitespace-normalized key');
});

test('normAreaName — strips half/full-width spaces', () => {
  assert.strictEqual(Q.normAreaName('宮城県 中部'), '宮城県中部');
  assert.strictEqual(Q.normAreaName('釧路地方　中南部'), '釧路地方中南部');
  assert.strictEqual(Q.normAreaName(''), '');
});

// ================================================================
//  lpcmClass — long-period ground motion passthrough
// ================================================================

test('lpcmClass — null when the bulletin carries no LPCM fields', () => {
  assert.strictEqual(Q.lpcmClass(null), null);
  assert.strictEqual(Q.lpcmClass({}), null);
  assert.strictEqual(Q.lpcmClass({ intensityDetail: {} }), null);
  assert.strictEqual(Q.lpcmClass({ intensityDetail: { maxScale: 40 } }), null);
  assert.strictEqual(Q.lpcmClass({ points: [{ pref: '宮城県', scale: 40 }] }), null);
});

test('lpcmClass — top-level intensityDetail spellings', () => {
  assert.strictEqual(Q.lpcmClass({ intensityDetail: { maxLgInt: 3 } }), 3);
  assert.strictEqual(Q.lpcmClass({ intensityDetail: { lgInt: 2 } }), 2);
  assert.strictEqual(Q.lpcmClass({ intensityDetail: { maxLgScale: '階級4' } }), 4);
  assert.strictEqual(Q.lpcmClass({ intensityDetail: { maxLgInt: 9 } }), 4, 'clamped to 4');
  assert.strictEqual(Q.lpcmClass({ intensityDetail: { maxLgInt: 0 } }), null, 'class 0 = absent');
});

test('lpcmClass — per-point fallback takes the worst class', () => {
  const evt = { points: [
    { pref: '宮城県', addr: '仙台市', scale: 40, lgScale: 2 },
    { pref: '福島県', addr: '福島市', scale: 30, lgScale: 3 },
    { pref: '岩手県', addr: '盛岡市', scale: 30 }
  ] };
  assert.strictEqual(Q.lpcmClass(evt), 3);
  // lgInt spelling on points also works
  assert.strictEqual(Q.lpcmClass({ points: [{ pref: 'x', lgInt: 1 }] }), 1);
});

// ================================================================
//  handleEvent dedup — id horizon 1 h, content-key window 60 s
// ================================================================

test('dedup — same id twice dropped', () => {
  const evt = {
    code: 551, id: 'test-qinfo-dedup-same-id', issueType: 'ScalePrompt',
    maxIntensity: 40, originTime: '2026/08/14 10:00:00', place: 'テスト', serial: 1, points: []
  };
  assert.strictEqual(Q.handleEvent(evt), true, 'first delivery announces');
  assert.strictEqual(Q.handleEvent(Object.assign({}, evt)), false, 'same id dropped');
});

test('dedup — same content key: within 60 s dropped, after 60 s announced', () => {
  const realNow = Date.now;
  let t0 = realNow();
  Date.now = () => t0;
  try {
    const base = {
      code: 551, issueType: 'ScaleAndDestination', maxIntensity: 50,
      originTime: '2026/08/14 11:11:11', place: 'テスト沖', serial: 1, points: []
    };
    assert.strictEqual(Q.handleEvent(Object.assign({ id: 'test-qinfo-dedup-win-a' }, base)), true);
    assert.strictEqual(
      Q.handleEvent(Object.assign({ id: 'test-qinfo-dedup-win-b' }, base)), false,
      'new id with identical content inside 60 s = reconnect resend');
    t0 += 61000;
    assert.strictEqual(
      Q.handleEvent(Object.assign({ id: 'test-qinfo-dedup-win-c' }, base)), true,
      'same content after the 60 s window = legitimate revision');
    assert.strictEqual(
      Q.handleEvent(Object.assign({ id: 'test-qinfo-dedup-win-a' }, base)), false,
      'id dedup horizon unchanged — the first id is still known');
  } finally {
    Date.now = realNow;
  }
});

// ================================================================
//  detailScalePoints — 各地の震度 panel rows (area only, sorted, capped)
// ================================================================

test('detailScalePoints — area rows sorted by shindo desc, capped at 30', () => {
  const points = [
    { pref: '宮城県', addr: '宮城県北部', scale: 55, isArea: true },
    { pref: '福島県', addr: '福島県中通り', scale: 50, isArea: true },
    { pref: '岩手県', addr: '岩手県沿岸北部', scale: 40, isArea: true }
  ];
  for (let i = 0; i < 35; i++) points.push({ pref: '県' + i, addr: '区域' + i, scale: 30, isArea: true });
  points.push({ pref: '宮城県', addr: '仙台市宮城野区', scale: 60, isArea: false });
  const out = Q.detailScalePoints({ issueType: 'DetailScale', points });
  assert.strictEqual(out.length, 30, 'cap at 30 rows');
  assert.deepStrictEqual(out[0], { pref: '宮城県', name: '宮城県北部', shindo: '6-', lat: null, lng: null });
  assert.strictEqual(out[1].shindo, '5+');
  assert.strictEqual(out[2].shindo, '4');
  assert.ok(out.slice(3).every(r => r.shindo === '3'), 'rest sorted after the top ranks');
  assert.ok(!out.some(r => r.name === '仙台市宮城野区'), 'city points excluded');
});

test('detailScalePoints — per-area max merges whitespace variants; non-DetailScale empty', () => {
  const evt = {
    issueType: 'DetailScale',
    points: [
      { pref: '宮城県', addr: '宮城県北部', scale: 40, isArea: true },
      { pref: '宮城県', addr: '宮城県 北部', scale: 50, isArea: true },
      { pref: '宮城県', addr: '不明区域', scale: 0, isArea: true }
    ]
  };
  const out = Q.detailScalePoints(evt);
  assert.strictEqual(out.length, 1, 'whitespace variants merge into one row');
  assert.strictEqual(out[0].shindo, '5+', 'keeps the higher scale');
  assert.deepStrictEqual(Q.detailScalePoints({ issueType: 'ScalePrompt', points: evt.points }), []);
  assert.deepStrictEqual(Q.detailScalePoints(null), []);
});

test('detailScalePoints — carries point coordinates when the feed has them', () => {
  const out = Q.detailScalePoints({ issueType: 'DetailScale', points: [
    { pref: '宮城県', addr: '宮城県北部', scale: 40, isArea: true, lat: 38.3, lng: 141.0 }
  ] });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].lat, 38.3);
  assert.strictEqual(out[0].lng, 141.0);
});

test('TTS brevity — ScalePrompt reads at most 3 prefectures (+他N)', () => {
  const msgs = Q.buildTtsMessages({
    issueType: 'ScalePrompt', maxIntensity: 50,
    points: [
      { pref: '宮城県', scale: 50 }, { pref: '福島県', scale: 50 }, { pref: '岩手県', scale: 40 },
      { pref: '山形県', scale: 40 }, { pref: '秋田県', scale: 30 }
    ]
  });
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].indexOf('宮城県') >= 0 && msgs[0].indexOf('福島県') >= 0 && msgs[0].indexOf('岩手県') >= 0);
  assert.ok(msgs[0].indexOf('山形県') === -1, '4th prefecture not spoken');
  assert.ok(msgs[0].indexOf('他2') >= 0, 'remainder counted: ' + msgs[0]);
});

test('TTS brevity — ScaleAndDestination drops the repeated pref list and depth', () => {
  const msgs = Q.buildTtsMessages({
    issueType: 'ScaleAndDestination', maxIntensity: 55, place: '福島県沖', mag: 7.3, depth: 55,
    points: [{ pref: '宮城県', scale: 55 }, { pref: '福島県', scale: 50 }]
  });
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].indexOf('最大震度6弱') >= 0);
  assert.ok(msgs[0].indexOf('福島県沖') >= 0 && msgs[0].indexOf('7.3') >= 0);
  assert.ok(msgs[0].indexOf('宮城県') === -1, 'prefecture list not repeated');
  assert.ok(msgs[0].indexOf('キロメートル') === -1, 'depth not repeated');
});
