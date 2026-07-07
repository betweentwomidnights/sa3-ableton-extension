# sa3 ableton extension

stable audio 3 generation, transformation, and continuation directly inside Ableton Live arrangement selections.

**UPDATE:** oops, i misunderstood how easy it was to use just the `.ablx` file if you disable developer mode. if you only want to use the extension, grab the latest `.ablx` from [Releases](https://github.com/betweentwomidnights/sa3-ableton-extension/releases) and install it inside Ableton Live beta with Developer Mode off.

fair warning...you still need an SA3 backend while generating, either Gary4local or the backend in this repo. but you do not need to run the Ableton extension host from a terminal unless you're building on top of this.

2nd warning...untested on macOS. plz let me know if it works/doesn't work on apple silicon.

this is an early V1 built against the Ableton Extensions SDK beta. the long-term idea is much larger: model workflows that feel native inside Live instead of forcing the user to leave the DAW, record into a plugin, drag files around, or manually line generated audio back up on the timeline. for now, this repo is intentionally focused on stable audio 3.

## what it do

the extension adds three right-click actions on audio-track arrangement selections:

- `Gary SA3: Transform Selection`
- `Gary SA3: Continue Selection`
- `Gary SA3: Generate Selection`

transform renders the selected audio range, sends it to an SA3 backend, and replaces the selected region by default.

continue renders the selected audio range, asks SA3 to add the requested number of bars after it, and replaces from the selection start with the returned source-plus-continuation clip.

generate uses the selected arrangement duration to create audio from text and places the result at the selected start.

ableton's undo restores the previous timeline state, which makes the replace workflow feel surprisingly natural.

## backend

this repo is local-first. The public branch defaults to:

```text
http://localhost:8006
```

the dialog keeps an editable backend URL field, so you can point it at any compatible SA3 server you control.

tested today with the Gary4local companion app:

https://github.com/betweentwomidnights/gary-localhost-installer

the standalone backend in [backend/](backend/) was extracted from Gary4local's `services/sa3/api.py` so people can run a small API wrapper around their existing official Stable Audio 3 checkout. The goal is to stay as close as possible to upstream:

https://github.com/Stability-AI/stable-audio-3

if you do not have a suitable GPU and want hosted access, open an issue or reach out. you can use our remote backend if you ask nicely, and if you're clever enough, you'll figure out how gary4juce talks to it anyway.

## backend contract

the extension expects an SA3-compatible HTTP backend with:

- `GET /health`
- `GET /loras`
- `GET /prompts`
- `POST /generate`
- `POST /transform`
- `POST /continue`
- `GET /poll_status/<session_id>`

the local backend also preserves useful output-shaping environment variables from gary4local, including latent scaling, peak normalization, and a gentle limiter. these handle some of the loudness issues i get from my loras.

backend extraction is now in [backend/](backend/). start with [backend/README.md](backend/README.md); the local SA3 setup uses `uv` and installs the official upstream stable audio 3 repo into the backend venv.

LoRA setup is documented in [backend/LORAS.md](backend/LORAS.md), including registry JSON, prompt dice files, and API checks.

## sa3.cpp backend experiment

There is an experimental branch for driving [`sa3.cpp`](https://github.com/betweentwomidnights/sa3.cpp)'s `sa3-server` directly from the Ableton extension. See [docs/SA3_CPP_BACKEND.md](docs/SA3_CPP_BACKEND.md).

## embedded sa3.cpp backend (this branch)

this branch embeds `sa3.cpp` directly inside the extension as a native node addon — no separate backend process. select `embedded` in the dialog's backend toggle.

### builds (cuda / vulkan / cpu)

the addon itself is backend-agnostic — it `LoadLibrary`s `sa3.dll` at runtime, so the only difference between builds is which `ggml` runtime DLLs are bundled next to it. three flavours:

| backend | build script | bundled DLLs | .ablx size | notes |
| --- | --- | --- | --- | --- |
| cuda   | `npm run package:cuda`   | `ggml-cuda` + CUDA runtime (`cublas*`, `cudart*`) | ~600 MB | fastest on NVIDIA; huge because of the CUDA runtime |
| vulkan | `npm run package:vulkan` | `ggml-vulkan` | ~15 MB | runs on any Vulkan GPU (NVIDIA/AMD/Intel); needs the system Vulkan loader (`vulkan-1.dll`, ships with GPU drivers). basically as fast as CUDA for this workload |
| cpu    | `npm run package:cpu`    | static `ggml-cpu` | ~3 MB | no GPU needed. slow for `medium`, genuinely usable for `small-music` |

`npm run package:all` builds all three in one pass (compiling the addon once). outputs land in `dist/gary-extension-<backend>.ablx` (also copied into the gitignored `releases/`). the backend is selected at build time with `GARY_SA3_BACKEND=cuda|vulkan|cpu`, mapping to the `sa3.cpp/build-cuda`, `build-vulkan`, and `build` runtime dirs respectively.

> the CPU build uses the plain static `build/` (where `ggml-cpu.dll` is a direct
> dependency and loads from the addon dir). the `build-cpu-variants` tree
> (`GGML_BACKEND_DL` runtime CPU-variant selection) is **CLI-only** — its
> `ggml-cpu-*.dll` are discovered from the process dir, which the extension host
> can't satisfy, so it aborts when embedded. keep it for `sa3-generate`
> benchmarking, not for packaging.

note: all three share the extension id `gary.gary-extension`, so only one can be installed at a time — installing a second replaces the first.

> performance is variable, especially on vulkan. the vulkan backend compiles
> compute shaders on first use, so the *first* init-audio transform/continue
> after install can take several extra seconds while pipelines build and get
> cached by the GPU driver; later runs are fast. speed also depends on power
> state (keep the laptop plugged in — battery throttles the GPU hard) and on
> GPU contention from screen capture/encoding (e.g. OBS). for init-audio-heavy
> work on NVIDIA, the cuda build is the most consistent. this is all still
> experimental.

### device toggle (auto / cpu)

the dialog's embedded panel has a **device** dropdown:

- `auto` — use the GPU if the build has one (cuda/vulkan), else CPU.
- `cpu` — force the CPU backend, even on a GPU build (both the cuda and vulkan builds bundle `ggml-cpu.dll`, so this always works).

switching device recreates the libsa3 context on the next generation. handy for A/B-ing GPU vs CPU, and CPU is genuinely usable for `small-music`.

under the hood this sets `sa3_config_ex.device` in libsa3 (added on `main`); the CLI's `SA3_DEVICE=cpu` / `SA3_GPU=<index-or-name>` env vars still work as the fallback when no explicit device is passed.

### the sandbox (why there is no file picker)

when an `.ablx` is installed normally (Developer Mode off), Live launches the extension host with node's permission model enabled. the extension's javascript can only read/write:

- `%LOCALAPPDATA%\Ableton\Extensions` (the installed extension itself)
- `%LOCALAPPDATA%\Ableton\Extensions Data\gary.gary-extension` (per-extension data)
- `%LOCALAPPDATA%\Temp\Ableton Extensions`

any other path — your `C:\dev\sa3.cpp\models`, your Downloads folder, anywhere — throws `ERR_ACCESS_DENIED` at the fs layer. that is why there is no "browse for models folder" button: a picked path outside the sandbox would be unreadable anyway. instead, the dialog has **models folder** / **loras folder** reveal buttons that open the sandbox locations in Explorer so you can copy files in.

developer mode (`npm start`) runs the host unsandboxed, so external paths work there. don't be fooled while testing.

### models

press **download** in the dialog to fetch the selected variant (`medium`, `small-music`, `small-sfx`) from Hugging Face into `Extensions Data\gary.gary-extension\models`. variants that are fully present are marked with a ✓ in the variant dropdown, and the extension auto-selects an available variant on open if the current one is missing.

already have the ggufs? press **models folder** and copy them in. the checker matches files by prefix/suffix glob (e.g. `stable-audio-3-medium-dit-*-F16.gguf`), so upstream version bumps in filenames are fine.

### loras

loras are base-model specific, so they live under a **variant subfolder** and are only listed when that variant is selected. the reveal button is labelled for the current variant (e.g. **loras/medium folder**) and opens exactly the right place. drop each lora in as its own subfolder, the way a training run leaves it:

```text
loras/
  medium/
    kev/
      kev.safetensors    <- required
      kev.json           <- required (adapter metadata)
      *.txt              <- optional: one caption per file, feeds the dice button
    keygen/
      ...
  small-music/
    <loras trained on small-music>
```

so a `medium` lora is not offered while `small-music` is selected, and vice versa. detection is automatic — no import step. the first time a lora is used for generation it is converted to gguf next to its safetensors (`kev/kev-f32.gguf`) and reused after that (reconverted if the safetensors is newer). a plain `lora-<name>-f32.gguf` dropped into the variant folder also works.

the `.txt` files are the captions from your training dataset. when a lora is active, the **dice** button rolls prompts from those captions instead of the generic pool. no txt files means dice falls back to the built-in generic pool and reports the lora pool as missing.

prefix a lora folder with `_` or `.` to disable it without deleting it.

a future idea is a hugging face lora registry with a "download loras" button; for now, copy folders in by hand.

## ableton beta sequence

### easiest install

this is the path if you just want to use the extension:

1. Download the Ableton Live beta from:
   https://ableton.github.io/extensions-sdk/
2. Download the latest `.ablx` from [Releases](https://github.com/betweentwomidnights/sa3-ableton-extension/releases).
3. Open Ableton Live beta.
4. In Preferences -> Extensions, make sure Developer Mode is disabled.
5. Install the `.ablx` extension from Live's extension UI.
6. Restart Ableton Live beta if the menu entries do not appear.
7. Make sure an SA3 backend is running at `http://localhost:8006`, or edit the backend URL in the extension dialog.

### developer mode

this sequence matters if you are building from source or running Ableton's dev host:

1. Download the Ableton Live beta and Ableton Extensions SDK from:
   https://ableton.github.io/extensions-sdk/
2. Copy the SDK tarballs into [vendor/](vendor/) and run `npm install`.
3. Package the extension with `npm run package:ablx`, or use a provided `.ablx` release artifact.
4. Open Ableton Live beta first.
5. Enable Developer Mode in Preferences -> Extensions.
6. Install the `.ablx` extension from Live's extension UI.
7. Restart Ableton Live beta.
8. After Live has restarted and knows the extension is installed, run:

```shell
npm start
```

in our Windows 11 beta testing, running `npm start` before Live had seen and installed the extension meant the context-menu entries did not appear. the reliable developer-mode order was: install in Live, restart Live, then start the dev host from the terminal.

## Ableton SDK setup

this repo does not vendor Ableton's SDK packages.

1. Download the Ableton Extensions SDK beta from Ableton.
2. Copy these tarballs into [vendor/](vendor/):
   - `ableton-extensions-sdk-1.0.0-beta.0.tgz`
   - `ableton-extensions-cli-1.0.0-beta.0.tgz`
3. Install dependencies:

```shell
npm install
```

## build

```shell
npm run build
```

package an installable `.ablx`:

```shell
npm run package:ablx
```

the package is written to `dist/gary-extension.ablx`.

## developer host

run in Live developer mode:

```shell
npm start
```

before `npm start`, create a local `.env` file from [.env.example](.env.example). this is required unless you pass `--live` manually:

```shell
cp .env.example .env
```

on macOS, `.env` should usually contain:

```shell
EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Beta.app
```

on Windows, `.env` should usually contain one of:

```shell
EXTENSION_HOST_PATH=C:\ProgramData\Ableton\Live 12 Beta
EXTENSION_HOST_PATH=C:\ProgramData\Ableton\Live 12 Beta\Program\Ableton Live.exe
```

`EXTENSION_HOST_PATH` can point at the Live install root, Live executable/app bundle, ExtensionHost directory, or `ExtensionHostNodeModule.node`.

for the most reliable tested Windows 11 Live 12 beta workflow:

1. Open Live first.
2. Confirm Developer Mode is enabled in Preferences -> Extensions.
3. Run `npm start`.

this uses Ableton's stock `extensions-cli run` path.

the explicit stock CLI path is also available:

```shell
npm run start:cli
```

the Windows bootstrap we used during early testing is available as:

```shell
npm run start:win
```

on the tested Windows setup, the custom `scripts/run-dev-host.cjs` path has been more reliable than `extensions-cli run`. it relaunches itself with Ableton's bundled `Program\ExtensionHost\node.exe` before loading `ExtensionHostNodeModule.node`.

on macOS, if you want to pass Live's `.app` path directly:

```shell
npm run start:cli -- --live "/Applications/Ableton Live 12 Beta.app"
```

passing `--live` overrides `.env`, which is useful for quick debugging. plain `npm start` needs `.env`.

avoid `--inspect` unless you are attaching a debugger. in this SDK beta, `--inspect` uses a break-on-start debugging mode, so the Extension Host can print `Started: Extension Host` while the extension code itself is still paused. if the extension activates, Ableton's Extension Host log should include lines like:

```text
[gary-sa3] activate
[gary-sa3] registered context menu
```

on macOS, the Extension Host log lives under:

```text
~/Library/Preferences/Ableton/Live x.x.x/ExtensionHost.txt
```

if Live is running, developer mode is enabled, and the host is started but those `gary-sa3` log lines never appear, the extension entrypoint is not activating yet. if the log lines do appear but the menu is missing, make sure you are selecting an arrangement time range on an audio track and right-clicking that selected arrangement area.

## status

this is beta SDK exploration, not a polished product. expect the repo shape, install flow, and backend wrapper to change quickly while we learn what Ableton Extensions can really do.
