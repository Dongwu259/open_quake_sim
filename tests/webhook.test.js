// webhook.test.js — unit tests for WebhookManager module
const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

// Load fresh module for each test by clearing require cache and re-importing
function loadFresh() {
  delete require.cache[require.resolve('../tools/webhook-manager.js')];
  return require('../tools/webhook-manager.js');
}

describe('WebhookManager', function() {

  it('uses a bounded webhook response body limit', function() {
    var W = loadFresh();
    assert.ok(Number.isFinite(W._maxResponseBytes));
    assert.ok(W._maxResponseBytes > 0 && W._maxResponseBytes <= 1024 * 1024);
  });

  it('settles a timeout/error race only once', async function() {
    var W = loadFresh();
    W._maxRetries = 1;
    var dns = require('dns');
    var https = require('https');
    var originalLookup = dns.lookup;
    var originalRequest = https.request;
    var failures = 0, callbacks = 0;
    try {
      dns.lookup = function(host, options, cb) { cb(null, [{address:'93.184.216.34',family:4}]); };
      https.request = function(options, onResponse) {
        var req = new EventEmitter();
        req.write = function() {};
        req.destroy = function() { req.emit('error', new Error('destroyed')); };
        req.end = function() { req.emit('timeout'); };
        return req;
      };
      var originalFailure = W._handleFailure;
      W._handleFailure = function(hook, body, attempt, cb, reason) {
        failures++;
        cb(reason);
      };
      W._deliverOne({id:'wh_test',url:'https://example.com/hook',secret:null,failCount:0},
        JSON.stringify({type:'earthquake.detected'}),0,function() { callbacks++; });
      await new Promise(function(resolve) { setImmediate(resolve); });
      assert.equal(failures, 1);
      assert.equal(callbacks, 1);
      W._handleFailure = originalFailure;
    } finally {
      dns.lookup = originalLookup;
      https.request = originalRequest;
    }
  });

  describe('register', function() {
    it('registers a valid webhook', function() {
      var W = loadFresh();
      var r = W.register('https://example.com/hook', ['earthquake.detected']);
      assert.ok(r.ok, 'Registration should succeed');
      assert.ok(r.hook.id, 'Hook should have an id');
      assert.equal(r.hook.url, 'https://example.com/hook');
      assert.equal(r.hook.status, 'active'); // starts active, verification runs in background
      assert.equal(r.hook.hasSecret, false);
    });

    it('accepts a secret', function() {
      var W = loadFresh();
      var r = W.register('https://example.com/hook', ['earthquake.detected'], 'mysecret');
      assert.ok(r.ok);
      assert.equal(r.hook.hasSecret, true);
    });

    it('rejects invalid URL', function() {
      var W = loadFresh();
      var r = W.register('ftp://bad.com', ['earthquake.detected']);
      assert.ok(!r.ok);
      assert.ok(r.error.indexOf('http') >= 0);
    });

    it('rejects loopback and private-network targets', function() {
      var W = loadFresh();
      ['http://127.0.0.1/hook', 'http://169.254.169.254/latest',
       'http://192.168.1.10/hook', 'http://[::1]/hook', 'https://service.local/hook']
        .forEach(function(url) {
          var r = W.register(url, ['earthquake.detected']);
          assert.ok(!r.ok, url + ' should be rejected');
        });
    });

    it('rejects empty URL', function() {
      var W = loadFresh();
      var r = W.register('', ['earthquake.detected']);
      assert.ok(!r.ok);
    });

    it('rejects empty events array', function() {
      var W = loadFresh();
      var r = W.register('https://example.com/hook', []);
      assert.ok(!r.ok);
    });

    it('rejects unknown event type', function() {
      var W = loadFresh();
      var r = W.register('https://example.com/hook', ['unknown.event']);
      assert.ok(!r.ok);
      assert.ok(r.error.indexOf('Unknown event type') >= 0);
    });

    it('enforces max hooks cap (10)', function() {
      var W = loadFresh();
      for (var i = 0; i < 10; i++) {
        W._hooks.push({ id: 'prefill_' + i, url: 'https://prefill-' + i + '.com', events: ['earthquake.detected'], status: 'active', failCount: 0 });
      }
      var r = W.register('https://example.com/hook', ['earthquake.detected']);
      assert.ok(!r.ok);
      assert.ok(r.error.indexOf('Maximum webhook limit') >= 0);
    });

    it('rejects duplicate URL', function() {
      var W = loadFresh();
      W.register('https://example.com/hook', ['earthquake.detected']);
      var r2 = W.register('https://example.com/hook', ['bulletin.published']);
      assert.ok(!r2.ok);
      assert.ok(r2.error.indexOf('already exists') >= 0);
    });
  });

  describe('list', function() {
    it('returns empty array when no hooks', function() {
      var W = loadFresh();
      assert.deepEqual(W.list(), []);
    });

    it('masks secrets in list output', function() {
      var W = loadFresh();
      W.register('https://example.com/hook', ['earthquake.detected'], 'secret123');
      var hooks = W.list();
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].hasSecret, true);
      assert.ok(!hooks[0].secret, 'secret field should not be present');
    });

    it('isolates webhooks by owner', function() {
      var W = loadFresh();
      W.register('https://one.example/hook', ['earthquake.detected'], null, 'owner-a');
      W.register('https://two.example/hook', ['earthquake.detected'], null, 'owner-b');
      assert.equal(W.list('owner-a').length, 1);
      assert.equal(W.list('owner-a')[0].url, 'https://one.example/hook');
      assert.equal(W.list('owner-b').length, 1);
    });
  });

  describe('delete', function() {
    it('deletes an existing webhook', function() {
      var W = loadFresh();
      var r = W.register('https://example.com/hook', ['earthquake.detected']);
      var d = W.delete(r.hook.id);
      assert.ok(d.ok);
      assert.equal(W.list().length, 0);
    });

    it('returns error for nonexistent id', function() {
      var W = loadFresh();
      var d = W.delete('nonexistent');
      assert.ok(!d.ok);
    });

    it('does not delete another owner\'s webhook', function() {
      var W = loadFresh();
      var r = W.register('https://example.com/hook', ['earthquake.detected'], null, 'owner-a');
      assert.ok(!W.delete(r.hook.id, 'owner-b').ok);
      assert.equal(W.list('owner-a').length, 1);
    });
  });

  describe('activate', function() {
    it('reactivates a paused webhook', function() {
      var W = loadFresh();
      W._hooks.push({ id: 'test1', url: 'https://x.com', events: ['earthquake.detected'], status: 'paused', failCount: 10, secret: null, created: Date.now(), lastDelivery: null });
      var r = W.activate('test1');
      assert.ok(r.ok);
      assert.equal(W._hooks[0].status, 'active');
      assert.equal(W._hooks[0].failCount, 0);
    });
  });

  describe('deliver', function() {
    it('does not throw when no hooks exist (no-op)', function() {
      var W = loadFresh();
      assert.doesNotThrow(function() {
        W.deliver('earthquake.detected', { mag: 5.0 });
      });
    });

    it('skips hooks not subscribed to this event type', function() {
      var W = loadFresh();
      W._hooks.push({ id: 't1', url: 'https://x.com', events: ['bulletin.published'], status: 'active', failCount: 0, secret: null, created: Date.now(), lastDelivery: null });
      // Should not throw — no matching hooks for earthquake.detected
      assert.doesNotThrow(function() {
        W.deliver('earthquake.detected', { mag: 5.0 });
      });
    });

    it('skips paused hooks', function() {
      var W = loadFresh();
      W._hooks.push({ id: 't1', url: 'https://x.com', events: ['earthquake.detected'], status: 'paused', failCount: 10, secret: null, created: Date.now(), lastDelivery: null });
      assert.doesNotThrow(function() {
        W.deliver('earthquake.detected', { mag: 5.0 });
      });
    });

    it('records asynchronous results against the correct webhook', function() {
      var W = loadFresh();
      W._hooks.push(
        { id:'first', url:'https://one.example/hook', events:['earthquake.detected'], status:'active', failCount:0 },
        { id:'second', url:'https://two.example/hook', events:['earthquake.detected'], status:'active', failCount:0 }
      );
      var callbacks = {};
      W._deliverOne = function(hook, body, attempt, callback) { callbacks[hook.id] = callback; };
      W.deliver('earthquake.detected', {mag:5});
      callbacks.second(null);
      callbacks.first(new Error('first failed'));
      var eventLog = W._deliveryLog[Object.keys(W._deliveryLog)[0]];
      assert.equal(eventLog.first.status, 'failed');
      assert.equal(eventLog.second.status, 'delivered');
    });
  });

  describe('VALID_EVENTS', function() {
    it('lists all supported event types', function() {
      var W = loadFresh();
      var evts = W.VALID_EVENTS;
      assert.ok(evts.indexOf('earthquake.detected') >= 0);
      assert.ok(evts.indexOf('bulletin.published') >= 0);
      assert.ok(evts.indexOf('source.status_change') >= 0);
      assert.ok(evts.indexOf('simulation.complete') >= 0);
    });
  });

});
