#!/usr/bin/env bash
set -euo pipefail
tests=$(cd -- "$(dirname -- "$0")" && pwd)
# Ubuntu installs the compositor's private typelibs outside GJS's default path.
libraries=(/usr/lib/*/mutter-18)
private="/usr/lib/gnome-shell:${libraries[0]}"
export GI_TYPELIB_PATH="$private${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
export LD_LIBRARY_PATH="$private${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec gjs -m "$tests/monitor-change.test.js"
