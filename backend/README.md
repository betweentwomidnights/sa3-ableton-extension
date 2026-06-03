# SA3 Local Backend

Small local HTTP wrapper for the Ableton extension. It is designed to sit beside the official Stable Audio 3 Python package, not replace it.

Upstream:

https://github.com/Stability-AI/stable-audio-3

## What It Exposes

- `GET /health`
- `GET /ready`
- `POST /load`
- `POST /unload`
- `GET /loras`
- `POST /reload`
- `GET /prompts`
- `POST /generate`
- `POST /generate/loop`
- `POST /transform`
- `POST /continue`
- `GET /poll_status/<session_id>`

`/health` does not load the model. First model load happens on `POST /load` or the first generation/edit request.

## Quick Health Test

This verifies the wrapper and port before installing the full model stack.

```shell
cd backend
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
python api.py
```

In another terminal:

```shell
python smoke-tests\health_smoke.py
```

If `stable_audio_3`, `torch`, or `torchaudio` are not installed yet, `/health` will still respond and list missing packages under `runtime_import_errors`.

## Full Stable Audio 3 Setup With uv

The official Stable Audio 3 repo uses `uv`, and this backend should too. The
most direct path is to install the official repo into this backend's venv so
`api.py` and `stable_audio_3` share one environment.

Install `uv` first if you do not have it:

```shell
winget install astral-sh.uv
```

On Windows/NVIDIA, the fragile part is matching Python, Torch, CUDA, and Flash
Attention. These commands use Python 3.11, Torch 2.7.1, CUDA 12.8 wheels, and a
matching Windows Flash Attention wheel. Adjust `cu128` and the Flash Attention
wheel if your system needs a different build.

```shell
cd C:\dev
git clone https://github.com/Stability-AI/stable-audio-3.git

cd C:\dev\gary-extension\backend
uv venv .venv --python 3.11
.\.venv\Scripts\activate

uv pip install --torch-backend cu128 -e C:\dev\stable-audio-3 -r requirements.txt
uv pip install https://github.com/sdbds/flash-attention-for-windows/releases/download/2.8.2/flash_attn-2.8.2+cu128torch2.7.1cxx11abiFALSEfullbackward-cp311-cp311-win_amd64.whl
uv pip install --reinstall --no-deps --torch-backend cu128 torch==2.7.1 torchaudio==2.7.1
```

`--torch-backend cu128` is the important part. It lets `uv` install the official
Stable Audio 3 dependencies from upstream while still choosing the CUDA Torch
wheel family. The final Torch reinstall is intentionally defensive: if anything
touches Torch while installing the Flash Attention wheel, this puts the expected
CUDA build back at the end.

Sanity check the environment:

```shell
python -c "import torch, torchaudio, stable_audio_3; print('torch', torch.__version__, 'cuda', torch.version.cuda, 'available', torch.cuda.is_available()); print('sa3', stable_audio_3.__file__)"
```

Official SA3 Medium requires Flash Attention. If the Flash Attention wheel fails,
check that all of these match:

- Python version, for example `cp311`
- Torch version, for example `torch2.7.1`
- CUDA wheel family, for example `cu128`
- Windows architecture, usually `win_amd64`

## Hugging Face Access

Set `HF_TOKEN` to a Hugging Face read token, and accept model access for:

- https://huggingface.co/stabilityai/stable-audio-3-medium
- https://huggingface.co/google/t5gemma-b-b-ul2

The token alone is not enough; the same account must accept the gated terms.

## Run

```shell
cd backend
python api.py
```

The default URL is:

```text
http://localhost:8006
```

## LoRAs

By default the backend scans:

```text
backend/loras
```

for `.ckpt` and `.safetensors` files. You can also point `SA3_LORA_REGISTRY` at a JSON registry. See [LORAS.md](LORAS.md) and [examples/lora_registry.example.json](examples/lora_registry.example.json).

Prompt dice pools live in:

```text
backend/prompts
```

To build a prompt dice pool from LoRA caption sidecars:

```shell
python build_lora_prompts.py --name my-sa3-lora --captions-dir C:\path\to\captions --out-dir prompts
```

recommended LoRA training repo: https://github.com/dada-bots/underfit

## Output Shaping

The wrapper includes local output-shaping controls that are not part of official upstream SA3. They are useful for DAW workflows, especially hot LoRA outputs:

- `SA3_LATENT_RESCALE`
- `SA3_LATENT_SHIFT`
- `SA3_LATENT_TARGET_STD`
- `SA3_LATENT_ADAPT_MIN`
- `SA3_LATENT_ADAPT_MAX`
- `SA3_PEAK_NORMALIZE_DB`
- `SA3_LIMITER_CEILING_DB`
- `SA3_LIMITER_KNEE`
- `SA3_CONTINUE_TAIL_MODE`
- `SA3_CONTINUE_TAIL_PAD`

Copy [.env.example](.env.example) for the full list.
