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
cp -r -- "$root/scripts" "$root/install.sh" "$root/uninstall.sh" "$profile/source/"
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
state=$XDG_STATE_HOME/ubuntu-window-spawner
settings=/org/gnome/shell/extensions/ubuntu-window-spawner/
mkdir -p "$extensions/other-extension" "$XDG_STATE_HOME/other-app"
gsettings set org.gnome.shell enabled-extensions "['other-extension']"
gsettings set org.gnome.shell disabled-extensions "['disabled-extension']"
if TEST_SHELL_VERSION=49 ./install.sh; then exit 1; fi
test ! -e "$installed"

./install.sh
test -s "$installed/schemas/gschemas.compiled"
cmp extension.js "$installed/extension.js"
test "$(gsettings get org.gnome.shell enabled-extensions)" = "['other-extension', '$uuid']"

mkdir -p "$state"
touch "$state/positions"
dconf write "${settings}remember-windows" false
gsettings set org.gnome.shell enabled-extensions "['other-extension']"
gsettings set org.gnome.shell disabled-extensions "['disabled-extension', '$uuid']"
echo '// Updated version' > extension.js
./install.sh
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
./uninstall.sh
TEST
echo 'Installer and uninstall checks passed.'
