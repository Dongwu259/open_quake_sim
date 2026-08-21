#!/usr/bin/env python3
"""Convert FDSN StationXML into an auditable QuakeSim station catalog.

Usage:
  python tools/import_stationxml.py inventory.xml output.json --source-url https://...

The output contains station/channel metadata only. It never invents Vs30 or
waveforms; missing response metadata is reported explicitly in the catalog.
ObsPy is required because StationXML is an XML standard with response stages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from obspy import read_inventory


def iso(value):
    if value is None:
        return None
    try:
        return value.datetime.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return str(value)


def source_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def convert(path: Path, source_url: str | None = None) -> dict:
    inventory = read_inventory(str(path))
    stations = {}
    channel_count = 0
    response_count = 0
    for network in inventory:
        for station in network:
            key = f"{network.code}.{station.code}"
            item = stations.setdefault(key, {
                "id": key,
                "network": network.code,
                "station": station.code,
                "name": station.site.name or station.code,
                "lat": float(station.latitude),
                "lng": float(station.longitude),
                "elevation_m": float(station.elevation or 0),
                "source": "StationXML",
                "channels": [],
                "validFrom": iso(station.start_date),
                "validTo": iso(station.end_date),
            })
            for channel in station.channels:
                channel_count += 1
                response = channel.response
                has_response = bool(response and response.response_stages)
                if has_response:
                    response_count += 1
                item["channels"].append({
                    "code": channel.code,
                    "location": channel.location_code or "",
                    "sampleRateHz": float(channel.sample_rate) if channel.sample_rate else None,
                    "azimuthDeg": float(channel.azimuth) if channel.azimuth is not None else None,
                    "dipDeg": float(channel.dip) if channel.dip is not None else None,
                    "sensor": getattr(getattr(channel, "sensor", None), "description", None),
                    "hasResponse": has_response,
                    "validFrom": iso(channel.start_date),
                    "validTo": iso(channel.end_date),
                })
    result = {
        "_schema": "quake-sim-station-catalog-v1",
        "_source": str(path.name),
        "_sourceUrl": source_url or None,
        "_sourceSha256": source_hash(path),
        "_license": "Preserve the data provider's StationXML license and attribution.",
        "_importedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "_units": {"lat": "degree", "lng": "degree", "elevation_m": "m", "sampleRateHz": "Hz"},
        "_stats": {"stations": len(stations), "channels": channel_count, "channelsWithResponse": response_count},
        "stations": sorted(stations.values(), key=lambda value: value["id"]),
    }
    return result


def main():
    parser = argparse.ArgumentParser(description="Import FDSN StationXML into QuakeSim JSON")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-url", default=None)
    args = parser.parse_args()
    if not args.input.is_file():
        parser.error(f"StationXML file not found: {args.input}")
    result = convert(args.input, args.source_url)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}: {result['_stats']['stations']} stations, {result['_stats']['channels']} channels")


if __name__ == "__main__":
    main()
