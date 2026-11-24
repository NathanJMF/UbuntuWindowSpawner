#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
source "$source_dir/scripts/install-paths.sh"

if [[ -d $data_dir ]]; then
    lock_installation
fi

gjs -m "$source_dir/scripts/registration.js" remove "$uuid"

# An extension remains registered in a running Shell until Shell unloads it.
# On a later login, or before the first login after install, only files exist.
if gnome-extensions list --user 2>/dev/null | grep -Fxq -- "$uuid"; then
    gnome-extensions uninstall "$uuid"
    for ((attempt = 0; attempt < 50; attempt++)); do
        if ! gnome-extensions list --active | grep -Fxq -- "$uuid"; then
            break
        fi
        sleep 0.1
    done
    if gnome-extensions list --active | grep -Fxq -- "$uuid"; then
        echo 'GNOME is still running Window Spawner. Log out, log back in, and retry uninstall.' >&2
        exit 1
    fi
fi

dconf reset -f /org/gnome/shell/extensions/ubuntu-window-spawner/
if owns_launcher; then
    rm -- "$launcher"
fi
rm -rf -- "$destination" "$staging" "$previous" "$state_dir" \
    "$data_dir/gnome-shell/extension-updates/$uuid"
echo 'Removed Ubuntu Window Spawner, its launcher, settings, and all saved window positions.'
