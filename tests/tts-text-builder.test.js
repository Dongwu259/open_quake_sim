const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/tts-text-builder.js');

test('builds the SREV EEW warning sentence', () => {
  assert.strictEqual(
    T.buildEEW({ areas: ['宮城県', '福島県'] }),
    '緊急地震速報。宮城県、福島県では、強い揺れに警戒してください！'
  );
});

test('builds the SREV EEW cancellation sentence', () => {
  assert.strictEqual(
    T.buildEEWCancellation(),
    '先ほどの緊急地震速報は、キャンセルされました。'
  );
});

test('formats origin time in Japan time with SREV am/pm wording', () => {
  assert.strictEqual(T.formatJstTime('2011-03-11T14:46:00+09:00'), '午後2時46分ごろ');
  assert.strictEqual(T.formatJstTime('1995-01-17T05:46:00+09:00'), '午前5時46分ごろ');
  assert.strictEqual(T.formatJstTime('2026-07-31T12:00:00+09:00'), '午後12時0分');
});

test('converts every JMA strong-intensity category to Japanese speech', () => {
  assert.strictEqual(T.shindoText('5-'), '5弱');
  assert.strictEqual(T.shindoText('5+'), '5強');
  assert.strictEqual(T.shindoText('6-'), '6弱');
  assert.strictEqual(T.shindoText('6+'), '6強');
});

test('builds the SREV final earthquake bulletin without tsunami', () => {
  assert.strictEqual(T.buildEarthquake({
    time: '2011-03-11T14:46:00+09:00',
    epicenter: '三陸沖',
    maxShindo: 7,
    depth: 24,
    magnitude: 9.1,
    tsunamiLevel: 0
  }), '地震情報。午後2時46分ごろ、三陸沖を震源とする地震がありました。最大震度7を観測しました。深さ24キロメートル。マグニチュード9.1。この地震による、津波の心配はありません。');
});

test('speaks the epicenter only once per information product', () => {
  const options = {
    time:'2011-03-11T14:46:00+09:00',epicenter:'三陸沖',maxShindo:'6-',
    maxAreas:['宮城県'],depth:24,magnitude:9.1,tsunamiStatus:'active'
  };
  for (const text of [T.buildHypocenterBulletin(options), T.buildCombinedBulletin(options)]) {
    const occurrences = text.split('三陸沖').length - 1;
    assert.strictEqual(occurrences, 1, `epicenter must not be repeated: ${text}`);
  }
});

test('announces a first tsunami issuance differently from an update', () => {
  assert.strictEqual(T.buildTsunamiForecast({level:'major',areas:['岩手県'],height:'3メートル',updated:false}),
    '大津波警報が発表されました。岩手県に発表されています。予想される津波の高さは、3メートルです。');
  assert.match(T.buildTsunamiForecast({level:'major',areas:['岩手県'],height:'3メートル',updated:true}),
    /^大津波警報の内容が、更新されました。/);
});

test('collapses a long EEW area list to the hardest-hit names with nado', () => {
  const text = T.buildEEW({ areas: ['宮城県','岩手県','福島県','山形県','秋田県','茨城県','栃木県','千葉県'] });
  assert.strictEqual(text, '緊急地震速報。宮城県、岩手県、福島県、山形県、秋田県などでは、強い揺れに警戒してください！');
});

test('announces maximum-intensity prefectures and an active tsunami forecast', () => {
  const text = T.buildEarthquake({
    time: '2024-01-01T16:10:00+09:00', epicenter: '石川県能登地方',
    maxShindo: '7', maxPrefectures: ['石川県'], depth: 16,
    magnitude: 7.6, tsunamiLevel: 2
  });
  assert.match(text, /最大震度7を石川県で観測しました。/);
  assert.match(text, /現在、津波予報等を発表中です。$/);
  assert.ok(text.length <= 300);
});

test('uses preset epicenter names and safe custom fallbacks', () => {
  assert.strictEqual(T.getEpicenterName('tohoku', true), '三陸沖');
  assert.strictEqual(T.getEpicenterName('', true), '日本近海');
  assert.strictEqual(T.getEpicenterName('', false), '日本付近');
});

test('builds the post-survey SREV intensity bulletin', () => {
  assert.strictEqual(T.buildIntensityBulletin({
    time:'2024-01-01T16:10:00+09:00',maxShindo:'7',maxAreas:['石川県']
  }), '震度速報。午後4時10分ごろ、最大震度7を石川県で観測しました。');
});

test('builds the simulated intensity-survey announcement', () => {
  assert.strictEqual(
    T.buildIntensitySurvey(),
    '各地の震度を調査しています。詳しい情報が分かり次第、お伝えします。'
  );
});

test('builds separate hypocenter and combined information products', () => {
  const options = {
    time:'1995-01-17T05:46:00+09:00',epicenter:'淡路島北部',maxShindo:'7',
    maxAreas:['兵庫県'],depth:16,magnitude:7.3,tsunamiStatus:'none'
  };
  assert.match(T.buildHypocenterBulletin(options), /^震源情報。/);
  assert.match(T.buildHypocenterBulletin(options), /震源の深さは16キロ。/);
  assert.match(T.buildCombinedBulletin(options), /^地震情報。/);
  assert.match(T.buildCombinedBulletin(options), /最大震度7を兵庫県で観測しました。/);
});

test('uses the SREV giant-earthquake and unknown-source wording', () => {
  const giant = T.buildHypocenterBulletin({epicenter:'三陸沖',depth:24,magnitude:9.1,tsunamiStatus:'active'});
  assert.match(giant, /マグニチュード8を超える、巨大地震/);
  const unknown = T.buildHypocenterBulletin({epicenter:'日本付近',depth:null,magnitude:null,tsunamiStatus:'investigating'});
  assert.match(unknown, /震源の深さは不明/);
  assert.match(unknown, /今後の情報に注意してください/);
});

test('builds SREV information revision and cancellation messages', () => {
  assert.strictEqual(T.buildInformationCancellation('intensity'), '先ほどの震度速報は、キャンセルされました。');
  assert.match(T.buildSourceRevision({epicenter:'能登半島沖',depth:10,magnitude:7.6}), /^震源が更新されました。/);
});

test('builds tsunami forecast and observation products', () => {
  assert.strictEqual(T.buildTsunamiForecast({level:'warn',areas:['石川県能登'],height:'3メートル'}),
    '津波警報の内容が、更新されました。津波警報が、次の地域に発表されています。石川県能登。予想される津波の高さは、3メートルです。');
  assert.match(T.buildTsunamiObservation({areas:['石川県能登'],height:'1.2メートル',updated:true}),
    /^津波観測に関する情報。石川県能登。現在、新たに観測された、/);
});
