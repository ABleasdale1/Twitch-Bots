# Twitch bot reliability update

This update addresses concrete failure paths in the uploaded code. The Pi's actual logs were not included, so it cannot prove which failure caused a particular outage. Tests ran locally with fake credentials and a local chat server; nothing was sent to Twitch.

## Install on your Pi

Download `twitch-bots-fixed.zip` and transfer it into `/home/edgerunner/` on the Pi, for example with WinSCP. Keep your current bots in `/home/edgerunner/twitch-bots`.

Extract the update into a **separate** directory, then run its installer as `edgerunner`:

```bash
mkdir -p ~/twitch-bots-update
unzip -o ~/twitch-bots-fixed.zip -d ~/twitch-bots-update
bash ~/twitch-bots-update/twitch-bots/install.sh
```

If your current bot folder is elsewhere, give its absolute path as the installer's argument. Do not prefix the installer with `sudo`; it invokes sudo for the systemd changes itself.

The installer checks Node and required settings, stops the three services, checks for other running bot copies, and backs up your current folder beside it. It copies the changed code and configures the three services to start automatically and restart after failure. Node's executable path and your username are detected on the Pi.

**Your current `.env` and every file in `data/` are preserved.** The archive contains the data snapshot you uploaded; do not copy that snapshot over newer XP/moderation data on the Pi. Use the installer to avoid that.

No dependency upgrade is included. The Node modules from your upload are still in the archive. The installer checks the existing target dependencies and leaves them in place. The project needs Node 18 or newer for `fetch` and `AbortSignal.timeout`, and Linux's `flock` command from util-linux. The tests here ran on Node 24.19.0, with your tmi.js 1.8.5.

If the installer reports another running bot, close that terminal/tmux job with Ctrl+C, or stop the other service/process manager that owns it, then rerun the installer. At that point the three main services are stopped. Avoid launching manual `node lvlBot.js` / `node joinBot.js` copies alongside the services. The new code rejects a second copy with exit code 73, including launches through `fixed-suite/`.

## Confirm it is running

```bash
systemctl --no-pager --full status lvlbot modbot joinbot
journalctl -u lvlbot -u modbot -u joinbot --since "5 minutes ago" --no-pager
```

Look for successful chat connections and no repeated fatal errors. `active (running)` alone does not prove Twitch authentication succeeded.

As in your original code, **auto raffle and personal raffle joining start OFF after a process restart**. In Twitch chat, use:

```text
~ar on
~aj on
```

`~aj on` is optional. The host still starts its first raffle after 10 minutes, then every 30 minutes. Personal raffle joins still wait a random 10–58 seconds. A confirmed offline stream switches auto raffle off. Tangia joining still starts enabled for both accounts, and `~rt off` disables it for the bot account. One `!join` from each of the two accounts is intentional.

`~refresh` now checks the tokens while keeping the existing connections. Normal reconnects are automatic.

For lvlbot, try your usual `!level`, `!rank`, or `!topyappers` command. Its text-file admin controls are unchanged.

## What was wrong and what changed

| Finding in the uploaded code | Why it matters | Fix |
| --- | --- | --- |
| lvlbot and modbot validate only at startup and store a fixed chat password. | A later login can reuse an expired token. In the bundled tmi.js version, an authentication failure disables automatic reconnect. lvlbot's admin-file polling can keep the process alive even though chat is dead. | Fetch the current token on every chat login; check tokens every four minutes in every bot. |
| modbot uses its process's old token for moderation API calls. | A token renewed by another bot is not automatically copied into modbot's memory. | Read the latest shared token for each API call and retry a definite HTTP 401 once after checking/renewing it. |
| joinbot replaces both chat clients every 50 minutes. Its cleanup only disconnects OPEN clients. | A closed client with a scheduled reconnect can survive replacement. Its message listener can then handle messages alongside the new client, causing duplicate replies or Tangia joins. | Create clients once and keep them. Maintenance no longer constructs or reconnects clients. |
| No per-bot process lock or message-ID deduplication. | A service plus a tmux/manual copy can both send messages; a redelivered message can be processed again. This is a plausible cause of doubled raffle-start commands, but needs Pi process/log evidence. | Kernel locks allow one copy of each bot per user/channel; bounded message-ID caches suppress redelivery. |
| Raffle runs and delayed joins have incomplete cancellation/overlap guards. | An old live-status request can finish after `ar off`, or repeated triggers can schedule multiple joins. | One raffle run at a time, cancellation checks after awaits, tracked/cancelled join timers, and one pending join per Tangia trigger type. |
| The logger redraws every dashboard row into non-interactive service logs for each update. | A single status/XP update generates many log lines and extra I/O. This does not prove an SD-card or memory failure. | Log only a changed row when running as a service. |
| Each token profile has a separate lock but both rewrite the same `.env`. | Two processes refreshing different profiles can overwrite each other's changes. | One shared kernel lock protects all token refresh writes; dotenv parsing accepts quoted/spaced values. |
| Several Helix requests have no explicit timeout. | Network trouble can leave operations waiting for too long. | 15-second HTTP timeouts; ambiguous failed moderation POSTs and raffle sends are not blindly retried. |

The connection watchdog checks successful channel joining and Twitch's PONG heartbeat, not how busy chat is. If a client remains disconnected/unjoined for about three minutes, or stops receiving heartbeats for three minutes, the bot exits. Systemd restarts it after 15 seconds. This is an automatic process recovery mechanism; it cannot diagnose power loss, a damaged SD card, or a completely stalled OS.

Fatal JavaScript errors now exit instead of leaving a partly functioning process alive. Expected chat/API errors are caught and logged. lvlbot saves loaded XP/boost state before fatal exits; its existing atomic XP writes remain unchanged. XP amounts, cooldowns, daily rewards, level formula, and moderation filter/escalation rules were not changed.

The old `fixed-suite/` JavaScript entry points now forward to the root files. Its installer forwards to the new installer, so it cannot accidentally copy an old second implementation over the root bots.

Twitch requires token validation at startup and at least hourly. Tokens can expire or be revoked, and refreshed tokens must be shared between processes. See Twitch's [token validation documentation](https://dev.twitch.tv/docs/authentication/validate-tokens/) and [refresh documentation](https://dev.twitch.tv/docs/authentication/refresh-tokens/). The tmi.js failure/reconnect behavior above was also checked in the actual 1.8.5 source included in your upload.

## If a bot still stops

Restart only that service; a full Pi reboot should not be needed just to restart a bot:

```bash
sudo systemctl restart lvlbot
```

Or restart all three:

```bash
sudo systemctl restart lvlbot modbot joinbot
```

Generate a report when the problem occurs, preferably before restarting:

```bash
bash ~/twitch-bots/diagnose.sh > ~/twitch-bots-diagnostics.txt
```

The report includes service restart counts, recent logs, process IDs, memory/disk status, and Pi throttling flags. It does not dump environment variables and redacts current token/secret/ID values from collected output. Logs can still contain Twitch chat text. Send the report if further diagnosis is needed.

If you see HTTP 400/401 during token refresh, check the named settings or re-authorise the relevant account with your existing `auth.js` flow. Automatically restarting cannot repair a revoked refresh grant. There is no need to send your `.env` here.

## Validation and recovery

Run the included offline tests from the patched folder:

```bash
cd ~/twitch-bots
npm test
```

All 27 tests passed. The installer flow was also exercised in an isolated temporary folder with systemd/sudo operations simulated; it preserved the current `.env` and all current data files and created the backup and service definitions. The real root-user guard was checked separately.

The tests cover real tmi.js reconnect/password renewal against a local WebSocket server, watchdog recovery versus quiet chat, duplicate process exclusion and crash-lock release, simultaneous refreshes in two Node processes, HTTP 401 recovery, duplicate chat/Tangia events, raffle overlap/cancellation, and service logging. They use fake credentials and temporary data; no real Twitch credentials or API calls are needed.

The installer prints a backup directory containing `project/` and any previous main service unit files under `services/`. If you need to roll back, stop all three services, copy only the previous code files from that backup, and restore any previous service unit files that existed before this update. Keep the current `.env` and current `data/` in place: tokens may have rotated and viewers may have earned XP since the backup. Then run `sudo systemctl daemon-reload` and restart the services. Do not restore an older `.env` or XP snapshot blindly.

Local test results do not substitute for observing the bots during a real stream on your Pi. Existing systemd drop-in overrides or a separate process manager are also outside the supplied archive; inspect them if the installed service behaves differently from these settings.
