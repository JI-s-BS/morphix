# Architecture

```
React UI (apps/desktop/src)  ──window.morphix (typed, preload)──▶  Electron main (apps/desktop/electron)
                                                                     ├─ packages/database   SQLite (sql.js/WASM) → ~/Morphix/database
                                                                     ├─ packages/storage    ~/Morphix layout, atomic writes, logs
                                                                     ├─ packages/domain     workflow state machine (approval gates)
                                                                     ├─ packages/meshy      generator adapters (demo now, Meshy in P2)
                                                                     ├─ packages/gemini     assistant adapters (demo now, Gemini Live in P2)
                                                                     ├─ packages/printer    QD330 observer — read-only command allowlist
                                                                     └─ packages/slicing    build-volume checks (slicer integration in P3)
```

* **Security** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; IPC handlers reject
  frames that are not the app's own page; navigation and new windows are blocked; only microphone
  permission is granted; API keys stay in the main process.
* **Local server** — the main process serves the UI and read-only model files on `127.0.0.1` (random port).
  This gives the page a secure context for the microphone while allowing the printer's plain-HTTP camera
  (`img-src http://192.168.10.51:8080` in the CSP). Requests outside the UI folder or the
  `models/`, `previews/`, `cache/recordings/`, `snapshots/` folders return 404.
* **Printer safety** — `packages/printer` can only send `M601 S1`, `M602`, `M115`, `M119`, `M105`, `M114`, `M27`.
  The workflow refuses `uploading/ready/printing` while print controls are disabled, and `uploading`
  always requires explicit user approval.
* **Crash recovery** — renderer crashes reload the window; generation tasks left running are marked
  interrupted at startup; the database is flushed atomically and backed up daily (7 kept);
  the user service restarts the app on failure.
* **Audio** — AudioWorklet capture, downsampled to 16 kHz mono PCM16 (Gemini Live's input format),
  saved as WAV in `~/Morphix/cache/recordings`.
