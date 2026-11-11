# Integration (merge of the parallel sessions)

Branch `open-platform-merge`, made from the server branch (claude/op-server-8915a6). Merged, in this order:

| Session | Branch head | Notes |
|---|---|---|
| server | af8370a | base |
| cleanup | b4f6d84 | conflict: `tests/sponsor-integrations.test.ts`. Cleanup deleted it and server had edited it; the deletion was kept. |
| catalog | 66f2d46 | |
| slicers | d4d2615 | `SLICERS` is exported from `@morphix/slicing`, so the server's driver printing and the setup page's slicer step use the adapters. |
| drivers-lan | 182737e | |
| drivers-serial | 0d76abd | |
| setup | a678180 | |
| install | 68e0706 | |

**Not merged: drivers-http** (Moonraker, OctoPrint, PrusaLink, Duet). That branch has no commits yet. `HTTP_DRIVERS` is empty, so the 14
catalog models that use those drivers can be picked, but resolving the connection falls back with "driver … is not available in this build".
README and docs/printers say "in progress".

Checks after the merge:
- Typecheck passes; 982 tests pass (6 skipped).
- Build and live run: first-run setup (admin → printer → slicer → keys → done), sign-in, RPC, and the phone layout were tried in a browser.

Fixes made during integration:
- Driver temperature changes are refused during a print (docs/SAFETY.md rule 1). docs/SAFETY.md now has a section on printers added from the setup page.
- Phone layout (styles.css `@media (max-width: 720px)`): one column with tabs at the bottom.
- README links fixed after cleanup merged the old docs (CAD/PHOTO3D/PHASE5 now live in AI/SAFETY/QD330).
- config/morphix.env.example rewritten (it still listed the removed portal, phone app and sponsor services); CONTRIBUTING expanded.
- Added SECURITY.md, .github issue/PR templates (including a "printer report" form). (A CI workflow is ready but not pushed yet: pushing workflows needs a token with the `workflow` scope.)
