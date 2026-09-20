// ================================================================
//  Webhook Manager — event subscription, delivery, and retry engine
//  Shared module: usable from Node.js (require) and browser (window)
//  Node.js: uses http/https for outbound delivery + fs for persistence
//  Browser: uses fetch for delivery (no persistence)
// ================================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.WebhookManager = factory(); }
}(typeof self !== 'undefined' ? self : this, function() {

var W = {};

// ---- Internal state ----
W._hooks = [];           // [{id, url, events[], secret, created, status, failCount, lastDelivery}]
W._deliveryLog = {};     // {eventId: {hookId: {status, time}}}
W._retryTimers = {};     // {timerId: timeoutRef}
W._maxHooks = 10;        // Per owner/API principal
W._maxRetries = 3;       // Delivery retry attempts
W._retryDelays = [10000, 60000, 300000]; // 10s, 60s, 300s
W._timeout = 5000;       // 5 second delivery timeout
W._maxResponseBytes = 1024 * 1024; // protect the server from unbounded webhook responses
W._maxFailures = 10;     // consecutive failures before auto-pause
W._persistPath = null;   // Set by Node.js init

// ---- Helpers ----

function generateId() {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var id = 'wh_';
  for (var i = 0; i < 12; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

function generateEventId() {
  return 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function safeJSON(obj) {
  try { return JSON.stringify(obj); } catch(e) { return '{}'; }
}

function isPrivateAddress(address) {
  var a = String(address || '').toLowerCase().split('%')[0];
  if (!a) return true;
  if (a.indexOf('::ffff:') === 0) a = a.slice(7);
  if (a.indexOf(':') >= 0) {
    return a === '::' || a === '::1' || a.indexOf('fc') === 0 ||
      a.indexOf('fd') === 0 || a.indexOf('fe8') === 0 ||
      a.indexOf('fe9') === 0 || a.indexOf('fea') === 0 || a.indexOf('feb') === 0;
  }
  var p = a.split('.').map(Number);
  if (p.length !== 4 || p.some(function(n) { return !Number.isInteger(n) || n < 0 || n > 255; })) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168);
}

function validateWebhookUrl(url) {
  var parsed;
  try { parsed = new URL(url); } catch(e) { return { ok:false, error:'invalid webhook URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok:false, error:'url must use http or https' };
  if (parsed.username || parsed.password) return { ok:false, error:'url credentials are not allowed' };
  var host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    return { ok:false, error:'private or local webhook targets are not allowed' };
  if (/^[0-9.]+$/.test(host) && isPrivateAddress(host))
    return { ok:false, error:'private or local webhook targets are not allowed' };
  if (host.indexOf(':') >= 0 && isPrivateAddress(host))
    return { ok:false, error:'private or local webhook targets are not allowed' };
  return { ok:true, parsed:parsed };
}

// ---- HMAC-SHA256 signature (Node.js only) ----
function sign(body, secret) {
  if (typeof require !== 'function' || !secret) return null;
  try {
    var crypto = require('crypto');
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  } catch(e) { return null; }
}

// ---- Persistence (Node.js only) ----
W.init = function(persistPath) {
  W._persistPath = persistPath;
  // Load existing webhooks from disk
  if (typeof require === 'function') {
    try {
      var fs = require('fs');
      if (persistPath && fs.existsSync(persistPath)) {
        var data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
        if (Array.isArray(data)) {
          W._hooks = data;
          // Reset failCount on load (fresh start)
          W._hooks.forEach(function(h) { if (h.status === 'paused') h.status = 'active'; h.failCount = 0; });
        }
      }
    } catch(e) { /* ignore */ }
  }
  return W;
};

W._save = function() {
  if (!W._persistPath || typeof require !== 'function') return;
  try {
    var fs = require('fs');
    fs.writeFileSync(W._persistPath, JSON.stringify(W._hooks, null, 2));
  } catch(e) { /* ignore */ }
};

// ---- Webhook CRUD ----

/**
 * Register a new webhook.
 * @param {string} url - Callback URL (must be https in production)
 * @param {string[]} events - Event types to subscribe to
 * @param {string} [secret] - Optional HMAC secret
 * @returns {{ok:boolean, hook?:object, error?:string}}
 */
W.register = function(url, events, secret, owner) {
  // Validate URL
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'url is required' };
  }
  var urlCheck = validateWebhookUrl(url);
  if (!urlCheck.ok) return { ok:false, error:urlCheck.error };
  url = urlCheck.parsed.href;
  owner = owner || null;

  // Validate events
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, error: 'events array is required (min 1 event type)' };
  }
  var validEvents = ['earthquake.detected', 'bulletin.published', 'source.status_change', 'simulation.complete'];
  for (var i = 0; i < events.length; i++) {
    if (validEvents.indexOf(events[i]) === -1) {
      return { ok: false, error: 'Unknown event type: ' + events[i] + '. Valid: ' + validEvents.join(', ') };
    }
  }

  // Check cap
  var ownerCount = W._hooks.filter(function(h) { return (h.owner || null) === owner; }).length;
  if (ownerCount >= W._maxHooks) {
    return { ok: false, error: 'Maximum webhook limit reached (' + W._maxHooks + ')' };
  }

  // Check duplicate URL
  for (var j = 0; j < W._hooks.length; j++) {
    if (W._hooks[j].url === url && (W._hooks[j].owner || null) === owner) {
      return { ok: false, error: 'A webhook for this URL already exists (id: ' + W._hooks[j].id + ')' };
    }
  }

  var hook = {
    id: generateId(),
    url: url,
    events: events,
    secret: secret || null,
    owner: owner,
    created: Date.now(),
    status: 'active',  // active immediately; verification runs in background
    failCount: 0,
    lastDelivery: null
  };

  W._hooks.push(hook);
  W._save();

  // Send verification ping (async, non-blocking — demotes to 'failed' if it doesn't pass)
  if (W._persistPath) W._verify(hook);

  return { ok: true, hook: W._sanitize(hook) };
};

/**
 * Send verification ping to a newly registered webhook.
 * The receiver must return 200 with the challenge in the response body.
 */
W._verify = function(hook) {
  // Defer verification so register() returns immediately
  if (typeof setImmediate !== 'undefined') {
    setImmediate(function() { W._doVerify(hook); });
  } else {
    setTimeout(function() { W._doVerify(hook); }, 0);
  }
};

W._doVerify = function(hook) {
  try {
    var challenge = generateId();
    var body = JSON.stringify({ type: 'verify', challenge: challenge, webhookId: hook.id });
    W._deliverOne(hook, body, 0, function(err, respBody) {
      if (!err && respBody && respBody.indexOf(challenge) >= 0) {
        // Verification passed
        hook.status = 'active';
        hook.failCount = 0;
      } else {
        // Verification failed
        hook.status = 'failed';
        hook.failCount = W._maxFailures;
      }
      W._save();
    });
  } catch(e) {
    // _deliverOne threw synchronously; mark hook as failed
    hook.status = 'failed';
    hook.failCount = W._maxFailures;
    W._save();
  }
};

/**
 * List all registered webhooks (sanitized — secrets masked).
 * @returns {object[]}
 */
W.list = function(owner) {
  owner = owner || null;
  return W._hooks.filter(function(h) { return (h.owner || null) === owner; })
    .map(function(h) { return W._sanitize(h); });
};

/**
 * Delete a webhook by ID.
 * @param {string} id
 * @returns {{ok:boolean, error?:string}}
 */
W.delete = function(id, owner) {
  owner = owner || null;
  for (var i = 0; i < W._hooks.length; i++) {
    if (W._hooks[i].id === id && (W._hooks[i].owner || null) === owner) {
      // Cancel any pending retry timers
      for (var key in W._retryTimers) {
        if (key.indexOf(id + '_') === 0) {
          clearTimeout(W._retryTimers[key]);
          delete W._retryTimers[key];
        }
      }
      W._hooks.splice(i, 1);
      W._save();
      return { ok: true };
    }
  }
  return { ok: false, error: 'Webhook not found: ' + id };
};

/**
 * Reactivate a paused webhook.
 */
W.activate = function(id, owner) {
  owner = owner || null;
  for (var i = 0; i < W._hooks.length; i++) {
    if (W._hooks[i].id === id && (W._hooks[i].owner || null) === owner) {
      W._hooks[i].status = 'active';
      W._hooks[i].failCount = 0;
      W._save();
      return { ok: true };
    }
  }
  return { ok: false, error: 'Webhook not found: ' + id };
};

/**
 * Sanitize hook for API response (mask secret, remove internal fields).
 */
W._sanitize = function(h) {
  return {
    id: h.id,
    url: h.url,
    events: h.events,
    hasSecret: !!h.secret,
    created: h.created,
    status: h.status,
    lastDelivery: h.lastDelivery
  };
};

// ---- Event Delivery Engine ----

/**
 * Deliver an event to all webhooks subscribed to this event type.
 * Called from server.js at event source points (SSE broadcast, TTS bulletin, source status).
 *
 * @param {string} eventType - e.g. 'earthquake.detected'
 * @param {object} data - Event payload
 */
W.deliver = function(eventType, data) {
  if (W._hooks.length === 0) return;

  var eventId = generateEventId();
  var timestamp = new Date().toISOString();
  var payload = {
    id: eventId,
    type: eventType,
    timestamp: timestamp,
    data: data || {}
  };
  var body = safeJSON(payload);

  for (var i = 0; i < W._hooks.length; i++) {
    var hook = W._hooks[i];
    // Skip hooks not subscribed to this event type
    if (hook.events.indexOf(eventType) === -1) continue;
    // Skip paused/failed hooks
    if (hook.status !== 'active') continue;

    // Dedup: skip if this event was already delivered to this hook
    if (W._deliveryLog[eventId] && W._deliveryLog[eventId][hook.id]) continue;

    // Track delivery attempt
    if (!W._deliveryLog[eventId]) W._deliveryLog[eventId] = {};
    W._deliveryLog[eventId][hook.id] = { status: 'pending', time: Date.now() };

    (function(deliveryHook) {
      W._deliverOne(deliveryHook, body, 0, function(err) {
        if (W._deliveryLog[eventId]) {
          W._deliveryLog[eventId][deliveryHook.id] = {
            status: err ? 'failed' : 'delivered',
            time: Date.now(),
            error: err || null
          };
        }
      });
    }(hook));
  }

  // Clean old delivery logs (keep last 500)
  var logKeys = Object.keys(W._deliveryLog);
  if (logKeys.length > 500) {
    var toDelete = logKeys.slice(0, logKeys.length - 500);
    for (var d = 0; d < toDelete.length; d++) delete W._deliveryLog[toDelete[d]];
  }
};

/**
 * Deliver to a single webhook with retry support.
 * @param {object} hook
 * @param {string} body - JSON payload
 * @param {number} attempt - Current retry attempt (0 = first try)
 * @param {function} callback - (err, respBody)
 */
W._deliverOne = function(hook, body, attempt, callback) {
  var payload = JSON.parse(body);
  var signature = sign(body, hook.secret);
  var eventId = payload.id || generateEventId();

  var headers = {
    'Content-Type': 'application/json',
    'X-QuakeSim-Event': payload.type || 'unknown',
    'X-QuakeSim-Event-Id': eventId,
    'X-QuakeSim-Delivery': String(attempt + 1)
  };
  if (signature) {
    headers['X-QuakeSim-Signature'] = 'sha256=' + signature;
  }

  // Node.js: use http/https module
  if (typeof require === 'function') {
    var proto = hook.url.indexOf('https://') === 0 ? require('https') : require('http');
    var urlObj;
    try {
      // Use the built-in URL from Node.js (global since Node 10)
      var URL = (typeof globalThis !== 'undefined' && globalThis.URL) || require('url').URL;
      urlObj = new URL(hook.url);
    } catch(e) {
      return callback('Invalid URL: ' + hook.url);
    }

    var dns = require('dns');
    var settled = false;
    function fail(reason) {
      if (settled) return;
      settled = true;
      W._handleFailure(hook, body, attempt, callback, reason);
    }
    function succeed(respBody) {
      if (settled) return;
      settled = true;
      hook.lastDelivery = Date.now();
      hook.failCount = 0;
      W._save();
      callback(null, respBody);
    }
    dns.lookup(urlObj.hostname, { all:true, verbatim:true }, function(lookupErr, addresses) {
      if (lookupErr || !addresses || !addresses.length) {
        return fail(lookupErr ? lookupErr.message : 'DNS lookup returned no addresses');
      }
      if (addresses.some(function(entry) { return isPrivateAddress(entry.address); })) {
        hook.status = 'failed'; hook.failCount = W._maxFailures; W._save();
        if (!settled) { settled = true; callback('private or local webhook targets are not allowed'); }
        return;
      }
      var selected = addresses[0];
      var reqHeaders = Object.assign({}, headers, { Host:urlObj.host });
      var reqOptions = {
        hostname: selected.address,
        family: selected.family,
        servername: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: reqHeaders,
        timeout: W._timeout
      };

      try {
        var req = proto.request(reqOptions, function(res) {
          var respBody = '', respBytes = 0;
          res.on('data', function(c) {
            if (settled) return;
            respBytes += c.length;
            if (respBytes > W._maxResponseBytes) {
              res.destroy();
              fail('response too large (max ' + W._maxResponseBytes + ' bytes)');
              return;
            }
            respBody += c;
          });
          res.on('end', function() {
            if (settled) return;
            if (res.statusCode >= 200 && res.statusCode < 300) succeed(respBody);
            else fail('HTTP ' + res.statusCode);
          });
        });

        req.on('error', function(e) {
          fail(e.message);
        });

        req.on('timeout', function() {
          fail('timeout after ' + W._timeout + 'ms');
          req.destroy();
        });

        req.write(body);
        req.end();
      } catch(e) {
        fail(e.message);
      }
    });
  } else {
    // Browser: use fetch
    fetch(hook.url, {
      method: 'POST',
      headers: headers,
      body: body
    }).then(function(res) {
      if (res.ok) {
        res.text().then(function(t) {
          if (t.length > W._maxResponseBytes) W._handleFailure(hook, body, attempt, callback, 'response too large');
          else {
            hook.lastDelivery = Date.now();
            hook.failCount = 0;
            callback(null, t);
          }
        });
      } else {
        W._handleFailure(hook, body, attempt, callback, 'HTTP ' + res.status);
      }
    }).catch(function(e) {
      W._handleFailure(hook, body, attempt, callback, e.message);
    });
  }
};

/**
 * Handle a delivery failure — retry or pause.
 */
W._handleFailure = function(hook, body, attempt, callback, reason) {
  hook.failCount++;

  if (attempt < W._maxRetries - 1) {
    // Schedule retry
    var delay = W._retryDelays[attempt] || 300000;
    var timerKey = hook.id + '_' + attempt + '_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    W._retryTimers[timerKey] = setTimeout(function() {
      delete W._retryTimers[timerKey];
      W._deliverOne(hook, body, attempt + 1, callback);
    }, delay);
  } else {
    // Exhausted retries
    if (hook.failCount >= W._maxFailures) {
      hook.status = 'paused';
      console.log('Webhook ' + hook.id + ' paused after ' + hook.failCount + ' consecutive failures');
    }
    W._save();
    callback(reason || 'Delivery failed after ' + W._maxRetries + ' retries');
  }
};

// ---- Module exports ----
W.VALID_EVENTS = ['earthquake.detected', 'bulletin.published', 'source.status_change', 'simulation.complete'];
W._isPrivateAddress = isPrivateAddress;
W._validateWebhookUrl = validateWebhookUrl;

return W;

}));
