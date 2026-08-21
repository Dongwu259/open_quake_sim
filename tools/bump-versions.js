#!/usr/bin/env node
// ============================================================
//  bump-versions.js — cache-busting sync gate (MANDATORY before deploy)
//
//  1. Rewrites every ?v=N in public/index.html to the first 6 hex chars
//     of the asset's SHA-1, so the version changes iff the content changes.
//  2. Derives the service-worker version from sw.js content and syncs it
//     across the three markers that must agree (checked by
//     tools/validate-release.js):
//       public/sw.js       CACHE_VERSION = 'qs-cache-v<N>'
//       public/app.js      serviceWorker.register('sw.js?v=<N>')
//       public/index.html  #build-ver data-sw="sw.js=v<N>"
//
//  Usage:
//    node tools/bump-versions.js            # rewrite in place (idempotent)
//    node tools/bump-versions.js --dry-run  # preview only, no writes
//    node tools/bump-versions.js --check    # exit 1 if anything is stale
//                                            (deploy gate / pre-push hook)
//
//  The server caches JS/CSS with 'max-age=31536000, immutable' — a forgotten
//  bump pins clients to stale code for a YEAR. Run this after every edit to a
//  versioned asset; it is wired into `npm run check` and the pre-push hook.
// ============================================================
'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const INDEX = path.join(PUBLIC, 'index.html');
const SW = path.join(PUBLIC, 'sw.js');
const APP = path.join(PUBLIC, 'app.js');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const checkMode = args.includes('--check');

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

// Staged file contents — ?v= hashes must be computed against the post-marker
// state (rewriting the SW registration string changes app.js content).
const staged = {}; // relPath -> new content
function contentOf(rel) {
  if (Object.prototype.hasOwnProperty.call(staged, rel)) return staged[rel];
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}
function hashOf(rel) {
  try { return sha1(Buffer.from(contentOf(rel), 'utf8')).slice(0, 6); }
  catch (e) { return null; } // file missing — leave version untouched
}

// ---- Service-worker version, derived from sw.js content ----
// The CACHE_VERSION literal is normalized to a placeholder before hashing, so
// rewriting the marker never changes the derived number (idempotent, and a
// content change can never collide with the number it just replaced).
function swVersionNumber(swContent) {
  const normalized = swContent.replace(/qs-cache-v\d+/g, 'qs-cache-v#');
  return String(100000 + parseInt(sha1(Buffer.from(normalized, 'utf8')).slice(0, 6), 16) % 900000);
}

const changes = [];   // { file, desc }
function recordChange(file, desc) { changes.push({ file, desc }); }
function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

if (!fs.existsSync(INDEX)) die('index.html not found at ' + INDEX);
if (!fs.existsSync(SW)) die('sw.js not found at ' + SW);
if (!fs.existsSync(APP)) die('app.js not found at ' + APP);

// ---- Stage 1: sync the three service-worker markers ----
const swContent = fs.readFileSync(SW, 'utf8');
const appContent = fs.readFileSync(APP, 'utf8');
let html = fs.readFileSync(INDEX, 'utf8');

const swNum = swVersionNumber(swContent);

const SW_RE    = /(CACHE_VERSION\s*=\s*['"])qs-cache-v\d+(['"])/;
const REG_RE   = /(serviceWorker\.register\(['"]sw\.js\?v=)\d+(['"]\))/;
const DATA_RE  = /(data-sw=['"]sw\.js=v)\d+(['"])/;

const swMarkers = [
  {
    name: 'sw.js CACHE_VERSION', file: 'sw.js',
    test: () => SW_RE.test(contentOf('sw.js')),
    apply: () => { staged['sw.js'] = contentOf('sw.js').replace(SW_RE, '$1qs-cache-v' + swNum + '$2'); }
  },
  {
    name: 'app.js SW registration', file: 'app.js',
    test: () => REG_RE.test(contentOf('app.js')),
    apply: () => { staged['app.js'] = contentOf('app.js').replace(REG_RE, '$1' + swNum + '$2'); }
  },
  {
    name: 'index.html data-sw marker', file: 'index.html',
    test: () => DATA_RE.test(html),
    apply: () => { html = html.replace(DATA_RE, '$1' + swNum + '$2'); }
  }
];

function markerNum(content, re) {
  const match = content.match(re);
  return match ? (content.slice(match.index).match(/\d+/) || [null])[0] : null;
}
const swStates = [
  { label: 'sw.js CACHE_VERSION', get: () => markerNum(contentOf('sw.js'), /qs-cache-v\d+/) },
  { label: 'app.js SW registration', get: () => markerNum(contentOf('app.js'), /sw\.js\?v=\d+/) },
  { label: 'index.html data-sw marker', get: () => markerNum(html, /sw\.js=v\d+/) }
];

// Rewrite pass (mutates staged/html via the marker descriptors above).
for (const m of swMarkers) {
  if (!m.test()) die(m.name + ' marker not found — refusing to guess. Inspect ' + m.file + ' manually.');
  const state = swStates.find(s => s.label === m.name);
  const before = state.get();
  if (before !== swNum) {
    m.apply();
    recordChange(m.file, `SW marker ${m.name}: v${before} -> v${swNum}`);
  }
}

// ---- Stage 2: ?v= rewrites (hashes computed against staged content) ----
// Match  src="path?v=N"  or  href="path?v=N"  for same-origin relative paths.
const RE = /((?:src|href)\s*=\s*")([^":?#]+?)(\?v=)([^"]*)(")/g;
const bumped = [];
html = html.replace(RE, (full, pre, rel, mid, oldV, post) => {
  const h = hashOf(rel);
  if (!h) return full; // file missing — leave version untouched
  if (h === oldV) return full;
  bumped.push({ file: rel, old: oldV, neu: h });
  return pre + rel + mid + h + post;
});
if (bumped.length) {
  for (const b of bumped) recordChange('index.html', `?v= ${b.file}: ${b.old} -> ${b.neu}`);
}
// index.html is written whenever it diverges from disk (moved data-sw marker
// or bumped ?v= strings).
if (html !== fs.readFileSync(INDEX, 'utf8')) staged['index.html'] = html;

// ---- Report ----
const prefix = (dryRun ? '[DRY-RUN] ' : '') + (checkMode ? '[CHECK] ' : '');
if (changes.length === 0) {
  console.log('All ?v= query strings and service-worker markers are in sync with file content. No changes.');
} else {
  console.log(prefix + 'Pending changes:');
  for (const c of changes) console.log('  ' + c.file.padEnd(16) + ' ' + c.desc);
}

if (bumped.length) {
  console.log('\n' + prefix + 'Version table (for the manual AGENTS.md/CLAUDE.md tables):');
  for (const r of bumped) {
    console.log(`| \`public/${r.file}\` | ${r.neu} | \`<...${r.file}?v=${r.neu}>\` |`);
  }
}

// ---- Write / gate ----
if (checkMode) {
  if (changes.length) {
    console.error(`\n${changes.length} stale version marker(s). Run: node tools/bump-versions.js`);
    process.exit(1);
  }
  process.exit(0);
}

if (!dryRun && changes.length) {
  const written = [];
  for (const [rel, content] of Object.entries(staged)) {
    fs.writeFileSync(path.join(PUBLIC, rel), content, 'utf8');
    written.push('public/' + rel);
  }
  if (written.length) console.log('\nWrote: ' + written.join(', '));
}
