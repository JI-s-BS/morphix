# Morphix

AI-assisted 3D printing: turn spoken ideas, photos, drawings, and dimensioned part descriptions into models you can preview, prepare, and send to a compatible printer.

> **Hackathon disclaimer:** Morphix was built during MDC 2026 SharkByte, where it won **1st place**. This repository shares the hackathon prototype as an open-source project. It is experimental software and is provided as-is; features and hardware integrations may need further development and validation.

[Devpost project](https://devpost.com/software/morphix-kbzot2#updates) · [MIT license](LICENSE)

## What it does

- Electron + React touchscreen interface for a Raspberry Pi 4 and Afinia QD330 workflow.
- Gemini voice interaction and Meshy model generation.
- Claude + OpenSCAD generation for dimensioned CAD parts.
- Model preview, size selection, local slicing, and an explicit approval workflow.
- Print Guardian camera analysis using Python/OpenCV, with optional cloud AI review.
- A local web portal and a separate remote phone interface.

The intended flow is **describe → generate → preview → prepare → approve → print → monitor**. Cloud features require your own accounts and API keys; provider usage may cost money. The application can be built and tested without those keys, but live AI features will be unavailable. Some older phase documents describe earlier implementation stages.

## Requirements

- Node.js **22** and npm.
- A graphical desktop supported by Electron to run the app. Raspberry Pi deployment scripts target Linux with a Wayland desktop and systemd user services.
- Optional: PrusaSlicer for local slicing, OpenSCAD for CAD generation, Python 3 with NumPy/OpenCV for camera monitoring.
- A compatible printer for physical printing. The included integration targets the **Afinia QD330**; other printers are not automatically supported.

## Quick start

```bash
git clone https://github.com/JI-s-BS/morphix.git
cd morphix
npm ci
npm test
npm run typecheck
npm run build
```

Create your local configuration (Linux/macOS shell):

```bash
mkdir -p "$HOME/Morphix/config"
cp config/morphix.env.example "$HOME/Morphix/config/morphix.env"
# Edit this file and add the keys for the features you want.
```

Launch in a regular window:

```bash
MORPHIX_WINDOWED=1 npm start
```

The default data directory is `~/Morphix`, containing configuration, models, database, and logs. Set `MORPHIX_ROOT` to use another directory; the application reads `config/morphix.env` inside that directory. The repository's `config/morphix.env.example` is a template, not a file the app loads directly. Keep real credentials out of Git.

## Configure AI and optional services

| Variable | Used for |
| --- | --- |
| `GEMINI_API_KEY` | Gemini voice and AI features |
| `MESHY_API_KEY` | Text/image-to-3D generation |
| `ANTHROPIC_API_KEY` | Claude CAD generation; also requires OpenSCAD |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` | Optional authenticated portal; see the portal guide for the remaining settings |
| `TIGER_DATABASE_URL`, `SWARMS_API_KEY`, `VULTR_INFERENCE_API_KEY` | Optional telemetry, review, and inference integrations |

See [the environment template](config/morphix.env.example) for printer and remote settings. AI model availability depends on your provider account; review the model settings if a provider rejects a configured model.

## Raspberry Pi setup

On a Raspberry Pi with a graphical Linux desktop and Node.js 22 installed, follow the quick start above, then install the optional local tools:

```bash
sudo apt update
sudo apt install -y prusa-slicer openscad python3-opencv python3-numpy
```

Configure your own printer address with `MORPHIX_PRINTER_HOST` in your environment file. IP addresses in older guides are examples from the hackathon installation.

To install the included systemd user services:

```bash
bash scripts/pi/install-user-services.sh
systemctl --user start morphix
journalctl --user -u morphix -f
```

The installer also starts the QD330 dashboard service. Review its settings before using it on your network. User services require a working user systemd session; startup at boot also depends on your machine's session and lingering configuration. The Electron launcher expects a Wayland desktop.

The local portal uses port **8443** when configured (HTTP by default), and the QD330 dashboard uses port **8000**. Use your Pi's actual address. Set `QD330_TOKEN` in `~/.config/qd330-web.env` and restart `qd330-web` to require a dashboard token. Keep printer services on a trusted network.

## Printing and monitoring

Physical printing needs hardware validation. Start with [the printer validation checklist](docs/PHASE5.md), which describes the print-control and GX verification flags. Do not enable those flags until you have validated the workflow on your hardware. Review generated models, dimensions, and slicer output before approving a print. Print Guardian is experimental and does not replace operator supervision.

## Development

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Vitest suite |
| `npm run typecheck` | Check TypeScript |
| `npm run build` | Build Electron and its renderer |
| `npm run dev:renderer` | Start the renderer development server |
| `npm run dev:remote` | Start the remote UI development server on port 5174 |
| `npm run build:remote` | Build the remote web interface |

The renderer development server alone does not launch Electron. For Python vision development and tests, see [services/vision/README.md](services/vision/README.md). A full desktop/printer check requires a graphical session, configured providers, and hardware.

## Project layout

```text
apps/desktop/              Electron main process and React UI
apps/remote/               Remote phone web interface
packages/                  Shared types, AI adapters, CAD, slicing, storage,
                           printer, portal, jobs, and monitoring
services/vision/           Python/OpenCV camera worker
services/qd330-dashboard/  Printer dashboard and CLI
config/                    Environment examples and printer/slicer profiles
scripts/pi/                Raspberry Pi build, launch, and service scripts
tests/                     TypeScript tests
docs/                      Architecture and integration guides
```

See [architecture](docs/ARCHITECTURE.md), [CAD](docs/CAD.md), [photo-to-3D](docs/PHOTO3D.md), [portal](docs/PORTAL.md), [remote access](docs/REMOTE.md), and [error reference](docs/ERRORS.md). The included `deploy.sh` is for the original Pi deployment environment; pushing to this repository does not by itself configure automatic deployment.

## Contributing

Issues and pull requests are welcome. Include reproduction steps for bugs, keep credentials and generated files out of commits, and run the tests, typecheck, and build before submitting changes. For printer integrations, document the exact hardware and validation performed. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Morphix is released under the [MIT License](LICENSE). Third-party dependencies, external services, and imported models retain their own licenses and terms.
