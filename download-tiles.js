// Download OSM tiles for Japan region to local cache
// Usage: node download-tiles.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = path.join(__dirname, 'public', 'tiles', 'osm');
// Japan bounds: lat 24-46, lng 122-150
const BOUNDS = { north: 46, south: 24, east: 150, west: 122 };
const ZOOMS = [5, 6, 7, 8];
const DELAY = 200; // ms between requests

function latLngToTile(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return [x, y];
}

function downloadTile(z, x, y) {
  return new Promise((resolve, reject) => {
    const dir = path.join(BASE, String(z), String(x));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, String(y) + '.png');
    if (fs.existsSync(file)) { resolve('cached'); return; }

    const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    https.get(url, { headers: { 'User-Agent': 'QuakeSim/1.0' } }, (res) => {
      if (res.statusCode !== 200) { reject(`HTTP ${res.statusCode}`); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(file, Buffer.concat(chunks));
        resolve('ok');
      });
    }).on('error', reject);
  });
}

async function main() {
  let total = 0, done = 0, cached = 0;
  const tasks = [];

  for (const z of ZOOMS) {
    const [x1, y1] = latLngToTile(BOUNDS.north, BOUNDS.west, z);
    const [x2, y2] = latLngToTile(BOUNDS.south, BOUNDS.east, z);
    const xMin = Math.min(x1, x2), xMax = Math.max(x1, x2);
    const yMin = Math.min(y1, y2), yMax = Math.max(y1, y2);
    const count = (xMax - xMin + 1) * (yMax - yMin + 1);
    total += count;
    console.log(`z${z}: x${xMin}-${xMax} y${yMin}-${yMax} = ${count} tiles`);

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tasks.push({ z, x, y });
      }
    }
  }

  console.log(`\nTotal: ${total} tiles to download\n`);

  for (let i = 0; i < tasks.length; i++) {
    const { z, x, y } = tasks[i];
    try {
      const result = await downloadTile(z, x, y);
      if (result === 'cached') cached++; else done++;
    } catch (e) {
      console.error(`  FAIL z${z}/${x}/${y}: ${e}`);
    }
    if ((i + 1) % 50 === 0 || i === tasks.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${total} (${done} new, ${cached} cached)   `);
    }
    await new Promise(r => setTimeout(r, DELAY));
  }
  console.log('\n\nDone!');
}

main().catch(console.error);
