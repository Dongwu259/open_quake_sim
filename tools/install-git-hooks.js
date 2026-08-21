#!/usr/bin/env node
// ============================================================
//  install-git-hooks.js — copy versioned hooks from githooks/
//  into .git/hooks/ (run by `npm install` via the `prepare`
//  script, or manually via `npm run install-hooks`).
//
//  Copies only; never overwrites an existing hook — machines
//  may have local hooks (e.g. a post-commit backup push) that
//  must survive. No-op outside a git checkout (e.g. Docker
//  builds, where .git/ and githooks/ are dockerignored).
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'githooks');
const DST = path.join(ROOT, '.git', 'hooks');

if (!fs.existsSync(SRC) || !fs.existsSync(DST)) {
  console.log('[hooks] no githooks/ or .git/hooks/ here — nothing to do');
  process.exit(0);
}

let installed = 0;
for (const name of fs.readdirSync(SRC)) {
  const src = path.join(SRC, name);
  const dst = path.join(DST, name);
  if (fs.existsSync(dst)) {
    const same = fs.readFileSync(src).equals(fs.readFileSync(dst));
    if (!same) {
      console.log(`[hooks] ${name} already exists with different content — left untouched`);
    }
    continue;
  }
  fs.copyFileSync(src, dst);
  try { fs.chmodSync(dst, 0o755); } catch (e) { /* Windows perms */ }
  console.log(`[hooks] installed ${name}`);
  installed++;
}
if (!installed) console.log('[hooks] already up to date');
