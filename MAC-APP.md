# The Agent Keep — macOS launcher

A double-clickable app that opens `http://127.0.0.1:7331/` in a Chrome app-mode window (no tabs, no address bar). If nothing is listening on port 7331, it first runs `node server.mjs` from this repo.

The finished app lives at `/Applications/The Agent Keep.app`. Finder's sidebar "Applications" is `/Applications`, not `~/Applications`.

## Prerequisites

- Google Chrome at `/Applications/Google Chrome.app`
- This repo checked out at `~/Develop/agent-office` (the launcher hardcodes that path)
- Node on the machine. Finder does **not** inherit a terminal's `PATH`, so `node` from nvm, Homebrew, or `/usr/local` will not be visible unless the launcher finds it itself. The script below checks `~/.nvm/versions/node` (honoring `~/.nvm/alias/default`, with or without a leading `v`), then `/opt/homebrew/bin` and `/usr/local/bin`.

- Optional, for Cursor cloud agents: the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) signed in, with your Cursor API key stored as an item. Copy `.env.example` to `.env` in the repo and set `CURSOR_API_KEY_OP_ITEM` to that item's ID (`op item list --categories "API Credential"` shows it). `CURSOR_API_KEY_OP_FIELD` defaults to `credential`. `.env` is gitignored because the item ID differs per user. `CLOUD_POLL_MS` in the same file is how often that server lists cloud agents, in milliseconds (minimum 1000, default 60000). The launcher parses `.env` as plain `KEY=value` lines and never sources it.

## Bundle layout

```
/Applications/The Agent Keep.app/
  Contents/
    Info.plist
    MacOS/launcher          # executable shell script
    Resources/AppIcon.icns  # optional
```

Create the directories:

```bash
APP="/Applications/The Agent Keep.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
```

## Contents/Info.plist

`LSUIElement` is true so the launcher itself does not sit in the Dock. The visible window is Chrome's.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>The Agent Keep</string>
	<key>CFBundleDisplayName</key>
	<string>The Agent Keep</string>
	<key>CFBundleIdentifier</key>
	<string>local.zreed.the-agent-keep</string>
	<key>CFBundleExecutable</key>
	<string>launcher</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
```

## Contents/MacOS/launcher

Write this file, then `chmod +x` it.

```bash
#!/bin/bash
# Starts The Agent Keep server if needed, then opens a Chrome app-mode window.

set -u

URL="http://127.0.0.1:7331/"
PORT=7331
APP_DIR="${HOME}/Develop/agent-office"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
LOG_DIR="${HOME}/Library/Logs"
LOG="${LOG_DIR}/TheAgentKeep.log"
PIDFILE="${HOME}/Library/Application Support/TheAgentKeep/server.pid"
ENV_FILE="${APP_DIR}/.env"

# Reads KEY=value from .env without sourcing it, so the file can't run commands.
env_value() {
  local key="$1" file="$2" line value
  [[ -r "${file}" ]] || return 1
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=(.*)$ ]] || continue
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 && ( "${value}" == \"*\" || "${value}" == \'*\' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    echo "${value}"
    return 0
  done <"${file}"
  return 1
}

# Finder launches do not inherit the shell's nvm PATH, so resolve node here.
# The default alias may be stored with or without the leading "v".
nvm_bin() {
  local root="${HOME}/.nvm/versions/node" alias_file="${HOME}/.nvm/alias/default" want dir
  [[ -d "${root}" ]] || return 1
  if [[ -r "${alias_file}" ]]; then
    want="$(tr -d '[:space:]' <"${alias_file}")"
    for dir in "${root}/${want}" "${root}/v${want#v}"; do
      [[ -x "${dir}/bin/node" ]] && { echo "${dir}/bin"; return 0; }
    done
  fi
  dir="$(ls -1 "${root}" 2>/dev/null | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)"
  [[ -n "${dir}" && -x "${root}/${dir}/bin/node" ]] && { echo "${root}/${dir}/bin"; return 0; }
  return 1
}

export PATH="$(nvm_bin || true):/opt/homebrew/bin:/usr/local/bin:${PATH}"

mkdir -p "${LOG_DIR}" "$(dirname "${PIDFILE}")"

port_in_use() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

wait_for_port() {
  local i
  for i in $(seq 1 50); do
    if port_in_use; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if ! port_in_use; then
  if ! command -v node >/dev/null 2>&1; then
    osascript -e 'display notification "Could not find node in PATH." with title "The Agent Keep"' >/dev/null 2>&1
    echo "$(date '+%Y-%m-%d %H:%M:%S') node not found" >>"${LOG}"
    exit 1
  fi

  if [[ ! -f "${APP_DIR}/server.mjs" ]]; then
    osascript -e 'display notification "server.mjs was not found in Develop/agent-office." with title "The Agent Keep"' >/dev/null 2>&1
    echo "$(date '+%Y-%m-%d %H:%M:%S') missing ${APP_DIR}/server.mjs" >>"${LOG}"
    exit 1
  fi

  # The Cloud Agents key can also mutate agents. It is read here and passed only
  # in the server's environment. Never log the value.
  CURSOR_API_ITEM="$(env_value CURSOR_API_KEY_OP_ITEM "${ENV_FILE}" || true)"
  CURSOR_API_FIELD="$(env_value CURSOR_API_KEY_OP_FIELD "${ENV_FILE}" || true)"
  CURSOR_API_FIELD="${CURSOR_API_FIELD:-credential}"
  if [[ -z "${CURSOR_API_ITEM}" ]]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') CURSOR_API_KEY_OP_ITEM not set in ${ENV_FILE}; Cursor Cloud off" >>"${LOG}"
  elif ! command -v op >/dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') 1Password CLI not found; Cursor Cloud off" >>"${LOG}"
    osascript -e 'display notification "1Password CLI was not found, so Cursor Cloud is off." with title "The Agent Keep"' >/dev/null 2>&1
  else
    cursor_api_key="$(op item get "${CURSOR_API_ITEM}" --fields "label=${CURSOR_API_FIELD}" --reveal 2>/dev/null || true)"
    if [[ -n "${cursor_api_key}" ]]; then
      export CURSOR_API_KEY="${cursor_api_key}"
      echo "$(date '+%Y-%m-%d %H:%M:%S') loaded Cursor API key from 1Password" >>"${LOG}"
    else
      echo "$(date '+%Y-%m-%d %H:%M:%S') could not read Cursor API key from 1Password; Cursor Cloud off" >>"${LOG}"
      osascript -e 'display notification "Could not read the Cursor API key from 1Password. Cursor Cloud is off." with title "The Agent Keep"' >/dev/null 2>&1
    fi
    unset cursor_api_key
  fi

  cloud_poll_ms="$(env_value CLOUD_POLL_MS "${ENV_FILE}" || true)"
  if [[ "${cloud_poll_ms}" =~ ^[0-9]+$ ]]; then
    export CLOUD_POLL_MS="${cloud_poll_ms}"
    echo "$(date '+%Y-%m-%d %H:%M:%S') cloud poll ${CLOUD_POLL_MS}ms from ${ENV_FILE}" >>"${LOG}"
  fi
  unset cloud_poll_ms

  echo "$(date '+%Y-%m-%d %H:%M:%S') starting node server.mjs" >>"${LOG}"
  cd "${APP_DIR}" || exit 1
  nohup node server.mjs >>"${LOG}" 2>&1 &
  echo $! >"${PIDFILE}"

  if ! wait_for_port; then
    osascript -e 'display notification "Server did not start on port 7331." with title "The Agent Keep"' >/dev/null 2>&1
    echo "$(date '+%Y-%m-%d %H:%M:%S') timed out waiting for ${PORT}" >>"${LOG}"
    exit 1
  fi
fi

"${CHROME}" --app="${URL}" >/dev/null 2>&1 &
disown
exit 0
```

```bash
chmod +x "$APP/Contents/MacOS/launcher"
```

## What a click does

1. If something is already listening on TCP 7331, skip straight to Chrome.
2. Otherwise resolve `node`, read the 1Password item from `.env` (see below), fetch the Cursor API key with `op`, export it as `CURSOR_API_KEY`, `cd ~/Develop/agent-office`, and `nohup node server.mjs`. The key is not written to the log. If `.env` has no item, `op` is missing, or the read fails, the server still starts and Cursor Cloud stays off.
3. Wait up to 5 seconds for the port. On failure, post a macOS notification and append a line to the log.
4. Open Chrome with `--app=http://127.0.0.1:7331/`.

Behavior worth knowing:

- Uses the normal Chrome profile, so existing logins and extensions apply.
- Each click opens a **new** window. It does not focus an existing one.
- The server is left running after the window closes. A later click reuses it.
- Logs: `~/Library/Logs/TheAgentKeep.log`. Pid file: `~/Library/Application Support/TheAgentKeep/server.pid` (written only when this launcher starts the server; a server you started yourself in a terminal is detected by the port check and has no pid file).

## Icon (optional)

`CFBundleIconFile` is `AppIcon`, so macOS looks for `Contents/Resources/AppIcon.icns`. Without it, the app still launches and shows a generic icon.

From a square PNG (real PNG bytes, not a JPEG renamed `.png`):

```bash
SRC=/path/to/icon.png
rm -rf /tmp/AppIcon.iconset
mkdir /tmp/AppIcon.iconset
sips -s format png "$SRC" --out /tmp/agent-keep-src.png
for s in 16 32 128 256 512; do
  sips -s format png -z $s $s /tmp/agent-keep-src.png --out /tmp/AppIcon.iconset/icon_${s}x${s}.png
  d=$((s * 2))
  sips -s format png -z $d $d /tmp/agent-keep-src.png --out /tmp/AppIcon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns /tmp/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
```

`sips` will say "Output file suffix should be jpg" and `iconutil` will fail if the source is a JPEG with a `.png` name. The `-s format png` conversion above avoids that.

## Register and pin

```bash
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
```

Then drag `/Applications/The Agent Keep.app` onto the Dock, or launch it from Spotlight as "The Agent Keep".

If the Dock icon was created while the bundle lived somewhere else, that Dock item still points at the old path. Remove it and drag the `/Applications` copy again. A stale generic icon usually clears after logging out, or after `lsregister -f`.

## Check that it works

Cold start (stop any existing server first, or just confirm the port is free):

```bash
lsof -nP -iTCP:7331 -sTCP:LISTEN   # expect nothing
open "/Applications/The Agent Keep.app"
sleep 3
lsof -nP -iTCP:7331 -sTCP:LISTEN   # expect node
pgrep -fl 'app=http://127.0.0.1:7331'
tail ~/Library/Logs/TheAgentKeep.log
```

A second click while the server is up should open another Chrome window and **not** append another `starting node server.mjs` line.

To prove node resolution the way Finder sees it (empty environment, no nvm on `PATH`), extract `nvm_bin` and run it under `env -i`. It should print a directory containing an executable `node`.

## Retargeting

Edit `URL`, `PORT`, and `APP_DIR` at the top of `Contents/MacOS/launcher`. The port check and the Chrome URL must stay in sync. `PORT` inside `server.mjs` defaults to 7331; override it only if both sides change together.
