# sa3.cpp backend experiment

This branch lets the Ableton extension talk directly to `sa3-server` from
`sa3.cpp` without a Python adapter service.

The extension defaults to the local SA3 backend:

```text
http://localhost:8006
```

For this experiment, run `sa3-server` on the same URL.

## Run sa3.cpp

From `C:\dev\sa3.cpp`:

```powershell
build.cmd cuda
python tools\download_models.py --variant medium --encoding f16
.\scripts\run-server.ps1
```

Health should respond without loading the model:

```powershell
Invoke-RestMethod http://localhost:8006/health
```

Expected shape:

```json
{"status":"ok","model":"medium","encoding":"f16","loaded":false}
```

## How the extension adapts

`sa3-server` already matches the async job model:

- `POST /generate` returns `{success, session_id, seed}`
- `GET /poll_status/<session_id>` returns progress and completed `audio_data`
- `GET /health` is lightweight

The extension now accepts a submit response without an explicit `success: true`,
which lets `sa3-server` work.

Generate sends the Python-compatible `duration` field. For `sa3.cpp`, it also sends:

- `dist_shift`
- `keep_models: false`
- `target_samples`
- `duration_padding_sec: 6.0`

For text generation, `duration` is the requested Ableton selection length,
`duration_padding_sec` is the upstream-style schedule headroom, and
`target_samples` trims the returned WAV back to the requested length.

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
`init_noise_level` mapped from the UI's init-noise slider. It also sends
`duration_padding_sec: 0.0`; audio2audio gets its length from the rendered input.

Continue first tries the legacy Python route:

```text
POST /continue
```

If that route is missing, it falls back to `POST /generate` with:

- `init_path`
- `inpaint_start` at the selected audio duration
- `inpaint_end` at selected duration plus continuation duration plus a 6s tail pad
- `target_samples` for the exact source-plus-continuation WAV length
- `duration_padding_sec: 0.0`

In the Ableton UI, the continue field means **add this many bars**. If the selected
audio is 14 bars and the continue field is 32 bars, the extension requests and places
a 46-bar source-plus-continuation clip. The sa3.cpp fallback mirrors the Python backend's
default continuation shape by generating a short tail beyond that 46-bar target, then trimming
the returned WAV back to exactly 46 bars.

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
