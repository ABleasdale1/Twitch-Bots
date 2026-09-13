#!/usr/bin/env bash
set -euo pipefail

# Run as the Pi account that owns the existing bots, WITHOUT sudo.
# This script uses sudo only for the three systemd units.
BOT_DIR="${1:-/home/edgerunner/twitch-bots}"
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ "$EUID" == 0 ]]; then
  echo "Run this as your normal Pi user: bash install.sh [existing-bot-folder]"
  exit 1
fi
for command_name in node python3 flock systemctl sudo; do
  command -v "$command_name" >/dev/null || { echo "Required command missing: $command_name"; exit 1; }
done
BOT_DIR="$(realpath -e -- "$BOT_DIR")"
NODE_BINARY="$(readlink -f -- "$(command -v node)")"
BOT_USER="$(id -un)"
if [[ "$BOT_DIR" == "$HERE" ]]; then
  echo "Extract the update into a separate folder, then run its installer against your existing bot folder."
  exit 1
fi
if [[ ! -w "$BOT_DIR" || ! -r "$BOT_DIR/.env" || "$(stat -c %u -- "$BOT_DIR")" != "$(id -u)" ]]; then
  echo "Your existing bot folder must belong to this user and contain your readable .env."
  exit 1
fi
# These values become systemd paths. Keep supported paths unambiguous.
if [[ ! "$BOT_DIR" =~ ^[a-zA-Z0-9_./-]+$ || ! "$NODE_BINARY" =~ ^[a-zA-Z0-9_./-]+$ ]]; then
  echo "Use a bot folder and Node path containing only letters, numbers, /, ., _, and -."
  exit 1
fi

"$NODE_BINARY" - "$BOT_DIR" <<'JS'
const path = require('path');
const { createRequire } = require('module');
if (Number(process.versions.node.split('.')[0]) < 18 || typeof fetch !== 'function' || typeof AbortSignal.timeout !== 'function') {
  throw new Error('This project needs Node 18 or newer with fetch and AbortSignal.timeout.');
}
const localRequire = createRequire(path.join(process.argv[2], 'package.json'));
localRequire('tmi.js');
const fs = require('fs');
const env = localRequire('dotenv').parse(fs.readFileSync(path.join(process.argv[2], '.env')));
const required = ['TWITCH_CHANNEL', 'BOT_USERNAME', 'JOIN_USERNAME', 'ACCESS_TOKEN', 'REFRESH_TOKEN',
  'JOIN_ACCESS_TOKEN', 'JOIN_REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'BROADCASTER_ID', 'MODERATOR_ID'];
const missing = required.filter(key => !env[key]);
if (missing.length) throw new Error('Missing .env keys: ' + missing.join(', '));
console.log('Node, existing dependencies, and required .env keys checked.');
JS

code_files=(lvlBot.js modBot.js joinBot.js tokenManager.js
  utils/logger.js utils/twitchApi.js utils/fileLock.js utils/botRuntime.js utils/messageDeduper.js)
for relative_path in "${code_files[@]}"; do
  "$NODE_BINARY" --check "$HERE/$relative_path"
done

units=(lvlbot.service modbot.service joinbot.service)
for unit in "${units[@]}"; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    sudo systemctl stop "$unit"
  fi
done

# A manual tmux job or another unit can survive stopping the three known units.
# Report exact PIDs; never use broad pkill/node commands that could stop other apps.
python3 - <<'PY'
import os
from pathlib import Path
names = {'lvlBot.js', 'modBot.js', 'joinBot.js'}
remaining = []
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():
        continue
    try:
        if proc.stat().st_uid != os.getuid():
            continue
        args = (proc / 'cmdline').read_bytes().split(b'\0')
        if not args or not Path(os.fsdecode(args[0])).name.startswith('node'):
            continue
        for arg in args[1:]:
            name = Path(os.fsdecode(arg)).name
            if name in names:
                remaining.append((proc.name, name))
                break
    except (OSError, ValueError):
        continue
if remaining:
    for pid, name in remaining:
        print(f'Still running: PID {pid} ({name})')
    print('The three main services are stopped. Close the extra bot jobs with Ctrl+C,')
    print('or stop their other service/process manager, then rerun this installer.')
    raise SystemExit(1)
PY

BACKUP_DIR="$(mktemp -d "$(dirname -- "$BOT_DIR")/twitch-bots-backup-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
chmod 700 "$BACKUP_DIR"
cp -a -- "$BOT_DIR" "$BACKUP_DIR/project"
mkdir -p "$BACKUP_DIR/services"
for unit in "${units[@]}"; do
  if [[ -e "/etc/systemd/system/$unit" || -L "/etc/systemd/system/$unit" ]]; then
    sudo cp -a -- "/etc/systemd/system/$unit" "$BACKUP_DIR/services/"
  fi
done
echo "Backup created: $BACKUP_DIR"
trap 'echo "Update did not finish. Backup: $BACKUP_DIR. Check the error above before starting the bots."' ERR

# Deliberately copy only code. Current .env and every data/ file stay in place.
for relative_path in "${code_files[@]}"; do
  mkdir -p -- "$(dirname -- "$BOT_DIR/$relative_path")"
  cp -- "$HERE/$relative_path" "$BOT_DIR/$relative_path"
done
cp -- "$HERE/package.json" "$HERE/package-lock.json" "$HERE/README-FIXES.md" "$HERE/diagnose.sh" "$HERE/install.sh" "$BOT_DIR/"
mkdir -p "$BOT_DIR/test" "$BOT_DIR/fixed-suite"
cp -- "$HERE"/test/*.js "$BOT_DIR/test/"
cp -- "$HERE"/fixed-suite/*.js "$HERE/fixed-suite/install.sh" "$BOT_DIR/fixed-suite/"

UNIT_STAGE="$(mktemp -d)"
trap 'rm -rf -- "$UNIT_STAGE"' EXIT
for unit in "${units[@]}"; do
  case "$unit" in
    lvlbot.service) script_name=lvlBot.js; description="Twitch Level Bot" ;;
    modbot.service) script_name=modBot.js; description="Twitch Moderation Bot" ;;
    joinbot.service) script_name=joinBot.js; description="Twitch Join and Raffle Bot" ;;
  esac
  cat > "$UNIT_STAGE/$unit" <<UNIT
[Unit]
Description=$description
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$BOT_USER
WorkingDirectory=$BOT_DIR
ExecStart=$NODE_BINARY $BOT_DIR/$script_name
Restart=always
RestartSec=15
RestartPreventExitStatus=73
TimeoutStopSec=20
KillMode=control-group
KillSignal=SIGTERM
UMask=0077
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  sudo install -m 644 "$UNIT_STAGE/$unit" "/etc/systemd/system/$unit"
  cp -- "$UNIT_STAGE/$unit" "$BOT_DIR/fixed-suite/$unit"
done

sudo systemctl daemon-reload
sudo systemctl reset-failed "${units[@]}"
sudo systemctl enable --now "${units[@]}"
sleep 2
systemctl --no-pager --full status "${units[@]}"
echo "Update installed. Check the journal for successful chat connections."
echo "Auto raffle and personal raffle joins start OFF after a restart: use ~ar on and, if wanted, ~aj on in chat."
