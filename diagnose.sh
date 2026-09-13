#!/usr/bin/env bash
set -euo pipefail
BOT_DIR="${1:-/home/edgerunner/twitch-bots}"
python3 - "$BOT_DIR" <<'PY'
import os
import re
import subprocess
import sys
from pathlib import Path

bot_dir = Path(sys.argv[1])
secrets = []
try:
    for line in (bot_dir / '.env').read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator and any(word in key.upper() for word in ('TOKEN', 'SECRET', '_ID')):
            value = value.strip().strip('"\'')
            if value:
                secrets.append(value)
except OSError:
    pass

def redacted(text):
    for value in sorted(secrets, key=len, reverse=True):
        text = text.replace(value, '[REDACTED]')
    return re.sub(r'(?i)(oauth:|Bearer\s+)[a-z0-9_%+./=-]+', r'\1[REDACTED]', text)

def run(title, args):
    print('\n' + title, flush=True)
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=20)
        print(redacted(result.stdout + result.stderr), end='')
    except (OSError, subprocess.TimeoutExpired) as error:
        print(type(error).__name__ + ': command unavailable or timed out')

run('OS', ['cat', '/etc/os-release'])
run('Node', ['node', '--version'])
run('Uptime', ['uptime'])
run('Memory', ['free', '-h'])
run('Disk', ['df', '-h', str(bot_dir)])
run('Pi throttling flags', ['vcgencmd', 'get_throttled'])
print('\nBot process list (PIDs and script names only)')
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():
        continue
    try:
        args = (proc / 'cmdline').read_bytes().split(b'\0')
        if not args or not Path(os.fsdecode(args[0])).name.startswith('node'):
            continue
        for arg in args[1:]:
            name = Path(os.fsdecode(arg)).name
            if name in {'lvlBot.js', 'modBot.js', 'joinBot.js'}:
                print(f'{proc.name}: {name} (uid {proc.stat().st_uid})')
                break
    except (OSError, ValueError):
        continue
for unit in ['lvlbot.service', 'modbot.service', 'joinbot.service']:
    run(unit + ' status', ['systemctl', 'show', unit,
        '--property=MainPID,NRestarts,ActiveState,SubState,ExecMainStatus,Result,ExecMainStartTimestamp'])
    run(unit + ' recent logs', ['journalctl', '-u', unit, '--since', '2 days ago', '-n', '150', '--no-pager', '-o', 'short-iso'])
PY
