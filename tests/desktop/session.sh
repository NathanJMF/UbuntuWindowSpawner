# Called by desktop.sh inside its temporary D-Bus session.
set -euo pipefail
tests=$1
shift
root=$(cd -- "$tests/.." && pwd)
export DBUS_SYSTEM_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"
export SPAWNER_TEST_CLIENT="$tests/desktop/client.js"
export SPAWNER_TEST_COMPANIONS=0
extensions="$XDG_DATA_HOME/gnome-shell/extensions"
uuid=ubuntu-window-spawner@local
driver=window-placement-test@local
snap=keyboard-monitor-snap@local
night=nightfall-popups@ubuntu-nightfall.local
tiling=tiling-assistant@ubuntu.com

mkdir -p "$extensions/$driver"
if [[ -n ${SPAWNER_TEST_CHROMIUM:-} ]]; then
    cp "$tests/desktop/chromium.js" "$extensions/$driver/extension.js"
    mkdir -p "$XDG_DATA_HOME/applications" "$XDG_RUNTIME_DIR/bin"
    cat > "$XDG_RUNTIME_DIR/bin/spawner-test-chromium" <<'BROWSER'
#!/usr/bin/env bash
set -eu
profile=$XDG_STATE_HOME/browser
if [[ -e $XDG_RUNTIME_DIR/windowed-profile ]]; then profile=$XDG_STATE_HOME/fresh-browser; fi
exec "$SPAWNER_TEST_CHROMIUM" --user-data-dir="$profile" --ozone-platform=wayland \
    --class=chromium --no-first-run --no-default-browser-check --password-store=basic \
    --disable-background-networking --disable-component-update --disable-sync --disable-gpu about:blank
BROWSER
    chmod +x "$XDG_RUNTIME_DIR/bin/spawner-test-chromium"
    export PATH="$XDG_RUNTIME_DIR/bin:$PATH"
    cat > "$XDG_DATA_HOME/applications/chromium_chromium.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Placement Browser
StartupWMClass=chromium
Exec=spawner-test-chromium
DESKTOP
else
    cp "$tests/desktop/driver.js" "$extensions/$driver/extension.js"
    if [[ ${SPAWNER_TEST_APPLICATIONS:-0} == 1 ]]; then
        cp "$tests/desktop/applications.js" "$extensions/$driver/"
    fi
fi
echo '{"uuid":"window-placement-test@local","name":"Window placement test","description":"Headless desktop test driver","shell-version":["50"]}' > "$extensions/$driver/metadata.json"
enabled="['$driver']"
if (( $# )); then
    mkdir -p "$extensions/$snap/schemas" "$extensions/$night"
    cp "$1/"*.js "$1/metadata.json" "$extensions/$snap/"
    cp "$1/schemas/"*.gschema.xml "$extensions/$snap/schemas/"
    glib-compile-schemas --strict "$extensions/$snap/schemas"
    cp -r "$2/extension/." "$extensions/$night/"
    enabled="['$tiling', '$snap', '$night', '$driver']"
    export SPAWNER_TEST_COMPANIONS=1
fi

gsettings set org.gnome.desktop.interface enable-animations true
gsettings set org.gnome.shell enabled-extensions "$enabled"
"$root/install.sh"
test -s "$extensions/$uuid/schemas/gschemas.compiled"
launcher="$XDG_DATA_HOME/applications/ubuntu-window-spawner.desktop"
test -f "$launcher"
gnome-shell --wayland --headless --virtual-monitor 1280x800 --virtual-monitor 1440x900 \
    --wayland-display spawner-test > "$XDG_RUNTIME_DIR/shell.log" 2>&1 &
shell_pid=$!
stop_shell() {
    kill "$shell_pid" 2>/dev/null || true
    wait "$shell_pid" || true
}
trap stop_shell EXIT

result=$XDG_RUNTIME_DIR/spawner-test-result
for ((attempt=0; attempt<100; attempt++)); do
    if [[ -s $result ]]; then break; fi
    if ! kill -0 "$shell_pid"; then echo 'Headless shell exited early' >&2; exit 1; fi
    sleep 1
done
if [[ ! -s $result ]]; then echo 'Timed out waiting for desktop tests' >&2; exit 1; fi
cat "$result"
grep -Fxq 'PASS' "$result"
test -d "$XDG_STATE_HOME/ubuntu-window-spawner"
if [[ -z ${SPAWNER_TEST_CHROMIUM:-} ]]; then
    test -n "$(dconf list /org/gnome/shell/extensions/ubuntu-window-spawner/)"
fi
before=$(gnome-extensions list --active)
grep -Fxq "$uuid" <<<"$before"
"$root/uninstall.sh"

# GNOME serializes extension unloads asynchronously. Wait for the actual
# registration to disappear before checking the unaffected registrations.
for ((attempt=0; attempt<50; attempt++)); do
    installed=$(gnome-extensions list --user)
    if ! grep -Fxq "$uuid" <<<"$installed"; then break; fi
    sleep 0.1
done
if grep -Fxq "$uuid" <<<"$installed"; then echo 'Removed extension is still registered' >&2; exit 1; fi
after=$(gnome-extensions list --active)
if grep -Fxq "$uuid" <<<"$after"; then echo 'Removed extension is still active' >&2; exit 1; fi
grep -Fxq "$driver" <<<"$after"
if [[ $SPAWNER_TEST_COMPANIONS == 1 ]]; then
    for other in "$tiling" "$snap" "$night"; do grep -Fxq "$other" <<<"$after"; done
fi
test "$(gsettings get org.gnome.shell enabled-extensions)" = "$enabled"
disabled=$(gsettings get org.gnome.shell disabled-extensions)
[[ $disabled != *"$uuid"* ]]
test -z "$(dconf list /org/gnome/shell/extensions/ubuntu-window-spawner/)"
test ! -e "$extensions/$uuid"
test ! -e "$XDG_STATE_HOME/ubuntu-window-spawner"
# A dangling desktop entry would still leave a fragment in the app launcher.
[[ ! -e $launcher && ! -L $launcher ]]
