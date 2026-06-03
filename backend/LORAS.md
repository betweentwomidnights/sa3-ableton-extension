# LoRA Setup

The backend can load SA3 LoRAs from either a folder scan or a JSON registry.
For a shared setup, use the JSON registry so every LoRA has a stable name that
the Ableton extension can show in the UI.

## Quick Folder Scan

The simplest setup is:

```shell
cd C:\dev\gary-extension\backend
mkdir loras
copy C:\path\to\my-sa3-lora.safetensors .\loras\
```

Restart the backend, or call `/reload` if the model is already loaded. The LoRA
will appear by filename, lowercased and without the extension. For example:

```text
backend/loras/my-sa3-lora.safetensors -> my-sa3-lora
```

## Recommended Registry Setup

Create:

```text
backend/lora_registry.json
```

with entries like:

```json
[
  {
    "name": "dadabots-breakcore",
    "path": "D:/models/sa3-loras/dadabots-breakcore.safetensors"
  },
  {
    "name": "dadabots-choir",
    "path": "D:/models/sa3-loras/dadabots-choir.safetensors"
  }
]
```

Use forward slashes in Windows paths to avoid JSON backslash escaping problems.
Names are normalized to lowercase by the backend. Keep names stable because the
Ableton extension and LoRA prompt dice files refer to them.

You can also keep the registry somewhere else:

```shell
$env:SA3_LORA_REGISTRY="D:/models/sa3-loras/lora_registry.json"
$env:SA3_LORA_DIR="D:/models/sa3-loras"
python api.py
```

or copy `backend/.env.example` to `backend/.env` and put those values there.

The registry can also be written as an object map if that is easier for a coding
agent to maintain:

```json
{
  "dadabots-breakcore": "D:/models/sa3-loras/dadabots-breakcore.safetensors",
  "dadabots-choir": {
    "path": "D:/models/sa3-loras/dadabots-choir.safetensors"
  }
}
```

## Prompt Dice For A LoRA

The LoRA registry only tells the backend what weights to load. The dice button
uses prompt files in:

```text
backend/prompts
```

For a LoRA named `dadabots-breakcore`, create:

```text
backend/prompts/dadabots-breakcore.json
```

with:

```json
{
  "version": 1,
  "dice": {
    "generic": [
      "hyperactive neural breakcore with chopped blast beats and synthetic choir",
      "distorted algorithmic grind with glitch edits and unstable tape pitch"
    ],
    "instrumental": [
      "dense breakcore instrumental with frantic edits and melodic noise",
      "maximal digital hardcore instrumental with crushed drums and bright synths"
    ],
    "drums": [
      "frantic chopped amen break with blast-beat fills",
      "high-speed glitch drums with abrupt edits and heavy compression"
    ]
  }
}
```

When the extension asks for prompts with `?lora=dadabots-breakcore`, those dice
buckets replace the matching default buckets. Do not include BPM or key in these
prompt snippets; the extension can append host context separately.

## Build Prompt Dice From Training Captions

If the LoRA training folder has `.txt` caption sidecars, generate a starter dice
file with:

```shell
cd C:\dev\gary-extension\backend
python build_lora_prompts.py --name dadabots-breakcore --captions-dir D:\datasets\dadabots-breakcore\captions --bucket generic
```

Use `--force` to overwrite an existing file after reviewing it:

```shell
python build_lora_prompts.py --name dadabots-breakcore --captions-dir D:\datasets\dadabots-breakcore\captions --bucket generic --force
```

The generated file is only a starting point. Curating the prompt list is worth
doing, especially for public LoRAs.

## Verify The Backend Sees The LoRAs

Start the backend:

```shell
cd C:\dev\gary-extension\backend
.\.venv\Scripts\activate
python api.py
```

Then check:

```shell
Invoke-RestMethod http://127.0.0.1:8006/loras | ConvertTo-Json -Depth 6
Invoke-RestMethod "http://127.0.0.1:8006/prompts?lora=dadabots-breakcore" | ConvertTo-Json -Depth 6
```

If the model is already loaded and you changed the registry or LoRA files, reload
when idle:

```shell
Invoke-RestMethod -Method Post http://127.0.0.1:8006/reload | ConvertTo-Json -Depth 6
```

Restarting the backend is the safest option while editing LoRA config.

## Request Shape For Coding Agents

Generation, transform, and continue requests can select one or more LoRAs:

```json
{
  "prompt": "dense breakcore instrumental with synthetic choir",
  "duration": 12,
  "loras": [
    {
      "name": "dadabots-breakcore",
      "strength": 0.8,
      "interval_min": 0.0,
      "interval_max": 1.0,
      "layer_filter": ""
    }
  ]
}
```

`strength` is the main knob. `interval_min` and `interval_max` are normalized
from `0.0` to `1.0` across the generation. `layer_filter` is passed through to
SA3 for advanced experiments and can usually be left empty.

## Notes

- Supported file extensions are `.ckpt` and `.safetensors`.
- If `lora_registry.json` exists and contains valid entries, it takes precedence
  over folder scanning.
- Registry entries with missing files are skipped, so check `/loras` after every
  edit.
- All configured LoRAs are loaded when the SA3 pipeline loads. Keep the registry
  focused if load time or VRAM use becomes a problem.
- Set `SA3_DEFAULT_LORA` to a registry name if you want `"default"` requests to
  resolve to a specific LoRA.
