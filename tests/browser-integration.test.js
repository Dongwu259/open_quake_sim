'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const BASE_URL = process.env.QS_BROWSER_URL || 'http://127.0.0.1:3000/';
const PROFILE_ROOT = path.join(ROOT, '.browser-test');
// Browser executables: env override first (QS_EDGE_PATH / QS_CHROME_PATH /
// QS_FIREFOX_PATH), then the usual install locations — the old single hard-
// coded path per browser silently SKIPped on any machine that installed
// elsewhere. A missing browser still SKIPs gracefully.
function resolveExe(envVar, candidates) {
  if (process.env[envVar]) return process.env[envVar];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return candidates[0];
}
const localAppData = process.env.LOCALAPPDATA || '';
const chromiumBrowsers = [
  {name:'Edge',exe:resolveExe('QS_EDGE_PATH',[
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']),port:9322},
  {name:'Chrome',exe:resolveExe('QS_CHROME_PATH',[
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(localAppData,'Google','Chrome','Application','chrome.exe')]),port:9323}
];
const firefox = {name:'Firefox',exe:resolveExe('QS_FIREFOX_PATH',[
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'])};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }

class CDP {
  constructor(url) {
    this.url = url; this.nextId = 1; this.pending = new Map(); this.listeners = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timeout')), 10000);
      this.ws.once('open', () => { clearTimeout(timer); resolve(); });
      this.ws.once('error', reject);
    });
    this.ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.id) {
        const item = this.pending.get(msg.id);
        if (!item) return;
        this.pending.delete(msg.id); clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(`${item.method}: ${msg.error.message}`));
        else item.resolve(msg.result);
        return;
      }
      for (const listener of this.listeners.get(msg.method) || []) listener(msg.params || {});
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  once(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const listener = value => { clearTimeout(timer); resolve(value); };
      const list = this.listeners.get(method) || [];
      list.push(listener); this.listeners.set(method, list);
      const timer = setTimeout(() => {
        const current = this.listeners.get(method) || [];
        this.listeners.set(method, current.filter(item => item !== listener));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
    });
  }
  send(method, params = {}, timeout = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, {resolve, reject, timer, method});
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {expression,returnByValue:true,awaitPromise,userGesture:true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { if (this.ws && this.ws.readyState <= 1) this.ws.close(); }
}

async function waitForEndpoint(port, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch (_) {}
    await sleep(150);
  }
  throw new Error(`Browser DevTools endpoint did not start on port ${port}`);
}

async function createTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {method:'PUT'});
  if (!response.ok) throw new Error(`Unable to create browser target: HTTP ${response.status}`);
  return response.json();
}

async function waitFor(cdp, expression, timeout = 20000, message = expression) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await sleep(150);
  }
  throw new Error(`Timed out: ${message}`);
}

async function click(cdp, selector) {
  const clicked = await cdp.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false; el.click(); return true; })()`);
  assert(clicked, `Missing clickable element ${selector}`);
}

async function setSelect(cdp, selector, value) {
  const changed = await cdp.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false; el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); return el.value===${JSON.stringify(value)}; })()`);
  assert(changed, `Unable to select ${value} in ${selector}`);
}

function installDiagnostics(cdp) {
  const errors = [];
  const requests = new Map();
  const optionalResource = /\/geojson\/vs30\.json(?:\?|$)|\/geojson\/landuse-manning\.json(?:\?|$)|\/favicon\.ico(?:\?|$)/;
  const add = value => { if (value && !errors.includes(value)) errors.push(value); };
  cdp.on('Runtime.exceptionThrown', event => add(`exception: ${event.exceptionDetails?.exception?.description || event.exceptionDetails?.text}`));
  cdp.on('Runtime.consoleAPICalled', event => {
    if (!['error','assert'].includes(event.type)) return;
    add(`console.${event.type}: ${(event.args || []).map(arg => arg.value || arg.description || '').join(' ')}`);
  });
  cdp.on('Log.entryAdded', event => {
    if (event.entry?.level !== 'error') return;
    const url = event.entry.url || '';
    if (optionalResource.test(url)) return;
    add(`log: ${event.entry.text}${url ? ` (${url})` : ''}`);
  });
  cdp.on('Network.requestWillBeSent', event => requests.set(event.requestId, event.request?.url || ''));
  cdp.on('Network.responseReceived', event => {
    const url = event.response?.url || '';
    const status = event.response?.status || 0;
    if (url.startsWith(BASE_URL) && status >= 400 && !optionalResource.test(url)) add(`HTTP ${status}: ${url}`);
  });
  cdp.on('Network.loadingFailed', event => {
    const url = requests.get(event.requestId) || '';
    if (url.startsWith(BASE_URL) && !event.canceled) add(`network failed: ${url} (${event.errorText})`);
  });
  return errors;
}

async function preparePage(cdp, viewport) {
  await Promise.all([
    cdp.send('Page.enable'),cdp.send('Runtime.enable'),cdp.send('Network.enable'),cdp.send('Log.enable')
  ]);
  await cdp.send('Emulation.setDeviceMetricsOverride', viewport);
  const loaded = cdp.once('Page.loadEventFired', 30000);
  await cdp.send('Page.navigate', {url:BASE_URL});
  await loaded;
  await waitFor(cdp, `document.readyState==='complete' && window.map && window.Physics && window.Research`, 30000, 'application globals');
  await waitFor(cdp, `document.getElementById('map-loading-overlay') && getComputedStyle(document.getElementById('map-loading-overlay')).display==='none'`, 30000, 'map data loading');
}

async function commonChecks(cdp) {
  const basics = await cdp.evaluate(`(() => ({
    title:document.title,
    duplicateIds:[...document.querySelectorAll('[id]')].map(x=>x.id).filter((id,i,a)=>a.indexOf(id)!==i),
    missingButtonNames:[...document.querySelectorAll('button')].filter(b=>!((b.getAttribute('aria-label')||b.title||b.textContent||'').trim())).length,
    sidebarPointer:getComputedStyle(document.getElementById('sidebar')).pointerEvents,
    sidebarOpacity:getComputedStyle(document.getElementById('sidebar')).opacity,
    mechanismOpen:document.getElementById('source-mechanism-panel').open,
    mapLoaded:Boolean(window.map && map._loaded),
    stationCount:Array.isArray(window.rawLandGrid)?window.rawLandGrid.length:0,
    promoAbsent:!document.getElementById('promo-overlay') && !document.getElementById('btn-promo-close'),
    mapA11y:{tabIndex:document.getElementById('map').tabIndex,busy:document.getElementById('map').getAttribute('aria-busy'),name:document.getElementById('map').getAttribute('aria-label')},
    canvasA11y:[...document.querySelectorAll('canvas:not([aria-hidden="true"])')].map(c=>({id:c.id,role:c.getAttribute('role'),name:c.getAttribute('aria-label'),description:c.getAttribute('aria-describedby')}))
  }))()`);
  assert(/v6\.0/.test(basics.title), `Unexpected release title: ${basics.title}`);
  assert(basics.duplicateIds.length === 0, `Duplicate DOM ids: ${basics.duplicateIds.join(', ')}`);
  assert(basics.missingButtonNames === 0, `${basics.missingButtonNames} buttons lack accessible names`);
  assert(basics.sidebarPointer !== 'none' && Number(basics.sidebarOpacity) > 0.5, 'Sidebar is blocked or visually disabled');
  assert(basics.mechanismOpen, 'Source mechanism must be expanded by default');
  assert(basics.mapLoaded && basics.stationCount >= 1000, 'Map/station data did not initialize');
  assert(basics.mapA11y.tabIndex === 0 && basics.mapA11y.busy === 'false' && basics.mapA11y.name, `Map accessibility state is incomplete: ${JSON.stringify(basics.mapA11y)}`);
  assert(basics.canvasA11y.length >= 15 && basics.canvasA11y.every(c => c.role === 'img' && c.name), `Canvas accessibility names are incomplete: ${JSON.stringify(basics.canvasA11y)}`);
  assert(basics.canvasA11y.filter(c => !c.id.startsWith('realtime-wf') && !c.id.startsWith('mwf-canvas')).every(c => c.description), 'Scenario canvases lack text descriptions');
  // scrub contract: the related-sites promo dialog must stay out of the open build
  assert(basics.promoAbsent, 'Promo dialog leaked back into the open build');

  const menuAudit = await cdp.evaluate(`(() => { const m=document.getElementById('map');m.focus();m.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}));const menu=document.getElementById('ctx-menu');return {open:getComputedStyle(menu).display!=='none',focused:document.activeElement&&document.activeElement.getAttribute('role'),names:[...menu.querySelectorAll('[role="menuitem"]')].map(x=>x.textContent.trim())}; })()`);
  assert(menuAudit.open && menuAudit.focused === 'menuitem' && menuAudit.names.length === 3 && menuAudit.names.every(Boolean), `Keyboard map menu failed: ${JSON.stringify(menuAudit)}`);
  await cdp.evaluate(`document.getElementById('ctx-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  assert(await cdp.evaluate(`getComputedStyle(document.getElementById('ctx-menu')).display==='none' && document.activeElement===document.getElementById('map')`), 'Escape did not close the map menu and restore focus');

  await click(cdp, '#tab-btn-advanced');
  await waitFor(cdp, `document.getElementById('tab-advanced').classList.contains('active') && document.getElementById('tab-btn-advanced').getAttribute('aria-selected')==='true'`, 3000, 'advanced tab');
  await click(cdp, '#tab-btn-info');
  await waitFor(cdp, `document.getElementById('tab-info').classList.contains('active') && document.getElementById('info-details-card').open`, 3000, 'info tab and diagnostics');
  await click(cdp, '#tab-btn-basic');

  await click(cdp, '#btn-help');
  await waitFor(cdp, `getComputedStyle(document.getElementById('help-overlay')).display!=='none'`, 3000, 'help open');
  await waitFor(cdp, `window._helpI18nLoaded===true`, 5000, 'lazy help translations');
  const helpAudit = await cdp.evaluate(`(() => { const o=document.getElementById('help-overlay'),finalHeader=o.querySelector('[data-i18n="help.v51_final_release"]'),previewHeader=o.querySelector('[data-i18n="help.v51_preview"]'),v52FinalHeader=o.querySelector('[data-i18n="help.v52_final_release"]'),v52PreviewHeader=o.querySelector('[data-i18n="help.v52_preview"]'); return {role:o.getAttribute('role'),modal:o.getAttribute('aria-modal'),forbidden:/开发者密码|developer password|管理密码/i.test(o.textContent),accuracy:o.textContent.includes('0.724'),focused:o.contains(document.activeElement),finalText:finalHeader&&finalHeader.textContent,previewText:previewHeader&&previewHeader.textContent,releaseBeforePreview:Boolean(finalHeader&&previewHeader&&(finalHeader.compareDocumentPosition(previewHeader)&Node.DOCUMENT_POSITION_FOLLOWING)),v52FinalText:v52FinalHeader&&v52FinalHeader.textContent,v52PreviewText:v52PreviewHeader&&v52PreviewHeader.textContent,v52ReleaseBeforePreview:Boolean(v52FinalHeader&&v52PreviewHeader&&(v52FinalHeader.compareDocumentPosition(v52PreviewHeader)&Node.DOCUMENT_POSITION_FOLLOWING))}; })()`);
  assert(helpAudit.role === 'dialog' && helpAudit.modal === 'true', 'Help overlay lacks dialog semantics');
  assert(!helpAudit.forbidden, 'Help contains removed developer-password material');
  assert(helpAudit.accuracy, 'Help does not contain the current finite-fault accuracy note');
  assert(/v5\.1.*正式版|v5\.1.*Release/.test(helpAudit.finalText || ''), `Formal-release help entry is missing: ${JSON.stringify(helpAudit)}`);
  assert(/v5\.1.*预览版|v5\.1.*Preview|v5\.1.*プレビュー版/.test(helpAudit.previewText || ''), `Preview help history is missing: ${JSON.stringify(helpAudit)}`);
  assert(helpAudit.releaseBeforePreview, 'Formal-release help must appear before the preview history');
  assert(/v5\.2.*正式版|v5\.2.*Release/.test(helpAudit.v52FinalText || ''), `v5.2 formal-release help entry is missing: ${JSON.stringify(helpAudit)}`);
  assert(/v5\.2.*预览版|v5\.2.*Preview|v5\.2.*プレビュー版/.test(helpAudit.v52PreviewText || ''), `v5.2 preview help history is missing: ${JSON.stringify(helpAudit)}`);
  assert(helpAudit.v52ReleaseBeforePreview, 'v5.2 formal-release help must appear before the v5.2 preview history');
  assert(helpAudit.focused, 'Help dialog did not receive focus');
  await click(cdp, '#btn-help-close');

  await click(cdp, '#btn-formulas');
  await waitFor(cdp, `getComputedStyle(document.getElementById('formulas-overlay')).display!=='none'`, 3000, 'formulas open');
  await click(cdp, '.formula-mode-btn[data-formula-mode="full"]');
  assert(await cdp.evaluate(`document.getElementById('formulas-overlay').classList.contains('formula-mode-full')`), 'Formula detail mode did not switch');
  await click(cdp, '#btn-formulas-close');

  await setSelect(cdp, '#lang-select', 'en');
  assert(/Earthquake Simulator v6\.0/.test(await cdp.evaluate(`document.querySelector('#sidebar-header h1').textContent`)), 'English release identity failed');
  await setSelect(cdp, '#lang-select', 'zh');
  assert(/地震模拟器 v6\.0/.test(await cdp.evaluate(`document.querySelector('#sidebar-header h1').textContent`)), 'Chinese release identity failed');

  const beforeZoom = await cdp.evaluate('map.getZoom()');
  await cdp.evaluate('map.setZoom(map.getZoom()+1); true');
  await waitFor(cdp, `map.getZoom()===${beforeZoom + 1}`, 5000, 'Leaflet zoom interaction');
}

async function tsunamiVisualizationChecks(cdp) {
  const result = await cdp.evaluate(`(() => {
    const modes=['waveField','maxSurface','arrivalTime','maxVelocity','maxInundation','cityInundation','seafloorDeformation'];
    const select=document.getElementById('tsunami-layer-select');
    const previous={grid:_bathyGrid,snapshot:_tsuResearchSnapshot,enabled:_tsunamiEl.checked,mode:cfgGet('tsunamiMapMode'),solver:cfgGet('tsunamiSolver'),center:map.getCenter(),zoom:map.getZoom(),selected:_tsunamiSelectedZoneId,hovered:_tsunamiHoveredZoneId};
    const outputs=[];
    map.setView([35.3,138.3],7,{animate:false});
    _bathyGrid={origin:[138,35],res:0.15,nx:4,ny:4,data:[-100,-80,-60,-40,-80,-30,1,2,-60,-20,3,5,-40,-10,4,8],meta:{dataset:'Browser integration terrain'}};
    _tsuResearchSnapshot={
      time:900,stride:1,model:'nonlinearSWE',maxRunup:2.4,inundatedAreaKm2:18.6,maxInundationDistanceKm:4.2,maxVelocity:1.7,visualAggregationKm:15,
      cells:[
        {x:0,y:0,eta:0.6,maxEta:1.2,maxDepth:0,maxVelocity:0.8,arrivalTime:120,terrain:-100},
        {x:1,y:1,eta:-0.4,maxEta:0.9,maxDepth:0,maxVelocity:1.1,arrivalTime:220,terrain:-30},
        {x:2,y:1,eta:0.2,maxEta:1.5,maxDepth:1.3,maxVelocity:1.7,arrivalTime:340,terrain:1},
        {x:3,y:2,eta:0.1,maxEta:0.8,maxDepth:0.7,maxVelocity:0.6,arrivalTime:480,terrain:5}
      ],
      inundationZones:[{id:'1,0',bbox:[138.20,35.10,138.58,35.48],maxDepth:1.3,maxSurface:2.1,maxVelocity:1.7,arrivalTime:340,areaKm2:18.6,cells:2}],
      deformation:{data:[0.4,0.2,-0.2,-0.4,0.3,0.15,-0.15,-0.3,0.2,0.1,-0.1,-0.2,0.1,0.05,-0.05,-0.1],maxUplift:0.4,maxSubsidence:-0.4,volumeResidual:0,method:'okada-patch',patches:6},
      diagnostics:{timeSeconds:900,steps:120,stableDtSeconds:7.5,maxCfl:0.38,cflLimit:0.38,gridNx:4,gridNy:4,cellCount:16,initialWaterVolumeM3:1e9,currentWaterVolumeM3:1e9,massResidualM3:0,massResidualFraction:0,negativeDepthCorrections:0,dryCellCorrections:2,nonFiniteCorrections:0,nonFiniteCells:0,minWaterDepthM:0,maxWaterDepthM:100,coriolisEnabled:true,minCellSizeM:12000,maxCellSizeM:16000}
    };
    _tsunamiEl.checked=true;
    function nonTransparentPixels() {
      const data=waveCtx.getImageData(0,0,waveCanvas.width,waveCanvas.height).data;
      let count=0;for(let i=3;i<data.length;i+=4)if(data[i])count++;
      return count;
    }
    for(const mode of modes){
      cfgSet('tsunamiMapMode',mode);select.value=mode;Renderer.invalidateCaches();waveCtx.clearRect(0,0,waveCanvas.width,waveCanvas.height);Renderer.drawResearchTsunami();
      outputs.push({mode,pixels:nonTransparentPixels(),selected:select.value,legend:!document.getElementById('research-layer-legend').hidden,quality:document.getElementById('research-data-quality').textContent});
    }
    const compatibilitySnapshot=_tsuResearchSnapshot;
    cfgSet('tsunamiSolver','linearSWE');select.value='cityInundation';select.dispatchEvent(new Event('change',{bubbles:true}));
    const compatibility={solver:cfgGet('tsunamiSolver'),mode:cfgGet('tsunamiMapMode'),advancedSolver:document.querySelector('.adv-row[data-cfg="tsunamiSolver"] select').value};
    _tsuResearchSnapshot=compatibilitySnapshot;
    const control=document.getElementById('tsunami-layer-control'),timeline=document.getElementById('timeline'),zoom=document.querySelector('.leaflet-control-zoom');
    const rect=control.getBoundingClientRect(),timelineRect=timeline.getBoundingClientRect(),zoomRect=zoom.getBoundingClientRect();
    const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
    const layout={visible:!control.hidden,inViewport:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,overlapsTimeline:overlaps(rect,timelineRect),overlapsZoom:overlaps(rect,zoomRect)};
    const stats=document.getElementById('tsunami-layer-stats').textContent;
    cfgSet('tsunamiMapMode','cityInundation');select.value='cityInundation';Renderer.invalidateCaches();Renderer.drawResearchTsunami();
    const hit=findTsunamiInundationZone({lat:35.3,lng:138.3});selectTsunamiInundationZone(hit);Renderer.drawResearchTsunami();
    const zonePanel=document.getElementById('tsunami-zone-details');
    const zoneState={hit:hit&&hit.id,selected:_tsunamiSelectedZoneId,visible:!zonePanel.hidden,text:zonePanel.textContent};
    const health=Physics.assessTsunamiNumericalHealth(_tsuResearchSnapshot.diagnostics);
    document.getElementById('tsunami-zone-detail-close').click();
    zoneState.closed=zonePanel.hidden&&_tsunamiSelectedZoneId===null;
    select.value='off';select.dispatchEvent(new Event('change',{bubbles:true}));waveCtx.clearRect(0,0,waveCanvas.width,waveCanvas.height);Renderer.drawResearchTsunami();
    const offState={pixels:nonTransparentPixels(),selected:select.value,configured:cfgGet('tsunamiMapMode'),legend:!document.getElementById('research-layer-legend').hidden,control:!control.hidden};
    select.value='cityInundation';select.dispatchEvent(new Event('change',{bubbles:true}));waveCtx.clearRect(0,0,waveCanvas.width,waveCanvas.height);Renderer.drawResearchTsunami();
    const reEnabledState={pixels:nonTransparentPixels(),selected:select.value,configured:cfgGet('tsunamiMapMode'),legend:!document.getElementById('research-layer-legend').hidden};
    _bathyGrid=previous.grid;_tsuResearchSnapshot=previous.snapshot;_tsunamiEl.checked=previous.enabled;_tsunamiSelectedZoneId=previous.selected;_tsunamiHoveredZoneId=previous.hovered;cfgSet('tsunamiMapMode',previous.mode);cfgSet('tsunamiSolver',previous.solver);select.value=previous.mode;
    map.setView(previous.center,previous.zoom,{animate:false});Renderer.invalidateCaches();waveCtx.clearRect(0,0,waveCanvas.width,waveCanvas.height);Renderer.drawResearchTsunami();
    return {options:[...select.options].map(option=>option.value),outputs,compatibility,offState,reEnabledState,layout,stats,zoneState,health};
  })()`);
  const expected=['off','waveField','maxSurface','arrivalTime','maxVelocity','maxInundation','cityInundation','seafloorDeformation'];
  assert(JSON.stringify(result.options) === JSON.stringify(expected), `Tsunami layer options are incomplete: ${JSON.stringify(result.options)}`);
  assert(result.outputs.every(item => item.selected === item.mode && item.legend && item.quality && item.pixels > 0), `Tsunami layer render failed: ${JSON.stringify(result.outputs)}`);
  assert(result.compatibility.solver === 'nonlinearSWE' && result.compatibility.mode === 'cityInundation' && result.compatibility.advancedSolver === 'nonlinearSWE', `City inundation did not activate NLSWE: ${JSON.stringify(result.compatibility)}`);
  assert(result.offState.selected === 'off' && result.offState.configured === 'off' && result.offState.pixels === 0 && !result.offState.legend && result.offState.control, `Tsunami layer cannot be disabled cleanly: ${JSON.stringify(result.offState)}`);
  assert(result.reEnabledState.selected === 'cityInundation' && result.reEnabledState.configured === 'cityInundation' && result.reEnabledState.pixels > 0 && result.reEnabledState.legend, `Tsunami layer cannot be re-enabled: ${JSON.stringify(result.reEnabledState)}`);
  assert(result.layout.visible && result.layout.inViewport && !result.layout.overlapsTimeline && !result.layout.overlapsZoom, `Tsunami control layout failed: ${JSON.stringify(result.layout)}`);
  assert(/2\.40\s*m/.test(result.stats) && /18\.6\s*km/.test(result.stats) && /4\.2\s*km/.test(result.stats) && /1\.70\s*m\/s/.test(result.stats), `Tsunami statistics are incomplete: ${result.stats}`);
  assert(result.zoneState.hit === '1,0' && result.zoneState.selected === '1,0' && result.zoneState.visible && result.zoneState.closed, `City inundation selection failed: ${JSON.stringify(result.zoneState)}`);
  assert(/1\.30\s*m/.test(result.zoneState.text) && /2\.10\s*m/.test(result.zoneState.text) && /1\.70\s*m\/s/.test(result.zoneState.text) && /18\.60\s*km/.test(result.zoneState.text) && /340\s*s/.test(result.zoneState.text), `City inundation details are incomplete: ${result.zoneState.text}`);
  assert(result.health.level === 'healthy' && result.health.massResidualPercent === 0, `Tsunami numerical health classification failed: ${JSON.stringify(result.health)}`);
}

async function finiteFaultImportChecks(cdp) {
  const fixture = {
    schema:'quake-sim-finite-fault-v1',id:'browser-finite-fault',
    event:{id:'browser-event',lat:35.2,lng:140.4,depthKm:12,momentNm:1e21,sourceType:'interplate'},
    provenance:{source:'Browser fixture',url:'https://example.test/finite-fault',license:'CC0'},
    patches:[
      {id:'a',corners:[{lat:35.25,lng:140.28,depthKm:8},{lat:35.31,lng:140.43,depthKm:8},{lat:35.20,lng:140.48,depthKm:17},{lat:35.14,lng:140.33,depthKm:17}],strikeDeg:65,dipDeg:25,rakeDeg:90,momentNm:4e20,ruptureTimeS:0,riseTimeS:2},
      {id:'b',corners:[{lat:35.31,lng:140.43,depthKm:8},{lat:35.37,lng:140.58,depthKm:8},{lat:35.26,lng:140.63,depthKm:17},{lat:35.20,lng:140.48,depthKm:17}],strikeDeg:68,dipDeg:28,rakeDeg:95,momentNm:6e20,ruptureTimeS:2.5,riseTimeS:3}
    ]
  };
  await click(cdp, '#tab-btn-info');
  const staged = await cdp.evaluate(`(() => {
    const input=document.getElementById('finite-fault-file'),dt=new DataTransfer();
    dt.items.add(new File([${JSON.stringify(JSON.stringify(fixture))}],'browser-fault.json',{type:'application/json'}));
    input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;
  })()`);
  assert(staged, 'Unable to stage finite-fault browser fixture');
  await waitFor(cdp, `window._pendingFiniteFault&&_pendingFiniteFault.id==='browser-finite-fault'&&!document.getElementById('finite-fault-use').disabled`, 5000, 'finite-fault parse and validation');
  await click(cdp, '#finite-fault-use');
  await waitFor(cdp, `window._observedFiniteFault&&window.epicenter&&eventMw===_observedFiniteFault.mw`, 5000, 'finite-fault activation');
  const imported = await cdp.evaluate(`(() => {
    const source=buildSourceModel({}),g=source.geometry,canvas=document.getElementById('ff-preview');
    FiniteFaultEditor.drawPreview();
    createFaultLayer(source.lat,source.lng,source.mw,source.strikeDeg,source.dipDeg,source.depthKm,0,source.mw,source.sourceType,g);
    const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let colored=0;for(let i=0;i<data.length;i+=4)if(data[i]>40||data[i+1]>40||data[i+2]>50)colored++;
    const result={kind:g.kind,patches:g.nSub,mapPatches:rupturePolyEntries.length,moment:source.momentNm,modelMoment:_observedFiniteFault.totalMomentNm,active:document.getElementById('finite-fault-result').textContent,previewPixels:colored,modelHash:g.modelHash};
    removeFaultLayer();rupturePolyEntries=[];return result;
  })()`);
  assert(imported.kind === 'imported-finite-fault' && imported.patches === 2 && imported.mapPatches === 2, `Imported map geometry failed: ${JSON.stringify(imported)}`);
  assert(imported.moment === imported.modelMoment && imported.modelHash && imported.previewPixels > 100, `Imported source/preview identity failed: ${JSON.stringify(imported)}`);
  assert(/权威|authoritative|権威/.test(imported.active), `Imported active diagnostic is missing: ${imported.active}`);

  await cdp.evaluate(`(() => { const canvas=document.getElementById('canvas-3d'),card=canvas.closest('details'),enable=document.getElementById('3d-enable');if(enable&&!enable.checked){enable.checked=true;enable.dispatchEvent(new Event('change',{bubbles:true}));}card.open=true;card.dispatchEvent(new Event('toggle'));return true; })()`);
  await waitFor(cdp, `typeof window.Quake3D!=='undefined'&&document.getElementById('canvas-3d').width>0`, 10000, 'imported 3-D initialization');
  await cdp.evaluate(`(() => { const source=buildSourceModel({});Quake3D.update({simElapsed:8,events:[{id:'browser-import',lat:source.lat,lng:source.lng,mag:source.mw,depth:source.depthKm,originTime:0,sourceType:source.sourceType,sourceModel:source}],epicenter:{lat:source.lat,lng:source.lng},strike:source.strikeDeg,dip:source.dipDeg,rupSpeed:2.8,stations:[]});return true; })()`);
  await sleep(400);
  const pixels3d = await cdp.evaluate(`(() => {const c=document.getElementById('canvas-3d'),gl=c.getContext('webgl2')||c.getContext('webgl');if(!gl)return 0;const p=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);let n=0;for(let i=0;i<p.length;i+=16)if(p[i]>8||p[i+1]>8||p[i+2]>18)n++;return n;})()`);
  assert(pixels3d > 100, `Imported finite-fault 3-D canvas is blank: ${pixels3d}`);

  await cdp.evaluate(`document.getElementById('strike').value=72;document.getElementById('strike').dispatchEvent(new Event('input',{bubbles:true}));true`);
  assert(await cdp.evaluate(`window._observedFiniteFault===null&&document.getElementById('finite-fault-clear').disabled===true`), 'Manual source edit did not deactivate imported finite fault');
  await click(cdp, '#tab-btn-basic');
}

async function desktopWorkflow(cdp) {
  await commonChecks(cdp);
  await tsunamiVisualizationChecks(cdp);
  await finiteFaultImportChecks(cdp);
  const motion = await cdp.evaluate(`({
    sidebar:getComputedStyle(document.getElementById('sidebar')).animationName,
    panel:getComputedStyle(document.querySelector('.tab-panel.active')).animationName,
    tabIndicator:getComputedStyle(document.querySelector('.tab-btn.active'),'::after').transform
  })`);
  assert(motion.sidebar.includes('ui-sidebar-enter'), `Sidebar entry motion is missing: ${motion.sidebar}`);
  assert(/ui-(panel|rise)-enter/.test(motion.panel), `Tab panel motion is missing: ${motion.panel}`);
  assert(motion.tabIndicator !== 'none', 'Active tab indicator motion is missing');
  const scrolling = await cdp.evaluate(`(() => { const el=document.getElementById('sidebar-content'); const before=el.scrollTop; el.scrollTop=el.scrollHeight; return {overflow:getComputedStyle(el).overflowY,before,after:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}; })()`);
  assert(['auto','scroll'].includes(scrolling.overflow), `Sidebar overflow is ${scrolling.overflow}`);
  assert(scrolling.scrollHeight > scrolling.clientHeight && scrolling.after > scrolling.before, 'Desktop sidebar cannot scroll');
  await cdp.evaluate(`document.getElementById('sidebar-content').scrollTop=0`);

  await setSelect(cdp, '#preset', 'tokachi2003');
  await waitFor(cdp, `!document.getElementById('btn-start').disabled && window.epicenter && window._liveMag>=6.5`, 5000, 'preset enables finite-fault simulation');
  const faultPreview = await cdp.evaluate(`(() => {
    const canvas=document.getElementById('ff-preview'),ctx=canvas.getContext('2d');
    FiniteFaultEditor.drawPreview();
    const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let colored=0,opaque=0,maxRgb=0;
    for(let i=0;i<data.length;i+=4){
      if(data[i+3]>0)opaque++;
      maxRgb=Math.max(maxRgb,data[i],data[i+1],data[i+2]);
      if(Math.abs(data[i]-10)+Math.abs(data[i+1]-14)+Math.abs(data[i+2]-26)>18)colored++;
    }
    const diag=document.getElementById('ff-diagnostics');
    return {visible:getComputedStyle(document.getElementById('ff-panel')).display!=='none',mag:window._liveMag,colored,opaque,maxRgb,width:canvas.width,height:canvas.height,
      diagnostics:diag.textContent,quality:diag.className};
  })()`);
  assert(faultPreview.visible && faultPreview.colored > 100, `Finite-fault preview is blank: ${JSON.stringify(faultPreview)}`);
  // Observed-model presets (tokachi2003 → Hayes 2014) defer to the imported
  // model's provenance line instead of the synthetic Wells/Strasser relation.
  assert(/Wells|Strasser|USGS|NEIC|Goldberg/.test(faultPreview.diagnostics) && /(patch|子断层|パッチ)/i.test(faultPreview.diagnostics), `Finite-fault diagnostics are incomplete: ${faultPreview.diagnostics}`);
  await setSelect(cdp, '#sound-mode', 'off');
  await cdp.evaluate(`document.getElementById('tts-enable').checked=false;document.getElementById('tsunami-enable').checked=false;document.getElementById('shindo-report-enable').checked=false`);
  await click(cdp, '.speed-btn[data-speed="10"]');
  await click(cdp, '#btn-start');
  await waitFor(cdp, `window.isRunning===true`, 8000, 'simulation start after countdown');
  await waitFor(cdp, `Array.isArray(window.landPoints) && window.landPoints.length>0`, 8000, 'finite-fault station predictions');
  await waitFor(cdp, `window.mainEvent&&mainEvent()&&mainEvent().sourceModel&&mainEvent().sourceModel.geometry&&window.rupturePolyEntries&&rupturePolyEntries.length>0`, 8000, 'canonical fault map rendering');
  await waitFor(cdp, `mainEvent().pRadius>0&&mainEvent().sRadius>0`, 8000, 'finite-fault P/S surface wavefronts');
  const faultMap = await cdp.evaluate(`(() => { const g=mainEvent().sourceModel.geometry; return {mapPatches:rupturePolyEntries.length,expected:g.nSub,L:g.L,W:g.W,moment:g.totalMoment,sourceMoment:mainEvent().sourceModel.momentNm}; })()`);
  assert(faultMap.mapPatches === faultMap.expected, `Map fault grid differs from canonical geometry: ${JSON.stringify(faultMap)}`);
  assert(Math.abs(faultMap.moment/faultMap.sourceMoment-1)<1e-10, `Rendered fault does not conserve source moment: ${JSON.stringify(faultMap)}`);
  await waitFor(cdp, `Array.isArray(window._replayData) && window._replayData.length>=4`, 8000, 'timeline capture');

  await click(cdp, '#btn-pause');
  await waitFor(cdp, `window.isPaused===true`, 3000, 'simulation pause');
  const mapOverlay = await cdp.evaluate(`(() => {
    const event=mainEvent(),center=toCanvas(event.lat,event.lng),ctx=waveCtx;
    drawFrame();
    function peakAt(radius,color){
      const x=Math.round(center.x),y=Math.round(center.y-radius),sample=ctx.getImageData(Math.max(0,x-5),Math.max(0,y-5),11,11).data;
      let alpha=0,dominance=-255;
      for(let i=0;i<sample.length;i+=4){alpha=Math.max(alpha,sample[i+3]);dominance=Math.max(dominance,color==='p'?sample[i+2]-sample[i]:sample[i]-sample[i+2]);}
      return {alpha,dominance};
    }
    const peaks={};retainGridPeak(peaks,1,'5+');retainGridPeak(peaks,1,3);const held=peaks[1];retainGridPeak(peaks,1,'6-');
    return {p:peakAt(kmToPx(event.pRadius,event),'p'),s:peakAt(kmToPx(event.sRadius,event),'s'),held,upgraded:peaks[1]};
  })()`);
  assert(mapOverlay.p.alpha >= 220 && mapOverlay.p.dominance > 20, `Finite-fault P front is too faint: ${JSON.stringify(mapOverlay.p)}`);
  assert(mapOverlay.s.alpha >= 220 && mapOverlay.s.dominance > 20, `Finite-fault S front is too faint: ${JSON.stringify(mapOverlay.s)}`);
  assert(mapOverlay.held === '5+' && mapOverlay.upgraded === '6-', `Intensity grid peak is not monotonic: ${JSON.stringify(mapOverlay)}`);
  const pausedAt = await cdp.evaluate('window.simElapsed');
  await sleep(300);
  assert(Math.abs((await cdp.evaluate('window.simElapsed')) - pausedAt) < 0.2, 'Simulation time advanced while paused');
  await click(cdp, '#btn-step');
  await waitFor(cdp, `window.simElapsed>=${pausedAt + 4.9}`, 3000, 'paused single-step');
  await click(cdp, '#btn-pause');
  await waitFor(cdp, `window.isPaused===false`, 3000, 'simulation resume');

  const perf = await cdp.evaluate(`new Promise(resolve => {
    let frames=0, start=performance.now();
    function tick(now) {
      frames++;
      if (now-start>=750) {
        const memory=performance.memory || {};
        resolve({fps:frames*1000/(now-start),heap:memory.usedJSHeapSize || 0});
      } else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })`);
  assert(perf.fps >= 15, `Simulation render rate is too low: ${perf.fps.toFixed(1)} fps`);
  // Transient heap before collection swings with GC timing (v5.6+ data
  // registries legitimately peak >256 MiB mid-run); the leak signal is the
  // retained floor after a forced GC — measured 136-140 MiB mid-run on the
  // tokachi2003 scenario, ~135 MiB after end (boot: 98 MiB).
  assert(!perf.heap || perf.heap < 512 * 1024 * 1024, `Transient JS heap is runaway: ${(perf.heap/1048576).toFixed(1)} MiB`);
  await cdp.send('HeapProfiler.enable').catch(() => {});
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  const retained = await cdp.evaluate(`(performance.memory||{}).usedJSHeapSize||0`);
  assert(!retained || retained < 192 * 1024 * 1024, `Retained JS heap exceeds leak baseline: ${(retained/1048576).toFixed(1)} MiB`);

  await click(cdp, '#tab-btn-info');
  await waitFor(cdp, `document.getElementById('info-summary-pga').textContent!=='—'`, 8000, 'live information metrics');
  await cdp.evaluate(`(() => { const canvas=document.getElementById('canvas-3d'),card=canvas.closest('details'),enable=document.getElementById('3d-enable'); if(enable&&!enable.checked){enable.checked=true;enable.dispatchEvent(new Event('change',{bubbles:true}));} card.open=true;card.dispatchEvent(new Event('toggle'));return true; })()`);
  await waitFor(cdp, `typeof window.Quake3D!=='undefined'&&document.getElementById('canvas-3d').width>0`, 10000, '3-D finite-fault initialization');
  await sleep(500);
  const fault3d = await cdp.evaluate(`(() => { const c=document.getElementById('canvas-3d'),gl=c.getContext('webgl2')||c.getContext('webgl'); if(!gl)return {context:false,pixels:0}; const p=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);let varied=0;for(let i=0;i<p.length;i+=16)if(p[i]>8||p[i+1]>8||p[i+2]>18)varied++;return {context:true,pixels:varied,width:c.width,height:c.height}; })()`);
  assert(fault3d.context && fault3d.pixels > 100, `3-D fault/terrain canvas is blank: ${JSON.stringify(fault3d)}`);
  const sim = await cdp.evaluate(`({running:window.isRunning,points:window.landPoints.length,gmpe:window.landPoints[0]&&window.landPoints[0].gmpeModel,distance:window.landPoints[0]&&window.landPoints[0].distanceMetric})`);
  // Class-based auto routing since v5.4: interplate megathrusts (tokachi2003)
  // route to zhao2006, crustal events to si-midorikawa.
  assert(sim.running && sim.points > 0 && ['si-midorikawa','zhao2006'].includes(sim.gmpe), `Unexpected simulation state ${JSON.stringify(sim)}`);
  const completedGrid = await cdp.evaluate(`(() => { activeGridCells[0]='5+';const before=Object.keys(activeGridCells).length;endSimulation();map.setZoom(map.getZoom()+1,{animate:false});drawFrame();return {before,after:Object.keys(activeGridCells).length}; })()`);
  assert(completedGrid.before > 0 && completedGrid.after === 0, `Completed shaking grid survived map zoom: ${JSON.stringify(completedGrid)}`);
  await waitFor(cdp, `window.isRunning===false && getComputedStyle(document.getElementById('btn-replay')).display!=='none'`, 3000, 'simulation completion and replay availability');
  await click(cdp, '#btn-replay');
  await waitFor(cdp, `window._replayMode===true && getComputedStyle(document.getElementById('replay-controls')).display!=='none'`, 3000, 'timeline replay mode');
  await click(cdp, '#btn-replay-exit');
  await waitFor(cdp, `window._replayMode===false`, 3000, 'timeline replay exit');
  await click(cdp, '#tab-btn-basic');
  await click(cdp, '#btn-reset');
  // Reset contract (2026-08-27 fix): a selected preset is re-applied — the
  // epicenter returns and Start stays usable instead of a dead disabled
  // button (the pre-fix state this test used to assert as normal).
  await waitFor(cdp, `window.isRunning===false && window._replayData.length===0 && window.landPoints.length===0 && window.epicenter && !document.getElementById('btn-start').disabled`, 5000, 'simulation reset and state cleanup');

  await setSelect(cdp, '#preset', 'tokachi2003');
  await waitFor(cdp, `window.epicenter && !document.getElementById('btn-start').disabled`, 5000, 'repeat scenario selection');
  await click(cdp, '#btn-start');
  await waitFor(cdp, `window.isRunning===true`, 12000, 'repeat simulation start');
  await waitFor(cdp, `window.landPoints.length>0`, 12000, 'repeat station predictions');
  await click(cdp, '#btn-reset');
  await waitFor(cdp, `window.isRunning===false && window.landPoints.length===0`, 5000, 'repeat simulation cleanup');
  return perf;
}

async function mobileWorkflow(cdp) {
  await commonChecks(cdp);
  const layout = await cdp.evaluate(`(() => { const s=document.getElementById('sidebar'),c=document.getElementById('sidebar-content'),nav=document.getElementById('tab-nav'); const before=c.scrollTop;c.scrollTop=c.scrollHeight; const durationMs=value=>value.split(',').reduce((max,item)=>{item=item.trim();return Math.max(max,parseFloat(item)*(item.endsWith('ms')?1:1000));},0); return {
    viewport:innerWidth,docWidth:document.documentElement.scrollWidth,sidebarWidth:s.getBoundingClientRect().width,
    navVisible:getComputedStyle(nav).display!=='none',tabHeights:[...nav.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height),
    overflow:getComputedStyle(c).overflowY,scrollable:c.scrollHeight>c.clientHeight,scrollMoved:c.scrollTop>before,
    dockVisible:getComputedStyle(document.querySelector('.basic-action-dock')).display!=='none',
    reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationMs:durationMs(getComputedStyle(s).animationDuration),transitionMs:durationMs(getComputedStyle(document.querySelector('.tab-btn')).transitionDuration)
  }; })()`);
  assert(layout.docWidth <= layout.viewport + 1, `Mobile page has horizontal overflow ${layout.docWidth}/${layout.viewport}`);
  assert(layout.sidebarWidth <= layout.viewport + 1 && layout.navVisible, 'Mobile sidebar/tab navigation is outside the viewport');
  assert(layout.tabHeights.every(height => height >= 40), `Mobile tab touch targets are too small: ${layout.tabHeights.join(',')}`);
  assert(['auto','scroll'].includes(layout.overflow) && layout.scrollable && layout.scrollMoved, 'Mobile sidebar is not scrollable');
  assert(layout.dockVisible, 'Mobile simulation action dock is hidden');
  assert(layout.reducedMotion && layout.animationMs <= 0.02 && layout.transitionMs <= 0.02, `Reduced-motion override failed: ${JSON.stringify(layout)}`);
}

async function runChromium(spec) {
  if (!fs.existsSync(spec.exe)) return {name:spec.name,status:'SKIP',reason:'browser executable missing'};
  await fs.promises.mkdir(PROFILE_ROOT, {recursive:true});
  const profile = path.join(PROFILE_ROOT, `${spec.name.toLowerCase()}-${process.pid}`);
  const child = spawn(spec.exe, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    `--remote-debugging-port=${spec.port}`,`--user-data-dir=${profile}`,'about:blank'], {windowsHide:true,stdio:'ignore'});
  let cdp;
  const started = Date.now();
  try {
    const version = await waitForEndpoint(spec.port);
    // Connect on a quiet target; preparePage performs the real navigation after
    // Page/Runtime/Network domains are enabled, avoiding startup races on large data sets.
    const target = await createTarget(spec.port, 'about:blank');
    cdp = new CDP(target.webSocketDebuggerUrl); await cdp.connect();
    const errors = installDiagnostics(cdp);
    await preparePage(cdp, {width:1365,height:768,deviceScaleFactor:1,mobile:false});
    const perf = await desktopWorkflow(cdp);
    await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await preparePage(cdp, {width:390,height:844,deviceScaleFactor:2,mobile:true,screenWidth:390,screenHeight:844});
    await mobileWorkflow(cdp);
    await sleep(500);
    assert(errors.length === 0, `Browser errors:\n${errors.join('\n')}`);
    return {name:spec.name,status:'PASS',browser:version.Browser,durationMs:Date.now()-started,perf};
  } finally {
    if (cdp) cdp.close();
    child.kill();
    await sleep(300);
    try { await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200}); } catch (_) {}
  }
}

async function runFirefoxSmoke() {
  if (!fs.existsSync(firefox.exe)) return {name:firefox.name,status:'SKIP',reason:'browser executable missing'};
  await fs.promises.mkdir(PROFILE_ROOT, {recursive:true});
  const profile = path.join(PROFILE_ROOT, `firefox-${process.pid}`);
  const screenshot = path.join(PROFILE_ROOT, `firefox-${process.pid}.png`);
  const child = spawn(firefox.exe, ['--headless','--profile',profile,'--window-size','1365,768','--screenshot',screenshot,BASE_URL],
    {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer=setTimeout(()=>{child.kill();reject(new Error('Firefox render smoke timed out'));},30000);
    child.once('exit',code=>{clearTimeout(timer);resolve(code);});child.once('error',reject);
  });
  const exists = fs.existsSync(screenshot) && fs.statSync(screenshot).size > 10000;
  try { await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200}); } catch (_) {}
  try { await fs.promises.rm(screenshot,{force:true}); } catch (_) {}
  assert(exitCode === 0 && exists, `Firefox render smoke failed (${exitCode}): ${stderr.slice(-1000)}`);
  return {name:firefox.name,status:'PASS',scope:'headless render smoke',durationMs:null};
}

(async () => {
  const server = await fetch(BASE_URL);
  assert(server.ok, `Application server unavailable: HTTP ${server.status}`);
  const results = [];
  for (const browser of chromiumBrowsers) results.push(await runChromium(browser));
  results.push(await runFirefoxSmoke());
  for (const result of results) {
    const perf = result.perf ? `, ${result.perf.fps.toFixed(1)} fps${result.perf.heap ? `, ${(result.perf.heap/1048576).toFixed(1)} MiB heap` : ''}` : '';
    console.log(`${result.status.padEnd(4)} ${result.name}: ${result.browser || result.scope || result.reason}${result.durationMs ? ` (${result.durationMs} ms${perf})` : ''}`);
  }
  if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
