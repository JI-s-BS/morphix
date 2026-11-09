# Morphix roadmap — five phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Local foundation: Electron/React/TS kiosk app for 1024×600, push-to-talk mic, audio playback, live QD330 camera, Three.js viewer, model library, SQLite, local storage, demo Gemini/Meshy adapters, observation-only printer, settings, logs, crash recovery | **Built — awaiting on-device sign-off** |
| 2 | Gemini Live voice + Meshy generation, revisions, sizing by voice, cost confirmation | **Built** — live Gemini proposal flow verified; awaiting keys on the Pi |
| 3 | Print preparation: validation, repair, orientation, slicing via existing engine, QD330 file validation, protocol investigation | **Built + wired** (Prepare screen). Verified on a real Meshy model; needs `prusa-slicer` on the Pi; `.gx` layout unverified |
| 4 | AI Print Guardian: snapshots, OpenCV, multi-frame confirmation, Gemini verification, alerts, incident history | **Built + wired** (Printer page). Tuning on a real print still to do; auto-pause off |
| 5 | Controlled printing: verified transfer, approved print start, pause/resume/cancel with confirmed acks, end-to-end demo, autostart | **Built + wired, locked** until the operator checklist (docs/PHASE5.md) sets `MORPHIX_PRINT_CONTROLS=1` |

## Phase 1 checklist (verify on the Pi with the touchscreen)
- [ ] App opens fullscreen on the 1024×600 touchscreen; all buttons easy to hit
- [ ] Hold-to-talk records from the TONOR G11; "Play recording" plays through the speaker
- [ ] "Test speaker" chime is audible
- [ ] Printer page shows the live QD330 camera and READY status
- [ ] "A small vase" → Create model → progress → Open in viewer; rotate/pinch/pan works
- [ ] 6 in preset updates the dimensions and fit check
- [ ] Library shows the model with a thumbnail after a restart
- [ ] Files appear under /home/jd/Morphix/models and the database under /home/jd/Morphix/database

## Phase 2 notes
- Voice: push-to-talk utterances go to Gemini Live (`gemini-3.8-live`, 16 kHz in / 24 kHz out) through the main process; the key never reaches the UI.
- Gemini can only *propose* via tools (generate_model, revise_model, refine_current_model, set_model_height, get_app_state, request_print). Anything that spends Meshy credits waits for a Confirm tap or a spoken "yes" that the app checks itself (`isAffirmative`). Daily cap: `MORPHIX_MESHY_DAILY_LIMIT`.
- Meshy: preview (20 credits on meshy-6) returns GLB + STL, downloaded to ~/Morphix immediately; "Add colour" runs refine (10 credits). Running jobs resume after a restart.
- Touch: the QDtech panel reports as a mouse pointer, so the app converts drags into scrolling. On-screen keyboard for typing ideas and Wi-Fi passwords. Settings → Network manages Wi-Fi via NetworkManager; the printer link is read-only.
