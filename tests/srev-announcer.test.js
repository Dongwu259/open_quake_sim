const test = require('node:test');
const assert = require('node:assert/strict');
const SrevAnnouncer = require('../public/srev-announcer.js');

test('SREV text splitting preserves every character and the 128-character limit', () => {
  const text = '震度速報。' + '強い揺れを観測しました。'.repeat(20);
  const chunks = SrevAnnouncer.splitText(text, 128);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 128));
  assert.equal(chunks.join(''), text);
});

test('SREV announcer serializes groups and speak-and-wait chunks', () => {
  const calls = [];
  const completions = [];
  const callbacks = [];
  const queue = SrevAnnouncer.create({maxLength:8, speak(text, onEnd) {
    calls.push(text); callbacks.push(onEnd); return {abort() {}};
  }});
  queue.enqueue(['震度速報。最大震度7。'], {onComplete() { completions.push('intensity'); }});
  queue.enqueue('震源情報。三陸沖。', {onComplete() { completions.push('source'); }});
  assert.equal(calls.length, 1);
  while (callbacks.length) callbacks.shift()();
  assert.deepEqual(completions, ['intensity', 'source']);
  assert.equal(queue.pendingCount(), 0);
  assert.ok(calls.length >= 4);
});

test('SREV announcer cancellation aborts active playback and drops pending groups', () => {
  let aborted = 0;
  const queue = SrevAnnouncer.create({speak() { return {abort() { aborted++; }}; }});
  queue.enqueue('震度速報。');
  queue.enqueue('震源情報。');
  queue.cancelAll();
  assert.equal(aborted, 1);
  assert.equal(queue.pendingCount(), 0);
  assert.equal(queue.isSpeaking(), false);
});

test('SREV announcer reports a failed group and continues with the next group', () => {
  const calls = [];
  const errors = [];
  const queue = SrevAnnouncer.create({speak(text, onEnd, onError) {
    calls.push(text);
    if (calls.length === 1) onError(new Error('offline')); else onEnd();
    return {abort() {}};
  }});
  queue.enqueue('第一報。', {onError(error) { errors.push(error.message); }});
  queue.enqueue('第二報。');
  assert.deepEqual(calls, ['第一報。', '第二報。']);
  assert.deepEqual(errors, ['offline']);
  assert.equal(queue.pendingCount(), 0);
});

test('SREV announcer replaces stale keyed bulletins and honors priority', () => {
  const calls = [];
  const callbacks = [];
  const queue = SrevAnnouncer.create({maxLength:128, speak(text, onEnd) {
    calls.push(text); callbacks.push(onEnd); return {abort() {}};
  }});
  queue.enqueue('active', {id:'active'});
  queue.enqueue('old estimate', {id:'estimate',replace:true,priority:10});
  queue.enqueue('new estimate', {id:'estimate',replace:true,priority:10});
  queue.enqueue('urgent final', {id:'final',priority:100});
  callbacks.shift()();
  assert.deepEqual(calls, ['active', 'urgent final']);
  callbacks.shift()();
  assert.deepEqual(calls, ['active', 'urgent final', 'new estimate']);
  callbacks.shift()();
  assert.equal(queue.pendingCount(), 0);
});

test('SREV announcer bounds pending groups and selectively cancels active speech', () => {
  const calls = [];
  const callbacks = [];
  let aborted = 0;
  const queue = SrevAnnouncer.create({maxGroups:2, speak(text, onEnd) {
    calls.push(text); callbacks.push(onEnd); return {abort() { aborted++; }};
  }});
  queue.enqueue('active eew', {id:'eew-warning'});
  queue.enqueue('low one', {id:'low-1',priority:1});
  queue.enqueue('low two', {id:'low-2',priority:2});
  queue.enqueue('final', {id:'final',priority:100});
  assert.equal(queue.pendingCount(), 3, 'one active plus two bounded pending groups');
  queue.cancelMatching(group => group.id.indexOf('eew-') === 0, true);
  assert.equal(aborted, 1);
  assert.equal(calls[1], 'final');
  callbacks.shift()(); // stale callback from the aborted group must be ignored
  callbacks.shift()();
  assert.equal(calls[2], 'low two');
});

test('intensity survey snapshot preserves historical peaks after visible stations disappear', () => {
  const snapshot = SrevAnnouncer.freezeIntensitySnapshot(
    {17:'7', 4:'6-', 13:'5+'},
    {17:0, 4:'4', 13:'6+'},
    [4, 13, 17]
  );
  assert.deepEqual(snapshot, {4:'6-', 13:'6+', 17:'7'});
  assert.equal(Object.isFrozen(snapshot), true);
});
