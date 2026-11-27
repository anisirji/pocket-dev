#!/usr/bin/env bash
# Download public reference reels into ignored, local project storage.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$REPO_ROOT/.pocket-dev/reel-tools"
OUTPUT_DIR="$REPO_ROOT/.pocket-dev/reference-reels"
REEL_PYTHON="${REEL_PYTHON:-python3}"

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: bash scripts/download-reference-reels.sh [public Instagram reel URL ...]

With no URLs, downloads Ani's three saved reference reels in their saved order.
Creates an isolated Python environment and installs yt-dlp if it is missing.
Saves videos and their metadata under .pocket-dev/reference-reels/ (gitignored).
Requires Python 3.11+ and working internet access; does not read browser cookies.
HELP
  exit 0
fi

if [[ $# -eq 0 ]]; then
  set -- \
    'https://www.instagram.com/reel/Det6xAWgLk4/' \
    'https://www.instagram.com/reel/DfhNx3Lh0GP/' \
    'https://www.instagram.com/reel/Df1gkaiGSh1/'
fi

# Validate everything before installing tools or making network requests.
"$REEL_PYTHON" - "$@" <<'PY'
import re
import sys
from urllib.parse import urlparse

if sys.version_info < (3, 11):
    raise SystemExit('Python 3.11+ is required. Set REEL_PYTHON to a newer Python.')
for value in sys.argv[1:]:
    url = urlparse(value)
    if (url.scheme != 'https' or url.netloc not in ('instagram.com', 'www.instagram.com')
            or not re.fullmatch(r'/reels?/[A-Za-z0-9_-]+/?', url.path)):
        raise SystemExit('Expected a public HTTPS Instagram reel URL; no download attempted.')
PY

if [[ ! -x "$TOOLS_DIR/bin/python" ]]; then
  "$REEL_PYTHON" -m venv "$TOOLS_DIR"
fi

if ! "$TOOLS_DIR/bin/python" -m yt_dlp --version >/dev/null 2>&1; then
  printf '%s\n' 'Installing yt-dlp in the project-local environment…'
  if ! "$TOOLS_DIR/bin/python" -m pip install --disable-pip-version-check \
      --no-cache-dir --retries 1 --timeout 15 yt-dlp; then
    printf '%s\n' 'Installation failed. Check internet access in the Terminal running this script.' >&2
    exit 1
  fi
fi

mkdir -p "$OUTPUT_DIR"
printf 'Downloader: '
"$TOOLS_DIR/bin/python" -m yt_dlp --version
printf 'Destination: %s\n' "$OUTPUT_DIR"

FAILED=0
for REEL_URL in "$@"; do
  if ! "$TOOLS_DIR/bin/python" -m yt_dlp \
      --ignore-config --no-playlist --no-overwrites \
      --socket-timeout 15 --retries 1 --extractor-retries 1 \
      --restrict-filenames --write-info-json \
      -P "$OUTPUT_DIR" -o '%(id)s.%(ext)s' "$REEL_URL"; then
    FAILED=1
    printf 'Download failed for %s\n' "$REEL_URL" >&2
  fi
done

if [[ "$FAILED" -ne 0 ]]; then
  printf '%s\n' 'Some downloads failed. Check the errors above; Instagram may require login.' >&2
  exit 1
fi

printf '\nDownloads completed. Files are in %s\n' "$OUTPUT_DIR"
