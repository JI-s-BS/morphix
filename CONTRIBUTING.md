# Contributing to Morphix

Thanks for helping! Morphix is a hackathon project turned open platform, and the most valuable help right now is **trying it with your
printer** and telling us what happened ([printer report](https://github.com/JI-s-BS/morphix/issues/new?template=printer-report.yml)).

## Reporting bugs

Open an issue with your Morphix version (`morphix version`), how it is installed, your machine and OS, the printer and connection,
steps to reproduce, and any error code (`MX-…`). `morphix doctor` and `morphix logs -n 200` help. **Remove API keys, passwords,
access codes and personal information first.** Security problems: see [SECURITY.md](SECURITY.md).

## Pull requests

1. Create a branch for your change.
2. `npm ci` (set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` if you don't need the kiosk).
3. Make a focused change and update the relevant docs.
4. Run `npm run typecheck`, `npm test`, and `npm run build:server && npm run build:renderer`.
5. Describe what you checked, including any hardware you tried it on, and what you could not check.

## Adding a printer

- **A model of a printer family Morphix already speaks**: add it to `packages/catalog/src/printers.ts` (bed, origin, nozzle, max
  temperatures, file format, start/end G-code) and to its brand guide in `docs/printers/`.
- **A new protocol**: add one driver file under `packages/printer/src/drivers/{http,lan,serial}/` implementing `PrinterDriver`
  (`packages/printer/src/drivers/types.ts`), register it in that family's `index.ts`, and test it against a fake printer in
  `tests/drivers-<family>-<name>.test.ts`. Every network call needs a timeout; every failure a plain message and a `hint`.
- Mark it `verified: "protocol"` unless you ran a real print with it, and say which printer and firmware you tried.

## Adding a slicer

Implement `SlicerAdapter` (`packages/slicing/src/adapters/types.ts`): detect the install, say which printers it supports, slice, and
give a one-line install hint per distro.

## Rules that keep people safe

- Nothing heats, moves or starts a print without the user confirming, and only when the printer state allows it.
- Temperatures stay within the catalog model's limits.
- Secrets never go into logs, URLs, git, the browser or error messages.
- Never claim hardware support that wasn't tried. More in [docs/SAFETY.md](docs/SAFETY.md).

Never commit API keys, environment files with credentials, local databases, or build output.

By contributing, you agree that your contributions are provided under this project's MIT license.
