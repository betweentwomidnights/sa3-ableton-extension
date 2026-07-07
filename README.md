# sa3 ableton extension

stable audio 3 generation, transformation, and continuation directly inside Ableton Live arrangement selections.

> ## ⚗️ experimental branch — embedded sa3.cpp
>
> **this is the experimental branch where we embed [sa3.cpp](https://github.com/betweentwomidnights/sa3.cpp) directly into the extension** — no separate backend process. still iterating; **not merging into `main` just yet.**
>
> **downloads (v0.1.0, experimental):** [cuda ~575 MB](https://github.com/betweentwomidnights/sa3-ableton-extension/releases/download/v0.1.0/gary-extension-cuda.ablx) · [vulkan ~15 MB](https://github.com/betweentwomidnights/sa3-ableton-extension/releases/download/v0.1.0/gary-extension-vulkan.ablx) · [cpu ~1 MB](https://github.com/betweentwomidnights/sa3-ableton-extension/releases/download/v0.1.0/gary-extension-cpu.ablx) · [all releases](https://github.com/betweentwomidnights/sa3-ableton-extension/releases)
>
> everything should theoretically still work if you switch to http requests and `local` mode, but right now we're busy testing the different sa3.cpp builds (CUDA, VULKAN, and — very shortly — Metal) to see what breaks.
>
> install with Developer Mode **off** in Ableton Live beta.

## embedded sa3.cpp backend (this branch)

this branch embeds `sa3.cpp` directly inside the extension as a native node addon — no separate backend process. select `embedded` in the dialog's backend toggle.

### builds (cuda / vulkan / cpu)

the addon itself is backend-agnostic — it `LoadLibrary`s `sa3.dll` at runtime, so the only difference between builds is which `ggml` runtime DLLs are bundled next to it. three flavours:

| backend | build script | bundled runtime | .ablx size | notes |
| --- | --- | --- | --- | --- |
| cuda   | `npm run package:cuda`   | `ggml-cuda` + CUDA runtime (`cublas*`, `cudart*`) | ~600 MB | fastest on NVIDIA; huge because of the CUDA runtime |
| vulkan | `npm run package:vulkan` | `ggml-vulkan` | ~15 MB | runs on any Vulkan GPU (NVIDIA/AMD/Intel); needs the system Vulkan loader (`vulkan-1.dll`, ships with GPU drivers). basically as fast as CUDA for this workload |
| cpu    | `npm run package:cpu`    | static `ggml-cpu` | ~3 MB | no GPU needed. slow for `medium`, genuinely usable for `small-music` |
| metal  | `npm run package:metal`  | `libsa3.dylib` + `ggml` dylibs (`ggml-metal`, `ggml-blas`, `ggml-cpu`, `ggml-base`) | ~15 MB | **macOS / Apple Silicon only**. uses the Metal GPU backend; the Metal shaders are embedded in `libggml-metal.dylib` (no separate `.metallib`). the packager rewrites the dylib rpaths to `@loader_path` and re-adhoc-signs them so the extension host can `dlopen` them |

`npm run package:all` builds all three Windows flavours in one pass (compiling the addon once). outputs land in `dist/gary-extension-<backend>.ablx` (also copied into the gitignored `releases/`). the backend is selected at build time with `GARY_SA3_BACKEND=cuda|vulkan|cpu|metal`, mapping to the `sa3.cpp/build-cuda`, `build-vulkan`, `build`, and `build-metal` runtime dirs respectively. `metal` is macOS-only (`npm run package:metal`); the Windows `package:all` does not include it.

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

### building from source

the addon compiles against `sa3.cpp` headers and bundles that project's runtime
(`sa3.dll` + `ggml` DLLs on Windows; `libsa3.dylib` + `ggml` dylibs on macOS), so
**`sa3.cpp` must be checked out next to this repo** (a sibling directory), or
point `SA3_CPP_DIR` at it:

```text
<parent>/
  sa3.cpp/                  <- https://github.com/betweentwomidnights/sa3.cpp
  sa3-ableton-extension/    <- this repo
```

prerequisites:

- Node 20+, and the Ableton Extensions SDK/CLI tarballs in [vendor/](vendor/) (then `npm install`)
- **Windows**: Visual Studio 2022 with the C++ toolchain (node-gyp compiles the native addon)
- **macOS**: the Xcode command-line tools (`xcode-select --install`) for clang + `install_name_tool`/`codesign`
- **cuda** build: the CUDA Toolkit with `CUDA_PATH` set — the packager copies `cudart*`/`cublas*` from `%CUDA_PATH%\bin`
- **vulkan** build: the Vulkan SDK (needed to build `sa3.cpp`; running only needs the driver's `vulkan-1.dll`)
- **metal** build: macOS on Apple Silicon; nothing extra beyond the Xcode CLT (Metal ships with the OS)

**1. build the sa3.cpp runtime** for the backend(s) you want, from the `sa3.cpp` dir:

```bat
build.cmd cuda      :: -> build-cuda/    (Windows)
build.cmd vulkan    :: -> build-vulkan/  (Windows)
build.cmd cpu       :: -> build/         (the static CPU build the extension packages)
```

```bash
./build.sh metal    #  -> build-metal/   (macOS)
```

**2. package the extension**, from this repo:

```bash
npm install
npm run package:cuda     # Windows: or package:vulkan / package:cpu / package:all
npm run package:metal    # macOS
```

each `.ablx` lands in `dist/` (and the gitignored `releases/`). `GARY_SA3_BACKEND`
selects which `sa3.cpp` build dir is bundled (`cuda`->`build-cuda`,
`vulkan`->`build-vulkan`, `cpu`->`build`, `metal`->`build-metal`); override the
location with `SA3_CPP_DIR` if your checkout isn't the sibling default. on macOS
the packager copies `libsa3.dylib` and its `ggml` dylib dependencies flat next to
the addon, rewrites their rpaths to `@loader_path`, and re-adhoc-signs them.

to iterate in Ableton's dev host without repackaging each time, `npm run start:win`
runs the extension unsandboxed against a local Live install — set
`EXTENSION_HOST_PATH` in `.env` to your Live beta path first.

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
