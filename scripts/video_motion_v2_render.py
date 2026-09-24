# -*- coding: utf-8 -*-
"""Motion-first 16:9 renderer for the Video Hub MVP.

This renderer is intentionally data/scene driven. It keeps the current voice and
ASR subtitle timeline, then redraws the visual layer as animated explainer
scenes instead of stitching static PNG slides.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFilter, ImageFont


WIDTH = 1920
HEIGHT = 1080
FPS = 30

FONT_REGULAR = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_MONO = r"C:\Windows\Fonts\simhei.ttf"

NAVY = (15, 23, 42)
INK = (17, 24, 39)
MUTED = (86, 99, 118)
BLUE = (43, 127, 255)
CYAN = (102, 204, 255)
GREEN = (0, 155, 106)
RED = (220, 38, 38)
AMBER = (245, 158, 11)
PANEL = (248, 250, 252)
LINE = (214, 222, 235)
WHITE = (255, 255, 255)


@dataclass
class Segment:
    index: int
    segment_id: str
    start_ms: int
    duration_ms: int
    visual: str | None
    voice: str | None
    subtitle: str


@dataclass
class MotionScene:
    scene_id: str
    order: int
    scene_type: str
    start_ms: int
    end_ms: int
    duration_ms: int
    segment_id: str | None
    segment_index: int
    text_overlays: list[dict[str, Any]]
    data_ref: dict[str, Any]
    motion: dict[str, Any]


@dataclass
class SubtitleEvent:
    start_ms: int
    end_ms: int
    text: str


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def ease_out_cubic(value: float) -> float:
    value = clamp(value)
    return 1 - (1 - value) ** 3


def ease_in_out(value: float) -> float:
    value = clamp(value)
    return value * value * (3 - 2 * value)


def pop(value: float) -> float:
    value = clamp(value)
    return 1 + 0.05 * math.sin(value * math.pi)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * clamp(t)


def rgba(color: tuple[int, int, int], alpha: int) -> tuple[int, int, int, int]:
    return color[0], color[1], color[2], alpha


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def mono_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_MONO if bold else FONT_REGULAR, size)


def parse_srt_time(value: str) -> int:
    match = re.match(r"^\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*$", value)
    if not match:
        raise ValueError(f"Invalid SRT timestamp: {value}")
    hours, minutes, seconds, millis = (int(item) for item in match.groups())
    return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis


def parse_srt(path: Path) -> list[SubtitleEvent]:
    content = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    events: list[SubtitleEvent] = []
    for block in re.split(r"\n\s*\n", content):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        timing_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if timing_index < 0:
            continue
        start_raw, end_raw = [part.strip().split(" ")[0] for part in lines[timing_index].split("-->", 1)]
        text = " ".join(lines[timing_index + 1 :]).strip()
        if text:
            events.append(SubtitleEvent(parse_srt_time(start_raw), parse_srt_time(end_raw), text))
    return events


def cover_image(path: str | None, width: int = WIDTH, height: int = HEIGHT) -> Image.Image:
    if not path or not Path(path).exists():
        return Image.new("RGB", (width, height), (232, 238, 247))
    image = Image.open(path).convert("RGB")
    scale = max(width / image.width, height / image.height)
    resized = image.resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


def alpha(base: Image.Image, overlay: Image.Image) -> Image.Image:
    return Image.alpha_composite(base.convert("RGBA"), overlay.convert("RGBA")).convert("RGB")


def draw_round(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    fill: tuple[int, int, int] | tuple[int, int, int, int],
    radius: int = 24,
    outline: tuple[int, int, int] | None = None,
    width: int = 2,
):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text_bbox(text: str, fnt: ImageFont.FreeTypeFont) -> tuple[int, int]:
    probe = Image.new("RGB", (10, 10))
    d = ImageDraw.Draw(probe)
    box = d.textbbox((0, 0), text, font=fnt)
    return box[2] - box[0], box[3] - box[1]


def draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    size: int,
    fill: tuple[int, int, int] | tuple[int, int, int, int] = INK,
    bold: bool = False,
    anchor: str | None = None,
    shadow: bool = False,
):
    fnt = font(size, bold)
    if shadow:
        sx, sy = xy[0] + 2, xy[1] + 3
        draw.text((sx, sy), text, font=fnt, fill=(0, 0, 0, 80), anchor=anchor)
    draw.text(xy, text, font=fnt, fill=fill, anchor=anchor)


def wrap_text(text: str, fnt: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    chunks: list[str] = []
    current = ""
    for ch in text:
        candidate = current + ch
        if text_bbox(candidate, fnt)[0] <= max_width or not current:
            current = candidate
        else:
            chunks.append(current)
            current = ch
    if current:
        chunks.append(current)
    return chunks


def draw_badge(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    text: str,
    fill: tuple[int, int, int],
    text_fill: tuple[int, int, int] = WHITE,
    size: int = 26,
):
    fnt = font(size, True)
    tw, th = text_bbox(text, fnt)
    box = (x, y, x + tw + 34, y + th + 20)
    draw_round(draw, box, fill, radius=22)
    draw.text((x + 17, y + 8), text, font=fnt, fill=text_fill)
    return box


def draw_subtitle(draw: ImageDraw.ImageDraw, events: list[SubtitleEvent], t_ms: int):
    current = next((event for event in events if event.start_ms <= t_ms < event.end_ms), None)
    if not current:
        return
    fnt = font(44, True)
    lines = wrap_text(current.text, fnt, 1050)
    if len(lines) > 2:
        lines = [lines[0], "".join(lines[1:])]
    line_height = 58
    box_width = min(1180, max(text_bbox(line, fnt)[0] for line in lines) + 96)
    box_height = len(lines) * line_height + 30
    x1 = (WIDTH - box_width) // 2
    y1 = HEIGHT - box_height - 30
    draw_round(draw, (x1, y1, x1 + box_width, y1 + box_height), (16, 18, 24, 170), radius=14)
    y = y1 + 15
    for line in lines:
        draw.text((WIDTH // 2, y), line, font=fnt, fill=WHITE, anchor="ma")
        y += line_height


def progress_for_segment(t_ms: int, segment: Segment) -> float:
    return clamp((t_ms - segment.start_ms) / max(1, segment.duration_ms))


def progress_for_scene(t_ms: int, scene: MotionScene) -> float:
    return clamp((t_ms - scene.start_ms) / max(1, scene.duration_ms))


def split_weighted(segment: Segment, sequence: list[tuple[str, float]]) -> list[tuple[str, int, int]]:
    total_weight = sum(weight for _, weight in sequence) or 1
    slices: list[tuple[str, int, int]] = []
    cursor = segment.start_ms
    for index, (scene_type, weight) in enumerate(sequence):
        if index == len(sequence) - 1:
            end_ms = segment.start_ms + segment.duration_ms
        else:
            end_ms = cursor + int(round(segment.duration_ms * weight / total_weight))
        slices.append((scene_type, cursor, max(cursor + 1, end_ms)))
        cursor = end_ms
    return slices


def split_evenly(segment: Segment, scene_type: str, max_duration_ms: int) -> list[tuple[str, int, int]]:
    count = max(1, math.ceil(segment.duration_ms / max_duration_ms))
    slices = []
    for index in range(count):
        start_ms = segment.start_ms + int(round(segment.duration_ms * index / count))
        end_ms = segment.start_ms + int(round(segment.duration_ms * (index + 1) / count))
        slices.append((scene_type, start_ms, max(start_ms + 1, end_ms)))
    return slices


def template_time(local: float, start_ms: int, end_ms: int) -> int:
    return int(round(lerp(start_ms, end_ms, local)))


class MotionRenderer:
    def __init__(self, composition_path: Path, subtitle_path: Path, motion_plan_path: Path | None = None):
        self.composition = json.loads(composition_path.read_text(encoding="utf-8-sig"))
        self.segments = [
            Segment(
                index=i,
                segment_id=str(item.get("segmentId") or f"segment-{i}"),
                start_ms=int(item["startMs"]),
                duration_ms=int(item["durationMs"]),
                visual=item.get("visual"),
                voice=item.get("voice"),
                subtitle=str(item.get("subtitle") or ""),
            )
            for i, item in enumerate(self.composition["segments"], start=1)
        ]
        self.duration_ms = max(segment.start_ms + segment.duration_ms for segment in self.segments)
        self.subtitles = parse_srt(subtitle_path)
        self.backgrounds = {segment.index: cover_image(segment.visual) for segment in self.segments}
        self.grid = self.make_grid()
        self.dark_bg = self.make_dark_bg()
        self.market_windows = self.load_market_windows(composition_path)
        self.motion_plan = self.load_motion_plan(motion_plan_path)
        self.motion_scenes = self.parse_motion_scenes(self.motion_plan)

    def load_motion_plan(self, motion_plan_path: Path | None) -> dict[str, Any]:
        if motion_plan_path:
            return json.loads(motion_plan_path.read_text(encoding="utf-8-sig"))
        embedded = self.composition.get("motionPlan")
        if isinstance(embedded, dict):
            return embedded
        return self.build_fallback_motion_plan()

    def build_fallback_motion_plan(self) -> dict[str, Any]:
        scenes: list[dict[str, Any]] = []
        order = 1
        for segment in self.segments:
            for scene_type, start_ms, end_ms in self.fallback_scene_slices(segment):
                scenes.append(
                    {
                        "sceneId": f"{segment.segment_id}-fallback-{order:03d}-{scene_type}",
                        "segmentId": segment.segment_id,
                        "segmentKey": f"segment-{segment.index}",
                        "order": order,
                        "startMs": start_ms,
                        "endMs": end_ms,
                        "durationMs": end_ms - start_ms,
                        "sceneType": scene_type,
                        "narrationIntent": "Legacy composition fallback scene.",
                        "dataRef": self.fallback_data_ref(scene_type, segment),
                        "visualFocus": scene_type,
                        "textOverlays": self.fallback_overlays(scene_type, segment),
                        "motion": self.fallback_motion(scene_type),
                        "requiredAssetTypes": ["voice"],
                        "qaRules": [],
                    }
                )
                order += 1
        return {
            "version": "motion-plan-v1",
            "projectId": str(self.composition.get("projectId") or "legacy-project"),
            "title": str(self.composition.get("title") or "Video"),
            "aspectRatio": "16:9",
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "totalDurationMs": self.duration_ms,
            "maxSceneDurationMs": 12_000,
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "source": {
                "planner": "deterministic_v1",
                "inputs": ["legacy_composition", "segment_duration", "subtitle"],
            },
            "dataBindings": [
                {
                    "key": "legacy_market_windows",
                    "type": "market_window_comparison",
                    "source": "market-data/btc-4h-video-windows.json",
                    "label": "market windows",
                    "required": False,
                    "fallbackSceneType": "text_card",
                }
            ],
            "scenes": scenes,
            "qaRules": [],
            "notes": ["Generated by renderer fallback because no explicit MotionPlan was supplied."],
        }

    def fallback_scene_slices(self, segment: Segment) -> list[tuple[str, int, int]]:
        if segment.index == 1:
            sequence = [
                ("hook_curve_warning", 0.275),
                ("real_market_chart", 0.15),
                ("ma_crossover_rule", 0.20),
                ("single_window_result", 0.225),
                ("hook_curve_warning", 0.15),
            ]
            return split_weighted(segment, sequence)

        segment_type = {
            2: "text_card",
            3: "window_comparison",
            4: "market_weather",
            5: "diagnostic_cards",
            6: "product_workflow",
        }.get(segment.index, "closing_standard")
        return split_evenly(segment, segment_type, max_duration_ms=12_000)

    def fallback_data_ref(self, scene_type: str, segment: Segment) -> dict[str, Any]:
        if scene_type in {"real_market_chart", "ma_crossover_rule", "single_window_result"}:
            return {"type": "market_window", "key": "bull", "source": "market-data", "label": "bull window"}
        if scene_type in {"window_comparison", "market_weather"}:
            return {
                "type": "market_window_comparison",
                "key": "bull,bear,chop",
                "source": "market-data",
                "label": "market window comparison",
            }
        if segment.visual:
            return {"type": "asset", "key": segment.visual, "source": segment.visual, "label": "segment visual"}
        return {"type": "script_segment", "key": segment.segment_id, "source": "composition", "label": "segment"}

    def fallback_motion(self, scene_type: str) -> dict[str, Any]:
        if scene_type in {"real_market_chart", "ma_crossover_rule", "single_window_result", "window_comparison", "market_weather"}:
            return {
                "transition": "match_cut",
                "camera": "track_chart",
                "chartDraw": "continuous",
                "emphasis": "result_delta",
                "layerAnimations": ["path_draw_continuous", "labels_stagger"],
            }
        return {
            "transition": "fade",
            "camera": "push_in",
            "chartDraw": "none",
            "emphasis": "workflow_step" if scene_type == "product_workflow" else "none",
            "layerAnimations": ["text_stagger"],
        }

    def fallback_overlays(self, scene_type: str, segment: Segment) -> list[dict[str, Any]]:
        label_by_type = {
            "hook_curve_warning": "单一窗口要谨慎",
            "real_market_chart": "真实走势先画出来",
            "ma_crossover_rule": "先定规则，再看结果",
            "single_window_result": "局部结果不等于完整结论",
            "window_comparison": "跨窗口对比",
            "market_weather": "市场环境会改变结果",
            "diagnostic_cards": "拆开看风险",
            "product_workflow": "把研究动作沉淀下来",
            "closing_standard": "结尾判断标准",
            "text_card": "方法先固定",
        }
        overlays = [
            {
                "text": label_by_type.get(scene_type, "关键画面"),
                "role": "headline",
                "position": "top_left",
            }
        ]
        if segment.subtitle:
            overlays.append({"text": segment.subtitle[:34], "role": "callout", "position": "lower_left"})
        return overlays

    def parse_motion_scenes(self, motion_plan: dict[str, Any]) -> list[MotionScene]:
        segment_by_id = {segment.segment_id: segment for segment in self.segments}
        parsed: list[MotionScene] = []
        for index, raw in enumerate(motion_plan.get("scenes", []), start=1):
            segment_id = raw.get("segmentId")
            segment = segment_by_id.get(str(segment_id)) if segment_id is not None else None
            if segment is None:
                segment = self.find_segment(int(raw.get("startMs") or 0))
            start_ms = int(raw.get("startMs") or segment.start_ms)
            end_ms = int(raw.get("endMs") or (start_ms + int(raw.get("durationMs") or segment.duration_ms)))
            parsed.append(
                MotionScene(
                    scene_id=str(raw.get("sceneId") or f"scene-{index}"),
                    order=int(raw.get("order") or index),
                    scene_type=str(raw.get("sceneType") or "text_card"),
                    start_ms=start_ms,
                    end_ms=end_ms,
                    duration_ms=max(1, int(raw.get("durationMs") or (end_ms - start_ms))),
                    segment_id=str(segment_id) if segment_id is not None else segment.segment_id,
                    segment_index=segment.index,
                    text_overlays=list(raw.get("textOverlays") or []),
                    data_ref=dict(raw.get("dataRef") or {}),
                    motion=dict(raw.get("motion") or {}),
                )
            )
        parsed.sort(key=lambda item: (item.start_ms, item.order))
        if not parsed:
            raise ValueError("MotionPlan has no scenes.")
        return parsed

    def write_resolved_motion_plan(self, output_path: Path):
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(self.motion_plan, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_market_windows(self, composition_path: Path) -> dict:
        project_dir = composition_path.parent.parent
        cache_dir = project_dir / "market-data"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / "btc-4h-video-windows.json"
        if cache_path.exists():
            return json.loads(cache_path.read_text(encoding="utf-8"))

        windows = {
            "bull": ("2020.10 - 2021.11", dt.datetime(2020, 10, 1), dt.datetime(2021, 11, 1)),
            "bear": ("2021.11 - 2022.11", dt.datetime(2021, 11, 1), dt.datetime(2022, 11, 1)),
            "chop": ("2024.03 - 2024.09", dt.datetime(2024, 3, 1), dt.datetime(2024, 9, 1)),
        }
        try:
            from pymongo import MongoClient

            client = MongoClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2500)
            client.admin.command("ping")
            collection = client["crypto_data_new"]["BTCUSDT_4h"]
            result = {}
            for key, (label, start, end) in windows.items():
                rows = list(
                    collection.find(
                        {"timestamp": {"$gte": start, "$lt": end}},
                        {"_id": 0, "timestamp": 1, "open": 1, "high": 1, "low": 1, "close": 1},
                    ).sort("timestamp", 1)
                )
                result[key] = self.prepare_market_rows(label, rows)
            cache_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            return result
        except Exception:
            result = {
                "bull": self.synthetic_market("2020.10 - 2021.11", 180, 0.18, 0.82, 0.06),
                "bear": self.synthetic_market("2021.11 - 2022.11", 180, 0.78, 0.28, 0.05),
                "chop": self.synthetic_market("2024.03 - 2024.09", 150, 0.52, 0.46, 0.15),
            }
            cache_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            return result

    def prepare_market_rows(self, label: str, rows: list[dict], max_points: int = 180) -> dict:
        normalized = [
            {
                "time": item["timestamp"].strftime("%Y-%m-%d"),
                "open": float(item["open"]),
                "high": float(item["high"]),
                "low": float(item["low"]),
                "close": float(item["close"]),
            }
            for item in rows
        ]
        if len(normalized) > max_points:
            sampled = []
            step = len(normalized) / max_points
            for i in range(max_points):
                chunk = normalized[int(i * step) : max(int((i + 1) * step), int(i * step) + 1)]
                sampled.append(
                    {
                        "time": chunk[0]["time"],
                        "open": chunk[0]["open"],
                        "high": max(item["high"] for item in chunk),
                        "low": min(item["low"] for item in chunk),
                        "close": chunk[-1]["close"],
                    }
                )
            normalized = sampled
        closes = [item["close"] for item in normalized]
        for i, item in enumerate(normalized):
            item["ma_fast"] = sum(closes[max(0, i - 6) : i + 1]) / (i - max(0, i - 6) + 1)
            item["ma_slow"] = sum(closes[max(0, i - 24) : i + 1]) / (i - max(0, i - 24) + 1)
        return {"label": label, "rows": normalized}

    def synthetic_market(self, label: str, count: int, start: float, end: float, noise: float) -> dict:
        rows = []
        for i in range(count):
            t = i / max(1, count - 1)
            base = lerp(start, end, t) + math.sin(t * math.pi * 7) * noise
            price = 20000 + base * 50000
            rows.append(
                {
                    "time": f"样本{i + 1}",
                    "open": price * (0.995 + 0.01 * math.sin(i)),
                    "high": price * 1.015,
                    "low": price * 0.985,
                    "close": price,
                }
            )
        return self.prepare_market_rows(label, rows, count)

    def make_grid(self) -> Image.Image:
        img = Image.new("RGB", (WIDTH, HEIGHT), (241, 245, 249))
        d = ImageDraw.Draw(img)
        for x in range(0, WIDTH, 80):
            d.line((x, 0, x, HEIGHT), fill=(226, 232, 240), width=1)
        for y in range(0, HEIGHT, 80):
            d.line((0, y, WIDTH, y), fill=(226, 232, 240), width=1)
        return img.filter(ImageFilter.GaussianBlur(0.3))

    def make_dark_bg(self) -> Image.Image:
        img = Image.new("RGB", (WIDTH, HEIGHT), (7, 12, 28))
        d = ImageDraw.Draw(img, "RGBA")
        for x in range(0, WIDTH, 90):
            d.line((x, 0, x, HEIGHT), fill=(36, 52, 82, 45), width=1)
        for y in range(0, HEIGHT, 90):
            d.line((0, y, WIDTH, y), fill=(36, 52, 82, 45), width=1)
        d.rounded_rectangle((820, 105, 1840, 770), radius=38, fill=(15, 23, 42, 230), outline=(67, 85, 118, 180), width=2)
        d.rounded_rectangle((865, 150, 1788, 585), radius=26, fill=(8, 13, 28, 255), outline=(45, 68, 104, 180), width=2)
        for i in range(5):
            d.rounded_rectangle((905 + i * 165, 620, 1015 + i * 165, 702), radius=18, fill=(30, 41, 59, 170))
        d.ellipse((1588, 138, 1708, 258), outline=(94, 234, 212, 160), width=16)
        d.arc((1588, 138, 1708, 258), 270, 75, fill=(251, 191, 36, 210), width=16)
        return img

    def base_dark(self) -> Image.Image:
        img = Image.new("RGB", (WIDTH, HEIGHT), (7, 12, 28))
        d = ImageDraw.Draw(img, "RGBA")
        for x in range(0, WIDTH, 96):
            d.line((x, 0, x, HEIGHT), fill=(36, 52, 82, 36), width=1)
        for y in range(0, HEIGHT, 96):
            d.line((0, y, WIDTH, y), fill=(36, 52, 82, 36), width=1)
        curve = [(120, 840), (360, 760), (620, 820), (900, 690), (1180, 735), (1480, 565), (1800, 650)]
        d.line(curve, fill=(37, 99, 235, 65), width=8, joint="curve")
        for x, y in curve:
            d.ellipse((x - 9, y - 9, x + 9, y + 9), fill=(102, 204, 255, 120))
        d.ellipse((1320, -230, 2050, 500), fill=(43, 127, 255, 22))
        d.ellipse((-260, 575, 420, 1255), fill=(0, 155, 106, 20))
        return img

    def frame(self, frame_no: int) -> Image.Image:
        t_ms = int(round(frame_no * 1000 / FPS))
        segment = self.find_segment(t_ms)
        scene = self.find_scene(t_ms)
        local = progress_for_scene(t_ms, scene)
        if scene.segment_id:
            segment = next((item for item in self.segments if item.segment_id == scene.segment_id), segment)
        frame = self.render_motion_scene(scene, segment, local)

        d = ImageDraw.Draw(frame, "RGBA")
        self.draw_motion_overlays(d, scene, local)
        draw_subtitle(d, self.subtitles, t_ms)
        self.draw_corner_brand(d)
        self.apply_scene_fade(frame, local)
        return frame

    def render_motion_scene(self, scene: MotionScene, segment: Segment, local: float) -> Image.Image:
        scene_type = scene.scene_type
        if scene_type == "hook_curve_warning":
            return self.scene_curve_warning(template_time(local, 0, 11_000))
        if scene_type == "real_market_chart":
            return self.scene_real_btc_history(template_time(local, 11_000, 17_000))
        if scene_type == "ma_crossover_rule":
            return self.scene_ma_rule(template_time(local, 17_000, 25_000))
        if scene_type == "single_window_result":
            return self.scene_bull_window_result(template_time(local, 25_000, 34_000))
        if scene_type == "window_comparison":
            return self.scene_window_comparison(segment, local)
        if scene_type == "market_weather":
            return self.scene_market_weather(segment, local)
        if scene_type == "diagnostic_cards":
            return self.scene_diagnosis(segment, local)
        if scene_type == "product_workflow":
            return self.scene_product_workflow(segment, local)
        if scene_type == "closing_standard":
            return self.scene_closing(segment, local)
        if scene_type == "image_explainer":
            return self.scene_image_explainer(scene, segment, local)
        return self.scene_text_card(scene, segment, local)

    def find_scene(self, t_ms: int) -> MotionScene:
        for scene in reversed(self.motion_scenes):
            if t_ms >= scene.start_ms:
                return scene
        return self.motion_scenes[0]

    def find_segment(self, t_ms: int) -> Segment:
        for segment in reversed(self.segments):
            if t_ms >= segment.start_ms:
                return segment
        return self.segments[0]

    def base_light(self) -> Image.Image:
        return self.grid.copy().convert("RGB")

    def draw_corner_brand(self, draw: ImageDraw.ImageDraw):
        draw_text(draw, (1660, 62), "CryptoPathX", 28, fill=(92, 194, 255), bold=True)

    def overlay_texts(self, scene: MotionScene) -> list[str]:
        texts: list[str] = []
        for overlay in scene.text_overlays:
            text = self.public_text(str(overlay.get("text") or "")).strip()
            if text and text not in texts:
                texts.append(text)
        return texts

    def public_text(self, value: str) -> str:
        replacements = {
            "BTCUSDT_4h": "比特币",
            "BTCUSDT": "比特币",
            "MongoDB": "复验数据",
            "crypto_data_new": "复验数据",
            "VerifiedCasePack": "复验结论",
            "CaseIntent": "复验请求",
            "ReviewAgent": "复验审核",
            "collection": "数据来源",
        }
        cleaned = value
        for source, target in replacements.items():
            cleaned = re.sub(re.escape(source), target, cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"([+-]?\d+)\.\d+%", r"\1%左右", cleaned)
        return cleaned[:80]

    def draw_motion_overlays(self, draw: ImageDraw.ImageDraw, scene: MotionScene, local: float):
        if scene.scene_type in {"text_card", "image_explainer"}:
            return
        overlays = [item for item in scene.text_overlays if str(item.get("role") or "callout") != "headline"][:2]
        for index, overlay in enumerate(overlays):
            text = self.public_text(str(overlay.get("text") or "")).strip()
            if not text:
                continue
            role = str(overlay.get("role") or "callout")
            position = str(overlay.get("position") or "top_left")
            alpha_value = int(225 * ease_out_cubic((local - index * 0.08) / 0.18))
            if alpha_value <= 0:
                continue
            fill = (255, 255, 255, alpha_value)
            text_fill = INK
            outline = LINE
            if role == "warning":
                fill = (255, 247, 237, alpha_value)
                text_fill = (146, 64, 14)
                outline = (251, 191, 36)
            elif role == "metric":
                fill = (236, 253, 245, alpha_value)
                text_fill = (21, 128, 61)
                outline = (187, 247, 208)
            x, y, anchor = self.overlay_position(position, index)
            fnt = font(30 if role in {"caption", "callout"} else 34, True)
            lines = wrap_text(text, fnt, 560)[:2]
            width = min(650, max(text_bbox(line, fnt)[0] for line in lines) + 48)
            height = 48 + len(lines) * 42
            if anchor == "center":
                x -= width // 2
            elif anchor == "right":
                x -= width
            draw_round(draw, (x, y, x + width, y + height), fill, radius=18, outline=outline, width=2)
            for line_index, line in enumerate(lines):
                draw.text((x + 24, y + 24 + line_index * 42), line, font=fnt, fill=text_fill)

    def overlay_position(self, position: str, index: int) -> tuple[int, int, str]:
        offset = index * 82
        mapping = {
            "top_left": (86, 86 + offset, "left"),
            "top_center": (WIDTH // 2, 78 + offset, "center"),
            "top_right": (WIDTH - 86, 86 + offset, "right"),
            "center": (WIDTH // 2, 430 + offset, "center"),
            "lower_left": (86, 760 + offset, "left"),
            "lower_center": (WIDTH // 2, 760 + offset, "center"),
            "lower_right": (WIDTH - 86, 760 + offset, "right"),
        }
        return mapping.get(position, mapping["top_left"])

    def scene_text_card(self, scene: MotionScene, segment: Segment, local: float) -> Image.Image:
        img = self.base_light().convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        texts = self.overlay_texts(scene)
        title = texts[0] if texts else self.public_text(segment.subtitle or "关键要点")
        bullets = texts[1:] or [self.public_text(segment.subtitle or "先把方法讲清楚，再进入结论。")]
        p = ease_out_cubic(local)
        x = int(160 + (1 - p) * -80)
        draw_round(d, (x, 160, x + 1120, 680), (255, 255, 255, 238), radius=28, outline=LINE, width=2)
        draw_badge(d, x + 46, 204, "知识卡片", (216, 240, 255), (6, 104, 151), 26)
        for i, line in enumerate(wrap_text(title, font(58, True), 920)[:2]):
            draw_text(d, (x + 50, 300 + i * 72), line, 58, fill=INK, bold=True)
        for i, bullet in enumerate(bullets[:3]):
            bp = ease_out_cubic((local - 0.24 - i * 0.12) / 0.16)
            if bp <= 0:
                continue
            by = 475 + i * 68
            d.ellipse((x + 54, by + 14, x + 78, by + 38), fill=rgba(BLUE if i % 2 == 0 else GREEN, int(210 * bp)))
            draw_text(d, (x + 98, by), bullet, 34, fill=(55, 65, 81), bold=True)
        self.draw_template_meter(d, local, scene.scene_type)
        return img

    def scene_image_explainer(self, scene: MotionScene, segment: Segment, local: float) -> Image.Image:
        base = self.backgrounds.get(segment.index, self.base_light()).copy()
        scale = 1.0 + 0.035 * ease_in_out(local)
        resized = base.resize((int(WIDTH * scale), int(HEIGHT * scale)), Image.Resampling.LANCZOS)
        left = (resized.width - WIDTH) // 2
        top = (resized.height - HEIGHT) // 2
        img = resized.crop((left, top, left + WIDTH, top + HEIGHT)).convert("RGB")
        overlay = Image.new("RGBA", (WIDTH, HEIGHT), (3, 7, 18, 85))
        img = alpha(img, overlay)
        d = ImageDraw.Draw(img, "RGBA")
        texts = self.overlay_texts(scene)
        title = texts[0] if texts else self.public_text(segment.subtitle or "画面解释")
        draw_round(d, (96, 120, 780, 410), (255, 255, 255, 226), radius=24, outline=LINE, width=2)
        draw_badge(d, 130, 154, "视觉解释", (220, 252, 231), (21, 128, 61), 24)
        for i, line in enumerate(wrap_text(title, font(48, True), 580)[:2]):
            draw_text(d, (130, 240 + i * 60), line, 48, fill=INK, bold=True)
        if len(texts) > 1:
            draw_text(d, (130, 365), texts[1], 30, fill=MUTED, bold=True)
        self.draw_template_meter(d, local, scene.scene_type)
        return img

    def draw_template_meter(self, draw: ImageDraw.ImageDraw, local: float, scene_type: str):
        x1, y1, x2 = 126, 928, 1794
        draw_round(draw, (x1, y1, x2, y1 + 18), (226, 232, 240, 190), radius=9)
        fill = BLUE if scene_type != "diagnostic_cards" else AMBER
        draw_round(draw, (x1, y1, x1 + int((x2 - x1) * clamp(local)), y1 + 18), rgba(fill, 220), radius=9)

    def section_progress(self, t_ms: int, start_ms: int, end_ms: int) -> float:
        return clamp((t_ms - start_ms) / max(1, end_ms - start_ms))

    def partial_polyline(self, points: list[tuple[float, float]], progress: float) -> list[tuple[int, int]]:
        if len(points) <= 1:
            return [(int(x), int(y)) for x, y in points]
        span = (len(points) - 1) * clamp(progress)
        index = int(math.floor(span))
        rest = span - index
        visible = points[: index + 1]
        if index < len(points) - 1:
            x1, y1 = points[index]
            x2, y2 = points[index + 1]
            visible.append((lerp(x1, x2, rest), lerp(y1, y2, rest)))
        return [(int(x), int(y)) for x, y in visible]

    def price_y(self, value: float, low: float, high: float, y1: int, y2: int) -> int:
        if high <= low:
            return (y1 + y2) // 2
        return int(y2 - ((value - low) / (high - low)) * (y2 - y1))

    def draw_market_chart(
        self,
        draw: ImageDraw.ImageDraw,
        key: str,
        box: tuple[int, int, int, int],
        progress: float,
        title: str,
        line_color: tuple[int, int, int],
        dark: bool = False,
        show_ma: bool = False,
        show_signals: bool = False,
        show_candles: bool = True,
    ):
        x1, y1, x2, y2 = box
        rows = self.market_windows.get(key, {}).get("rows", [])
        if len(rows) < 2:
            return
        panel_fill = (255, 255, 255, 235) if not dark else (15, 23, 42, 215)
        panel_line = (214, 222, 235) if not dark else (67, 85, 118)
        text_fill = INK if not dark else WHITE
        muted_fill = MUTED if not dark else (190, 201, 218)
        draw_round(draw, box, panel_fill, radius=22, outline=panel_line, width=2)
        draw_text(draw, (x1 + 34, y1 + 28), title, 34, fill=text_fill, bold=True)
        draw_text(draw, (x1 + 34, y1 + 75), self.market_windows[key]["label"], 24, fill=muted_fill)

        chart = (x1 + 58, y1 + 125, x2 - 34, y2 - 52)
        cx1, cy1, cx2, cy2 = chart
        for i in range(5):
            y = int(cy1 + i * (cy2 - cy1) / 4)
            draw.line((cx1, y, cx2, y), fill=(148, 163, 184, 52 if dark else 70), width=1)
        lows = [row["low"] for row in rows]
        highs = [row["high"] for row in rows]
        low, high = min(lows), max(highs)
        pad = (high - low) * 0.08
        low -= pad
        high += pad

        p = ease_in_out(progress)
        visible_count = max(2, min(len(rows), int(len(rows) * p)))
        step_x = (cx2 - cx1) / max(1, len(rows) - 1)

        if show_candles:
            candle_step = max(1, len(rows) // 95)
            candle_w = max(3, int(step_x * candle_step * 0.52))
            for i in range(0, visible_count, candle_step):
                row = rows[i]
                x = int(cx1 + i * step_x)
                oy = self.price_y(row["open"], low, high, cy1, cy2)
                cy = self.price_y(row["close"], low, high, cy1, cy2)
                hy = self.price_y(row["high"], low, high, cy1, cy2)
                ly = self.price_y(row["low"], low, high, cy1, cy2)
                color = GREEN if row["close"] >= row["open"] else RED
                draw.line((x, hy, x, ly), fill=rgba(color, 135), width=1)
                top, bottom = min(oy, cy), max(oy, cy)
                draw.rectangle((x - candle_w // 2, top, x + candle_w // 2, max(top + 2, bottom)), fill=rgba(color, 115))

        close_points = [(cx1 + i * step_x, self.price_y(row["close"], low, high, cy1, cy2)) for i, row in enumerate(rows)]
        line_points = self.partial_polyline(close_points, p)
        if len(line_points) > 1:
            draw.line(line_points, fill=rgba(line_color, 238), width=5, joint="curve")
            lx, ly = line_points[-1]
            draw.ellipse((lx - 7, ly - 7, lx + 7, ly + 7), fill=line_color)

        if show_ma:
            ma_fast = [(cx1 + i * step_x, self.price_y(row["ma_fast"], low, high, cy1, cy2)) for i, row in enumerate(rows)]
            ma_slow = [(cx1 + i * step_x, self.price_y(row["ma_slow"], low, high, cy1, cy2)) for i, row in enumerate(rows)]
            fast_points = self.partial_polyline(ma_fast, p)
            slow_points = self.partial_polyline(ma_slow, p)
            if len(fast_points) > 1:
                draw.line(fast_points, fill=(251, 191, 36, 235), width=4)
            if len(slow_points) > 1:
                draw.line(slow_points, fill=(96, 165, 250, 235), width=4)
            draw_text(draw, (x2 - 250, y1 + 34), "快线", 22, fill=(251, 191, 36), bold=True)
            draw_text(draw, (x2 - 170, y1 + 34), "慢线", 22, fill=(96, 165, 250), bold=True)

        if show_signals:
            signals = []
            for i in range(25, visible_count):
                prev_fast, prev_slow = rows[i - 1]["ma_fast"], rows[i - 1]["ma_slow"]
                cur_fast, cur_slow = rows[i]["ma_fast"], rows[i]["ma_slow"]
                if prev_fast <= prev_slow < cur_fast:
                    signals.append((i, "买", GREEN))
                elif prev_fast >= prev_slow > cur_fast:
                    signals.append((i, "卖", RED))
            for i, label, color in signals[:5]:
                row = rows[i]
                x = int(cx1 + i * step_x)
                y = self.price_y(row["close"], low, high, cy1, cy2)
                draw_round(draw, (x - 22, y - 42, x + 22, y - 6), rgba(color, 215), radius=10)
                draw_text(draw, (x, y - 36), label, 20, fill=WHITE, bold=True, anchor="ma")

        draw_text(draw, (cx1, cy2 + 18), rows[0]["time"][:7], 22, fill=muted_fill)
        draw_text(draw, (cx2, cy2 + 18), rows[-1]["time"][:7], 22, fill=muted_fill, anchor="ra")
        draw_text(draw, (cx2 - 4, cy1 - 4), f"{int(high):,}", 20, fill=muted_fill, anchor="ra")
        draw_text(draw, (cx2 - 4, cy2 - 22), f"{int(low):,}", 20, fill=muted_fill, anchor="ra")

    def apply_scene_fade(self, frame: Image.Image, local: float):
        fade = 0
        if local < 0.025:
            fade = int(180 * (1 - local / 0.025))
        elif local > 0.985:
            fade = int(130 * ((local - 0.985) / 0.015))
        if fade:
            overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, fade))
            frame.paste(alpha(frame, overlay))

    def scene_hook(self, segment: Segment, local: float, t_ms: int) -> Image.Image:
        if t_ms < 11_000:
            return self.scene_curve_warning(t_ms)
        if t_ms < 17_000:
            return self.scene_real_btc_history(t_ms)
        if t_ms < 25_000:
            return self.scene_ma_rule(t_ms)
        if t_ms < 34_000:
            return self.scene_bull_window_result(t_ms)
        return self.scene_single_window_warning(t_ms)

    def scene_curve_warning(self, t_ms: int) -> Image.Image:
        p_scene = self.section_progress(t_ms, 0, 11_000)
        img = self.dark_bg.copy()
        d = ImageDraw.Draw(img, "RGBA")

        title_p = ease_out_cubic((p_scene - 0.03) / 0.16)
        x = int(80 + (1 - title_p) * -70)
        draw_round(d, (x, 92, x + 770, 420), (255, 255, 255, 242), radius=26)
        draw_badge(d, x + 38, 126, "知识卡片", (216, 240, 255), (6, 104, 151), 26)
        draw_text(d, (x + 38, 196), "开场：漂亮曲线最危险", 52, bold=True)
        draw_text(d, (x + 42, 330), "单一牛市窗口，不能证明策略有效。", 34, fill=(55, 65, 81))

        chart_alpha = int(220 * ease_out_cubic((p_scene - 0.12) / 0.16))
        self.draw_animated_curve(d, 910, 250, 830, 300, (255, 210, 95, chart_alpha), p_scene)
        if p_scene > 0.42:
            pulse = 1 + 0.04 * math.sin(t_ms / 140)
            cx, cy = int(1350 * pulse + 0 * (1 - pulse)), 350
            draw_round(d, (cx - 154, cy - 70, cx + 154, cy + 70), (255, 244, 214, 225), radius=18, outline=(245, 158, 11), width=3)
            draw_text(d, (cx, cy - 26), "漂亮", 34, fill=AMBER, bold=True, anchor="mm")
            draw_text(d, (cx, cy + 26), "不等于有效", 30, fill=INK, bold=True, anchor="mm")

        if p_scene > 0.62:
            self.draw_risk_radar(d, 1260, 625, p_scene)
        return img

    def scene_real_btc_history(self, t_ms: int) -> Image.Image:
        p = self.section_progress(t_ms, 11_000, 17_000)
        img = self.base_light().convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (88, 70), "真实案例：比特币 4 小时历史走势", 56, fill=INK, bold=True)
        draw_text(d, (92, 142), "先看同一段历史，不急着下结论。", 32, fill=MUTED)
        self.draw_market_chart(
            d,
            "bull",
            (105, 220, 1815, 825),
            p,
            "比特币历史数据",
            GREEN,
            dark=False,
            show_ma=False,
            show_candles=True,
        )
        draw_badge(d, 118, 850, "历史复盘，不构成投资建议", (226, 232, 240), (55, 65, 81), 24)
        return img

    def scene_ma_rule(self, t_ms: int) -> Image.Image:
        p = self.section_progress(t_ms, 17_000, 25_000)
        img = self.base_light().convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (88, 68), "规则：两条均线交叉", 58, fill=INK, bold=True)
        draw_text(d, (92, 140), "快线上穿慢线，就买入；快线下穿慢线，就卖出。", 32, fill=MUTED)
        self.draw_market_chart(
            d,
            "bull",
            (88, 214, 1320, 838),
            p,
            "同一条比特币历史走势",
            BLUE,
            dark=False,
            show_ma=True,
            show_signals=True,
            show_candles=False,
        )
        card_p = ease_out_cubic((p - 0.18) / 0.28)
        draw_round(d, (1370, 300, 1798, 455), (255, 255, 255, int(235 * card_p)), radius=24, outline=LINE, width=2)
        draw_text(d, (1406, 338), "买入条件", 32, fill=GREEN, bold=True)
        draw_text(d, (1406, 392), "快线向上穿过慢线", 30, fill=INK, bold=True)
        card_p2 = ease_out_cubic((p - 0.42) / 0.28)
        draw_round(d, (1370, 508, 1798, 663), (255, 255, 255, int(235 * card_p2)), radius=24, outline=LINE, width=2)
        draw_text(d, (1406, 546), "卖出条件", 32, fill=RED, bold=True)
        draw_text(d, (1406, 600), "快线向下穿过慢线", 30, fill=INK, bold=True)
        return img

    def scene_bull_window_result(self, t_ms: int) -> Image.Image:
        p = self.section_progress(t_ms, 25_000, 34_000)
        img = self.base_light().convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (88, 68), "只看上涨窗口，结果会很诱人", 56, fill=INK, bold=True)
        self.draw_market_chart(
            d,
            "bull",
            (88, 190, 1240, 820),
            p,
            "2020 到 2021 上涨窗口",
            GREEN,
            dark=False,
            show_ma=True,
            show_signals=False,
            show_candles=True,
        )
        metric_p = ease_out_cubic((p - 0.28) / 0.34)
        x = int(1300 + (1 - metric_p) * 80)
        draw_round(d, (x, 260, x + 430, 590), (255, 255, 255, int(240 * metric_p)), radius=26, outline=LINE, width=2)
        draw_text(d, (x + 42, 312), "单窗口结果", 34, fill=INK, bold=True)
        draw_text(d, (x + 42, 420), "赚了130%多", int(60 * pop(metric_p)), fill=GREEN, bold=True)
        draw_text(d, (x + 42, 508), "看起来很香，但还不够。", 30, fill=MUTED)
        return img

    def scene_single_window_warning(self, t_ms: int) -> Image.Image:
        p = self.section_progress(t_ms, 34_000, 39_960)
        img = self.base_dark()
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (92, 80), "先停一下", 58, fill=WHITE, bold=True)
        draw_text(d, (92, 160), "单一牛市窗口，不能证明策略有效。", 40, fill=(226, 232, 240), bold=True)
        self.draw_market_chart(
            d,
            "bull",
            (960, 205, 1790, 770),
            p,
            "只看这一段，结论会偏",
            AMBER,
            dark=True,
            show_ma=False,
            show_signals=False,
            show_candles=True,
        )
        warn_p = ease_out_cubic((p - 0.18) / 0.28)
        draw_round(d, (115, 350, 805, 590), (255, 255, 255, int(232 * warn_p)), radius=26)
        draw_text(d, (160, 405), "问题不在它漂亮", 42, fill=INK, bold=True)
        draw_text(d, (160, 480), "问题在你只看了它", 50, fill=RED, bold=True)
        return img

    def draw_animated_curve(self, draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, color, local: float):
        raw = [0.72, 0.62, 0.67, 0.48, 0.55, 0.36, 0.43, 0.28, 0.31, 0.2, 0.14]
        all_points = [(x + w * i / (len(raw) - 1), y + h * value) for i, value in enumerate(raw)]
        points = self.partial_polyline(all_points, ease_in_out((local - 0.18) / 0.32))
        if len(points) > 1:
            draw.line(points, fill=color, width=8, joint="curve")
            for point in points[:-1:2]:
                draw.ellipse((point[0] - 7, point[1] - 7, point[0] + 7, point[1] + 7), fill=color)
            end = points[-1]
            draw.ellipse((end[0] - 10, end[1] - 10, end[0] + 10, end[1] + 10), fill=color)

    def draw_risk_radar(self, draw: ImageDraw.ImageDraw, x: int, y: int, local: float):
        items = [("窗口", BLUE), ("回撤", RED), ("样本", AMBER), ("集中度", GREEN)]
        for i, (label, color) in enumerate(items):
            p = ease_out_cubic((local - 0.62 - i * 0.06) / 0.12)
            if p <= 0:
                continue
            bx = x + (i % 2) * 220
            by = y + (i // 2) * 92
            draw_round(draw, (bx, by, bx + int(180 * p), by + 58), rgba(color, 210), radius=16)
            if p > 0.7:
                draw_text(draw, (bx + 90, by + 29), label, 28, fill=WHITE, bold=True, anchor="mm")

    def scene_method_flow(self, segment: Segment, local: float) -> Image.Image:
        img = self.base_light().convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (96, 86), "方法：先定窗口，再跑结果", 58, fill=INK, bold=True)
        draw_text(d, (100, 162), "不要跑完以后才挑最好看的那一段。", 34, fill=MUTED)
        steps = [
            ("01", "先定窗口", "上涨、下跌、震荡分开看"),
            ("02", "固定规则", "规则、成本、执行假设不变"),
            ("03", "运行复盘", "同一口径产出结果"),
            ("04", "横向对比", "看策略是否换了个人设"),
        ]
        y = 330
        prev_center = None
        for i, (no, title, sub) in enumerate(steps):
            p = ease_out_cubic((local - 0.08 - i * 0.13) / 0.13)
            x = int(110 + (1 - p) * -120)
            box = (x + i * 425, y, x + i * 425 + 340, y + 245)
            draw_round(d, box, WHITE + (235,), radius=26, outline=LINE, width=2)
            draw_badge(d, box[0] + 28, box[1] + 28, no, BLUE if i < 2 else GREEN, size=24)
            draw_text(d, (box[0] + 28, box[1] + 96), title, 42, bold=True)
            for j, line in enumerate(wrap_text(sub, font(28), 270)[:2]):
                draw_text(d, (box[0] + 28, box[1] + 165 + j * 38), line, 28, fill=MUTED)
            center = (box[0] + 170, box[1] + 122)
            if prev_center and p > 0.2:
                d.line((prev_center[0] + 185, prev_center[1], center[0] - 185, center[1]), fill=rgba(BLUE, int(170 * p)), width=6)
                d.polygon(
                    [
                        (center[0] - 188, center[1]),
                        (center[0] - 210, center[1] - 12),
                        (center[0] - 210, center[1] + 12),
                    ],
                    fill=rgba(BLUE, int(170 * p)),
                )
            prev_center = center

        scan_x = int(110 + 1600 * ((local * 1.35) % 1))
        draw_round(d, (scan_x, 648, scan_x + 280, 684), rgba(CYAN, 70), radius=18)
        draw_text(d, (104, 760), "结论：先把研究过程固定住，结果才有比较意义。", 42, fill=INK, bold=True)
        return img

    def scene_window_comparison(self, segment: Segment, local: float) -> Image.Image:
        img = self.base_light().convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (86, 70), "案例数字：同一规则，三种结果", 54, fill=INK, bold=True)
        draw_badge(d, 90, 154, "多阶段对比", (220, 252, 231), (21, 128, 61), 28)
        windows = [
            ("bull", "上涨窗口", "赚了130%多", GREEN, "23 次交易  胜率 48% 左右"),
            ("bear", "下跌窗口", "亏了45%左右", RED, "21 次交易  胜率 24% 左右"),
            ("chop", "震荡回撤", "亏了27%左右", AMBER, "11 次交易  胜率 18% 左右"),
        ]
        for i, (key, title, result, color, detail) in enumerate(windows):
            p = ease_out_cubic((local - 0.08 - i * 0.16) / 0.18)
            x = int(88 + i * 610 + (1 - p) * 70)
            self.draw_market_chart(
                d,
                key,
                (x, 240, x + 520, 675),
                p,
                title,
                color,
                dark=False,
                show_ma=True,
                show_signals=False,
                show_candles=False,
            )
            if p > 0.45:
                badge_p = ease_out_cubic((p - 0.45) / 0.35)
                draw_round(d, (x + 28, 690, x + 492, 760), (255, 255, 255, int(235 * badge_p)), radius=18, outline=LINE, width=2)
                draw_text(d, (x + 54, 706), result, 34, fill=color, bold=True)
                draw_text(d, (x + 272, 713), detail, 22, fill=MUTED)
        callout_p = ease_out_cubic((local - 0.66) / 0.18)
        if callout_p > 0:
            y = int(812 + (1 - callout_p) * 50)
            draw_round(d, (128, y, 1792, y + 110), (255, 247, 237, int(235 * callout_p)), radius=22, outline=(251, 191, 36), width=2)
            draw_text(d, (170, y + 38), "同一套规则在不同市场阶段的表现差异很大。", 42, fill=(146, 64, 14), bold=True)
            draw_text(d, (1290, y + 57), "差不多两倍", int(46 * pop(callout_p)), fill=RED, bold=True, anchor="mm")
        return img

    def draw_metric_card(self, draw: ImageDraw.ImageDraw, x: int, y: int, item, p: float):
        title, verb, number, suffix, color, detail = item
        alpha_v = int(235 * p)
        draw_round(draw, (x, y, x + 500, y + 430), (255, 255, 255, alpha_v), radius=24, outline=LINE, width=2)
        if p < 0.15:
            return
        draw_text(draw, (x + 36, y + 46), title, 34, fill=INK, bold=True)
        value = int(round(number * ease_out_cubic((p - 0.25) / 0.55)))
        draw_text(draw, (x + 36, y + 154), f"{verb}{value}{suffix}", 62, fill=color, bold=True)
        lines = detail.split("  ")
        for i, line in enumerate(lines):
            draw_text(draw, (x + 36, y + 260 + i * 45), line, 29, fill=(55, 65, 81), bold=i == 2)

    def scene_market_weather(self, segment: Segment, local: float) -> Image.Image:
        img = self.base_dark()
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (92, 70), "为什么：漂亮结果可能只是顺风车", 54, fill=WHITE, bold=True)
        phases = [
            ("bull", "上涨阶段", GREEN),
            ("bear", "下跌阶段", RED),
            ("chop", "震荡阶段", AMBER),
        ]
        for i, (key, label, color) in enumerate(phases):
            p = ease_out_cubic((local - 0.08 - i * 0.16) / 0.18)
            x = 110 + i * 590
            self.draw_market_chart(
                d,
                key,
                (x, 225, x + 500, 690),
                p,
                label,
                color,
                dark=True,
                show_ma=False,
                show_signals=False,
                show_candles=False,
            )
        if local > 0.62:
            p = ease_out_cubic((local - 0.62) / 0.16)
            draw_round(d, (330, 790, 1590, 900), (255, 255, 255, int(225 * p)), radius=22)
            draw_text(d, (960, 845), "不是策略突然聪明，而是市场环境可能在帮忙。", 44, fill=INK, bold=True, anchor="mm")
        return img

    def scene_diagnosis(self, segment: Segment, local: float) -> Image.Image:
        img = self.base_light().convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (86, 70), "诊断：别只看收益率", 58, fill=INK, bold=True)
        metrics = [
            ("回撤压力", "30% 左右到接近 47%", RED, "先看自己扛不扛得住"),
            ("样本数量", "样本偏少", BLUE, "样本太少就别急着下结论"),
            ("利润集中度", "70% 多", (124, 58, 237), "收益是否集中在少数机会"),
            ("跨阶段表现", "差异明显", AMBER, "顺风和逆风要分开看"),
        ]
        for i, item in enumerate(metrics):
            p = ease_out_cubic((local - 0.08 - i * 0.13) / 0.18)
            x = 120 + (i % 2) * 860
            y = 220 + (i // 2) * 285
            self.draw_diagnostic_card(d, x, y, item, p)
        if local > 0.72:
            p = ease_out_cubic((local - 0.72) / 0.12)
            draw_round(d, (118, 840, 1802, 930), (239, 246, 255, int(235 * p)), radius=22, outline=(147, 197, 253), width=2)
            draw_text(d, (154, 868), "这类检查的目的，是把看似漂亮的收益拆开看清楚。", 38, fill=(30, 64, 175), bold=True)
        return img

    def draw_diagnostic_card(self, draw: ImageDraw.ImageDraw, x: int, y: int, item, p: float):
        title, value, color, note = item
        draw_round(draw, (x, y, x + 720, y + 205), (255, 255, 255, int(235 * p)), radius=24, outline=LINE, width=2)
        if p <= 0.12:
            return
        draw_text(draw, (x + 38, y + 34), title, 36, fill=INK, bold=True)
        draw_text(draw, (x + 38, y + 92), value, int(48 * pop(p)), fill=color, bold=True)
        draw_text(draw, (x + 38, y + 156), note, 28, fill=MUTED)
        bar_w = int(620 * p)
        draw_round(draw, (x + 38, y + 186, x + 38 + bar_w, y + 196), rgba(color, 190), radius=8)

    def scene_product_workflow(self, segment: Segment, local: float) -> Image.Image:
        img = self.base_dark()
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (88, 76), "流程：把想法变成可复跑实验", 56, fill=WHITE, bold=True)
        draw_text(d, (92, 152), "产品露出只服务一个问题：怎么把研究流程沉淀下来。", 34, fill=(203, 213, 225))
        nodes = [
            ("策略想法", "一句研究假设"),
            ("历史实验", "固定窗口和规则"),
            ("运行记录", "保存每次结果"),
            ("横向报告", "比较不同阶段"),
            ("AI 整理", "生成下一轮问题"),
        ]
        y = 405
        centers = []
        for i, (title, sub) in enumerate(nodes):
            p = ease_out_cubic((local - 0.08 - i * 0.1) / 0.16)
            x = 92 + i * 350
            centers.append((x + 145, y + 95))
            draw_round(d, (x, y, x + 290, y + 190), (255, 255, 255, int(230 * p)), radius=26)
            if p > 0.1:
                draw_text(d, (x + 145, y + 60), title, 34, fill=INK, bold=True, anchor="mm")
                draw_text(d, (x + 145, y + 116), sub, 24, fill=MUTED, anchor="mm")
            if i > 0 and p > 0.2:
                prev = centers[i - 1]
                cur = centers[i]
                d.line((prev[0] + 154, prev[1], cur[0] - 154, cur[1]), fill=rgba(CYAN, 220), width=6)
                dot_t = ((local * 3.5) + i * 0.13) % 1
                dx = int(lerp(prev[0] + 154, cur[0] - 154, dot_t))
                d.ellipse((dx - 8, prev[1] - 8, dx + 8, prev[1] + 8), fill=CYAN)
        if local > 0.62:
            p = ease_out_cubic((local - 0.62) / 0.2)
            draw_round(d, (500, 720, 1420, 825), (10, 132, 255, int(220 * p)), radius=24)
            draw_text(d, (960, 772), "CryptoPathX：把研究动作变成可复盘记录", 40, fill=WHITE, bold=True, anchor="mm")
        return img

    def scene_closing(self, segment: Segment, local: float) -> Image.Image:
        img = self.base_dark()
        d = ImageDraw.Draw(img, "RGBA")
        draw_text(d, (92, 80), "结尾判断标准", 54, fill=WHITE, bold=True)
        words = ["不是相信最漂亮的曲线", "而是知道什么时候该怀疑它"]
        for i, line in enumerate(words):
            p = ease_out_cubic((local - 0.12 - i * 0.18) / 0.18)
            x = int(180 + (1 - p) * -90)
            y = 290 + i * 120
            draw_text(d, (x, y), line, int(64 * pop(p)), fill=WHITE, bold=True, shadow=True)
        checks = [("窗口", BLUE), ("回撤", RED), ("样本量", AMBER), ("集中度", GREEN)]
        for i, (label, color) in enumerate(checks):
            p = ease_out_cubic((local - 0.56 - i * 0.06) / 0.12)
            if p <= 0:
                continue
            x = 260 + i * 330
            y = 650
            draw_round(d, (x, y, x + 240, y + 74), rgba(color, int(210 * p)), radius=22)
            draw_text(d, (x + 120, y + 37), label, 32, fill=WHITE, bold=True, anchor="mm")
        if local > 0.8:
            p = ease_out_cubic((local - 0.8) / 0.12)
            draw_round(d, (460, 790, 1460, 890), (255, 255, 255, int(225 * p)), radius=24)
            draw_text(d, (960, 840), "跨窗口复盘，提高研究结论的可信度。", 40, fill=INK, bold=True, anchor="mm")
        return img


def ffprobe_duration_ms(path: Path) -> int:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return int(round(float(result.stdout.strip()) * 1000))


def has_encoder(name: str) -> bool:
    result = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], check=True, capture_output=True, text=True)
    return name in result.stdout


def encoder_args(preference: str) -> list[str]:
    if preference == "nvenc" and has_encoder("h264_nvenc"):
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-b:v", "0"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]


def render_video(
    renderer: MotionRenderer,
    audio_source: Path,
    output_path: Path,
    encoder: str,
    max_seconds: float | None = None,
):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration_ms = min(renderer.duration_ms, int(max_seconds * 1000)) if max_seconds else renderer.duration_ms
    total_frames = math.ceil(duration_ms / 1000 * FPS)
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{WIDTH}x{HEIGHT}",
        "-r",
        str(FPS),
        "-i",
        "-",
        "-i",
        str(audio_source),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        *encoder_args(encoder),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-shortest",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    process = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame_no in range(total_frames):
            frame = renderer.frame(frame_no)
            process.stdin.write(frame.tobytes())
            if frame_no % (FPS * 30) == 0 and frame_no:
                print(f"[motion-v2] rendered {frame_no}/{total_frames} frames")
    finally:
        process.stdin.close()
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"ffmpeg exited with {code}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--composition", required=True)
    parser.add_argument("--motion-plan")
    parser.add_argument("--subtitles", required=True)
    parser.add_argument("--audio-source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--encoder", default="nvenc", choices=["nvenc", "x264"])
    parser.add_argument("--max-seconds", type=float)
    parser.add_argument("--write-resolved-motion-plan")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError("ffmpeg and ffprobe are required")
    renderer = MotionRenderer(Path(args.composition), Path(args.subtitles), Path(args.motion_plan) if args.motion_plan else None)
    if args.write_resolved_motion_plan:
        renderer.write_resolved_motion_plan(Path(args.write_resolved_motion_plan))
    if args.dry_run:
        print(
            json.dumps(
                {
                    "ok": True,
                    "durationMs": renderer.duration_ms,
                    "motionPlanVersion": renderer.motion_plan.get("version"),
                    "sceneCount": len(renderer.motion_scenes),
                    "sceneTypes": [scene.scene_type for scene in renderer.motion_scenes],
                },
                ensure_ascii=False,
            )
        )
        return
    render_video(renderer, Path(args.audio_source), Path(args.output), args.encoder, args.max_seconds)
    print(json.dumps({"ok": True, "output": args.output, "durationMs": ffprobe_duration_ms(Path(args.output))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
