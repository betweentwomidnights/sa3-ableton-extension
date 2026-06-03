# Ableton Extensions SDK Exploration Notes

## What looks viable

- Context menu actions can target `AudioTrack.ArrangementSelection`, so a right-click action can receive the selected arrangement time range plus selected lanes.
- The SDK can render selected arrangement audio through `context.resources.renderPreFxAudio(track, startBeat, endBeat)`.
- Extensions can use Node-style filesystem access inside the extension storage/temp directories.
- The docs explicitly show `fetch` for downloading audio from an API, so HTTP requests from the extension host are part of the intended workflow.
- Modal webviews can be shown from `data:` URLs and can return JSON back to extension code.
- Generated/downloaded WAVs should be written into the extension temp directory, imported with `context.resources.importIntoProject`, then used to create Live audio clips.
- Live undo cleanly restores the original selected audio after a replacement transform.
- Multi-track arrangement selections are passed through as multiple selected lanes. The current implementation transforms each selected audio track sequentially.
- Partial clip selection works: Live can render and replace only the selected beat range.
- Empty or silent arrangement ranges can be used as generation targets. The extension submits `/generate` without rendering source audio and creates the returned clip at the selected start with the selected duration.
- Live's current scale is exposed in SDK `1.0.0-beta.0` as `song.rootNote`, `song.scaleName`, `song.scaleMode`, and `song.scaleIntervals`.
- The extension now appends BPM and the current Live scale to SA3 prompts when Scale Mode is enabled.
- The local SDK types do not appear to expose Live's time signature/meter yet, even though key/scale is exposed. This is useful beta feedback because bar-based UX currently has to assume 4 beats per bar.
- The seed UX mirrors the JUCE SA3 tab: the last returned seed is displayed, but the transform request sends `-1` unless the user enables the seed checkbox.
- The dialog is served from a short-lived localhost bridge in the extension host. Dice and LoRA refresh call same-origin bridge endpoints, which proxy `/prompts` and `/loras` through the host and avoid WebView CORS/reopen churn.
- The SA3 dialog mirrors the `gary4juce` backend toggle: remote uses `https://g4l.thecollabagepatch.com/sa3`, local uses `http://localhost:8006`, and health probes `/health` through the localhost bridge.
- V1 should stay SA3-focused. Other transform-capable models can become tabs later, but SA3 already proves the right-click selected-audio UX.
- SA3 Continue is now a separate context-menu action. It sends the selected audio to `/continue`, asks for a continuation `duration (bars)`, and places the returned source-plus-tail audio as one longer replacement clip starting at the selection start.

## Current beta constraints

- The SDK exposes pre-FX arrangement rendering, not post-FX rendering.
- The baseline implementation only handles selected audio tracks, not take lanes or arbitrary selected clips.
- The baseline implementation creates clips back on the selected source tracks. Replacement is on by default; non-replacement places the generated audio after the selected range.
- The Windows beta developer-host path currently needs `scripts/run-dev-host.cjs`, which preloads a few globals before loading `ExtensionHostNodeModule.node`.
- `npm start` should be run after Live is already open. The script re-launches itself under Live's bundled `Program\ExtensionHost\node.exe`, matching the process shape that successfully registered context menus in testing.
- Continue currently follows transform's per-audio-track loop. Multi-track continuation still means independent continuations, not one grouped model request.
- Generate currently follows the same selected-audio-track loop. If multiple audio tracks are selected, it will create one independent generation per track.

## Suggested next steps

- Test the prototype inside Live developer mode with remote SA3 first, then localhost `http://localhost:8006`.
- Confirm whether `renderPreFxAudio` produces exactly the audio semantics we want for multi-track selections.
- Test the separate `Gary SA3: Continue Selection` action using `/sa3/continue`.
- Test the separate `Gary SA3: Generate Selection` action on empty audio-track arrangement ranges.
- Decide whether transformed audio should replace the source, land on a new track, or land on a generated-takes lane.
