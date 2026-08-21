#!/usr/bin/env python3
"""
Generate TTS audio fragments for Earthquake Simulator Pro bulletin system.
Uses edge-tts (Microsoft Edge TTS) + ffmpeg to produce 16kHz mono PCM WAV.

Usage:
  python tools/generate_tts.py --lang jp          # Japanese only
  python tools/generate_tts.py --lang en          # English only
  python tools/generate_tts.py --lang zh          # Chinese only
  python tools/generate_tts.py --lang all         # All 3 languages
  python tools/generate_tts.py --lang jp --dry-run  # Preview without generating
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile

# --- Config ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
SOUNDS_DIR = os.path.join(PROJECT_ROOT, "sounds")
GEOJSON_PATH = os.path.join(PROJECT_ROOT, "public", "geojson", "japan_prefectures.geojson")

# Voice settings per language
VOICES = {
    "jp": "ja-JP-NanamiNeural",
    "en": "en-US-JennyNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
}

# --- Prefecture name translations ---
# English names for en/zh TTS (romaji for en, Chinese names for zh)
PREF_NAMES_EN = [
    "Hokkaido", "Aomori Prefecture", "Iwate Prefecture", "Miyagi Prefecture",
    "Akita Prefecture", "Yamagata Prefecture", "Fukushima Prefecture", "Ibaraki Prefecture",
    "Tochigi Prefecture", "Gunma Prefecture", "Saitama Prefecture", "Chiba Prefecture",
    "Tokyo Metropolis", "Kanagawa Prefecture", "Niigata Prefecture", "Toyama Prefecture",
    "Ishikawa Prefecture", "Fukui Prefecture", "Yamanashi Prefecture", "Nagano Prefecture",
    "Gifu Prefecture", "Shizuoka Prefecture", "Aichi Prefecture", "Mie Prefecture",
    "Shiga Prefecture", "Kyoto Prefecture", "Osaka Prefecture", "Hyogo Prefecture",
    "Nara Prefecture", "Wakayama Prefecture", "Tottori Prefecture", "Shimane Prefecture",
    "Okayama Prefecture", "Hiroshima Prefecture", "Yamaguchi Prefecture", "Tokushima Prefecture",
    "Kagawa Prefecture", "Ehime Prefecture", "Kochi Prefecture", "Fukuoka Prefecture",
    "Saga Prefecture", "Nagasaki Prefecture", "Kumamoto Prefecture", "Oita Prefecture",
    "Miyazaki Prefecture", "Kagoshima Prefecture", "Okinawa Prefecture",
]

PREF_NAMES_ZH = [
    "北海道", "青森县", "岩手县", "宫城县",
    "秋田县", "山形县", "福岛县", "茨城县",
    "栃木县", "群马县", "埼玉县", "千叶县",
    "东京都", "神奈川县", "新潟县", "富山县",
    "石川县", "福井县", "山梨县", "长野县",
    "岐阜县", "静冈县", "爱知县", "三重县",
    "滋贺县", "京都府", "大阪府", "兵库县",
    "奈良县", "和歌山县", "鸟取县", "岛根县",
    "冈山县", "广岛县", "山口县", "德岛县",
    "香川县", "爱媛县", "高知县", "福冈县",
    "佐贺县", "长崎县", "熊本县", "大分县",
    "宫崎县", "鹿儿岛县", "冲绳县",
]

# --- Phrase definitions per language ---
# Format: { filename_base: { lang: text } }
FIXED_PHRASES = {
    "ph_hour":    {"jp": "時",       "en": "",           "zh": "时"},
    "ph_min":     {"jp": "分",       "en": "",           "zh": "分"},
    "ph_intro1":  {"jp": "発生した震度", "en": "An earthquake of intensity ", "zh": "发生了震度"},
    "ph_intro2":  {"jp": "の地震",   "en": " has occurred", "zh": "的地震"},
    "ph_mag":     {"jp": "マグニチュード", "en": "Magnitude ", "zh": "震级"},
    "ph_depth":   {"jp": "深さ",     "en": "Depth ",     "zh": "深度"},
    "ph_km":      {"jp": "キロメートル", "en": " kilometers", "zh": "公里"},
    "ph_decimal": {"jp": "点",       "en": " point ",    "zh": "点"},
}

TSUNAMI_PHRASES = {
    "ph_tsu_major":    {"jp": "大津波警報が発表されました", "en": "Major tsunami warning issued. ", "zh": "发布大海啸警报"},
    "ph_tsu_warning":  {"jp": "津波警報が発表されました",   "en": "Tsunami warning issued. ",       "zh": "发布海啸警报"},
    "ph_tsu_advisory": {"jp": "津波注意報が発表されました", "en": "Tsunami advisory issued. ",       "zh": "发布海啸注意报"},
}

AFFECTED_PHRASE = {
    "ph_affected": {"jp": "被害が予想される地域", "en": "Affected areas: ", "zh": "受灾地区"},
}

# Intensity short phrases for concatenation like "震度6強"
INTENSITY_SHORTS = {
    "int_1":  {"jp": "震度1", "en": "Intensity 1",   "zh": "震度1"},
    "int_2":  {"jp": "震度2", "en": "Intensity 2",   "zh": "震度2"},
    "int_3":  {"jp": "震度3", "en": "Intensity 3",   "zh": "震度3"},
    "int_4":  {"jp": "震度4", "en": "Intensity 4",   "zh": "震度4"},
    "int_5m": {"jp": "震度5弱", "en": "Intensity 5 minus", "zh": "震度5弱"},
    "int_5p": {"jp": "震度5強", "en": "Intensity 5 plus",  "zh": "震度5强"},
    "int_6m": {"jp": "震度6弱", "en": "Intensity 6 minus", "zh": "震度6弱"},
    "int_6p": {"jp": "震度6強", "en": "Intensity 6 plus",  "zh": "震度6强"},
    "int_7":  {"jp": "震度7", "en": "Intensity 7",   "zh": "震度7"},
    "int_0":  {"jp": "震度0", "en": "No intensity",  "zh": "震度0"},
}


def load_pref_names_jp():
    """Load Japanese prefecture names from GeoJSON."""
    with open(GEOJSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    names = []
    for feat in data["features"]:
        pid = feat["properties"]["id"]
        name_ja = feat["properties"]["nam_ja"]
        names.append((pid, name_ja))
    names.sort(key=lambda x: x[0])
    return [n[1] for n in names]


def get_pref_names(lang):
    """Get prefecture name list for the given language."""
    if lang == "jp":
        return load_pref_names_jp()
    elif lang == "en":
        return PREF_NAMES_EN
    elif lang == "zh":
        return PREF_NAMES_ZH
    else:
        raise ValueError(f"Unknown language: {lang}")


async def generate_tts(text, output_wav, voice, rate="+0%"):
    """Generate a WAV file using edge-tts + ffmpeg."""
    # edge-tts outputs MP3; we convert to 16kHz mono PCM WAV via ffmpeg
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_mp3 = tmp.name

    try:
        # Generate MP3 with edge-tts
        cmd = [
            sys.executable, "-m", "edge_tts",
            "--voice", voice,
            "--text", text,
            "--rate", rate,
            "--write-media", tmp_mp3,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace")[:200]
            raise RuntimeError(f"edge-tts failed (exit {proc.returncode}): {err_msg}")

        # Convert to 16kHz mono PCM WAV
        os.makedirs(os.path.dirname(output_wav), exist_ok=True)
        ffmpeg_cmd = [
            "ffmpeg", "-y", "-i", tmp_mp3,
            "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            output_wav,
        ]
        proc2 = await asyncio.create_subprocess_exec(
            *ffmpeg_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr2 = await proc2.communicate()
        if proc2.returncode != 0:
            err_msg = stderr2.decode("utf-8", errors="replace")[:200]
            raise RuntimeError(f"ffmpeg failed (exit {proc2.returncode}): {err_msg}")

        # Verify output
        size = os.path.getsize(output_wav)
        if size < 100:
            raise RuntimeError(f"Output file too small ({size} bytes)")

        return size

    finally:
        if os.path.exists(tmp_mp3):
            os.unlink(tmp_mp3)


async def generate_numbers(lang, voice, out_dir, dry_run=False):
    """Generate number audio files 0-99."""
    print(f"  [{lang}] Generating numbers 0-99...")
    for i in range(100):
        fname = f"num_{i:02d}.wav"
        out_path = os.path.join(out_dir, fname)
        if os.path.exists(out_path):
            # Only print skip for the first few to avoid noise
            if i < 5: print(f"    SKIP {fname} (exists)")
            continue
        text = str(i)
        if dry_run:
            if i < 5: print(f"    DRY-RUN {fname}: \"{text}\"")
            continue
        size = await generate_tts(text, out_path, voice)
        if i < 5: print(f"    OK {fname} ({size} bytes)")
    print(f"    ... 0-99 complete")


async def generate_prefectures(lang, voice, out_dir, dry_run=False):
    """Generate prefecture name audio files."""
    print(f"  [{lang}] Generating 47 prefecture names...")
    names = get_pref_names(lang)
    for i, name in enumerate(names):
        pid = i + 1  # 1-based
        fname = f"pref_{pid:02d}.wav"
        out_path = os.path.join(out_dir, fname)
        if os.path.exists(out_path):
            print(f"    SKIP {fname} (exists)")
            continue
        if dry_run:
            print(f"    DRY-RUN {fname}: \"{name}\"")
            continue
        size = await generate_tts(name, out_path, voice)
        print(f"    OK {fname} \"{name}\" ({size} bytes)")


async def generate_phrases(phrase_dict, lang, voice, out_dir, dry_run=False):
    """Generate a set of phrase audio files."""
    for base_name, translations in phrase_dict.items():
        text = translations.get(lang, "")
        if not text:
            print(f"    SKIP {base_name}.wav (empty text for {lang})")
            continue
        fname = f"{base_name}.wav"
        out_path = os.path.join(out_dir, fname)
        if os.path.exists(out_path):
            print(f"    SKIP {fname} (exists)")
            continue
        if dry_run:
            print(f"    DRY-RUN {fname}: \"{text}\"")
            continue
        size = await generate_tts(text, out_path, voice)
        print(f"    OK {fname} \"{text}\" ({size} bytes)")


async def generate_language(lang, dry_run=False):
    """Generate all TTS files for one language."""
    voice = VOICES[lang]
    out_dir = os.path.join(SOUNDS_DIR, lang, "info", "female")
    os.makedirs(out_dir, exist_ok=True)

    print(f"\n{'='*60}")
    print(f"Generating TTS for: {lang} (voice: {voice})")
    print(f"Output: {out_dir}")
    print(f"{'='*60}")

    # Numbers 0-59
    await generate_numbers(lang, voice, out_dir, dry_run)

    # Prefecture names
    await generate_prefectures(lang, voice, out_dir, dry_run)

    # Fixed phrases
    print(f"  [{lang}] Generating fixed phrases...")
    await generate_phrases(FIXED_PHRASES, lang, voice, out_dir, dry_run)

    # Tsunami phrases
    print(f"  [{lang}] Generating tsunami phrases...")
    await generate_phrases(TSUNAMI_PHRASES, lang, voice, out_dir, dry_run)

    # Affected areas intro
    print(f"  [{lang}] Generating affected areas phrase...")
    await generate_phrases(AFFECTED_PHRASE, lang, voice, out_dir, dry_run)

    # Intensity shorts
    print(f"  [{lang}] Generating intensity shorts...")
    await generate_phrases(INTENSITY_SHORTS, lang, voice, out_dir, dry_run)

    # Count files
    wav_count = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    print(f"\n  [{lang}] Done. {wav_count} WAV files in {out_dir}")


async def main():
    parser = argparse.ArgumentParser(description="Generate TTS audio for earthquake bulletin")
    parser.add_argument("--lang", choices=["jp", "en", "zh", "all"], default="all",
                        help="Target language (default: all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview files to generate without actually generating")
    args = parser.parse_args()

    langs = ["jp", "en", "zh"] if args.lang == "all" else [args.lang]

    for lang in langs:
        try:
            await generate_language(lang, dry_run=args.dry_run)
        except Exception as e:
            print(f"  ERROR generating {lang}: {e}", file=sys.stderr)
            if args.lang != "all":
                sys.exit(1)

    print("\nAll TTS generation complete.")


if __name__ == "__main__":
    asyncio.run(main())
