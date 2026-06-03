# Gary Ableton Extension Roadmap

## Phase 1: SA3 transform baseline

- Keep one real context menu entry: `Gary SA3: Transform Selection`.
- Render selected arrangement audio with `renderPreFxAudio`.
- Submit `/transform` requests to the SA3 backend with prompt, audio, strength, steps, cfg, shift, seed, negative prompt, and BPM/current Live scale appended to the prompt.
- Replace selected audio by default, with Live undo as the restoration path.
- Keep non-replace mode available by placing the generated clip after the selected range.
- Treat multi-track selections as sequential per-track transforms until we decide whether grouped rendering is possible or desirable.
- Testing note: Kev learned Live can group tracks and bounce the group in place. That may be the cleanest current UX for transforming multiple tracks as one piece of audio without asking the extension to solve grouped rendering itself.
- Keep the first production-shaped flow SA3-only until transform and continue feel excellent.

## Phase 2: Advanced SA3 transform

- Fetch `/loras` from the active SA3 backend and show an advanced LoRA section. Done in the first advanced pass.
- Match the VST payload shape for active LoRAs. Done:
  `{ name, strength, interval_min: 0.0, interval_max: 1.0 }`.
- Persist LoRA strengths in the extension storage. Done globally; per-backend preservation can be added if needed.
- Use Live's current scale automatically when `song.scaleMode` is enabled. Done.
- Keep BPM automatic from `context.application.song.tempo`; include it in prompt composition. Done.
- Add the smart dice button, including LoRA-aware prompt pools from the backend. Done in the first advanced pass.

## Phase 3: Extend / continue

- Add a separate context menu entry for `Gary SA3: Continue Selection`. Done.
- Render the selected source as conditioning audio. Done.
- Submit `/continue` with `audio_data`, `continuation_seconds`, `continuation_mode`, prompt, BPM, seed, steps, cfg, shift, negative prompt, and LoRAs. Done.
- Use standard inpaint continuation for the public V1. Keep latent-prefix continuation experiments on a private branch until they are proven useful.
- Because the current backend returns source plus continuation, replace from the selection start with one longer audio clip. Done for V1.
- For V1, continue selected audio tracks sequentially like transform. Grouped multi-layer continuation should be a separate experiment.
- Live's group-track bounce-in-place workflow may answer much of this: group the layers, bounce the group in place, then continue that bounced audio as one coherent source.

## Phase 4: Generate from empty selection

- Add a separate context menu entry for `Gary SA3: Generate Selection`. Done.
- Use the selected arrangement time as the generation duration. Done.
- Open a generation-mode SA3 dialog instead of transform. Done.
- Submit `/generate` with prompt, selected duration, BPM, seed, steps, cfg, shift, negative prompt, and LoRAs. Done.
- Create the generated clip in the selected lane at the selected time range. Done.
- Consider `/generate/loop` once plain selected-duration generation is tested in Live.

## Open questions

- Should multi-track selection mean sequential independent transforms, a single grouped mix transform, or a stem-aware request where all layers are sent together?
- How far should the extension lean on Live's native group-and-bounce workflow for multi-track transform/continue instead of building custom grouped rendering behavior?
- For generated alternates, should non-replace mode land to the right, below on a new track, or follow Ableton's stem-separation style by deactivating originals and creating new tracks?
- Can the SDK render MIDI tracks cleanly enough for this workflow, or should MIDI remain explicit via Live's bounce-in-place command?
- Should MIDI transform ever replace MIDI with audio, or should that always create a new audio lane to avoid surprising the user?
- Where should non-replace results land long-term: after the selection, on a new audio track, or in a generated-takes lane if the SDK exposes one?
- Should we add manual key/scale override for cases where Live Scale Mode is off but the user still wants a harmonic hint?
