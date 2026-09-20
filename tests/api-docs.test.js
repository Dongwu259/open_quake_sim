// tests/api-docs.test.js
// Documentation consistency gate: every /api/* route registered in server.js
// must be documented in public/openapi.json (and vice versa), and api.html
// must mention each documented path. server.js uses zero-dependency
// hand-rolled routing, so routes are extracted with simple regexes over the
// source — keep the regexes in sync if the routing style ever changes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const openapi = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'openapi.json'), 'utf8'));
const apiHtml = fs.readFileSync(path.join(ROOT, 'public', 'api.html'), 'utf8');

// ---------------------------------------------------------------------------
// Route extraction from server.js
// ---------------------------------------------------------------------------

// Exact-match routes: if (reqPath === '/api/...') — also catches /health etc.
const exactRoutes = new Set();
for (const m of serverSrc.matchAll(/reqPath === '(\/(?:api\/|health)[^']*)'/g)) {
  exactRoutes.add(m[1]);
}

// Prefix routes: if (reqPath.startsWith('/api/...')) — path-parameter style
// endpoints (e.g. /api/webhooks/:id) and prefix-matched proxies.
const prefixRoutes = new Set();
for (const m of serverSrc.matchAll(/reqPath\.startsWith\('(\/api\/[^']*)'\)/g)) {
  prefixRoutes.add(m[1]);
}

// Routes deliberately NOT documented in openapi.json (each must be justified):
//  - '/api/v1/'   — version-prefix normalization rule (/api/v1/x -> /api/x),
//                   not an endpoint of its own (server.js:895-898)
//  - '/api/'      — CORS preflight + JSON 404 fallthrough, not an endpoint
//                   (server.js:901, 2507)
const UNDOCUMENTED_WHITELIST = new Set(['/api/v1/', '/api/']);

// ---------------------------------------------------------------------------
// Path normalization helpers
// ---------------------------------------------------------------------------

// openapi documents the versioned form (/api/v1/earthquakes); server.js
// matches the normalized form (/api/earthquakes). Strip the version prefix.
function toServerPath(openapiPath) {
  return openapiPath.startsWith('/api/v1/')
    ? '/api/' + openapiPath.slice('/api/v1/'.length)
    : openapiPath;
}

// Compare ignoring {param} / :param style differences.
function pathKey(p) {
  return p.replace(/\{[^}/]+\}/g, ':_').replace(/\/:[^/]+/g, '/:_');
}

// A server path (exact or templated) is "registered" when it matches an exact
// route or falls under a registered prefix route.
function isRegistered(serverPath) {
  if (exactRoutes.has(serverPath)) return true;
  const key = pathKey(serverPath);
  for (const exact of exactRoutes) {
    if (pathKey(exact) === key) return true;
  }
  for (const prefix of prefixRoutes) {
    if (key.startsWith(pathKey(prefix))) return true;
  }
  return false;
}

const openapiPaths = Object.keys(openapi.paths);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('openapi.json parses with a valid openapi version field', () => {
  assert.ok(openapi && typeof openapi === 'object');
  assert.match(openapi.openapi, /^3\./);
  assert.ok(openapi.info && typeof openapi.info.version === 'string');
  assert.ok(Object.keys(openapi.paths).length > 0);
});

test('every /api/* route in server.js is documented in openapi.json', () => {
  const documented = new Set(openapiPaths.map(toServerPath).concat(openapiPaths));
  const undocumented = [];
  for (const route of exactRoutes) {
    if (UNDOCUMENTED_WHITELIST.has(route)) continue;
    const key = pathKey(route);
    const hit = [...documented].some((p) => pathKey(p) === key);
    if (!hit) undocumented.push(route);
  }
  for (const prefix of prefixRoutes) {
    if (UNDOCUMENTED_WHITELIST.has(prefix)) continue;
    const key = pathKey(prefix);
    // A prefix route is covered when some documented path lives under it.
    const hit = [...documented].some((p) => {
      const k = pathKey(p);
      return k === key.replace(/\/$/, '') || k.startsWith(key);
    });
    if (!hit) undocumented.push(prefix + '*');
  }
  assert.deepStrictEqual(undocumented, [],
    'server.js routes missing from openapi.json: ' + undocumented.join(', '));
});

test('every openapi.json path exists as a route in server.js', () => {
  const phantom = [];
  for (const p of openapiPaths) {
    const serverPath = toServerPath(p);
    if (!isRegistered(serverPath)) phantom.push(p);
  }
  assert.deepStrictEqual(phantom, [],
    'openapi.json paths with no matching server.js route: ' + phantom.join(', '));
});

test('api.html mentions every documented path', () => {
  const missing = [];
  for (const p of openapiPaths) {
    const colonStyle = p.replace(/\{([^}/]+)\}/g, ':$1');
    if (!apiHtml.includes(p) && !apiHtml.includes(colonStyle)) missing.push(p);
  }
  assert.deepStrictEqual(missing, [],
    'openapi.json paths not mentioned in api.html: ' + missing.join(', '));
});
