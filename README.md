# sa3 ableton extension

stable audio 3 generation, transformation, and continuation directly inside Ableton Live arrangement selections.

fair warning...there's a bit of setup involved and you'll have to run at least one terminal while using the ableton beta (two terminals if you're not using gary4local)

2nd warning...untested on macOS. plz let me know if it works/doesn't work on apple silicon.

this is an early V1 built against the Ableton Extensions SDK beta. the long-term idea is much larger: model workflows that feel native inside Live instead of forcing the user to leave the DAW, record into a plugin, drag files around, or manually line generated audio back up on the timeline. for now, this repo is intentionally focused on stable audio 3.

## what it do

the extension adds three right-click actions on audio-track arrangement selections:

- `Gary SA3: Transform Selection`
- `Gary SA3: Continue Selection`
- `Gary SA3: Generate Selection`

transform renders the selected audio range, sends it to an SA3 backend, and replaces the selected region by default.

continue renders the selected audio range, asks SA3 for a longer inpaint continuation, and replaces from the selection start with the returned source-plus-continuation clip.

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

the local backend also preserves useful output-shaping environment variables from gary4local, including latent scaling, peak normalization, and a gentle limiter. these handle some of the loudness issues i get from my loras. see [PUBLIC_RELEASE_PLAN.md](PUBLIC_RELEASE_PLAN.md).

backend extraction is now in [backend/](backend/). start with [backend/README.md](backend/README.md); the local SA3 setup uses `uv` and installs the official upstream stable audio 3 repo into the backend venv.

LoRA setup is documented in [backend/LORAS.md](backend/LORAS.md), including registry JSON, prompt dice files, and API checks.

## ableton beta sequence

this sequence matters with the current Ableton Extensions SDK beta:

1. Download the Ableton Live beta and Ableton Extensions SDK from:
   https://ableton.github.io/extensions-sdk/
2. If building from source, copy the SDK tarballs into [vendor/](vendor/) and run `npm install`.
3. Package the extension with `npm run package:ablx`, or use a provided `.ablx` release artifact.
4. Open Ableton Live beta first.
5. Enable Developer Mode in Preferences -> Extensions.
6. Install the `.ablx` extension from Live's extension UI.
7. Restart Ableton Live beta.
8. After Live has restarted and knows the extension is installed, run:

```shell
npm start
```

in our Windows 11 beta testing, running `npm start` before Live had seen and installed the extension meant the context-menu entries did not appear. the reliable order was: install in Live (enable developer mode), restart Live, then start the dev host from the terminal.

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

run in Live developer mode with the Windows host bootstrap:

```shell
npm start
```

create a local `.env` file from [.env.example](.env.example) that points `EXTENSION_HOST_PATH` at the Live install root, Ableton Live executable, ExtensionHost directory, or `ExtensionHostNodeModule.node`.

for the most reliable tested Windows 11 Live 12 beta workflow:

1. Open Live first.
2. Confirm Developer Mode is enabled in Preferences -> Extensions.
3. Run `npm start`.

the script relaunches itself with Ableton's bundled `Program\ExtensionHost\node.exe` before loading `ExtensionHostNodeModule.node`.

the stock CLI path is still available:

```shell
npm run start:cli
```

on the tested Windows setup, the custom `scripts/run-dev-host.cjs` path has been more reliable than `extensions-cli run`.

## status

this is beta SDK exploration, not a polished product. expect the repo shape, install flow, and backend wrapper to change quickly while we learn what Ableton Extensions can really do.
