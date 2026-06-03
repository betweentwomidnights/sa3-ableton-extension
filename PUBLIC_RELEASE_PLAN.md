# Public Release Plan

Target repository: `betweentwomidnights/sa3-ableton-extension`

## V1 Scope

- Keep the public extension Stable Audio 3 only.
- Ship three Ableton context-menu actions:
  - `Gary SA3: Transform Selection`
  - `Gary SA3: Continue Selection`
  - `Gary SA3: Generate Selection`
- Keep Continue on upstream-compatible `inpaint` mode.
- Keep latent-prefix continuation and sampler patch experiments on a private branch until they are proven useful.
- Keep public `main` local-first. Do not publish a hardcoded hosted backend URL.

## Backend Shape

The public repo should include a small companion backend so users can run:

```shell
python api.py
```

and point the extension at:

```text
http://localhost:8006
```

The backend should expose the same contract the extension already uses:

- `GET /health`
- `GET /loras`
- `GET /prompts`
- `POST /generate`
- `POST /transform`
- `POST /continue`
- `GET /poll_status/<session_id>`

## Extraction Strategy

Use `C:\dev\gary-localhost-installer\services\sa3\api.py` as the starting point, but do not vendor the whole Gary4local app.

Prefer this public structure once the backend is extracted:

```text
.
|- backend/
|  |- api.py
|  |- requirements.txt
|  |- prompts/defaults.json
|  |- examples/lora_registry.example.json
|  `- README.md
|- extension/
|  |- src/
|  |- scripts/
|  |- manifest.json
|  |- package.json
|  `- README.md
|- dist/
|  `- gary-extension.ablx
|- README.md
`- LICENSE
```

For the first push, it is acceptable for the repo to contain the extension at the root plus this release plan while the backend extraction is in progress.

## Upstream Alignment

The current Gary4local `services/sa3/stable_audio_3` package is nearly identical to official `Stability-AI/stable-audio-3` at commit `cd87e6f`.

The only meaningful local package diff found is in `stable_audio_3/inference/sampling.py`, where latent-prefix continuation support pins clean prefix latents in the pingpong sampler. Because public V1 will not expose latent-prefix continuation, the public backend should depend on official upstream `stable-audio-3` instead of vendoring our patched package.

## Useful Backend Environment Variables

Preserve the Gary4local SA3 output-shaping controls in the public backend. They are useful and should remain overrideable through environment variables even if the public wrapper is kept small:

- `SA3_MODEL`, default `medium`
- `SA3_MODEL_HALF`, default `1`
- `SA3_DEFAULT_STEPS`, default `8`
- `SA3_DEFAULT_CFG`, default `1.0`
- `SA3_DEFAULT_NEGATIVE`, default `low quality`
- `SA3_DEFAULT_DURATION`, default `30`
- `SA3_MAX_DURATION`, default `300`
- `SA3_DEFAULT_SAMPLER`, default `pingpong`
- `SA3_SAMPLE_RATE`, default `44100`
- `SA3_PROMPTS_DIR`
- `SA3_LORA_REGISTRY`
- `SA3_LORA_DIR`
- `OUTPUT_DIR`
- `SA3_LATENT_RESCALE`, default `1.0`
- `SA3_LATENT_SHIFT`, default `0.0`
- `SA3_LATENT_TARGET_STD`, default off
- `SA3_LATENT_ADAPT_MIN`, default `0.9`
- `SA3_LATENT_ADAPT_MAX`, default `1.0`
- `SA3_PEAK_NORMALIZE_DB`, default `2.0`
- `SA3_LIMITER_CEILING_DB`, default `-0.3`
- `SA3_LIMITER_KNEE`, default `0.8`
- `SA3_CONTINUE_TAIL_MODE`, default `regen_past`
- `SA3_CONTINUE_TAIL_PAD`, default `6`

The public README should describe peak normalization and the limiter as gentle local output shaping, not as part of official upstream Stable Audio 3.

## Install Guidance

Document two setup paths:

- Recommended modern path: `uv`, matching official Stable Audio 3.
- Windows CUDA path: Python 3.11, torch/torchaudio `2.7.1`, CUDA wheel index, and a matching Flash Attention wheel for SA3 Medium.

Keep the README explicit that users need Hugging Face access accepted for:

- `stabilityai/stable-audio-3-medium`
- `google/t5gemma-b-b-ul2`

## Remote Backend Policy

Keep the hardcoded Gary remote backend option off public `main`.

Use `internal/remote-backend` for the remote-enabled workflow. Public `main` should remain local-first with an editable custom backend URL field. If hosted access becomes necessary for GPU-poor users, add a CTA in the README rather than publishing a backend URL directly.

## First Public Tasks

1. Move the current extension into `extension/` if we decide the backend should live in the same repo immediately.
2. Extract `services/sa3/api.py`, `services/sa3/prompts/defaults.json`, and `services/sa3/build_lora_prompts.py` into `backend/`.
3. Remove Gary4local-specific `%APPDATA%\Gary4JUCE` defaults from the public backend; use local `backend/loras`, `backend/prompts`, and `backend/outputs` defaults, still overrideable by environment variables.
4. Replace vendored `stable_audio_3` with dependency instructions against official upstream.
5. Add an `.env.example` for backend settings.
6. Add smoke tests for `/health`, `/generate`, `/transform`, and `/continue`.
7. Add release instructions for building and packaging `dist/gary-extension.ablx`.
