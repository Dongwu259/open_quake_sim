# QuakeSim Finite-Fault v1 Data Contract

`quake-sim-finite-fault-v1` is the browser simulator's lossless interchange format for observed or externally inverted finite-fault models. Import is local to the browser; the file is not uploaded.

## Supported Inputs

- Native `quake-sim-finite-fault-v1` JSON
- GeoJSON `FeatureCollection` containing `Polygon`, `MultiPolygon`, or dimensioned `Point` patches
- SRCMOD/FSP text containing a `LAT LON ... SLIP` subfault table

FSP slip is converted from centimetres when declared in the column or units row. Subfault moments declared in dyne-cm are converted with `1 dyne-cm = 1e-7 Nm`. Undeclared depth, slip, time, or moment units are never guessed beyond the documented format defaults (`km`, `m`, `s`, `Nm`).

## Native JSON

```json
{
  "schema": "quake-sim-finite-fault-v1",
  "id": "event-model-id",
  "event": {
    "id": "event-id",
    "lat": 38.1,
    "lng": 142.8,
    "depthKm": 24.0,
    "momentNm": 4.5e22,
    "sourceType": "interplate"
  },
  "units": {"depth": "km", "slip": "m", "time": "s", "moment": "Nm"},
  "provenance": {
    "source": "provider and model name",
    "eventId": "provider-event-id",
    "url": "https://example.org/model",
    "license": "CC-BY-4.0",
    "retrievedAt": "2026-08-02T00:00:00Z"
  },
  "patches": [
    {
      "id": "p-001",
      "corners": [
        {"lat": 38.20, "lng": 142.70, "depthKm": 12.0},
        {"lat": 38.10, "lng": 142.90, "depthKm": 12.0},
        {"lat": 38.00, "lng": 142.85, "depthKm": 24.0},
        {"lat": 38.10, "lng": 142.65, "depthKm": 24.0}
      ],
      "strikeDeg": 193.0,
      "dipDeg": 12.0,
      "rakeDeg": 88.0,
      "slipM": 4.2,
      "rigidityGPa": 40.0,
      "ruptureTimeS": 1.8,
      "riseTimeS": 3.0
    }
  ]
}
```

Each patch must provide either four WGS84/depth corners or a center plus positive `lengthKm` and `widthKm`. It must also provide positive slip or scalar moment. When only slip is present, `M0i = mu * Ai * Di`; when only moment is present, slip is derived from the same equation. Negative rupture time, non-positive rise time, invalid coordinates, zero area, and more than 20,000 patches are rejected.

## Normalization and Quality

The normalized model preserves each patch's independent strike, dip, rake, slip, rigidity, moment, rupture onset, and rise time. Total scalar moment is the exact patch sum and Mw is derived from:

```text
Mw = (log10(M0 [Nm]) - 9.1) / 1.5
```

The import is marked research-ready only when source, HTTPS-capable reference URL metadata, license, event-to-patch moment agreement (within 5%), and patch `M0` versus `mu*A*D` agreement (within 5%) are present. A degraded model remains usable, but the UI reports every missing or inconsistent field.

## Runtime Semantics

- Imported patch geometry is authoritative and is not rebuilt with empirical length/width scaling.
- Ground motion uses the minimum station-to-patch quadrilateral rupture distance (`Rrup`).
- Map and 3-D views use the same exact patch corners, slip weights, rupture times, and rise times.
- The canonical source is shared with tsunami deformation, rupture animation, and aftershock placement.
- Imported models apply only to the single main event. Multi-event segments do not inherit one observed model.
- Editing epicenter, magnitude, depth, strike, dip, rake, or synthetic fault-editor controls deactivates the imported model visibly.

## Current Limits

This contract preserves externally computed finite-fault results; it does not itself invert waveforms. The current tsunami deformation kernel is still a compact Okada approximation rather than validated DC3D, and the strong-motion path still applies empirical GMPEs rather than a full broadband wave-propagation solver. Large patch sets execute on the CPU main thread pending the planned Worker/WASM reference backend.
