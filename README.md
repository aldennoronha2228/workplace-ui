# WireUp Workplace UI

Standalone Vite + React + TypeScript playground for the WireUp hardware workspace frontend.

These components were extracted from the main [hihihih](https://github.com/aldennoronha2228/hihihih) repository so UI changes can be developed and previewed independently.

## Run locally

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173

## Notes for editors

- Heavy hardware runtime, API, Velxio registry, and SPICE dependencies are stubbed.
- The goal of this repo is visual / layout / interaction changes to the workspace UI.
- Main entry point is `src/components/hardware-workspace.tsx`.
- Related views: schematic-canvas, schematic-studio, breadboard-view, hardware-instruments, build-guide, connection-check.

When you are happy with UI changes, they can be copied back into the main WireUp repository.
