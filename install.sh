#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
source "$source_dir/scripts/install-paths.sh"

version=$(gnome-shell --version)
if [[ ! $version =~ (^|[[:space:]])50([.]|$) ]]; then
    echo "Ubuntu Window Spawner requires GNOME Shell 50. Detected $version." >&2
    exit 1
fi

mkdir -p -- "$data_dir"
lock_installation
mkdir -p -- "$extensions_dir" "$launcher_dir"
if [[ -e $launcher || -L $launcher ]] && ! owns_launcher; then
    echo "The application launcher path is already in use: $launcher" >&2
    exit 1
fi

# Recover an update interrupted between the two directory renames.
if [[ -d $previous && ! -e $destination ]]; then
    mv -T -- "$previous" "$destination"
fi
rm -rf -- "$previous" "$staging"
mkdir -p -- "$staging/schemas"
created_launcher=false
cleanup() {
    local result=$?
    if (( result != 0 )) && "$created_launcher" && owns_launcher; then
        rm -- "$launcher"
    fi
    if [[ -d $previous && ! -e $destination ]]; then
        mv -T -- "$previous" "$destination"
    fi
    rm -rf -- "$staging"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

install -m 644 -- "$source_dir"/metadata.json "$source_dir/$launcher_name" "$source_dir"/*.js "$staging/"
install -m 644 -- "$source_dir"/schemas/*.gschema.xml "$staging/schemas/"
glib-compile-schemas --strict "$staging/schemas"

# The link stays valid when a new version replaces the extension directory.
if ! owns_launcher; then
    ln -sT -- "$launcher_target" "$launcher"
    created_launcher=true
fi

if [[ -d $destination ]]; then
    mv -T -- "$destination" "$previous"
    mv -T -- "$staging" "$destination"
    rm -rf -- "$previous"
    echo 'Updated Ubuntu Window Spawner. Your settings and saved positions were preserved.'
else
    mv -T -- "$staging" "$destination"
    if ! gjs -m "$source_dir/scripts/registration.js" enable "$uuid"; then
        mv -T -- "$destination" "$staging"
        exit 1
    fi
    echo 'Installed Ubuntu Window Spawner.'
fi
echo 'Log out and back in to load this version in GNOME Shell.'
