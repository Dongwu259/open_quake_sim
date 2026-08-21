#!/usr/bin/env python3
"""Fetch an auditable FDSN waveform package for browser display or 3-C analysis.

The previous implementation labelled raw MiniSEED counts as physical motion.
This version always requests StationXML response metadata and removes the
instrument response before emitting acceleration in gal.  It also keeps the
legacy ``data[]`` traces used by older quake-sim clients.

Usage:
  python tools/fetch_waveform.py --network IU --station MAJO --channel BHZ
  python tools/fetch_waveform.py --network IU --station MAJO --channel BHZ \
      --three-component --purpose analysis --duration-seconds 600
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone

from obspy import UTCDateTime
from obspy.clients.fdsn import Client


SERVERS = ("IRIS", "GFZ")
SCHEMA = "quake-sim-waveform-v1"
DISPLAY_MAX_POINTS = 5000
ANALYSIS_MAX_POINTS = 60000


def iso_utc(value) -> str:
    return str(value).replace("+00:00", "Z")


def component_name(channel: str) -> str | None:
    suffix = channel[-1:].upper()
    return {"Z": "z", "N": "n", "E": "e"}.get(suffix)


def finite_samples(values) -> list[float]:
    result = []
    for value in values:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("non-finite sample after response removal")
        result.append(number)
    return result


def processed_hash(samples: list[float]) -> str:
    # Canonical decimal encoding is portable across Python/JavaScript and
    # hashes the delivered values rather than an implementation-specific ndarray.
    payload = ",".join(format(value, ".12g") for value in samples).encode("ascii")
    return hashlib.sha256(payload).hexdigest()


def request_stream(network, station, location, channel, starttime, endtime):
    errors = []
    for server in SERVERS:
        try:
            client = Client(server)
            inventory = client.get_stations(
                network=network, station=station, location=location,
                channel=channel, starttime=starttime, endtime=endtime,
                level="response",
            )
            stream = client.get_waveforms(
                network=network, station=station, location=location,
                channel=channel, starttime=starttime, endtime=endtime,
                attach_response=False,
            )
            if len(stream):
                return server, client, inventory, stream
            errors.append(f"{server}: empty stream")
        except Exception as exc:  # provider diagnostics belong on stderr
            errors.append(f"{server}: {exc}")
    raise RuntimeError("; ".join(errors) or "no FDSN provider returned data")


def prepare_stream(stream, inventory, purpose, max_points):
    gap_rows = stream.get_gaps()
    stream = stream.copy()
    stream.detrend("demean")
    stream.detrend("linear")

    # ACC produces m/s^2.  The pre-filter suppresses unstable response tails;
    # water_level avoids silently clipping valid in-band amplitudes.
    prefilters = {}
    for trace in stream:
        nyquist = float(trace.stats.sampling_rate) * 0.5
        high_stop = min(25.0, nyquist * 0.90)
        high_pass = min(20.0, high_stop * 0.80)
        if high_pass <= 0.05:
            raise RuntimeError(f"sample rate too low for stable response removal: {trace.id}")
        pre_filter = (0.02, 0.05, high_pass, high_stop)
        trace.remove_response(
            inventory=inventory, output="ACC", water_level=None,
            pre_filt=pre_filter, zero_mean=False, taper=True,
        )
        prefilters[trace.id] = [round(value, 6) for value in pre_filter]

    processing = [
        "demean", "linear-detrend",
        "remove-response:ACC", "adaptive-prefilter-by-Nyquist",
    ]
    if gap_rows:
        stream.merge(method=1, fill_value="interpolate")
        processing.append("gap-interpolation")

    # Metadata-aware rotation turns 1/2 or non-cardinal horizontal channels
    # into north/east where the StationXML orientation is sufficient.
    try:
        stream.rotate(method="->ZNE", inventory=inventory)
        processing.append("rotate-to-ZNE")
    except Exception:
        processing.append("rotation-unavailable")

    # Never combine channels from separate sensor locations.  Prefer the
    # location with the most complete Z/N/E set, then the longest coverage.
    locations = {}
    for trace in sorted(stream, key=lambda tr: tr.stats.npts, reverse=True):
        name = component_name(trace.stats.channel)
        location = str(trace.stats.location)
        group = locations.setdefault(location, {})
        if name and name not in group:
            group[name] = trace.copy()
    chosen = max(locations.values(), key=lambda group: (len(group), sum(tr.stats.npts for tr in group.values())), default={})
    if not chosen:
        raise RuntimeError("no supported Z/N/E or Z/1/2 channels in response")

    common_start = max(trace.stats.starttime for trace in chosen.values())
    common_end = min(trace.stats.endtime for trace in chosen.values())
    if common_end <= common_start:
        raise RuntimeError("component time windows do not overlap")
    target_rate = min(float(trace.stats.sampling_rate) for trace in chosen.values())
    npts = int(math.floor((common_end - common_start) * target_rate)) + 1
    if npts < 2:
        raise RuntimeError("waveform window is too short")

    resampled = False
    for trace in chosen.values():
        if abs(float(trace.stats.sampling_rate) - target_rate) > 1e-7 or trace.stats.starttime != common_start:
            trace.interpolate(target_rate, starttime=common_start, npts=npts)
            resampled = True
        else:
            trace.trim(common_start, common_end, nearest_sample=False)
    if resampled:
        processing.append(f"aligned-resample:{target_rate:g}Hz")

    delivered_rate = target_rate
    decimated = False
    if npts > max_points:
        delivered_rate = target_rate * max_points / npts
        for trace in chosen.values():
            trace.resample(delivered_rate, strict_length=False)
        processing.append(f"anti-alias-display-resample:{delivered_rate:.8g}Hz")
        decimated = True

    components = {}
    legacy = []
    for name in ("z", "n", "e"):
        trace = chosen.get(name)
        if trace is None:
            continue
        values = [value * 100.0 for value in finite_samples(trace.data)]  # m/s2 -> gal
        channel = str(trace.stats.channel)
        components[name] = {
            "channel": channel,
            "samples": values,
            "sha256": processed_hash(values),
        }
        legacy.append({
            "id": f"{trace.stats.network}.{trace.stats.station}.{trace.stats.location}.{channel}",
            "network": str(trace.stats.network), "station": str(trace.stats.station),
            "location": str(trace.stats.location), "channel": channel,
            "starttime": iso_utc(trace.stats.starttime),
            "sampling_rate": float(trace.stats.sampling_rate),
            "npts": len(values), "max_amplitude": max(map(abs, values), default=0.0),
            "unit": "gal", "samples": values,
        })

    reasons = []
    if set(components) != {"z", "n", "e"}:
        reasons.append("three-components-required")
    if gap_rows:
        reasons.append("source-gaps-interpolated")
    if decimated:
        reasons.append("delivery-resampled")
    if purpose != "analysis":
        reasons.append("display-purpose")
    return {
        "components": components, "legacy": legacy,
        "sample_rate": float(next(iter(chosen.values())).stats.sampling_rate),
        "start_time": iso_utc(next(iter(chosen.values())).stats.starttime),
        "processing": processing,
        "prefilters": prefilters,
        "quality": {
            "researchReady": not reasons,
            "reasons": reasons,
            "sourceGapCount": len(gap_rows),
            "responseRemoved": True,
            "threeComponents": set(components) == {"z", "n", "e"},
            "deliveryResampled": decimated,
        },
    }


def station_metadata(inventory, network, station):
    try:
        selected = inventory.select(network=network, station=station)
        item = selected[0][0]
        return {
            "id": f"{selected[0].code}.{item.code}",
            "network": selected[0].code, "station": item.code,
            "name": item.site.name or item.code,
            "lat": float(item.latitude), "lng": float(item.longitude),
            "elevationM": float(item.elevation),
        }
    except Exception:
        return {"id": f"{network}.{station}", "network": network, "station": station}


def build_package(args):
    endtime = UTCDateTime(args.endtime) if args.endtime else UTCDateTime.now()
    duration = args.duration_seconds or args.hours * 3600
    starttime = endtime - duration
    requested_channel = args.channel[:2] + "?" if args.three_component else args.channel
    provider, _client, inventory, stream = request_stream(
        args.network, args.station, args.location, requested_channel, starttime, endtime,
    )
    max_points = ANALYSIS_MAX_POINTS if args.purpose == "analysis" else DISPLAY_MAX_POINTS
    prepared = prepare_stream(stream, inventory, args.purpose, max_points)
    retrieved = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    source_url = "https://service.iris.edu/fdsnws/" if provider == "IRIS" else "https://geofon.gfz-potsdam.de/fdsnws/"
    return {
        "_schema": SCHEMA, "type": "waveform",
        "station": station_metadata(inventory, args.network, args.station),
        "startTime": prepared["start_time"],
        "sampleRateHz": prepared["sample_rate"], "units": "gal",
        "components": prepared["components"], "quality": prepared["quality"],
        "processing": prepared["processing"], "responsePrefiltersHz": prepared["prefilters"],
        "provenance": {
            "provider": provider, "sourceUrl": source_url,
            "retrievedAt": retrieved,
            "request": {
                "network": args.network, "station": args.station,
                "location": args.location, "channel": requested_channel,
                "startTime": iso_utc(starttime), "endTime": iso_utc(endtime),
                "purpose": args.purpose,
            },
            "license": "Use is subject to the selected FDSN data center and network terms.",
        },
        "data": prepared["legacy"],
    }


def parse_args():
    parser = argparse.ArgumentParser(description="Fetch response-corrected FDSN acceleration")
    parser.add_argument("--station", default="MAJO")
    parser.add_argument("--network", default="IU")
    parser.add_argument("--location", default="*")
    parser.add_argument("--channel", default="BHZ")
    parser.add_argument("--hours", type=int, default=1)
    parser.add_argument("--duration-seconds", type=int, default=None)
    parser.add_argument("--endtime", default=None)
    parser.add_argument("--purpose", choices=("display", "analysis"), default="display")
    parser.add_argument("--three-component", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        print(json.dumps(build_package(args), ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        print(f"Waveform fetch failed: {exc}", file=sys.stderr)
        print(json.dumps({"error": str(exc), "_schema": SCHEMA}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
