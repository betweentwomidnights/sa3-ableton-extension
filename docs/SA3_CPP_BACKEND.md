# sa3.cpp backend experiment

This branch lets the Ableton extension talk directly to `sa3-server` from
`sa3.cpp` without a Python adapter service.

The extension still defaults to the original localhost backend:

```text
http://localhost:8006
```

For this experiment, run `sa3-server` and point the extension's backend field at:

```text
http://localhost:8086
```

## Run sa3.cpp

From `C:\dev\sa3.cpp`:

```powershell
build.cmd cuda
python tools\download_models.py --variant medium --encoding f16
.\scripts\run-server.ps1
```

Health should respond without loading the model:

```powershell
Invoke-RestMethod http://localhost:8086/health
```

Expected shape:

```json
{"status":"ok","model":"medium","encoding":"f16","loaded":false}
```

## How the extension adapts

`sa3-server` already matches the async job model:

- `POST /generate` returns `{session_id, seed}`
- `GET /poll_status/<session_id>` returns progress and completed `audio_data`
- `GET /health` is lightweight

The extension now accepts a submit response without an explicit `success: true`,
which lets `sa3-server` work.

Generate sends both backend dialects in one request:

- Python backend: `duration`, `shift`
- `sa3.cpp`: `seconds`, `dist_shift`, `keep_models: false`

The extension requests frugal/early-free mode for `sa3.cpp` so long audio
transforms and continuations have the best chance of fitting on 8 GB GPUs. That
costs a reload between requests, but avoids keeping T5, DiT, and the decoder
resident while Ableton is also active.

Transform first tries the legacy Python route:

```text
POST /transform
```

If that route is missing, it falls back to:

```text
POST /generate
```

with `init_path` pointing at the WAV file Ableton rendered from the selection and
`init_noise_level` mapped from the UI's init-noise slider.

Continue first tries the legacy Python route:

```text
POST /continue
```

If that route is missing, it falls back to `POST /generate` with:

- `init_path`
- `inpaint_start` at the selected audio duration
- `inpaint_end` at selected duration plus continuation duration

## Current gaps

`sa3-server` does not currently expose:

- `POST /transform`
- `POST /continue`

The extension works around those by falling back to `POST /generate` with
`init_path`.

The extension also does not embed `libsa3`. That is still possible later through
a native Node addon or an external helper process, but the HTTP server is the
cleanest first DAW integration because it keeps large model/runtime state outside
Ableton's extension host.
