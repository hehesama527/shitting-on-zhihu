# -*- coding: utf-8 -*-
"""HTTP adapter for the local CosyVoice deployment.

The video worker calls POST /tts with:
  { "text": "...", "outputPath": "C:/path/out.wav", "format": "wav", "useGpu": true }

This server keeps CosyVoice loaded in memory so each segment does not pay the
model startup cost.
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
from pathlib import Path
from typing import Optional

import torch
import torchaudio
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


DEFAULT_AUDIO_TTS_ROOT = r"E:\audio_tts"


class TtsRequest(BaseModel):
    text: str
    outputPath: Optional[str] = None
    format: str = "wav"
    useGpu: bool = True


def configure_imports(audio_tts_root: str):
    root = Path(audio_tts_root).resolve()
    if not root.exists():
        raise RuntimeError(f"Cosy root does not exist: {root}")

    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "CosyVoice"))
    sys.path.insert(0, str(root / "CosyVoice" / "third_party" / "Matcha-TTS"))
    os.chdir(root)
    return root


def create_app(audio_tts_root: str):
    root = configure_imports(audio_tts_root)
    import run_voiceover_from_file as cosy_script  # type: ignore
    from cosyvoice.cli.cosyvoice import AutoModel  # type: ignore

    app = FastAPI(title="Local CosyVoice TTS Adapter")
    lock = threading.Lock()
    state = {
        "model": None,
        "sample_rate": None,
        "root": str(root),
        "model_dir": cosy_script.MODEL_DIR,
        "reference_audio": cosy_script.REF,
    }

    def load_model():
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is not available; refusing to run CosyVoice on CPU.")
        if not Path(cosy_script.REF).exists():
            raise RuntimeError(f"Reference audio does not exist: {cosy_script.REF}")
        if state["model"] is None:
            state["model"] = AutoModel(model_dir=cosy_script.MODEL_DIR)
            state["sample_rate"] = state["model"].sample_rate
        return state["model"]

    @app.on_event("startup")
    def startup():
        load_model()

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "cuda": torch.cuda.is_available(),
            "modelLoaded": state["model"] is not None,
            "modelDir": state["model_dir"],
            "referenceAudio": state["reference_audio"],
        }

    @app.post("/tts")
    def tts(request: TtsRequest):
        text = request.text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="text is required")
        if request.format.lower() != "wav":
            raise HTTPException(status_code=400, detail="Only wav output is supported")
        if request.useGpu and not torch.cuda.is_available():
            raise HTTPException(status_code=503, detail="CUDA is not available")

        output_path = Path(request.outputPath or (root / "output_v3" / "video_worker_tts.wav")).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with lock:
                cosyvoice = load_model()
                chunks = synthesize_chunks(cosyvoice, cosy_script, text)
                if not chunks and len(text) < 40:
                    chunks = synthesize_chunks(cosyvoice, cosy_script, f"\ufeff{text}")

                if not chunks:
                    raise RuntimeError("CosyVoice generated no audio chunks")

                audio = torch.cat(chunks, dim=1) if len(chunks) > 1 else chunks[0]
                torchaudio.save(str(output_path), audio, cosyvoice.sample_rate)
                duration_sec = float(audio.shape[1] / cosyvoice.sample_rate)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        return {
            "ok": True,
            "filePath": str(output_path),
            "durationSec": duration_sec,
        }

    return app


def synthesize_chunks(cosyvoice, cosy_script, text: str):
    chunks = []
    for item in cosyvoice.inference_zero_shot(
        text,
        cosy_script.PROMPT_TEXT,
        cosy_script.REF,
        stream=False,
    ):
        chunks.append(item["tts_speech"])
    return chunks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.environ.get("COSY_AUDIO_TTS_ROOT", DEFAULT_AUDIO_TTS_ROOT))
    parser.add_argument("--host", default=os.environ.get("COSY_TTS_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("COSY_TTS_PORT", "8795")))
    args = parser.parse_args()

    app = create_app(args.root)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
