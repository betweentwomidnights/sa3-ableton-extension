# SA3 Ableton Extension

Stable Audio 3 generation, transformation, and continuation directly inside Ableton Live arrangement selections.

This is an early V1 built against the Ableton Extensions SDK beta. The long-term idea is much larger: model workflows that feel native inside Live instead of forcing the user to leave the DAW, record into a plugin, drag files around, or manually line generated audio back up on the timeline. For now, this repo is intentionally focused on Stable Audio 3.

## What It Does

The extension adds three right-click actions on audio-track arrangement selections:

- `Gary SA3: Transform Selection`
- `Gary SA3: Continue Selection`
- `Gary SA3: Generate Selection`

Transform renders the selected audio range, sends it to an SA3 backend, and replaces the selected region by default.

Continue renders the selected audio range, asks SA3 for a longer inpaint continuation, and replaces from the selection start with the returned source-plus-continuation clip.

Generate uses the selected arrangement duration to create audio from text and places the result at the selected start.

Live undo restores the previous timeline state, which makes the replace workflow feel surprisingly natural.

## Backend

This repo is local-first. The public branch defaults to:

```text
http://localhost:8006
```

The dialog keeps an editable backend URL field, so you can point it at any compatible SA3 server you control.

Tested today with the Gary4local companion app:

https://github.com/betweentwomidnights/gary-localhost-installer

We are extracting a standalone backend from Gary4local's `services/sa3/api.py` so people can run a small API wrapper around their existing official Stable Audio 3 checkout. The goal is to stay as close as possible to upstream:

https://github.com/Stability-AI/stable-audio-3

If you do not have a suitable GPU and want hosted access, open an issue or reach out. We are thinking carefully about how to offer a remote option without accidentally melting our own hardware.

## Backend Contract

The extension expects an SA3-compatible HTTP backend with:

- `GET /health`
- `GET /loras`
- `GET /prompts`
- `POST /generate`
- `POST /transform`
- `POST /continue`
- `GET /poll_status/<session_id>`

The local backend work-in-progress also preserves useful output-shaping environment variables from Gary4local, including latent scaling, peak normalization, and a gentle limiter. See [PUBLIC_RELEASE_PLAN.md](PUBLIC_RELEASE_PLAN.md).

## Ableton SDK Setup

This repo does not vendor Ableton's SDK packages.

1. Download the Ableton Extensions SDK beta from Ableton.
2. Copy these tarballs into [vendor/](vendor/):
   - `ableton-extensions-sdk-1.0.0-beta.0.tgz`
   - `ableton-extensions-cli-1.0.0-beta.0.tgz`
3. Install dependencies:

```shell
npm install
```

## Build

```shell
npm run build
```

Package an installable `.ablx`:

```shell
npm run package:ablx
```

The package is written to `dist/gary-extension.ablx`.

## Developer Host

Run in Live developer mode with the Windows host bootstrap:

```shell
npm start
```

Create a local `.env` file that points `EXTENSION_HOST_PATH` at the Live install root, Ableton Live executable, ExtensionHost directory, or `ExtensionHostNodeModule.node`.

For the most reliable tested Windows 11 Live 12 beta workflow:

1. Open Live first.
2. Confirm Developer Mode is enabled in Preferences -> Extensions.
3. Run `npm start`.

The script relaunches itself with Ableton's bundled `Program\ExtensionHost\node.exe` before loading `ExtensionHostNodeModule.node`.

The stock CLI path is still available:

```shell
npm run start:cli
```

On the tested Windows setup, the custom `scripts/run-dev-host.cjs` path has been more reliable than `extensions-cli run`.

## Status

This is beta SDK exploration, not a polished product. Expect the repo shape, install flow, and backend wrapper to change quickly while we learn what Ableton Extensions can really do.
