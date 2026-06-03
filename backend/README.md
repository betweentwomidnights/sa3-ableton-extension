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

## Full Stable Audio 3 Setup

Follow the official Stable Audio 3 install guidance for your platform. For SA3 Medium on Windows/NVIDIA, the broad shape is:

```shell
cd path\to\stable-audio-3
python -m venv .venv
.venv\Scripts\activate
python -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128
python -m pip install -e . --no-deps
python -m pip install -r path\to\sa3-ableton-extension\backend\requirements.txt
python -m pip install <matching-flash-attn-wheel>
python -m pip install --force-reinstall --no-deps torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128
```

Use the CUDA/PyTorch/Flash Attention wheels that match your system. Official SA3 Medium requires Flash Attention.

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

for `.ckpt` and `.safetensors` files. You can also point `SA3_LORA_REGISTRY` at a JSON registry. See [examples/lora_registry.example.json](examples/lora_registry.example.json).

Prompt dice pools live in:

```text
backend/prompts
```

To build a prompt dice pool from LoRA caption sidecars:

```shell
python build_lora_prompts.py --name my-sa3-lora --captions-dir C:\path\to\captions --out-dir prompts
```

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
