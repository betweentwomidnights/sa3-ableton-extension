#!/usr/bin/env python3
"""
Stable Audio 3 localhost API.

Small local API wrapper for the SA3 Ableton extension. The model implementation
comes from the official Stable Audio 3 Python package.
"""

from __future__ import annotations

import base64
import gc
import io
import json
import math
import os
import random
import re
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request
from flask_cors import CORS

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - .env loading is a convenience
    load_dotenv = None


BASE_DIR = Path(__file__).resolve().parent
if load_dotenv is not None:
    load_dotenv(BASE_DIR / ".env", override=False)

RUNTIME_IMPORT_ERRORS: dict[str, str] = {}

try:
    import soundfile as sf
except Exception as exc:  # pragma: no cover - reported by /health
    sf = None
    RUNTIME_IMPORT_ERRORS["soundfile"] = str(exc)

try:
    import torch
except Exception as exc:  # pragma: no cover - reported by /health
    torch = None
    RUNTIME_IMPORT_ERRORS["torch"] = str(exc)

try:
    import torchaudio
except Exception as exc:  # pragma: no cover - reported by /health
    torchaudio = None
    RUNTIME_IMPORT_ERRORS["torchaudio"] = str(exc)

try:
    from einops import rearrange
except Exception as exc:  # pragma: no cover - reported by /health
    rearrange = None
    RUNTIME_IMPORT_ERRORS["einops"] = str(exc)

try:
    from huggingface_hub import login
except Exception:  # pragma: no cover - import diagnostics are surfaced at load time
    login = None

try:
    from stable_audio_3 import StableAudioModel
    from stable_audio_3.inference.distribution_shift import (
        DistributionShift,
        FluxDistributionShift,
        IdentityDistributionShift,
        LogSNRShift,
    )
except Exception as exc:  # pragma: no cover - reported by /health
    StableAudioModel = None
    DistributionShift = None
    FluxDistributionShift = None
    IdentityDistributionShift = None
    LogSNRShift = None
    RUNTIME_IMPORT_ERRORS["stable_audio_3"] = str(exc)



os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

app = Flask(__name__)
CORS(app)


MODEL_NAME = os.environ.get("SA3_MODEL", "medium")
MODEL_HALF = os.environ.get("SA3_MODEL_HALF", "1") != "0"
DEFAULT_STEPS = int(os.environ.get("SA3_DEFAULT_STEPS", "8"))
DEFAULT_CFG = float(os.environ.get("SA3_DEFAULT_CFG", "1.0"))
DEFAULT_NEGATIVE = os.environ.get("SA3_DEFAULT_NEGATIVE", "low quality")
DEFAULT_DURATION = float(os.environ.get("SA3_DEFAULT_DURATION", "30"))
MAX_DURATION = float(os.environ.get("SA3_MAX_DURATION", "300"))
DEFAULT_SAMPLER = os.environ.get("SA3_DEFAULT_SAMPLER", "pingpong")
DEFAULT_LOOP_BARS = int(os.environ.get("SA3_DEFAULT_LOOP_BARS", "8"))
LOOP_PAD_SECONDS = float(os.environ.get("SA3_LOOP_PAD_SECONDS", "2.0"))
DEFAULT_CONTINUATION_SECONDS = float(os.environ.get("SA3_DEFAULT_CONTINUATION_SECONDS", "8.0"))
CONTINUE_TAIL_MODE = os.environ.get("SA3_CONTINUE_TAIL_MODE", "regen_past").lower()
CONTINUE_TAIL_PAD = float(os.environ.get("SA3_CONTINUE_TAIL_PAD", "6.0"))
CONTINUE_TAIL_PAD_MAX = float(os.environ.get("SA3_CONTINUE_TAIL_PAD_MAX", "60.0"))
OUTPUT_SAMPLE_RATE = int(os.environ.get("SA3_SAMPLE_RATE", "44100"))

OUTPUT_DIR = os.environ.get("OUTPUT_DIR") or str(BASE_DIR / "outputs")
PROMPTS_DIR = os.environ.get("SA3_PROMPTS_DIR") or str(BASE_DIR / "prompts")
LORA_DIR = os.environ.get("SA3_LORA_DIR") or str(BASE_DIR / "loras")
LORA_REGISTRY_PATH = os.environ.get("SA3_LORA_REGISTRY") or os.path.join(
    Path(PROMPTS_DIR).resolve().parent, "lora_registry.json"
)
DEFAULT_LORA_NAME = os.environ.get("SA3_DEFAULT_LORA", "").strip()
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(PROMPTS_DIR, exist_ok=True)
os.makedirs(LORA_DIR, exist_ok=True)

VALID_SHIFTS = {"default", "none", "logsnr", "flux", "full"}
VALID_LOOP_BARS = {4, 8, 16, 32}
VALID_CONTINUATION_MODES = {"inpaint"}
LORA_EXTS = (".ckpt", ".safetensors")
_BPM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*bpm", re.IGNORECASE)


def env_optional_float(name: str, default: float | None = None) -> float | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    raw = raw.strip()
    if not raw or raw.lower() in {"off", "none", "disable", "disabled"}:
        return None
    return float(raw)


LATENT_DIAG = os.environ.get("SA3_LATENT_DIAG", "0") != "0"
LATENT_RESCALE = float(os.environ.get("SA3_LATENT_RESCALE", "1.0"))
LATENT_SHIFT = float(os.environ.get("SA3_LATENT_SHIFT", "0.0"))
LATENT_TARGET_STD = env_optional_float("SA3_LATENT_TARGET_STD")
LATENT_ADAPT_MIN = float(os.environ.get("SA3_LATENT_ADAPT_MIN", "0.9"))
LATENT_ADAPT_MAX = float(os.environ.get("SA3_LATENT_ADAPT_MAX", "1.0"))
PEAK_NORM_DB = env_optional_float("SA3_PEAK_NORMALIZE_DB", 2.0)
LIMITER_CEILING_DB = env_optional_float("SA3_LIMITER_CEILING_DB", -0.3)
if LIMITER_CEILING_DB is not None and LIMITER_CEILING_DB > 0.0:
    LIMITER_CEILING_DB = None
LIMITER_KNEE = float(os.environ.get("SA3_LIMITER_KNEE", "0.8"))

# A ceiling, not a fixed allocation: StableAudioModel adapts this down to the
# requested duration. It prevents the upstream 120s default cap from clipping
# legitimate longer local requests.
MAX_SAMPLE_SIZE = int((MAX_DURATION + CONTINUE_TAIL_PAD_MAX + 40.0) * OUTPUT_SAMPLE_RATE)

SA3_MODEL_LINKS = {
    "stable-audio-3-medium": "https://huggingface.co/stabilityai/stable-audio-3-medium",
    "t5gemma-b-b-ul2": "https://huggingface.co/google/t5gemma-b-b-ul2",
}


sessions: dict[str, dict[str, Any]] = {}
sessions_lock = threading.Lock()
model_lock = threading.Lock()
generation_lock = threading.Lock()

pipe: StableAudioModel | None = None
model_loaded = False
model_loading = False
model_error: str | None = None
last_load_seconds = 0.0
model_sample_rate = OUTPUT_SAMPLE_RATE
model_device: str | None = None
lora_registry: list[tuple[str, str]] = []
lora_name_to_index: dict[str, int] = {}


def cuda_mem_mb() -> dict[str, float] | None:
    if torch is None or not torch.cuda.is_available():
        return None
    free, total = torch.cuda.mem_get_info()
    return {
        "allocated_mb": round(torch.cuda.memory_allocated() / 1048576, 1),
        "reserved_mb": round(torch.cuda.memory_reserved() / 1048576, 1),
        "free_mb": round(free / 1048576, 1),
        "total_mb": round(total / 1048576, 1),
    }


def cleanup_cuda() -> None:
    for _ in range(2):
        gc.collect()
    if torch is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()


def hf_token_configured() -> bool:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    return bool(token and token.strip())


def configure_hf_auth() -> None:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token:
        return
    os.environ.setdefault("HUGGING_FACE_HUB_TOKEN", token)
    if login is None:
        return
    try:
        login(token=token, add_to_git_credential=False)
    except TypeError:
        login(token=token)


def normalize_lora_name(raw: str) -> str:
    return raw.strip().lower()


def lora_path_is_valid(path: str) -> bool:
    return path.lower().endswith(LORA_EXTS) and os.path.isfile(path)


def scan_lora_dir() -> list[tuple[str, str]]:
    if not os.path.isdir(LORA_DIR):
        return []
    entries = []
    for filename in sorted(os.listdir(LORA_DIR)):
        if not filename.lower().endswith(LORA_EXTS):
            continue
        path = os.path.join(LORA_DIR, filename)
        if os.path.isfile(path):
            entries.append((os.path.splitext(filename)[0].lower(), path))
    return entries


def read_lora_registry_file() -> list[tuple[str, str]]:
    if not os.path.isfile(LORA_REGISTRY_PATH):
        return []
    with open(LORA_REGISTRY_PATH, encoding="utf-8") as handle:
        raw = json.load(handle)

    entries: list[tuple[str, str]] = []
    if isinstance(raw, dict):
        for name, value in raw.items():
            if isinstance(value, dict):
                path = value.get("path")
            else:
                path = value
            if not isinstance(path, str):
                continue
            clean_name = normalize_lora_name(str(name))
            if clean_name and lora_path_is_valid(path):
                entries.append((clean_name, path))
    elif isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = normalize_lora_name(str(item.get("name") or ""))
            path = item.get("path")
            if name and isinstance(path, str) and lora_path_is_valid(path):
                entries.append((name, path))

    seen = set()
    deduped = []
    for name, path in sorted(entries, key=lambda item: item[0]):
        if name in seen:
            continue
        seen.add(name)
        deduped.append((name, path))
    return deduped


def configured_loras() -> list[tuple[str, str]]:
    try:
        registry_entries = read_lora_registry_file()
    except Exception as exc:
        print(f"[sa3] could not read LoRA registry {LORA_REGISTRY_PATH}: {exc}")
        registry_entries = []
    return registry_entries if registry_entries else scan_lora_dir()


def lora_payload(entries: list[tuple[str, str]]) -> list[dict[str, Any]]:
    return [{"index": i, "name": name, "path": path} for i, (name, path) in enumerate(entries)]


def friendly_load_error(error: Exception) -> str:
    raw = str(error)
    lower = raw.lower()
    if RUNTIME_IMPORT_ERRORS:
        missing = ", ".join(sorted(RUNTIME_IMPORT_ERRORS))
        return (
            f"Missing SA3 runtime dependency/dependencies: {missing}. "
            "Install the backend requirements and the official stable-audio-3 package."
        )
    if not hf_token_configured():
        return (
            "HF_TOKEN is not configured. Set a Hugging Face read token, then "
            "accept the model terms for Stable Audio 3 Medium and T5Gemma."
        )
    if any(marker in lower for marker in ("401", "403", "gated", "restricted", "access")):
        return (
            "Hugging Face token is configured, but this account may not have "
            "accepted all gated model terms for SA3. Open the Stable Audio 3 "
            "Medium and T5Gemma model pages, accept access, then retry."
        )
    return raw


def load_pipeline(force: bool = False) -> StableAudioModel:
    global pipe, model_loaded, model_loading, model_error, last_load_seconds
    global model_sample_rate, model_device
    global lora_registry, lora_name_to_index

    with model_lock:
        if pipe is not None and not force:
            return pipe

        model_loading = True
        model_error = None
        if force:
            pipe = None
            model_loaded = False
            cleanup_cuda()

        started = time.time()
        try:
            if RUNTIME_IMPORT_ERRORS or StableAudioModel is None:
                raise RuntimeError(friendly_load_error(RuntimeError("SA3 runtime is not installed")))
            configure_hf_auth()
            print(f"[sa3] loading Stable Audio 3 model={MODEL_NAME} half={MODEL_HALF}")
            loaded = StableAudioModel.from_pretrained(MODEL_NAME, model_half=MODEL_HALF)

            registry = configured_loras()
            if registry:
                paths = [path for _, path in registry]
                print(f"[sa3] preloading {len(paths)} LoRA(s): {[name for name, _ in registry]}")
                loaded.load_lora(paths)
            else:
                print(f"[sa3] no LoRA files configured")

            lora_registry = registry
            lora_name_to_index = {name: i for i, (name, _) in enumerate(registry)}
            pipe = loaded
            model_loaded = True
            model_sample_rate = int(loaded.model_config.get("sample_rate", OUTPUT_SAMPLE_RATE))
            model_device = str(loaded.device)
            last_load_seconds = round(time.time() - started, 2)
            print(
                f"[sa3] model ready in {last_load_seconds}s "
                f"sr={model_sample_rate} device={model_device} mem={cuda_mem_mb()}"
            )
            return loaded
        except Exception as exc:
            model_loaded = False
            model_error = friendly_load_error(exc)
            print(f"[sa3] model load failed: {model_error}")
            traceback.print_exc()
            raise
        finally:
            model_loading = False


def unload_pipeline() -> dict[str, Any]:
    global pipe, model_loaded, model_error
    with model_lock:
        before = cuda_mem_mb()
        pipe = None
        model_loaded = False
        model_error = None
        cleanup_cuda()
        if torch is not None and torch.cuda.is_available():
            torch.cuda.synchronize()
        after = cuda_mem_mb()
        freed = None
        if before and after:
            freed = round(before["allocated_mb"] - after["allocated_mb"], 1)
        return {"status": "unloaded", "freed_mb": freed, "before": before, "after": after}


def create_session(meta: dict[str, Any]) -> str:
    session_id = str(uuid.uuid4())[:12]
    with sessions_lock:
        sessions[session_id] = {
            "status": "queued",
            "generation_in_progress": True,
            "transform_in_progress": meta.get("mode") == "transform",
            "progress": 0,
            "step": 0,
            "total_steps": meta.get("steps", DEFAULT_STEPS),
            "audio_data": None,
            "error": None,
            "meta": meta,
            "created_at": time.time(),
        }
    return session_id


def update_session(session_id: str, **updates: Any) -> None:
    with sessions_lock:
        if session_id in sessions:
            sessions[session_id].update(updates)


def get_session(session_id: str) -> dict[str, Any] | None:
    with sessions_lock:
        value = sessions.get(session_id)
        return value.copy() if value else None


def cleanup_old_sessions(max_age_seconds: float = 1800.0) -> None:
    now = time.time()
    with sessions_lock:
        expired = [sid for sid, s in sessions.items() if now - s.get("created_at", 0) > max_age_seconds]
        for sid in expired:
            sessions.pop(sid, None)


def get_json_body() -> dict[str, Any] | None:
    data = request.get_json(silent=True)
    if data is not None:
        return data
    raw = request.get_data(as_text=True)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def extract_bpm(prompt: str) -> float | None:
    match = _BPM_RE.search(prompt or "")
    return float(match.group(1)) if match else None


def parse_float(data: dict[str, Any], key: str, default: float) -> float:
    raw = data.get(key, default)
    if raw in (None, ""):
        return default
    return float(raw)


def parse_int(data: dict[str, Any], key: str, default: int) -> int:
    raw = data.get(key, default)
    if raw in (None, ""):
        return default
    return int(raw)


def parse_optional_float(data: dict[str, Any], key: str, default: float | None) -> float | None:
    raw = data.get(key, default)
    if raw in (None, ""):
        return default
    if isinstance(raw, str) and raw.strip().lower() in {"off", "none", "disable", "disabled"}:
        return None
    return float(raw)


def parse_peak_normalize_db(data: dict[str, Any]) -> float | None:
    return parse_optional_float(data, "peak_normalize_db", PEAK_NORM_DB)


def parse_limiter_ceiling_db(data: dict[str, Any]) -> float | None:
    value = parse_optional_float(data, "limiter_ceiling_db", LIMITER_CEILING_DB)
    return None if value is not None and value > 0.0 else value


def float_or_default(value: float | None, default: float) -> float:
    return default if value is None else value


def loudness_params(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "latent_rescale": float_or_default(
            parse_optional_float(data, "latent_rescale", LATENT_RESCALE),
            1.0,
        ),
        "latent_shift": float_or_default(
            parse_optional_float(data, "latent_shift", LATENT_SHIFT),
            0.0,
        ),
        "latent_target_std": parse_optional_float(data, "latent_target_std", LATENT_TARGET_STD),
        "latent_adapt_min": float_or_default(
            parse_optional_float(data, "latent_adapt_min", LATENT_ADAPT_MIN),
            LATENT_ADAPT_MIN,
        ),
        "latent_adapt_max": float_or_default(
            parse_optional_float(data, "latent_adapt_max", LATENT_ADAPT_MAX),
            LATENT_ADAPT_MAX,
        ),
        "peak_normalize_db": parse_peak_normalize_db(data),
        "limiter_ceiling_db": parse_limiter_ceiling_db(data),
        "limiter_knee": float_or_default(
            parse_optional_float(data, "limiter_knee", LIMITER_KNEE),
            LIMITER_KNEE,
        ),
    }


def resolve_seed(data: dict[str, Any]) -> int:
    seed = parse_int(data, "seed", -1)
    return random.randint(0, 99999) if seed == -1 else seed


def resolve_dist_shift(model: StableAudioModel, shift: str):
    shift = (shift or "default").lower()
    if shift == "default":
        return None
    if shift == "none":
        return IdentityDistributionShift()
    families = {
        "logsnr": LogSNRShift,
        "flux": FluxDistributionShift,
        "full": DistributionShift,
    }
    cls = families[shift]
    default = getattr(model.model, "sampling_dist_shift", None)
    return default if isinstance(default, cls) else cls()


def validate_common(data: dict[str, Any], require_duration: bool = True) -> list[str]:
    errors: list[str] = []
    if not (data.get("prompt") or "").strip():
        errors.append("prompt is required")

    if require_duration:
        try:
            duration = parse_float(data, "duration", DEFAULT_DURATION)
            if duration <= 0 or duration > MAX_DURATION:
                errors.append(f"duration must be in (0, {MAX_DURATION}] seconds")
        except (TypeError, ValueError):
            errors.append("duration must be a number")

    try:
        steps = parse_int(data, "steps", DEFAULT_STEPS)
        if steps < 1 or steps > 200:
            errors.append("steps must be in [1, 200]")
    except (TypeError, ValueError):
        errors.append("steps must be an integer")

    try:
        cfg = parse_float(data, "cfg_scale", DEFAULT_CFG)
        if cfg < 0 or cfg > 25:
            errors.append("cfg_scale must be in [0, 25]")
    except (TypeError, ValueError):
        errors.append("cfg_scale must be a number")

    shift = (data.get("shift") or "default").lower()
    if shift not in VALID_SHIFTS:
        errors.append(f"shift must be one of {sorted(VALID_SHIFTS)}")

    if data.get("loras") is not None and not isinstance(data.get("loras"), list):
        errors.append("loras must be a list")

    try:
        loudness = loudness_params(data)
        target_std = loudness["latent_target_std"]
        if loudness["latent_rescale"] < 0:
            errors.append("latent_rescale must be >= 0")
        if target_std is not None and target_std <= 0:
            errors.append("latent_target_std must be > 0 or off")
        if loudness["latent_adapt_min"] < 0 or loudness["latent_adapt_max"] < loudness["latent_adapt_min"]:
            errors.append("latent_adapt_min/max must satisfy 0 <= min <= max")
        if loudness["limiter_knee"] <= 0 or loudness["limiter_knee"] > 1:
            errors.append("limiter_knee must be in (0, 1]")
    except (TypeError, ValueError):
        errors.append("loudness fields must be numbers, empty, or off")

    return errors


def resolve_loras(data: dict[str, Any]) -> list[dict[str, Any]]:
    entries = data.get("loras")
    if entries is None:
        selected = normalize_lora_name(str(data.get("lora") or ""))
        if not selected or selected == "none":
            return []
        if selected == "default":
            selected = DEFAULT_LORA_NAME or (lora_registry[0][0] if lora_registry else "")
        if not selected:
            return []
        entries = [{"name": selected, "strength": data.get("lora_strength", 1.0)}]

    resolved = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("each loras entry must be an object")
        name = normalize_lora_name(str(entry.get("name") or ""))
        if not name:
            raise ValueError("each loras entry needs a name")
        if name not in lora_name_to_index:
            raise ValueError(f"unknown LoRA '{name}'. available: {list(lora_name_to_index)}")

        interval_min = float(entry.get("interval_min", 0.0))
        interval_max = float(entry.get("interval_max", 1.0))
        if not (0.0 <= interval_min <= interval_max <= 1.0):
            raise ValueError(f"LoRA '{name}': require 0 <= interval_min <= interval_max <= 1")

        resolved.append(
            {
                "lora_index": lora_name_to_index[name],
                "name": name,
                "strength": float(entry.get("strength", 1.0)),
                "interval": (interval_min, interval_max),
                "layer_filter": str(entry.get("layer_filter", "") or ""),
            }
        )
    return resolved


def common_params(data: dict[str, Any], duration: float | None = None) -> dict[str, Any]:
    return {
        "prompt": data["prompt"].strip(),
        "negative_prompt": (data.get("negative_prompt", DEFAULT_NEGATIVE) or "").strip(),
        "duration": duration if duration is not None else parse_float(data, "duration", DEFAULT_DURATION),
        "steps": parse_int(data, "steps", DEFAULT_STEPS),
        "cfg_scale": parse_float(data, "cfg_scale", DEFAULT_CFG),
        "shift": (data.get("shift") or "default").lower(),
        "sampler_type": data.get("sampler_type", DEFAULT_SAMPLER),
        "seed": resolve_seed(data),
        "target_samples": None,
        "mode": "generate",
        "loras_request": data.get("loras"),
        "lora": data.get("lora"),
        "lora_strength": data.get("lora_strength"),
        **loudness_params(data),
    }


def decode_audio_data(data: dict[str, Any]) -> tuple[int, torch.Tensor]:
    if torchaudio is None:
        raise RuntimeError("torchaudio is not installed")
    encoded = data.get("audio_data")
    if not encoded:
        raise ValueError("audio_data (base64 WAV) is required")
    if isinstance(encoded, str) and encoded.startswith("data:") and "," in encoded:
        encoded = encoded.split(",", 1)[1]
    raw = base64.b64decode(encoded)
    waveform, sample_rate = torchaudio.load(io.BytesIO(raw))
    return sample_rate, waveform


def encode_wav_base64(audio: torch.Tensor, sample_rate: int) -> str:
    if sf is None:
        raise RuntimeError("soundfile is not installed")
    if rearrange is None:
        raise RuntimeError("einops is not installed")
    # audio is [batch, channels, samples]. The API returns one rendered sequence.
    if audio.dim() == 3:
        audio = rearrange(audio, "b d n -> d (b n)")
    audio = audio.to(torch.float32).clamp(-1, 1).cpu()
    wav = io.BytesIO()
    sf.write(wav, audio.transpose(0, 1).numpy(), sample_rate, format="WAV", subtype="PCM_16")
    wav.seek(0)
    return base64.b64encode(wav.read()).decode("ascii")


def apply_target_length(audio: torch.Tensor, target_samples: int | None) -> torch.Tensor:
    if target_samples is None:
        return audio
    current = audio.shape[-1]
    if current > target_samples:
        return audio[..., :target_samples]
    if current < target_samples:
        return torch.nn.functional.pad(audio, (0, target_samples - current))
    return audio


def loudness_meta_from_params(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "latent_rescale": params["latent_rescale"],
        "latent_shift": params["latent_shift"],
        "latent_target_std": params["latent_target_std"],
        "latent_adapt_min": params["latent_adapt_min"],
        "latent_adapt_max": params["latent_adapt_max"],
        "latent_factor": 1.0,
        "latent_std": None,
        "peak_normalize_db": params["peak_normalize_db"],
        "peak_normalize_gain": None,
        "limiter_ceiling_db": params["limiter_ceiling_db"],
        "limiter_knee": params["limiter_knee"],
        "limiter_limited_fraction": None,
        "decoded_peak": None,
        "final_peak": None,
    }


def should_use_loudness_latent_path(params: dict[str, Any]) -> bool:
    return (
        LATENT_DIAG
        or params["latent_rescale"] != 1.0
        or params["latent_shift"] != 0.0
        or params["latent_target_std"] is not None
        or params["peak_normalize_db"] is not None
        or params["limiter_ceiling_db"] is not None
    )


def apply_loudness_chain(
    local_pipe: StableAudioModel,
    latents: torch.Tensor,
    params: dict[str, Any],
    sample_rate: int,
    session_id: str,
) -> tuple[torch.Tensor, dict[str, Any]]:
    meta = loudness_meta_from_params(params)
    target_std = params["latent_target_std"]
    adaptive = target_std is not None and target_std > 0.0
    latent_factor = params["latent_rescale"]
    shift = params["latent_shift"]

    if LATENT_DIAG:
        lf = latents.detach().to(torch.float32)
        seg = max(1, lf.shape[-1] // 5)
        head = lf[..., :seg]
        tail = lf[..., -seg:]
        print(
            f"[{session_id}] LATENT diag shape={tuple(latents.shape)} "
            f"min={lf.min().item():.4f} max={lf.max().item():.4f} "
            f"mean={lf.mean().item():.4f} std={lf.std().item():.4f} "
            f"absmax={lf.abs().max().item():.4f} "
            f"head_std={head.std().item():.4f} tail_std={tail.std().item():.4f}"
        )
        del lf, head, tail

    if adaptive:
        cur_std = latents.detach().to(torch.float32).std().item()
        meta["latent_std"] = round(cur_std, 6)
        if cur_std > 1e-6:
            latent_factor = target_std / cur_std
            latent_factor = min(params["latent_adapt_max"], max(params["latent_adapt_min"], latent_factor))
        else:
            latent_factor = 1.0
        print(
            f"[{session_id}] adaptive latent rescale std={cur_std:.4f} "
            f"target={target_std} factor={latent_factor:.4f}"
        )
    elif LATENT_DIAG:
        meta["latent_std"] = round(latents.detach().to(torch.float32).std().item(), 6)

    if latent_factor != 1.0 or shift != 0.0:
        latents = latents * latent_factor + shift
    meta["latent_factor"] = round(float(latent_factor), 6)

    pretransform = local_pipe.model.pretransform
    try:
        decode_dtype = next(pretransform.parameters()).dtype
        latents = latents.to(decode_dtype)
    except StopIteration:
        pass
    audio = pretransform.decode(latents).float()

    if not params.get("target_samples"):
        keep = int(params["duration"] * sample_rate)
        if audio.shape[-1] > keep:
            audio = audio[..., :keep]

    decoded_peak = audio.detach().abs().max().item()
    meta["decoded_peak"] = round(decoded_peak, 6)
    norm_db = params["peak_normalize_db"]
    if norm_db is not None and decoded_peak > 1e-6:
        gain = (10.0 ** (norm_db / 20.0)) / decoded_peak
        audio = audio * gain
        meta["peak_normalize_gain"] = round(gain, 6)

    lim_db = params["limiter_ceiling_db"]
    if lim_db is not None:
        ceiling = 10.0 ** (lim_db / 20.0)
        knee_fraction = max(1e-6, min(1.0, params["limiter_knee"]))
        knee = ceiling * knee_fraction
        mag = audio.abs()
        over = mag > knee
        limited = int(over.sum().item())
        if limited:
            if knee >= ceiling:
                limited_mag = torch.minimum(mag, mag.new_tensor(ceiling))
            else:
                limited_mag = knee + (ceiling - knee) * torch.tanh((mag - knee) / (ceiling - knee))
            audio = torch.where(over, torch.sign(audio) * limited_mag, audio)
        fraction = limited / max(1, audio.numel())
        meta["limiter_limited_fraction"] = round(float(fraction), 8)
        if LATENT_DIAG:
            print(
                f"[{session_id}] limiter ceiling={lim_db}dB knee={knee_fraction} "
                f"limited={limited}/{audio.numel()} ({100.0 * fraction:.4f}%)"
            )

    final_peak = audio.detach().abs().max().item()
    meta["final_peak"] = round(final_peak, 6)
    if LATENT_DIAG:
        clip_fraction = (audio.detach().abs() > 1.0).float().mean().item()
        print(
            f"[{session_id}] DECODED diag peak={final_peak:.4f} "
            f"clip>1.0={clip_fraction:.6f} norm_db={norm_db}"
        )

    return audio, meta


def generation_worker(session_id: str, params: dict[str, Any]) -> None:
    started = time.time()
    local_pipe: StableAudioModel | None = None
    try:
        update_session(session_id, status="generating", progress=0)

        with generation_lock:
            local_pipe = load_pipeline()
            sr = int(local_pipe.model_config.get("sample_rate", OUTPUT_SAMPLE_RATE))
            loras = resolve_loras(
                {
                    "loras": params.get("loras_request"),
                    "lora": params.get("lora"),
                    "lora_strength": params.get("lora_strength"),
                }
            )
            loaded_lora_count = len(getattr(local_pipe.model, "lora_names", []))
            requested_loras = {config["lora_index"]: config for config in loras}
            for idx in range(loaded_lora_count):
                strength = requested_loras.get(idx, {}).get("strength", 0.0)
                local_pipe.set_lora_strength(strength, lora_index=idx)
            lora_configs = [
                {
                    "lora_index": idx,
                    "interval": requested_loras.get(idx, {}).get("interval", (0.0, 1.0)),
                    "layer_filter": requested_loras.get(idx, {}).get("layer_filter", ""),
                }
                for idx in range(loaded_lora_count)
            ] if loaded_lora_count else None

            def on_step(info: dict[str, Any]) -> None:
                idx = int(info.get("i", 0)) + 1
                progress = min(90, int(idx / max(params["steps"], 1) * 90))
                update_session(session_id, step=idx, progress=progress)

            gen_kwargs = {
                "prompt": params["prompt"],
                "negative_prompt": params["negative_prompt"] or None,
                "duration": params["duration"],
                "sample_size": MAX_SAMPLE_SIZE,
                "steps": params["steps"],
                "cfg_scale": params["cfg_scale"],
                "seed": params["seed"],
                "dist_shift": resolve_dist_shift(local_pipe, params["shift"]),
                "sampler_type": params["sampler_type"],
                "callback": on_step,
            }
            if lora_configs is not None:
                gen_kwargs["lora_configs"] = lora_configs

            if params.get("init_audio") is not None:
                gen_kwargs["init_audio"] = params["init_audio"]
                gen_kwargs["init_noise_level"] = params["init_noise_level"]

            if params.get("inpaint_audio") is not None:
                gen_kwargs["inpaint_audio"] = params["inpaint_audio"]
                gen_kwargs["inpaint_mask_start_seconds"] = params["inpaint_mask_start_seconds"]
                gen_kwargs["inpaint_mask_end_seconds"] = params["inpaint_mask_end_seconds"]

            if should_use_loudness_latent_path(params):
                gen_kwargs["return_latents"] = True
                latents = local_pipe.generate(**gen_kwargs)
                audio, loudness_meta = apply_loudness_chain(local_pipe, latents, params, sr, session_id)
            else:
                audio = local_pipe.generate(**gen_kwargs)
                loudness_meta = loudness_meta_from_params(params)
                loudness_meta["decoded_peak"] = round(audio.detach().abs().max().item(), 6)
                loudness_meta["final_peak"] = loudness_meta["decoded_peak"]
            audio = apply_target_length(audio, params.get("target_samples"))

        update_session(session_id, status="encoding", progress=92)
        audio_data = encode_wav_base64(audio, int(model_sample_rate or OUTPUT_SAMPLE_RATE))

        meta = {
            "mode": params["mode"],
            "prompt": params["prompt"],
            "negative_prompt": params["negative_prompt"],
            "duration": params["duration"],
            "steps": params["steps"],
            "cfg_scale": params["cfg_scale"],
            "shift": params["shift"],
            "sampler_type": params["sampler_type"],
            "seed": params["seed"],
            "sample_rate": int(model_sample_rate or OUTPUT_SAMPLE_RATE),
            "generation_seconds": round(time.time() - started, 3),
            "loras": [
                {
                    "name": config["name"],
                    "strength": config["strength"],
                    "interval": list(config["interval"]),
                    "layer_filter": config["layer_filter"],
                }
                for config in loras
            ],
            "loudness": loudness_meta,
        }
        for key in ("loop", "transform", "continue"):
            if params.get(key):
                meta[key] = params[key]

        update_session(
            session_id,
            status="completed",
            generation_in_progress=False,
            transform_in_progress=False,
            progress=100,
            audio_data=audio_data,
            meta=meta,
        )
    except Exception as exc:
        error = friendly_load_error(exc)
        update_session(
            session_id,
            status="failed",
            generation_in_progress=False,
            transform_in_progress=False,
            progress=0,
            error=error,
        )
    finally:
        del local_pipe
        cleanup_cuda()


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "healthy",
            "service": "sa3",
            "model": MODEL_NAME,
            "model_loaded": model_loaded,
            "model_loading": model_loading,
            "model_error": model_error,
            "last_load_seconds": last_load_seconds,
            "loras": lora_payload(lora_registry if model_loaded else configured_loras()),
            "hf_token_configured": hf_token_configured(),
            "gate_links": SA3_MODEL_LINKS,
            "runtime_import_errors": RUNTIME_IMPORT_ERRORS,
            "device": model_device,
            "cuda_available": bool(torch is not None and torch.cuda.is_available()),
            "cuda_mem": cuda_mem_mb(),
            "sample_rate": model_sample_rate,
            "loudness_defaults": {
                "latent_rescale": LATENT_RESCALE,
                "latent_shift": LATENT_SHIFT,
                "latent_target_std": LATENT_TARGET_STD,
                "latent_adapt_min": LATENT_ADAPT_MIN,
                "latent_adapt_max": LATENT_ADAPT_MAX,
                "peak_normalize_db": PEAK_NORM_DB,
                "limiter_ceiling_db": LIMITER_CEILING_DB,
                "limiter_knee": LIMITER_KNEE,
                "continuation_tail_mode": CONTINUE_TAIL_MODE,
                "continuation_tail_pad": CONTINUE_TAIL_PAD,
            },
        }
    )


@app.route("/ready", methods=["GET"])
def ready():
    if model_loaded:
        return jsonify({"ready": True, "model": MODEL_NAME})
    return jsonify({"ready": False, "loading": model_loading, "error": model_error}), 503


@app.route("/load", methods=["POST"])
def load():
    try:
        already_loaded = model_loaded
        load_pipeline()
        return jsonify(
            {
                "success": True,
                "status": "already_loaded" if already_loaded else "loaded",
                "load_seconds": 0.0 if already_loaded else last_load_seconds,
                "sample_rate": model_sample_rate,
                "device": model_device,
                "cuda_mem": cuda_mem_mb(),
            }
        )
    except Exception as exc:
        return jsonify({"success": False, "error": friendly_load_error(exc), "gate_links": SA3_MODEL_LINKS}), 503


@app.route("/unload", methods=["POST"])
def unload():
    if generation_lock.locked():
        return jsonify({"success": False, "error": "generation in progress - retry when idle"}), 409
    return jsonify({"success": True, **unload_pipeline()})


@app.route("/loras", methods=["GET"])
def loras():
    entries = lora_registry if model_loaded else configured_loras()
    return jsonify(
        {
            "loras": lora_payload(entries),
            "default_lora": DEFAULT_LORA_NAME or None,
            "lora_dir": LORA_DIR,
            "registry_path": LORA_REGISTRY_PATH,
            "model_loaded": model_loaded,
        }
    )


@app.route("/reload", methods=["POST"])
def reload_loras():
    if not generation_lock.acquire(blocking=False):
        return jsonify({"success": False, "error": "generation in progress - retry when idle"}), 409
    try:
        previous = [name for name, _ in lora_registry]
        load_pipeline(force=True)
        return jsonify(
            {
                "success": True,
                "previous": previous,
                "loras": lora_payload(lora_registry),
            }
        )
    except Exception as exc:
        return jsonify({"success": False, "error": friendly_load_error(exc), "gate_links": SA3_MODEL_LINKS}), 503
    finally:
        generation_lock.release()


def read_json_file(path: str) -> dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


@app.route("/prompts", methods=["GET"])
def prompts():
    defaults_path = os.path.join(PROMPTS_DIR, "defaults.json")
    data = read_json_file(defaults_path) or {
        "version": 1,
        "dice": {"generic": [], "instrumental": [], "drums": []},
    }
    dice = {
        key: list(value)
        for key, value in (data.get("dice") or {}).items()
        if isinstance(value, list)
    }
    available_loras = []
    if os.path.isdir(PROMPTS_DIR):
        available_loras = sorted(
            os.path.splitext(filename)[0]
            for filename in os.listdir(PROMPTS_DIR)
            if filename.endswith(".json") and filename != "defaults.json"
        )

    selected_loras: list[str] = []
    seen_loras = set()
    for raw in request.args.getlist("lora"):
        for name in (piece.strip().lower() for piece in raw.split(",")):
            if name and name not in seen_loras:
                selected_loras.append(name)
                seen_loras.add(name)

    source: dict[str, Any] = {
        "generic": "defaults.json" if os.path.exists(defaults_path) else "empty"
    }
    bucket_seen: dict[str, set[Any]] = {}
    bucket_replaced = set()
    missing_loras = []
    for name in selected_loras:
        lora_data = read_json_file(os.path.join(PROMPTS_DIR, f"{name}.json"))
        lora_dice = lora_data.get("dice") if lora_data else None
        if not isinstance(lora_dice, dict):
            missing_loras.append(name)
            continue
        for bucket, items in lora_dice.items():
            if not isinstance(items, list):
                continue
            if bucket not in bucket_replaced:
                dice[bucket] = []
                bucket_seen[bucket] = set()
                bucket_replaced.add(bucket)
                source[bucket] = []
            for item in items:
                key = item.lower() if isinstance(item, str) else item
                if key in bucket_seen[bucket]:
                    continue
                bucket_seen[bucket].add(key)
                dice[bucket].append(item)
            if f"{name}.json" not in source[bucket]:
                source[bucket].append(f"{name}.json")

    if missing_loras:
        source["_note"] = f"no prompt file for: {', '.join(missing_loras)}"

    return jsonify(
        {
            "success": True,
            "loras": selected_loras,
            "missing_loras": missing_loras,
            "available_loras": available_loras,
            "prompts": {
                "version": data.get("version", 1),
                "dice": dice,
                "source": source,
            },
        }
    )


@app.route("/generate", methods=["POST"])
def generate():
    cleanup_old_sessions()
    data = get_json_body()
    if not data:
        return jsonify({"success": False, "error": "JSON body required"}), 400
    errors = validate_common(data)
    if errors:
        return jsonify({"success": False, "errors": errors}), 400

    params = common_params(data)
    session_id = create_session(
        {
            "mode": "generate",
            "prompt": params["prompt"],
            "steps": params["steps"],
            "duration": params["duration"],
        }
    )
    threading.Thread(target=generation_worker, args=(session_id, params), daemon=True).start()
    return jsonify(
        {
            "success": True,
            "session_id": session_id,
            "seed": params["seed"],
            "prompt": params["prompt"],
            "duration": params["duration"],
        }
    )


@app.route("/generate/loop", methods=["POST"])
def generate_loop():
    cleanup_old_sessions()
    data = get_json_body()
    if not data:
        return jsonify({"success": False, "error": "JSON body required"}), 400
    errors = validate_common(data)
    if errors:
        return jsonify({"success": False, "errors": errors}), 400

    prompt = data["prompt"].strip()
    bpm = data.get("bpm")
    bpm = float(bpm) if bpm not in (None, "") else extract_bpm(prompt)
    if not bpm or bpm <= 0:
        return jsonify({"success": False, "error": "BPM required in prompt or bpm field"}), 400

    bars = parse_int(data, "bars", DEFAULT_LOOP_BARS)
    if bars not in VALID_LOOP_BARS:
        return jsonify({"success": False, "error": f"bars must be one of {sorted(VALID_LOOP_BARS)}"}), 400

    seconds_per_bar = (60.0 / bpm) * 4.0
    loop_duration = seconds_per_bar * bars
    gen_duration = loop_duration + LOOP_PAD_SECONDS
    if gen_duration > MAX_DURATION:
        return jsonify(
            {
                "success": False,
                "error": f"{bars} bars at {bpm} bpm exceeds max {MAX_DURATION}s with pad",
            }
        ), 400

    target_samples = round(loop_duration * OUTPUT_SAMPLE_RATE)
    params = common_params(data, duration=gen_duration)
    params["mode"] = "loop"
    params["target_samples"] = target_samples
    params["loop"] = {
        "bpm": bpm,
        "bars": bars,
        "seconds_per_bar": round(seconds_per_bar, 6),
        "loop_duration": round(loop_duration, 6),
        "gen_duration": round(gen_duration, 6),
        "target_samples": target_samples,
    }

    session_id = create_session({"mode": "loop", "prompt": params["prompt"], "steps": params["steps"], "duration": gen_duration})
    threading.Thread(target=generation_worker, args=(session_id, params), daemon=True).start()
    return jsonify({"success": True, "session_id": session_id, "seed": params["seed"], **params["loop"]})


@app.route("/transform", methods=["POST"])
def transform():
    cleanup_old_sessions()
    data = get_json_body()
    if not data:
        return jsonify({"success": False, "error": "JSON body required"}), 400
    errors = validate_common(data, require_duration=False)
    if errors:
        return jsonify({"success": False, "errors": errors}), 400
    try:
        input_sr, waveform = decode_audio_data(data)
    except Exception as exc:
        return jsonify({"success": False, "error": f"could not decode audio_data: {exc}"}), 400

    input_duration = waveform.shape[-1] / float(input_sr)
    if input_duration <= 0 or input_duration > MAX_DURATION:
        return jsonify({"success": False, "error": f"input duration must be in (0, {MAX_DURATION}] seconds"}), 400

    strength = max(0.01, min(1.0, parse_float(data, "strength", 0.9)))
    target_samples = round(input_duration * OUTPUT_SAMPLE_RATE)
    params = common_params(data, duration=input_duration + 0.5)
    params["mode"] = "transform"
    params["target_samples"] = target_samples
    params["init_audio"] = (input_sr, waveform)
    params["init_noise_level"] = strength
    params["transform"] = {
        "strength": strength,
        "input_duration": round(input_duration, 6),
        "input_sr": input_sr,
        "input_channels": int(waveform.shape[0]),
        "target_samples": target_samples,
    }

    session_id = create_session({"mode": "transform", "prompt": params["prompt"], "steps": params["steps"], "duration": input_duration})
    threading.Thread(target=generation_worker, args=(session_id, params), daemon=True).start()
    return jsonify({"success": True, "session_id": session_id, "seed": params["seed"], **params["transform"]})


@app.route("/continue", methods=["POST"])
def continue_audio():
    cleanup_old_sessions()
    data = get_json_body()
    if not data:
        return jsonify({"success": False, "error": "JSON body required"}), 400
    errors = validate_common(data, require_duration=False)
    if errors:
        return jsonify({"success": False, "errors": errors}), 400

    mode = (data.get("continuation_mode") or "inpaint").lower()
    if mode not in VALID_CONTINUATION_MODES:
        return jsonify(
            {
                "success": False,
                "error": f"continuation_mode must be one of {sorted(VALID_CONTINUATION_MODES)}",
            }
        ), 400

    try:
        input_sr, waveform = decode_audio_data(data)
    except Exception as exc:
        return jsonify({"success": False, "error": f"could not decode audio_data: {exc}"}), 400

    source_duration = waveform.shape[-1] / float(input_sr)
    continuation_seconds = parse_float(data, "continuation_seconds", DEFAULT_CONTINUATION_SECONDS)
    tail_pad = min(CONTINUE_TAIL_PAD_MAX, max(0.0, parse_float(data, "continuation_tail_pad", CONTINUE_TAIL_PAD)))
    total_duration = source_duration + continuation_seconds
    if source_duration <= 0 or continuation_seconds <= 0 or total_duration > MAX_DURATION:
        return jsonify({"success": False, "error": f"source + continuation must be in (0, {MAX_DURATION}] seconds"}), 400

    if CONTINUE_TAIL_MODE == "exact":
        gen_duration = total_duration
        mask_end = total_duration
    elif CONTINUE_TAIL_MODE == "regen_past":
        gen_duration = total_duration + tail_pad
        mask_end = gen_duration
    else:
        gen_duration = total_duration + 0.5
        mask_end = total_duration

    target_samples = round(total_duration * OUTPUT_SAMPLE_RATE)
    params = common_params(data, duration=gen_duration)
    params["mode"] = "continue"
    params["target_samples"] = target_samples
    params["inpaint_audio"] = (input_sr, waveform)
    params["inpaint_mask_start_seconds"] = source_duration
    params["inpaint_mask_end_seconds"] = mask_end
    params["continue"] = {
        "mode": mode,
        "source_duration": source_duration,
        "continuation_seconds": round(continuation_seconds, 6),
        "total_duration": round(total_duration, 6),
        "tail_mode": CONTINUE_TAIL_MODE,
        "tail_pad": round(tail_pad, 6),
        "gen_duration": round(gen_duration, 6),
        "mask_start_seconds": round(source_duration, 6),
        "mask_end_seconds": round(mask_end, 6),
        "sampler_type": params["sampler_type"],
        "input_sr": input_sr,
        "input_channels": int(waveform.shape[0]),
        "target_samples": target_samples,
    }

    session_id = create_session({"mode": "continue", "prompt": params["prompt"], "steps": params["steps"], "duration": total_duration})
    threading.Thread(target=generation_worker, args=(session_id, params), daemon=True).start()
    return jsonify({"success": True, "session_id": session_id, "seed": params["seed"], **params["continue"]})


@app.route("/poll_status/<session_id>", methods=["GET"])
def poll_status(session_id: str):
    session = get_session(session_id)
    if session is None:
        return jsonify({"success": False, "error": f"unknown session: {session_id}"}), 404

    status = session["status"]
    queue_status: dict[str, Any] = {}
    if status == "queued":
        queue_status = {
            "status": "queued",
            "position": 1,
            "total_queued": 1,
            "message": "Task queued locally.",
            "estimated_seconds": 5,
        }
    elif status in ("generating", "encoding"):
        queue_status = {"status": "ready"}

    response = {
        "success": status != "failed",
        "generation_in_progress": session["generation_in_progress"],
        "transform_in_progress": session["transform_in_progress"],
        "progress": session["progress"],
        "step": session.get("step", 0),
        "total_steps": session.get("total_steps", 0),
        "status": status,
        "queue_status": queue_status,
    }
    if status == "completed":
        response["audio_data"] = session.get("audio_data", "")
        response["meta"] = session.get("meta", {})
    if status == "failed":
        response["error"] = session.get("error", "unknown error")
        response["gate_links"] = SA3_MODEL_LINKS
    return jsonify(response)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8006"))
    app.run(host="0.0.0.0", port=port, threaded=True)
