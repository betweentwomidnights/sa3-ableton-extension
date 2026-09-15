# releases

Packaged `.ablx` builds are intentionally **not committed** here — they are large
build artifacts (the CUDA build is ~575 MB) and `releases/*.ablx` is gitignored.

Where to get a build:

- **Download:** the latest `.ablx` per backend is published on the
  [GitHub Releases page](https://github.com/betweentwomidnights/sa3-ableton-extension/releases).
- **Build locally:** artifacts emerge in `dist/` (and are copied here, gitignored):
  - `npm run package:cuda` — NVIDIA, ~575 MB
  - `npm run package:vulkan` — any Vulkan GPU, ~15 MB
  - `npm run package:cpu` — CPU only, ~3 MB
  - `npm run package:all` — all three in one pass
