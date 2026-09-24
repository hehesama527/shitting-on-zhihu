# -*- coding: utf-8 -*-
"""Deterministic 16:9 ffmpeg composer for Video Hub MVP."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


WIDTH = 1920
HEIGHT = 1080
FPS = 30
DEFAULT_MOTION = {
    "enabled": True,
    "zoomMax": 1.035,
    "panScale": 1.025,
    "panCycleSec": 24,
    "videoFadeSec": 0.35,
    "subtitleFadeMs": 180,
}

ENCODER_AUTO = "auto"
ENCODER_NVENC = "nvenc"
ENCODER_X264 = "x264"


def run(command: list[str]):
    subprocess.run(command, check=True)


def run_encode(command: list[str], fallback_command: list[str] | None = None):
    try:
        run(command)
    except subprocess.CalledProcessError:
        if not fallback_command:
            raise
        run(fallback_command)


def ffprobe_duration(path: str | None) -> float | None:
    if not path:
        return None
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        value = json.loads(result.stdout).get("format", {}).get("duration")
        return float(value) if value is not None else None
    except Exception:
        return None


def format_srt_time(ms: int) -> str:
    hours = ms // 3_600_000
    minutes = (ms % 3_600_000) // 60_000
    seconds = (ms % 60_000) // 1000
    millis = ms % 1000
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def write_srt(path: Path, segments: list[dict], durations_ms: list[int]):
    cursor = 0
    blocks = []
    for index, (segment, duration_ms) in enumerate(zip(segments, durations_ms), start=1):
        start = cursor
        end = cursor + duration_ms
        cursor = end
        subtitle = str(segment.get("subtitle") or "").strip()
        blocks.append(f"{index}\n{format_srt_time(start)} --> {format_srt_time(end)}\n{subtitle}\n")
    path.write_text("\n".join(blocks), encoding="utf-8")


def format_ass_time(ms: int) -> str:
    centiseconds = max(0, ms) // 10
    hours = centiseconds // 360_000
    minutes = (centiseconds % 360_000) // 6_000
    seconds = (centiseconds % 6_000) // 100
    cs = centiseconds % 100
    return f"{hours}:{minutes:02}:{seconds:02}.{cs:02}"


def write_ass(path: Path, segments: list[dict], durations_ms: list[int], subtitle_fade_ms: int):
    cursor = 0
    events = []
    for segment, duration_ms in zip(segments, durations_ms):
        start = cursor
        end = cursor + duration_ms
        cursor = end
        subtitle = normalize_subtitle(str(segment.get("subtitle") or "").strip())
        if not subtitle:
            continue
        text = escape_ass_text(subtitle)
        if subtitle_fade_ms > 0:
            text = f"{{\\fad({subtitle_fade_ms},{subtitle_fade_ms})}}{text}"
        events.append((start, end, text))

    write_ass_events(path, events, subtitle_fade_ms, text_already_escaped=True)


def write_ass_events(
    path: Path,
    events: list[tuple[int, int, str]],
    subtitle_fade_ms: int,
    text_already_escaped: bool = False,
):
    dialogue_lines = []
    for start, end, raw_text in events:
        subtitle = normalize_subtitle(str(raw_text or "").strip())
        if not subtitle:
            continue
        text = subtitle if text_already_escaped else escape_ass_text(subtitle)
        if subtitle_fade_ms > 0:
            text = f"{{\\fad({subtitle_fade_ms},{subtitle_fade_ms})}}{text}"
        dialogue_lines.append(
            f"Dialogue: 0,{format_ass_time(start)},{format_ass_time(end)},Default,,0,0,0,,{text}"
        )

    path.write_text(
        "\n".join(
            [
                "[Script Info]",
                "ScriptType: v4.00+",
                "WrapStyle: 2",
                "ScaledBorderAndShadow: yes",
                f"PlayResX: {WIDTH}",
                f"PlayResY: {HEIGHT}",
                "",
                "[V4+ Styles]",
                "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
                "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
                "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
                "Style: Default,SimHei,46,&H00FFFFFF,&H00FFFFFF,&H99111827,&H99000000,"
                "1,0,0,0,100,100,0,0,3,14,0,2,180,180,48,1",
                "",
                "[Events]",
                "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
                *dialogue_lines,
                "",
            ]
        ),
        encoding="utf-8",
    )


def parse_srt_time(value: str) -> int:
    match = re.match(r"^\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*$", value)
    if not match:
        raise ValueError(f"Invalid SRT timestamp: {value}")
    hours, minutes, seconds, millis = (int(item) for item in match.groups())
    return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis


def read_srt_events(path: Path) -> list[tuple[int, int, str]]:
    content = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    events: list[tuple[int, int, str]] = []
    for block in re.split(r"\n\s*\n", content):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        timing_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if timing_index < 0:
            continue
        start_raw, end_raw = [part.strip().split(" ")[0] for part in lines[timing_index].split("-->", 1)]
        text = " ".join(lines[timing_index + 1 :]).strip()
        if text:
            events.append((parse_srt_time(start_raw), parse_srt_time(end_raw), text))
    return events


def concat_list_line(path: Path) -> str:
    normalized = str(path.resolve()).replace("\\", "/").replace("'", "'\\''")
    return f"file '{normalized}'\n"


def ffmpeg_filter_path(path: Path) -> str:
    normalized = str(path.resolve()).replace("\\", "/")
    normalized = normalized.replace(":", "\\:")
    normalized = normalized.replace("'", "\\'")
    return normalized


def ffmpeg_number(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def get_motion_config(composition: dict) -> dict:
    raw = composition.get("motion") if isinstance(composition.get("motion"), dict) else {}
    return {
        "enabled": bool(raw.get("enabled", DEFAULT_MOTION["enabled"])),
        "zoomMax": float(raw.get("zoomMax", DEFAULT_MOTION["zoomMax"])),
        "panScale": float(raw.get("panScale", DEFAULT_MOTION["panScale"])),
        "panCycleSec": float(raw.get("panCycleSec", DEFAULT_MOTION["panCycleSec"])),
        "videoFadeSec": float(raw.get("videoFadeSec", DEFAULT_MOTION["videoFadeSec"])),
        "subtitleFadeMs": int(raw.get("subtitleFadeMs", DEFAULT_MOTION["subtitleFadeMs"])),
    }


def build_video_filter(duration_sec: float, motion: dict, visual_path: str | None) -> str:
    if not motion["enabled"]:
        return f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},fps={FPS},format=yuv420p"

    visual_style = classify_visual_style(visual_path)
    if visual_style in {"chart", "card"}:
        base = f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},fps={FPS}"
    else:
        scale_factor = min(1.06, max(1.0, float(motion.get("panScale", DEFAULT_MOTION["panScale"]))))
        scaled_width = int(round(WIDTH * scale_factor))
        scaled_height = int(round(HEIGHT * scale_factor))
        pan_cycle = max(12.0, float(motion.get("panCycleSec", DEFAULT_MOTION["panCycleSec"])))
        base = ",".join(
            [
                f"scale={scaled_width}:{scaled_height}:force_original_aspect_ratio=increase",
                (
                    f"crop={WIDTH}:{HEIGHT}:"
                    f"x='round((iw-ow)*(0.5+0.45*sin(2*PI*t/{ffmpeg_number(pan_cycle)})))':"
                    f"y='round((ih-oh)*(0.5+0.2*sin(2*PI*t/{ffmpeg_number(pan_cycle * 1.31)})))'"
                ),
                f"fps={FPS}",
            ]
        )

    fade_sec = min(float(motion["videoFadeSec"]), max(0.0, duration_sec / 3))
    fade_in = ffmpeg_number(fade_sec)
    fade_out_start = ffmpeg_number(max(0.0, duration_sec - fade_sec))
    filters = [
        base,
        "setpts=PTS-STARTPTS",
    ]
    if fade_sec > 0:
        filters.extend(
            [
                f"fade=t=in:st=0:d={fade_in}",
                f"fade=t=out:st={fade_out_start}:d={fade_in}",
            ]
        )
    filters.append("format=yuv420p")
    return ",".join(filters)


def classify_visual_style(visual_path: str | None) -> str:
    name = Path(str(visual_path or "")).name.lower()
    if "chart" in name:
        return "chart"
    if "card" in name:
        return "card"
    return "image"


def resolve_encoder(preference: str | None) -> str:
    normalized = (preference or ENCODER_AUTO).strip().lower()
    if normalized in {"h264_nvenc", ENCODER_NVENC}:
        return ENCODER_NVENC
    if normalized in {"libx264", ENCODER_X264, "cpu"}:
        return ENCODER_X264
    if normalized != ENCODER_AUTO:
        raise RuntimeError(f"Unsupported encoder preference: {preference}")
    return ENCODER_NVENC if has_ffmpeg_encoder("h264_nvenc") else ENCODER_X264


def has_ffmpeg_encoder(name: str) -> bool:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-encoders"],
        check=True,
        capture_output=True,
        text=True,
    )
    return name in result.stdout


def video_encoder_args(encoder: str) -> list[str]:
    if encoder == ENCODER_NVENC:
        return [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            "22",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
        ]
    return [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
    ]


def build_audio_filter(duration_sec: float, motion: dict) -> str:
    duration_value = ffmpeg_number(duration_sec)
    filters = [
        "apad",
        f"atrim=0:{duration_value}",
        "asetpts=PTS-STARTPTS",
    ]
    if motion["enabled"]:
        fade_sec = min(0.22, max(0.0, duration_sec / 4))
        if fade_sec > 0:
            fade_value = ffmpeg_number(fade_sec)
            fade_out_start = ffmpeg_number(max(0.0, duration_sec - fade_sec))
            filters.extend(
                [
                    f"afade=t=in:st=0:d={fade_value}",
                    f"afade=t=out:st={fade_out_start}:d={fade_value}",
                ]
            )
    return ",".join(filters)


def normalize_subtitle(value: str) -> str:
    value = " ".join(value.split())
    if len(value) <= 34:
        return value
    breakpoints = ["，", "。", "；", "、", ",", ";", " "]
    midpoint = len(value) // 2
    candidates = []
    for breakpoint in breakpoints:
        index = value.rfind(breakpoint, 0, midpoint + 8)
        if index > 8:
            candidates.append(index + (0 if breakpoint == " " else 1))
        index = value.find(breakpoint, midpoint - 8)
        if index > 8:
            candidates.append(index + (0 if breakpoint == " " else 1))
    if candidates:
        split_at = min(candidates, key=lambda item: abs(item - midpoint))
    else:
        split_at = midpoint
    return f"{value[:split_at].strip()}\\N{value[split_at:].strip()}"


def escape_ass_text(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("{", "\\{")
        .replace("}", "\\}")
    )


def compose(
    composition_path: Path,
    output_path: Path,
    subtitle_srt_path: Path | None = None,
    encoder_preference: str | None = None,
):
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is not available on PATH")
    if shutil.which("ffprobe") is None:
        raise RuntimeError("ffprobe is not available on PATH")

    composition = json.loads(composition_path.read_text(encoding="utf-8-sig"))
    segments = composition.get("segments") or []
    if not segments:
        raise RuntimeError("composition.segments is empty")
    motion = get_motion_config(composition)
    encoder = resolve_encoder(encoder_preference or os.environ.get("VIDEO_FFMPEG_ENCODER"))
    encoder_args = video_encoder_args(encoder)
    fallback_encoder_args = video_encoder_args(ENCODER_X264) if encoder == ENCODER_NVENC else None
    print(f"[video-compose] encoder={encoder}")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="video-hub-ffmpeg-") as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        segment_files: list[Path] = []
        durations_ms: list[int] = []

        for index, segment in enumerate(segments, start=1):
            visual = segment.get("visual")
            voice = segment.get("voice")
            if not visual or not Path(visual).exists():
                raise RuntimeError(f"Segment {index} visual asset is missing: {visual}")
            if not voice or not Path(voice).exists():
                raise RuntimeError(f"Segment {index} voice asset is missing: {voice}")

            planned_sec = max(0.1, float(segment.get("durationMs") or 0) / 1000)
            voice_sec = ffprobe_duration(voice)
            duration_sec = max(planned_sec, voice_sec or 0)
            duration_ms = int(round(duration_sec * 1000))
            durations_ms.append(duration_ms)

            segment_path = temp_dir / f"segment-{index:03}.mp4"
            segment_command = [
                "ffmpeg",
                "-y",
                "-loop",
                "1",
                "-framerate",
                str(FPS),
                "-i",
                str(visual),
                "-i",
                str(voice),
                "-t",
                f"{duration_sec:.3f}",
                "-vf",
                build_video_filter(duration_sec, motion, str(visual)),
                "-af",
                build_audio_filter(duration_sec, motion),
                *encoder_args,
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                str(segment_path),
            ]
            segment_fallback_command = (
                [
                    "ffmpeg",
                    "-y",
                    "-loop",
                    "1",
                    "-framerate",
                    str(FPS),
                    "-i",
                    str(visual),
                    "-i",
                    str(voice),
                    "-t",
                    f"{duration_sec:.3f}",
                    "-vf",
                    build_video_filter(duration_sec, motion, str(visual)),
                    "-af",
                    build_audio_filter(duration_sec, motion),
                    *fallback_encoder_args,
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-movflags",
                    "+faststart",
                    str(segment_path),
                ]
                if fallback_encoder_args
                else None
            )
            run_encode(
                segment_command,
                segment_fallback_command,
            )
            segment_files.append(segment_path)

        concat_path = temp_dir / "concat.txt"
        concat_path.write_text("".join(concat_list_line(item) for item in segment_files), encoding="utf-8")
        merged_path = temp_dir / "merged.mp4"
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_path), "-c", "copy", str(merged_path)])

        subtitle_path = output_path.with_suffix(".srt")
        ass_path = output_path.with_suffix(".ass")
        if subtitle_srt_path:
            shutil.copyfile(subtitle_srt_path, subtitle_path)
            write_ass_events(
                ass_path,
                read_srt_events(subtitle_srt_path),
                int(motion["subtitleFadeMs"]) if motion["enabled"] else 0,
            )
        else:
            write_srt(subtitle_path, segments, durations_ms)
            write_ass(ass_path, segments, durations_ms, int(motion["subtitleFadeMs"]) if motion["enabled"] else 0)

        final_command = [
            "ffmpeg",
            "-y",
            "-i",
            str(merged_path),
            "-vf",
            f"ass='{ffmpeg_filter_path(ass_path)}'",
            *encoder_args,
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        final_fallback_command = (
            [
                "ffmpeg",
                "-y",
                "-i",
                str(merged_path),
                "-vf",
                f"ass='{ffmpeg_filter_path(ass_path)}'",
                *fallback_encoder_args,
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                str(output_path),
            ]
            if fallback_encoder_args
            else None
        )
        run_encode(
            final_command,
            final_fallback_command,
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--composition", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--subtitle-srt")
    parser.add_argument(
        "--encoder",
        default=os.environ.get("VIDEO_FFMPEG_ENCODER", ENCODER_AUTO),
        choices=[ENCODER_AUTO, ENCODER_NVENC, ENCODER_X264, "h264_nvenc", "libx264", "cpu"],
    )
    args = parser.parse_args()

    compose(
        Path(args.composition).resolve(),
        Path(args.output).resolve(),
        Path(args.subtitle_srt).resolve() if args.subtitle_srt else None,
        args.encoder,
    )


if __name__ == "__main__":
    main()
