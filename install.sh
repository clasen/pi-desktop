#!/bin/bash
# Usage: curl -fsSL https://raw.githubusercontent.com/clasen/pi-desktop/master/install.sh | bash

set -euo pipefail

main() {
  local repo="clasen/pi-desktop"
  local releases="https://github.com/$repo/releases"
  local api="https://api.github.com/repos/$repo/releases?per_page=10"
  local platform arch suffix urls url download name expected actual stage="" backup="" destination=""
  local connect_timeout=15 download_timeout=600

  fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
  confirm() {
    local answer
    # stdin contains the script when invoked through curl | bash.
    if ! { printf '%s [y/N] ' "$*" > /dev/tty; IFS= read -r answer < /dev/tty; } 2>/dev/null; then
      return 1
    fi
    [[ "$answer" = y || "$answer" = Y ]]
  }
  download_file() {
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout "$connect_timeout" --max-time "$download_timeout" "$1" -o "$2" \
      || fail "Download failed: $1. Check your connection and available disk space, then retry."
  }
  cleanup() {
    if [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$destination" ]; then
      mv "$backup" "$destination" || printf 'Restore the previous app from %s\n' "$backup" >&2
    fi
    # Do not delete a backup if restoring it failed.
    if [ -n "$stage" ] && { [ -z "$backup" ] || [ ! -e "$backup" ]; }; then
      rm -rf "$stage"
    fi
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  command -v curl >/dev/null || fail 'curl is required. Install it using your system package manager.'
  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=mac ;;
    MINGW*|MSYS*|CYGWIN*)
      fail 'On Windows, run this in PowerShell: curl.exe -fsSL https://raw.githubusercontent.com/clasen/pi-desktop/master/install.ps1 | Out-String | Invoke-Expression' ;;
    *) fail 'Unsupported operating system. See https://github.com/clasen/pi-desktop/releases.' ;;
  esac
  arch="$(uname -m)"
  # A shell under Rosetta reports x86_64 on an Apple Silicon Mac.
  if [ "$platform" = mac ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  case "$platform-$arch" in
    linux-x86_64) suffix='linux-x86_64.AppImage' ;;
    mac-arm64) suffix='mac-arm64.zip' ;;
    mac-x86_64) suffix='mac-x64.zip' ;;
    *) fail "No prebuilt installer for $platform-$arch. See $releases." ;;
  esac
  if [ "$platform" = mac ]; then
    command -v ditto >/dev/null || fail 'The macOS ditto utility is missing.'
    command -v shasum >/dev/null || fail 'The macOS shasum utility is missing.'
    destination="$HOME/Applications/Pi Desktop.app"
  else
    command -v sha256sum >/dev/null || fail 'sha256sum is required (provided by coreutils).'
    destination="$HOME/.local/share/pi-desktop/Pi-Desktop.AppImage"
  fi

  printf 'Pi Desktop installer: %s-%s\nClose Pi Desktop before updating.\n' "$platform" "$arch"
  mkdir -p "$(dirname "$destination")"
  stage="$(mktemp -d "$(dirname "$destination")/.pi-desktop-install.XXXXXX")"
  download_file "$api" "$stage/releases.json"
  # Match only this repository's asset URLs. The public API includes prereleases,
  # newest first; checksums are downloaded from the very same release as the app.
  urls="$(grep -Eo '"browser_download_url"[[:space:]]*:[[:space:]]*"https://github.com/'"$repo"'/releases/download/[A-Za-z0-9._-]+/Pi-Desktop-[A-Za-z0-9.+_-]+"' "$stage/releases.json" | cut -d '"' -f 4 || true)"
  # Use a literal suffix comparison, not a regex containing the filename's dots.
  download=""
  while IFS= read -r url; do
    case "$url" in *-"$suffix") download="$url"; break ;; esac
  done <<< "$urls"
  [ -n "$download" ] || fail "No published $suffix installer found. Publish a version tag in $repo and wait for the Build workflow: $releases."
  name="${download##*/}"
  download_file "$download.sha256" "$stage/checksum"
  expected="$(awk 'NR == 1 {print $1}' "$stage/checksum")"
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Invalid SHA-256 checksum. Nothing was installed.'
  download_file "$download" "$stage/$name"
  if [ "$platform" = mac ]; then
    actual="$(shasum -a 256 "$stage/$name")"
  else
    actual="$(sha256sum "$stage/$name")"
  fi
  actual="${actual%% *}"
  [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" = "$actual" ] || fail 'SHA-256 mismatch. Nothing was installed; download again or report the release.'

  if [ "$platform" = mac ]; then
    ditto -x -k "$stage/$name" "$stage/unpacked" || fail 'Could not unpack the app. Check available disk space.'
    [ -d "$stage/unpacked/Pi Desktop.app/Contents" ] || fail 'The archive does not contain Pi Desktop.app.'
    if [ -e "$destination" ]; then
      backup="$stage/previous.app"
      mv "$destination" "$backup" || fail 'Could not move the previous app. Check permissions and close Pi Desktop.'
    fi
    mv "$stage/unpacked/Pi Desktop.app" "$destination" || fail 'Could not install the app. Restoring the previous version.'
    if [ -n "$backup" ]; then rm -rf "$backup"; backup=""; fi
    printf 'Installed: %s\nOpen it from Finder. Alpha builds are unsigned; macOS may require approval in Privacy & Security.\n' "$destination"
  else
    mkdir -p "$HOME/.local/bin"
    # Extraction mode avoids requiring FUSE or installing system libraries as root.
    printf '%s\n' '#!/bin/sh' 'exec env APPIMAGE_EXTRACT_AND_RUN=1 "$HOME/.local/share/pi-desktop/Pi-Desktop.AppImage" "$@"' > "$stage/launcher"
    chmod 755 "$stage/$name" "$stage/launcher"
    mv -f "$stage/$name" "$destination"
    mv -f "$stage/launcher" "$HOME/.local/bin/pi-desktop"
    printf 'Installed: %s\nRun: %s/.local/bin/pi-desktop\n' "$destination" "$HOME"
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *) printf 'To add the launcher to PATH, add this to your shell profile:\n  export PATH="$HOME/.local/bin:$PATH"\n' ;;
    esac
  fi

  if ! command -v pi >/dev/null && ! command -v omp >/dev/null; then
    printf '\nPi or OMP is required to run an agent. Neither was found on PATH.\n'
    if confirm 'Download and run the official Pi installer from https://pi.dev/install.sh?'; then
      download_file 'https://pi.dev/install.sh' "$stage/install-pi.sh"
      sh "$stage/install-pi.sh" || fail 'Pi installation failed. Pi Desktop is installed; retry Pi installation separately.'
      printf 'Pi installer finished. Open a new terminal so PATH changes take effect.\n'
    else
      printf 'Skipped Pi installation. Install Pi/OMP later or select an existing executable in Settings > Agent Configuration.\n'
    fi
  fi
  cleanup
  trap - EXIT
}

main "$@"
