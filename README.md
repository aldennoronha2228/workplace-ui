# Workplace UI

A frontend-only Workplace editor shell extracted for UI redesign work.

This project intentionally contains no backend, API client, authentication,
AI/chat integration, firmware compiler, ESP32 runtime, or circuit simulator.
The component cards and editor canvas are visual placeholders only.

## Run locally

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (usually http://127.0.0.1:5173).

## For editors

The complete editable page is in:

- `src/components/hardware-workspace.tsx` — page structure and component groups
- `src/index.css` — all page styling

The component library is static by design so the UI can be redesigned without
bringing along the original application's backend or hardware implementation.
