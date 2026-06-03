# Gary Extension

Ableton Extensions SDK prototype for running Gary model workflows directly from Live arrangement selections.

What it does:

- Adds `Gary SA3: Transform Selection` to `AudioTrack.ArrangementSelection`.
- Adds `Gary SA3: Continue Selection` to the same context-menu scope.
- Adds `Gary SA3: Generate Selection` for creating audio from an empty or selected arrangement time span.
- Renders the selected audio-track time range with `renderPreFxAudio`.
- Opens a small Ableton-styled SA3 dialog with dice prompts and advanced LoRA sliders.
- Includes a remote/local SA3 backend toggle and health indicator.
- Sends the rendered WAV to `/sa3/transform`.
- Sends continuation requests to `/sa3/continue` with the selected audio as conditioning.
- Sends generation requests to `/sa3/generate`, using the selected Live duration as the requested audio duration.
- Polls `/sa3/poll_status/<session_id>`.
- Writes the returned WAV into the extension temp directory.
- Imports it into the Live project and creates a new audio clip.
- Appends Live tempo and Live's current scale to the prompt when Scale Mode is enabled.
- Fetches LoRAs from `/sa3/loras` and sends active LoRAs in the same payload shape as `gary4juce`.
- Rolls prompts from `/sa3/prompts`, including active LoRA prompt pools.
- Keeps the last returned seed visible but disabled until the user enables seeded transforms.

Defaults:

- Remote backend: `https://g4l.thecollabagepatch.com/sa3`
- Local backend: `http://localhost:8006`
- `replace selection` is on by default because it is the cleanest UX and Live undo restores the source.
- When transform `replace selection` is off, the generated clip is placed after the selected range and moved past existing clips on that track.
- Continue treats SA3's returned audio as source plus continuation, so it replaces from the selection start with a longer clip. The `duration (bars)` field controls how much new audio to request.
- Generate places one generated clip at the selection start with the same duration as the selected arrangement range.

Install dependencies:

```shell
npm install
```

Build:

```shell
npm run build
```

Package an installable `.ablx`:

```shell
npm run package:ablx
```

The package is written to `dist/gary-extension.ablx`.

Run in Live developer mode with the Windows host bootstrap:

```shell
npm start
```

The `.env` file should point `EXTENSION_HOST_PATH` at the Live install root, Ableton Live executable, ExtensionHost directory, or `ExtensionHostNodeModule.node`.

For the most reliable beta workflow, open Live first, confirm Developer Mode is enabled in Preferences -> Extensions, then run `npm start`. The script will re-launch itself with Ableton's bundled `Program\ExtensionHost\node.exe` before loading `ExtensionHostNodeModule.node`.

The stock CLI path is still available as:

```shell
npm run start:cli
```

On the tested Windows 11 Live 12 beta setup, the custom `scripts/run-dev-host.cjs` path is currently more reliable than `extensions-cli run`.
