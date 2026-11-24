#!/usr/bin/env bash
# Run the desktop checks on two virtual monitors in an isolated GNOME Shell 50.
set -euo pipefail
tests=$(cd -- "$(dirname -- "$0")" && pwd)
case $# in
    0) ;;
    3)
        [[ $1 == --companions ]] || { echo 'Expected --companions SNAP_CHECKOUT NIGHTFALL_CHECKOUT' >&2; exit 2; }
        set -- "$(realpath -e -- "$2")" "$(realpath -e -- "$3")"
        ;;
    *) echo "Usage: $0 [--companions SNAP_CHECKOUT NIGHTFALL_CHECKOUT]" >&2; exit 2 ;;
esac

profile=$(mktemp -d)
trap 'rm -rf -- "$profile"' EXIT
export XDG_RUNTIME_DIR="$profile/run" XDG_CONFIG_HOME="$profile/config"
export XDG_DATA_HOME="$profile/data" XDG_STATE_HOME="$profile/state" XDG_CACHE_HOME="$profile/cache"
mkdir -m 700 -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland GSETTINGS_BACKEND=dconf
export LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe GSK_RENDERER=cairo
export GIO_USE_VFS=local GTK_A11Y=none NO_AT_BRIDGE=1
unset DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS DBUS_STARTER_ADDRESS
unset GNOME_SHELL_SESSION_MODE G_RESOURCE_OVERLAYS GNOME_DESKTOP_SESSION_ID
# Isolate the test's services from the host system bus, including services
# activated by dbus-daemon itself. The inner script routes Shell to its private bus.
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/no-system-bus"

if ! dbus-run-session -- bash "$tests/desktop/session.sh" "$tests" "$@" > "$profile/session.log" 2>&1; then
    tail -n 60 "$profile/session.log" >&2
    if [[ -f $XDG_RUNTIME_DIR/shell.log ]]; then tail -n 65 "$XDG_RUNTIME_DIR/shell.log" >&2; fi
    exit 1
fi
grep -F 'Window Spawner test:' "$XDG_RUNTIME_DIR/shell.log" || true
echo 'PASS — desktop placement, disable, re-enable and live uninstall'
