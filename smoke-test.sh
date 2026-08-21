#!/bin/bash
# ================================================================
#  Earthquake Simulator Pro v4.1 — Smoke Test
#  Usage: bash smoke-test.sh [base_url]
#  Default: http://localhost:3000
#  Checks: server health, all API endpoints, static files, physics
# ================================================================
BASE="${1:-http://localhost:3000}"
PASS=0; FAIL=0
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'

pass() { echo -e "${GRN}PASS${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}FAIL${NC} $1 — $2"; FAIL=$((FAIL+1)); }

echo "========================================"
echo " Earthquake Simulator Pro v4.1 Smoke Test"
echo " Target: $BASE"
echo " $(date)"
echo "========================================"

# ---- 1. Server Health ----
echo ""
echo "--- Health ---"
if curl -sf "$BASE/health" > /dev/null 2>&1; then
  HEALTH=$(curl -sf "$BASE/health")
  if echo "$HEALTH" | grep -q '"status":"ok"'; then pass "GET /health"; else fail "GET /health" "status not ok: $HEALTH"; fi
  UPTIME=$(echo "$HEALTH" | grep -o '"uptime":[0-9]*' | cut -d: -f2)
  echo "       Uptime: ${UPTIME}s"
else
  fail "GET /health" "server unreachable — is node server.js running?"
  exit 1
fi

# ---- 2. Static Files ----
echo ""
echo "--- Static Files ---"
check_static() { local path="$1" desc="$2"
  if curl -sfI "$BASE$path" | grep -q "200 OK\|304"; then pass "$desc ($path)"
  else fail "$desc ($path)" "not reachable"; fi
}
check_static "/" "Index page"
check_static "/index.html" "HTML"
check_static "/app.js" "app.js"
check_static "/physics.js" "physics.js"
check_static "/i18n.js" "i18n.js"
check_static "/config.js" "config.js"
check_static "/audio.js" "audio.js"
check_static "/quake3d.js" "quake3d.js"
check_static "/style.css" "CSS"
check_static "/sw.js" "Service Worker"
check_static "/manifest.json" "Manifest"
check_static "/leaflet/leaflet.js" "Leaflet"
check_static "/turf/turf.min.js" "Turf.js"
check_static "/three.min.js" "Three.js"

# ---- 3. GeoJSON Data ----
echo ""
echo "--- GeoJSON ---"
check_geojson() { local path="$1" desc="$2"
  local body=$(curl -sf --compressed "$BASE$path" 2>/dev/null)
  if [ -n "$body" ] && (echo "$body" | grep -q '"type"\|"features"\|"name"\|"obs"\|"stations"\|"origin"\|"data"\|"nx"\|"ny"' || echo "$body" | grep -q '^\['); then pass "$desc ($path)"
  else fail "$desc ($path)" "invalid or empty JSON"; fi
}
check_geojson "/geojson/stations.json" "Stations"
check_geojson "/geojson/observed.json" "Presets"
check_geojson "/geojson/coastline_50m.json" "Coastline"
check_geojson "/geojson/bathymetry.json" "Bathymetry"
check_geojson "/geojson/japan_prefectures.geojson" "Prefectures"
check_geojson "/geojson/seafloor_stations.json" "Seafloor stations"
check_geojson "/geojson/plates.json" "Plates"
check_geojson "/geojson/historical_quakes.json" "Historical quakes"

# ---- 4. API Endpoints ----
echo ""
echo "--- API ---"
check_api() { local path="$1" desc="$2"
  local body=$(curl -sf "$BASE$path")
  if echo "$body" | grep -q '"ok":true\|"ok": true\|"data"\|"features"\|"presets"\|"count"'; then pass "$desc ($path)"
  else fail "$desc ($path)" "unexpected response"; fi
}
check_api_json() { local path="$1" desc="$2"
  if curl -sfI "$BASE$path" | grep -q 'application/json'; then pass "$desc ($path)"
  else fail "$desc ($path)" "not JSON response"; fi
}
check_api "/api/earthquakes" "Earthquakes (merged)"
check_api_json "/api/live-quakes" "Live quakes proxy"

# ---- 5. Compression ----
echo ""
echo "--- Compression ---"
GZIP=$(curl -sf -H "Accept-Encoding: gzip" -o /dev/null -D - "$BASE/api/earthquakes" 2>/dev/null || true)
if echo "$GZIP" | grep -qi 'content-encoding:.*gzip'; then pass "API gzip compression"
else fail "API gzip compression" "not detected"; fi

IMMUTABLE=$(curl -sfI "$BASE/app.js" 2>/dev/null || true)
if echo "$IMMUTABLE" | grep -qi 'immutable'; then pass "Cache-Control immutable"
else fail "Cache-Control immutable" "not detected"; fi

# ---- 6. Audio Files ----
echo ""
echo "--- Audio ---"
for f in EEW1 EEW2 Shindo0 Shindo1 Shindo4 Shindo7 Tsunami_1 Tsunami_2 Tsunami_3; do
  if [ -f "sounds/jp/${f}.wav" ]; then pass "sounds/jp/${f}.wav"
  else fail "sounds/jp/${f}.wav" "missing"; fi
done

# ---- 7. Node Tests ----
echo ""
echo "--- Unit Tests ---"
if [ -f "package.json" ] && grep -q '"test"' package.json; then
  if npm test > /dev/null 2>&1; then pass "npm test"
  else fail "npm test" "tests failed"; fi
else
  echo -e "${YLW}SKIP${NC} npm test — no package.json"
fi

# ---- 8. Custom Check: Server Info ----
echo ""
echo "--- System ---"
NODE_VER=$(node -v 2>/dev/null || echo "N/A")
echo "       Node: $NODE_VER"
echo "       Server: $(curl -sf "$BASE/health" | grep -o '"p2p":"[^"]*"' | head -1)"

# ---- Summary ----
echo ""
echo "========================================"
echo -e " Results: ${GRN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "========================================"
[ $FAIL -eq 0 ] && exit 0 || exit 1
