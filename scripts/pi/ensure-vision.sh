#!/bin/bash
# Python environment for the AI Print Guardian (services/vision). No sudo:
# a venv that can see system packages (python3-opencv from apt, if installed),
# otherwise opencv-python-headless + numpy from PyPI.
set -euo pipefail
cd "$(dirname "$0")/../.."
VENV="$HOME/.local/share/morphix-vision"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv --system-site-packages "$VENV"
fi
if ! "$VENV/bin/python" -c "import cv2, numpy" 2>/dev/null; then
  echo "Installing OpenCV for the guardian (first run only)"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check -r services/vision/requirements.txt
fi
"$VENV/bin/python" -c "import cv2; print('guardian python ok, OpenCV', cv2.__version__)"
