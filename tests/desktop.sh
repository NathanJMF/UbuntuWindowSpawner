#!/usr/bin/env bash
# Run the desktop checks on two virtual monitors in an isolated GNOME Shell 50.
set -euo pipefail
tests=$(cd -- "$(dirname -- "$0")" && pwd)
unset SPAWNER_TEST_CHROMIUM SPAWNER_TEST_APPLICATIONS
case $# in
    0) ;;
    1)
        [[ $1 == --applications ]] || { echo 'Expected --applications' >&2; exit 2; }
        export SPAWNER_TEST_APPLICATIONS=1
        set --
        ;;
    2)
        [[ $1 == --chromium && -x $2 ]] || { echo 'Expected --chromium PATH_TO_BROWSER_EXECUTABLE' >&2; exit 2; }
        SPAWNER_TEST_CHROMIUM=$(realpath -e -- "$2")
        export SPAWNER_TEST_CHROMIUM
        set --
        ;;
    3)
        [[ $1 == --companions ]] || { echo 'Expected --companions SNAP_CHECKOUT NIGHTFALL_CHECKOUT' >&2; exit 2; }
        set -- "$(realpath -e -- "$2")" "$(realpath -e -- "$3")"
        ;;
    *) echo "Usage: $0 [--applications | --companions SNAP_CHECKOUT NIGHTFALL_CHECKOUT | --chromium PATH_TO_BROWSER_EXECUTABLE]" >&2; exit 2 ;;
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

session_env=()
if [[ ${SPAWNER_TEST_APPLICATIONS:-0} == 1 || -n ${SPAWNER_TEST_CHROMIUM:-} ]]; then
    # Some real applications also read files outside XDG directories.
    mkdir -m 700 "$profile/home"
    session_env+=("HOME=$profile/home")
fi
if ! env "${session_env[@]}" dbus-run-session -- bash "$tests/desktop/session.sh" "$tests" "$@" > "$profile/session.log" 2>&1; then
    tail -n 60 "$profile/session.log" >&2
    if [[ -f $XDG_RUNTIME_DIR/shell.log ]]; then tail -n 65 "$XDG_RUNTIME_DIR/shell.log" >&2; fi
    exit 1
fi
grep -F 'Window Spawner test:' "$XDG_RUNTIME_DIR/shell.log" || true
echo 'PASS — desktop placement and live uninstall'
