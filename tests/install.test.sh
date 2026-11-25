#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
profile=$(mktemp -d)
trap 'rm -rf -- "$profile"' EXIT

# The private bus launches its own dconf writer with the same temporary paths.
export XDG_DATA_HOME="$profile/data" XDG_CONFIG_HOME="$profile/config"
export XDG_STATE_HOME="$profile/state" XDG_RUNTIME_DIR="$profile/runtime"
export GSETTINGS_BACKEND=dconf GIO_USE_VFS=local LC_ALL=C
unset G_RESOURCE_OVERLAYS
mkdir -m 700 -- "$XDG_RUNTIME_DIR"
mkdir -p -- "$profile/bin" "$profile/source/schemas"
cp -r -- "$root/scripts" "$root/ubuntu-window-spawner.desktop" "$root/install.sh" "$root/uninstall.sh" "$profile/source/"
cat > "$profile/source/schemas/test.gschema.xml" <<'SCHEMA'
<schemalist>
  <schema id="org.gnome.shell.extensions.ubuntu-window-spawner" path="/org/gnome/shell/extensions/ubuntu-window-spawner/">
    <key name="remember-windows" type="b"><default>true</default></key>
  </schema>
</schemalist>
SCHEMA
echo '{"name":"Window Spawner","uuid":"ubuntu-window-spawner@local"}' > "$profile/source/metadata.json"
echo '// Initial version' > "$profile/source/extension.js"

cat > "$profile/bin/gnome-shell" <<'MOCK'
#!/bin/sh
echo "GNOME Shell ${TEST_SHELL_VERSION:-50.1}"
MOCK
cat > "$profile/bin/gnome-extensions" <<'MOCK'
#!/bin/sh
case "$*" in
    "list --user"|"list --active")
        if test -f "$XDG_RUNTIME_DIR/active"; then echo ubuntu-window-spawner@local; fi ;;
    "uninstall ubuntu-window-spawner@local")
        rm -f -- "$XDG_RUNTIME_DIR/active"
        touch "$XDG_RUNTIME_DIR/unloaded" ;;
    *) exit 1 ;;
esac
MOCK
chmod +x "$profile/bin/gnome-shell" "$profile/bin/gnome-extensions"
export PATH="$profile/bin:$PATH"

dbus-run-session -- bash -eu -o pipefail -s -- "$profile/source" <<'TEST'
cd "$1"
uuid=ubuntu-window-spawner@local
extensions=$XDG_DATA_HOME/gnome-shell/extensions
installed=$extensions/$uuid
launcher=$XDG_DATA_HOME/applications/ubuntu-window-spawner.desktop
state=$XDG_STATE_HOME/ubuntu-window-spawner
settings=/org/gnome/shell/extensions/ubuntu-window-spawner/
mkdir -p "$extensions/other-extension" "$XDG_STATE_HOME/other-app"
gsettings set org.gnome.shell enabled-extensions "['other-extension']"
gsettings set org.gnome.shell disabled-extensions "['disabled-extension']"
if TEST_SHELL_VERSION=49 ./install.sh; then exit 1; fi
test ! -e "$installed"

# An unrelated file at the chosen launcher ID survives installation and removal.
mkdir -p "$(dirname "$launcher")"
echo 'Existing desktop entry' > "$launcher"
if ./install.sh; then exit 1; fi
./uninstall.sh
test "$(cat "$launcher")" = 'Existing desktop entry'
test ! -e "$installed"
rm -- "$launcher"

# If registration fails after both paths are placed, neither survives.
mkdir "$XDG_RUNTIME_DIR/fail"
printf '#!/bin/sh\nexit 1\n' > "$XDG_RUNTIME_DIR/fail/gjs"
chmod +x "$XDG_RUNTIME_DIR/fail/gjs"
if PATH="$XDG_RUNTIME_DIR/fail:$PATH" ./install.sh; then exit 1; fi
test ! -e "$installed"
test ! -L "$launcher"

# Interrupt a fresh install after placing its directory and before registration.
# A retry must register it, even though it now looks like an existing installation.
mkdir "$XDG_RUNTIME_DIR/interrupt"
printf '#!/bin/sh\nkill -KILL "$PPID"\n' > "$XDG_RUNTIME_DIR/interrupt/gjs"
chmod +x "$XDG_RUNTIME_DIR/interrupt/gjs"
if PATH="$XDG_RUNTIME_DIR/interrupt:$PATH" ./install.sh; then exit 1; fi
test "$(gsettings get org.gnome.shell enabled-extensions)" = "['other-extension']"

./install.sh
test -s "$installed/schemas/gschemas.compiled"
test ! -e "$installed/.registration-pending"
test -L "$launcher"
cmp ubuntu-window-spawner.desktop "$launcher"
gjs -c '
    const app = imports.gi.GioUnix.DesktopAppInfo.new("ubuntu-window-spawner.desktop");
    if (!app?.should_show() || app.get_name() !== "Window Placement" ||
        app.get_commandline() !== "gnome-extensions prefs ubuntu-window-spawner@local")
        throw new Error("Window Placement launcher is missing or invalid");
'
cmp extension.js "$installed/extension.js"
test "$(gsettings get org.gnome.shell enabled-extensions)" = "['other-extension', '$uuid']"

mkdir -p "$state"
touch "$state/positions"
dconf write "${settings}remember-windows" false
gsettings set org.gnome.shell enabled-extensions "['other-extension']"
gsettings set org.gnome.shell disabled-extensions "['disabled-extension', '$uuid']"
# Simulate an update from an older release without a launcher.
rm -- "$launcher" "$installed/ubuntu-window-spawner.desktop"
echo '// Updated version' > extension.js
./install.sh
cmp ubuntu-window-spawner.desktop "$launcher"
cmp extension.js "$installed/extension.js"
test "$(gsettings get org.gnome.shell disabled-extensions)" = "['disabled-extension', '$uuid']"
test "$(dconf read "${settings}remember-windows")" = false
test -e "$state/positions"

# A bad update must preserve the installed version and remove staging files.
echo '<invalid>' > schemas/broken.gschema.xml
if ./install.sh; then exit 1; fi
cmp extension.js "$installed/extension.js"
test ! -e "$extensions/.$uuid.installing"
rm -- schemas/broken.gschema.xml

# Recover a process interruption between moving the old directory and the new one.
mv "$installed" "$extensions/.$uuid.previous"
./install.sh
test ! -e "$extensions/.$uuid.previous"
cmp extension.js "$installed/extension.js"

touch "$XDG_RUNTIME_DIR/active"
mkdir -p "$XDG_DATA_HOME/gnome-shell/extension-updates/$uuid"
dconf write "${settings}obsolete-key" true
dconf write '/org/gnome/shell/extensions/unrelated/sentinel' true
./uninstall.sh
test -e "$XDG_RUNTIME_DIR/unloaded"
test ! -L "$launcher"
for path in "$installed" "$state" "$extensions/.$uuid.previous" "$extensions/.$uuid.installing" \
    "$XDG_DATA_HOME/gnome-shell/extension-updates/$uuid"; do
    test ! -e "$path"
done
test "$(dconf list "$settings")" = ""
test "$(dconf read /org/gnome/shell/extensions/unrelated/sentinel)" = true
test -d "$extensions/other-extension"
test -d "$XDG_STATE_HOME/other-app"
test "$(gsettings get org.gnome.shell enabled-extensions)" = "['other-extension']"
test "$(gsettings get org.gnome.shell disabled-extensions)" = "['disabled-extension']"
./uninstall.sh
./install.sh
test "$(GSETTINGS_SCHEMA_DIR="$installed/schemas" gsettings get org.gnome.shell.extensions.ubuntu-window-spawner remember-windows)" = true
test ! -e "$state"
# A launcher that replaced our link after install belongs to its new owner.
rm -- "$launcher"
ln -s -- unrelated.desktop "$launcher"
./uninstall.sh
test "$(readlink "$launcher")" = unrelated.desktop
TEST
echo 'Installer and uninstall checks passed.'
