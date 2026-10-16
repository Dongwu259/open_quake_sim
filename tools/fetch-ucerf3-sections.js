#!/usr/bin/env node
'use strict';
/**
 * fetch-ucerf3-sections.js — UCERF3 branch-averaged fault-system solutions (FM3.1 / FM3.2)
 * → parent-section-level frozen artifact tools/data/ucerf3-sections-california.json
 * (schema quake-sim-ucerf3-sections-v1).
 *
 * Source channel (data-availability report docs/UCERF3-AVAILABILITY.md, measured 2026-10-07):
 *   Zenodo DOI 10.5281/zenodo.5519802, CC BY 4.0
 *     branch_averaged_ucerf3_sol_FM3_1.zip  17,405,961 B  sha256 6804ba8e…02ce
 *     branch_averaged_ucerf3_sol_FM3_2.zip  19,525,785 B  sha256 714b1061…f2f7
 *   Format: Legacy Fault System Solution (zip{fault_sections.xml + big-endian double/int32 bins}),
 *   described verbatim by the record's file_format.md (three primitives: flat f64 arrays,
 *   int32 array-lists with count+length prefixes, MFD binary).
 * Citation: Field et al. (2014), USGS Open-File Report 2013-1165 / BSSA 104(3).
 *
 * Aggregation: rupture-level detail is NOT committed (reproducible from the zips via the
 * pinned sha256). Per parent section we keep: subsection ids, per-subsection traces (5dp),
 * length-weighted slip rate / dip / aseismic factor, circular-mean rake, depth envelope,
 * total length, Mmax and the participation rate (Σ rates of ruptures touching the parent,
 * each rupture counted once), plus per-subsection participation rate and Mmax.
 *
 * Frozen anchors (asserted in-tool, re-locked in tests/ucerf3-sections.test.js):
 *   FM3.1: 253,706 ruptures, 2,606 subsections, total fault rate 0.469 /yr,
 *          San Andreas (Parkfield) participation ≈0.045 /yr, Mmax 8.34.
 *
 * Usage:
 *   node tools/fetch-ucerf3-sections.js            # parse cached zips (.cache/ucerf3/) and write artifact
 *   node tools/fetch-ucerf3-sections.js --fetch    # download missing zips from Zenodo first
 *   node tools/fetch-ucerf3-sections.js --check    # artifact presence/schema sanity only
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'ucerf3');
const OUT = path.join(ROOT, 'tools', 'data', 'ucerf3-sections-california.json');

const DOI = '10.5281/zenodo.5519802';
const RECORD = 'https://zenodo.org/records/5519802';
const ZENODO_IPS = ['188.185.48.75', '137.138.153.219', '188.184.98.114', '137.138.52.235']; // CERN A-records, latency-tested 2026-09-18 (hosts-fix scripts); DNS on this box is unreliable for zenodo.org

const SOLUTIONS = [
  {
    faultModel: 'FM3.1',
    file: 'branch_averaged_ucerf3_sol_FM3_1.zip',
    local: 'ba_fm31.zip',
    bytes: 17405961,
    sha256: '6804ba8e76bf65b2c18ca4b665f900db79c8d84e51639e23515a6e3e2b5902ce',
  },
  {
    faultModel: 'FM3.2',
    file: 'branch_averaged_ucerf3_sol_FM3_2.zip',
    local: 'ba_fm32.zip',
    bytes: 19525785,
    sha256: '714b1061aa3086c0b136334b796675f2dd021a905f8ec5d4b542598a1f04c2f7',
  },
];
// Node index → lat/lng for the gridded-seismicity MFDs (RELM region, 0.1°,
// 7,636 nodes; Zenodo record companion file).
const RELM_CSV = {
  file: 'relm_gridded_region.csv',
  local: 'relm_gridded_region.csv',
  bytes: 176158,
  sha256: 'dc83d1f159b75e2c19facb3c63630ea9f9033146748ad210ea9a373c9d81eb53',
};
const OUT_GRID = path.join(ROOT, 'tools', 'data', 'ucerf3-grid-mfd.json');
const GRID_BIN_FLOOR = 1e-7;   // /yr; bins below this never touch any RP<=10k hazard level
const GRID_MIN_MAG = 5.0;      // project mMin — bins fully below are dropped

// ---- minimal ZIP reader (stored + deflate; same approach as fetch-kiknet-logs.js) ------
function unzip(buffer) {
  const b = Buffer.from(buffer);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65536); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
  const count = b.readUInt16LE(eocd + 10);
  let ptr = b.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(ptr + 10);
    const compSize = b.readUInt32LE(ptr + 20);
    const nameLen = b.readUInt16LE(ptr + 28), extraLen = b.readUInt16LE(ptr + 30), commentLen = b.readUInt16LE(ptr + 32);
    const localOff = b.readUInt32LE(ptr + 42);
    const name = b.slice(ptr + 46, ptr + 46 + nameLen).toString('latin1');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lhName = b.readUInt16LE(localOff + 26), lhExtra = b.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhName + lhExtra;
    const comp = b.slice(dataStart, dataStart + compSize);
    files.set(name, method === 0 ? comp : zlib.inflateRawSync(comp));
  }
  return files;
}

// ---- Legacy FSS binary primitives (big-endian, per file_format.md) ----------------------
function readDoubleArray(buf) {
  if (buf.length % 8 !== 0) throw new Error('double array byte length not multiple of 8: ' + buf.length);
  const n = buf.length / 8;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readDoubleBE(i * 8);
  return out;
}

function readIntArrayList(buf) {
  const count = buf.readInt32BE(0);
  const out = new Array(count);
  let ptr = 4;
  for (let i = 0; i < count; i++) {
    const len = buf.readInt32BE(ptr); ptr += 4;
    const arr = new Int32Array(len);
    for (let j = 0; j < len; j++) { arr[j] = buf.readInt32BE(ptr); ptr += 4; }
    out[i] = arr;
  }
  if (ptr !== buf.length) throw new Error('int array list trailing bytes: ' + (buf.length - ptr));
  return out;
}

// ---- fault_sections.xml parser (regular <iN attrs>…<FaultTrace>…</FaultTrace>…</iN>) ----
function xmlUnescape(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1]] = xmlUnescape(m[2]);
  return attrs;
}
function parseFaultSections(xml) {
  const sections = [];
  const re = /<i(\d+) ([^>]*)>([\s\S]*?)<\/i\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = parseAttrs(m[2]);
    const body = m[3];
    const tm = /<FaultTrace[^>]*>([\s\S]*?)<\/FaultTrace>/.exec(body);
    if (!tm) throw new Error('section ' + a.sectionId + ' has no FaultTrace');
    const trace = [];
    const lre = /<Location [^>]*\/>/g;
    let lm;
    while ((lm = lre.exec(tm[1]))) {
      const la = parseAttrs(lm[0]);
      trace.push([Number(la.Latitude), Number(la.Longitude)]);
    }
    if (trace.length < 1) throw new Error('section ' + a.sectionId + ' empty FaultTrace');
    sections.push({
      id: Number(a.sectionId),
      name: a.sectionName,
      slipRate: Number(a.aveLongTermSlipRate),
      dip: Number(a.aveDip),
      rake: Number(a.aveRake),
      upperKm: Number(a.aveUpperDepth),
      lowerKm: Number(a.aveLowerDepth),
      aseismic: Number(a.aseismicSlipFactor),
      dipDirection: Number(a.dipDirection),
      parentName: a.parentSectionName,
      parentId: Number(a.parentSectionId),
      trace,
    });
  }
  return sections;
}

// ---- geo helpers ------------------------------------------------------------------------
function haversineKm(a, b) {
  const R = 6371.0088;
  const dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function traceLengthKm(trace) {
  let L = 0;
  for (let i = 1; i < trace.length; i++) L += haversineKm(trace[i - 1], trace[i]);
  return L;
}
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// ---- Zenodo fetch (DNS first, pinned-IP SNI fallback; redirects followed) ---------------
function httpGet(urlOrIp, urlPath, hostHeader) {
  const opts = typeof urlOrIp === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(urlOrIp)
    ? { host: urlOrIp, port: 443, path: urlPath, servername: hostHeader, headers: { Host: hostHeader, 'User-Agent': 'quake-sim-tooling' }, timeout: 240000 }
    : { host: urlOrIp, port: 443, path: urlPath, headers: { 'User-Agent': 'quake-sim-tooling' }, timeout: 240000 };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const loc = new URL(res.headers.location, 'https://' + hostHeader);
        resolve({ redirect: loc });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}
async function fetchZenodoFile(sol, outPath) {
  const urlPath = '/records/5519802/files/' + sol.file + '?download=1';
  let lastErr = null;
  const attempts = [{ host: 'zenodo.org' }].concat(ZENODO_IPS.map((ip) => ({ ip })));
  for (const at of attempts) {
    try {
      let host = at.host || at.ip;
      let p = urlPath;
      for (let r = 0; r < 5; r++) {
        const res = await httpGet(host, p, 'zenodo.org');
        if (res.redirect) { host = res.redirect.hostname; p = res.redirect.pathname + res.redirect.search; continue; }
        if (res.status !== 200) throw new Error('HTTP ' + res.status);
        if (res.body.length !== sol.bytes) throw new Error('size mismatch: got ' + res.body.length + ', expected ' + sol.bytes);
        fs.writeFileSync(outPath, res.body);
        return;
      }
      throw new Error('too many redirects');
    } catch (e) { lastErr = e; }
  }
  throw new Error('zenodo fetch failed on all channels: ' + (lastErr && lastErr.message));
}

// ---- per-solution aggregation ------------------------------------------------------------
function aggregateSolution(sol, files) {
  for (const need of ['fault_sections.xml', 'rates.bin', 'mags.bin', 'rup_sections.bin', 'info.txt']) {
    if (!files.has(need)) throw new Error(sol.local + ' missing ' + need);
  }
  const info = files.get('info.txt').toString('utf8');
  if (!/BRANCH AVERAGED SOLUTION/.test(info)) throw new Error(sol.local + ' not a branch-averaged solution');

  const sections = parseFaultSections(files.get('fault_sections.xml').toString('utf8'));
  const rates = readDoubleArray(files.get('rates.bin'));
  const mags = readDoubleArray(files.get('mags.bin'));
  const rupSections = readIntArrayList(files.get('rup_sections.bin'));
  if (rupSections.length !== rates.length || rates.length !== mags.length) {
    throw new Error('rupture count mismatch: sections lists ' + rupSections.length + ' rates ' + rates.length + ' mags ' + mags.length);
  }

  // per-subsection participation rate + Mmax
  const nSect = sections.length;
  const sectRate = new Float64Array(nSect);
  const sectMmax = new Float64Array(nSect).fill(-Infinity);
  for (let r = 0; r < rupSections.length; r++) {
    const rate = rates[r], mag = mags[r];
    const arr = rupSections[r];
    for (let j = 0; j < arr.length; j++) {
      const s = arr[j];
      if (s < 0 || s >= nSect) throw new Error('rupture ' + r + ' references subsection ' + s + ' out of range');
      sectRate[s] += rate;
      if (mag > sectMmax[s]) sectMmax[s] = mag;
    }
  }

  // sectionId must be a dense 0..n-1 index — the rupture arrays reference it positionally
  const byId = new Array(nSect);
  for (const s of sections) {
    if (s.id < 0 || s.id >= nSect || byId[s.id]) throw new Error('subsection ids not dense/unique at id ' + s.id);
    byId[s.id] = s;
  }

  // parent aggregation (rupture counted once per parent via mark array);
  // charMfd: sparse incremental MFD (0.1 mag bins) of ruptures touching the
  // parent — the characteristic-source rate table for the v3 pack builder.
  const parents = new Map();
  for (const s of sections) {
    if (!parents.has(s.parentId)) {
      parents.set(s.parentId, {
        parentId: s.parentId, name: s.parentName, subsectionIds: [],
        lenKm: 0, wSum: 0, slipW: 0, dipW: 0, aseisW: 0, rakeSin: 0, rakeCos: 0,
        upperKm: Infinity, lowerKm: -Infinity, mmax: -Infinity,
        partRate: 0, mfd: Object.create(null),
      });
    }
    const p = parents.get(s.parentId);
    const len = traceLengthKm(s.trace);
    const w = Math.max(len, 1e-9);
    p.subsectionIds.push(s.id);
    p.lenKm += len;
    p.wSum += w;
    p.slipW += s.slipRate * w; p.dipW += s.dip * w; p.aseisW += s.aseismic * w;
    const th = s.rake * Math.PI / 180;
    p.rakeSin += Math.sin(2 * th) * w; p.rakeCos += Math.cos(2 * th) * w;
    p.upperKm = Math.min(p.upperKm, s.upperKm);
    p.lowerKm = Math.max(p.lowerKm, s.lowerKm);
    if (sectMmax[s.id] > p.mmax) p.mmax = sectMmax[s.id];
  }
  const parentArr = Array.from(parents.values());
  const parentIdx = new Map(parentArr.map((p, i) => [p.parentId, i]));
  const mark = new Int32Array(parentArr.length).fill(-1);
  const sectToParent = new Int32Array(nSect);
  for (const s of sections) sectToParent[s.id] = parentIdx.get(s.parentId);
  let totalRate = 0;
  let mmaxOverall = -Infinity;
  for (let r = 0; r < rupSections.length; r++) {
    const rate = rates[r], mag = mags[r];
    totalRate += rate;
    if (mag > mmaxOverall) mmaxOverall = mag;
    const arr = rupSections[r];
    const bin = Math.round(mag * 10) / 10;
    for (let j = 0; j < arr.length; j++) {
      const pi = sectToParent[arr[j]];
      if (mark[pi] !== r) {
        mark[pi] = r;
        parentArr[pi].partRate += rate;
        parentArr[pi].mfd[bin] = (parentArr[pi].mfd[bin] || 0) + rate;
      }
    }
  }

  const parentsOut = parentArr
    .sort((a, b) => a.parentId - b.parentId)
    .map((p) => ({
      parentId: p.parentId,
      name: p.name,
      subsectionCount: p.subsectionIds.length,
      subsectionIds: p.subsectionIds,
      totalLengthKm: r6(p.lenKm),
      slipRateMmPerYr: r6(p.slipW / p.wSum),
      dipDeg: r6(p.dipW / p.wSum),
      rakeDeg: r6((Math.atan2(p.rakeSin, p.rakeCos) / 2) * 180 / Math.PI),
      upperDepthKm: p.upperKm,
      lowerDepthKm: p.lowerKm,
      aseismicSlipFactor: r6(p.aseisW / p.wSum),
      participationRatePerYr: p.partRate,
      mmax: p.mmax,
      charMfd: Object.keys(p.mfd).map(Number).sort((a, b) => a - b).map((k) => [k, p.mfd[k]]),
    }));

  return {
    faultModel: sol.faultModel,
    branchAveraged: true,
    ruptureCount: rates.length,
    subsectionCount: nSect,
    parentCount: parentsOut.length,
    totalFaultRatePerYr: totalRate,
    mmaxOverall,
    subsections: sections.map((s) => ({
      id: s.id, parentId: s.parentId,
      slipRateMmPerYr: s.slipRate,
      dipDeg: s.dip, dipDirectionDeg: s.dipDirection, rakeDeg: s.rake,
      upperDepthKm: s.upperKm, lowerDepthKm: s.lowerKm,
      aseismicSlipFactor: s.aseismic,
      trace: s.trace.map((pt) => [r5(pt[0]), r5(pt[1])]),
      participationRatePerYr: sectRate[s.id],
      mmax: sectMmax[s.id],
    })),
    parents: parentsOut,
  };
}

// ---- grid_sources.bin → per-node sparse MFDs (schema quake-sim-ucerf3-gridmfd-v1) -------
function readGridSources(buf) {
  const count = buf.readInt32BE(0);
  let ptr = 4;
  const arrays = new Array(count);
  for (let i = 0; i < count; i++) {
    const len = buf.readInt32BE(ptr); ptr += 4;
    const a = new Float64Array(len);
    for (let j = 0; j < len; j++) { a[j] = buf.readDoubleBE(ptr); ptr += 8; }
    arrays[i] = a;
  }
  if (ptr !== buf.length) throw new Error('grid_sources trailing bytes: ' + (buf.length - ptr));
  return arrays; // [xVals, node0_unassoc, node0_subseismo, node1_unassoc, ...]
}

function sparseMfd(y, xVals) {
  const out = [];
  for (let i = 0; i < y.length; i++) {
    const lo = xVals[i] - 0.05;
    // 4 significant digits: relative 1e-4 on rates — nil against GMPE sigma
    // (~0.6 dex) and it keeps the frozen artifact under the 12 MB manifest cap
    if (lo >= GRID_MIN_MAG - 1e-9 && y[i] > GRID_BIN_FLOOR) out.push([r6(xVals[i]), Number(y[i].toPrecision(4))]);
  }
  return out;
}

function buildGridMfdModel(sol, files, nodePos) {
  const arrays = readGridSources(files.get('grid_sources.bin'));
  const xVals = arrays[0];
  const nNodes = (arrays.length - 1) / 2;
  if (nNodes !== nodePos.length) throw new Error(sol.local + ' grid nodes ' + nNodes + ' != csv ' + nodePos.length);
  if (Math.abs(xVals[1] - xVals[0] - 0.1) > 1e-9) throw new Error('unexpected MFD bin width');
  const nodes = new Array(nNodes);
  let totU = 0, totS = 0;
  for (let n = 0; n < nNodes; n++) {
    const u = arrays[1 + 2 * n].length ? sparseMfd(arrays[1 + 2 * n], xVals) : [];
    const s = arrays[2 + 2 * n].length ? sparseMfd(arrays[2 + 2 * n], xVals) : [];
    for (const b of u) totU += b[1];
    for (const b of s) totS += b[1];
    nodes[n] = [r5(nodePos[n][0]), r5(nodePos[n][1]), u, s];
  }
  return { nodes, totalUnassocRateM5: totU, totalSubseismoRateM5: totS };
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function main() {
  if (process.argv.includes('--check')) {
    let ok = true;
    if (!fs.existsSync(OUT)) { console.log('PACK-MISS ' + OUT); ok = false; }
    else {
      const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (!(doc.schema === 'quake-sim-ucerf3-sections-v1' && doc.models && doc.models['FM3.1'] && doc.models['FM3.2'])) ok = false;
    }
    if (!fs.existsSync(OUT_GRID)) { console.log('PACK-MISS ' + OUT_GRID); ok = false; }
    else {
      const g = JSON.parse(fs.readFileSync(OUT_GRID, 'utf8'));
      if (!(g.schema === 'quake-sim-ucerf3-gridmfd-v1' && g.models && g.models['FM3.1'] && g.models['FM3.2'])) ok = false;
    }
    console.log(ok ? 'PACK-OK ' + OUT + ' + ' + OUT_GRID : 'PACK-BAD-SCHEMA');
    process.exit(ok ? 0 : 1);
  }

  if (process.argv.includes('--fetch')) {
    for (const sol of SOLUTIONS.concat([RELM_CSV])) {
      const p = path.join(CACHE_DIR, sol.local);
      if (fs.existsSync(p) && sha256File(p) === sol.sha256) continue;
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      console.log('fetching ' + sol.file + ' …');
      await fetchZenodoFile(sol, p);
    }
  }

  // RELM node positions (grid_sources.bin arrays are ordered by node index)
  const csvPath = path.join(CACHE_DIR, RELM_CSV.local);
  if (!fs.existsSync(csvPath)) throw new Error('missing ' + csvPath + ' (run with --fetch)');
  if (sha256File(csvPath) !== RELM_CSV.sha256) throw new Error('relm csv sha256 mismatch');
  const csvLines = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);
  const nodePos = csvLines.map((line, i) => {
    const f = line.split(',');
    if (Number(f[0]) !== i) throw new Error('relm csv index out of order at row ' + i);
    return [Number(f[1]), Number(f[2])];
  });

  const models = {};
  const gridModels = {};
  for (const sol of SOLUTIONS) {
    const p = path.join(CACHE_DIR, sol.local);
    if (!fs.existsSync(p)) throw new Error('missing ' + p + ' (run with --fetch)');
    console.log('parsing ' + sol.faultModel + ' …');
    const zipBuf = fs.readFileSync(p);
    if (crypto.createHash('sha256').update(zipBuf).digest('hex') !== sol.sha256) throw new Error(sol.local + ' sha256 mismatch');
    const files = unzip(zipBuf);
    models[sol.faultModel] = aggregateSolution(sol, files);
    gridModels[sol.faultModel] = buildGridMfdModel(sol, files, nodePos);
    const m = models[sol.faultModel], g = gridModels[sol.faultModel];
    console.log('  ruptures=' + m.ruptureCount + ' subsections=' + m.subsectionCount +
      ' parents=' + m.parentCount + ' totalRate=' + m.totalFaultRatePerYr.toFixed(4) + '/yr Mmax=' + m.mmaxOverall.toFixed(2));
    console.log('  grid M>=5: unassoc=' + g.totalUnassocRateM5.toFixed(4) + '/yr subseismo=' + g.totalSubseismoRateM5.toFixed(4) + '/yr');
    const pk = m.parents.find((x) => /Parkfield/.test(x.name));
    if (pk) console.log('  anchor ' + pk.name + ': partRate=' + pk.participationRatePerYr.toFixed(4) + '/yr Mmax=' + pk.mmax.toFixed(2) +
      ' charMfdSum=' + pk.charMfd.reduce((a, b) => a + b[1], 0).toFixed(5));
  }

  // in-tool sanity gates (mirrored by tests/ucerf3-sections.test.js)
  const m31 = models['FM3.1'];
  if (m31.ruptureCount !== 253706 || m31.subsectionCount !== 2606) throw new Error('FM3.1 count anchors broken');
  if (Math.abs(m31.totalFaultRatePerYr - 0.469) > 0.005) throw new Error('FM3.1 total rate anchor broken: ' + m31.totalFaultRatePerYr);
  if (Math.abs(m31.mmaxOverall - 8.34) > 0.005) throw new Error('FM3.1 Mmax anchor broken: ' + m31.mmaxOverall);
  for (const pk of ['FM3.1', 'FM3.2']) {
    const p = models[pk].parents.find((x) => /Parkfield/.test(x.name));
    if (!p) throw new Error(pk + ' Parkfield missing');
    const mfdSum = p.charMfd.reduce((a, b) => a + b[1], 0);
    if (Math.abs(mfdSum - p.participationRatePerYr) > 1e-9) throw new Error(pk + ' charMfd does not sum to participation rate');
  }
  const g31 = gridModels['FM3.1'];
  if (Math.abs(g31.totalUnassocRateM5 - 3.607) > 0.01) throw new Error('FM3.1 grid unassoc M>=5 anchor broken: ' + g31.totalUnassocRateM5);
  if (Math.abs(g31.totalSubseismoRateM5 - 4.197) > 0.01) throw new Error('FM3.1 grid subseismo M>=5 anchor broken: ' + g31.totalSubseismoRateM5);

  const provenance = {
    doi: DOI,
    record: RECORD,
    license: 'CC BY 4.0',
    citation: 'Field et al. (2014), USGS Open-File Report 2013-1165 / BSSA 104(3); UCERF3 branch-averaged fault-system solutions',
    format: 'Legacy Fault System Solution (fault_sections.xml + big-endian f64/i32 binaries, file_format.md)',
    availabilityReport: 'docs/UCERF3-AVAILABILITY.md',
    solutions: SOLUTIONS.map((s) => ({ faultModel: s.faultModel, file: s.file, bytes: s.bytes, sha256: s.sha256 })),
    tool: 'tools/fetch-ucerf3-sections.js',
  };
  const doc = {
    schema: 'quake-sim-ucerf3-sections-v1',
    generatedAt: new Date().toISOString(),
    provenance,
    units: { participationRatePerYr: '1/yr', totalFaultRatePerYr: '1/yr', slipRateMmPerYr: 'mm/yr', depthKm: 'km (below surface)', totalLengthKm: 'km', mmax: 'moment magnitude', charMfd: '[[mag center (0.1 bins), incremental 1/yr], ...]' },
    notes: [
      'Parent-section aggregation of the 720-branch branch-averaged solutions; rupture-level detail is not committed — reproduce via the pinned zip sha256.',
      'participationRatePerYr sums rates of all ruptures touching the section/parent (each rupture counted once per parent); it is an event rate, not a moment rate. charMfd is the same sum split into 0.1-mag bins (sums to participationRatePerYr exactly).',
      'rakeDeg is the length-weighted circular mean (double-angle); slip rate / dip / aseismic factor are length-weighted arithmetic means.',
      'Geometry lives at subsection level (trace 5dp, dip, dipDirection, depth envelope); parents carry subsectionIds.',
      'Double-counting with the smoothed grid-GR sources was measured and resolved for the v3 pack (replacement-inside-RELM) — tools/ucerf3-reconcile.js + tools/data/ucerf3-reconcile-report.json.',
    ],
    models,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc));
  console.log('wrote ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes, sha256 ' + sha256File(OUT) + ')');

  const gridDoc = {
    schema: 'quake-sim-ucerf3-gridmfd-v1',
    generatedAt: doc.generatedAt,
    provenance: Object.assign({}, provenance, {
      relmCsv: { file: RELM_CSV.file, bytes: RELM_CSV.bytes, sha256: RELM_CSV.sha256 },
      format: 'grid_sources.bin double-array-list (x bins shared, then unassoc/subseismo y arrays per node) + relm_gridded_region.csv node positions',
    }),
    region: {
      name: 'RELM testing region',
      spacingDeg: 0.1,
      anchor: [31.5, -125.4],
      nodeCount: nodePos.length,
      // verbatim from grid_sources_reg.xml (identical in both zips, sha a4b444e0)
      polygon: [
        [43.0, -125.2], [43.0, -119.0], [39.4, -119.0], [35.7, -114.0], [34.3, -113.1],
        [32.9, -113.5], [32.2, -113.6], [31.7, -114.5], [31.5, -117.1], [31.9, -117.9],
        [32.8, -118.4], [33.7, -121.0], [34.2, -121.6], [37.7, -123.8], [40.2, -125.4], [40.5, -125.4],
      ],
    },
    mfdDef: {
      binWidth: 0.1, minMag: GRID_MIN_MAG, binFloorPerYr: GRID_BIN_FLOOR,
      note: 'incremental annual rates at 0.1-mag bin centers 5.05..8.95; bins with rate<=1e-7 and bins fully below M5.0 dropped (never touch RP<=10k hazard); rates rounded to 4 significant digits (relative 1e-4, nil against GMPE sigma); u=unassociated (off-fault), s=sub-seismogenic (on-fault small-M) per UCERF3 semantics',
    },
    units: { rate: '1/yr (incremental per bin)', mag: 'moment magnitude bin center' },
    models: Object.fromEntries(SOLUTIONS.map((s) => [s.faultModel, {
      totalUnassocRateM5: gridModels[s.faultModel].totalUnassocRateM5,
      totalSubseismoRateM5: gridModels[s.faultModel].totalSubseismoRateM5,
      nodes: gridModels[s.faultModel].nodes,
    }])),
  };
  fs.writeFileSync(OUT_GRID, JSON.stringify(gridDoc));
  console.log('wrote ' + OUT_GRID + ' (' + fs.statSync(OUT_GRID).size + ' bytes, sha256 ' + sha256File(OUT_GRID) + ')');
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
