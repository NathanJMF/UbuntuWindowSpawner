# Shared by install.sh and uninstall.sh. The directory lock leaves no lock file.
uuid=ubuntu-window-spawner@local
data_dir=${XDG_DATA_HOME:-"$HOME/.local/share"}
state_dir=${XDG_STATE_HOME:-"$HOME/.local/state"}/ubuntu-window-spawner
extensions_dir=$data_dir/gnome-shell/extensions
destination=$extensions_dir/$uuid
staging=$extensions_dir/.$uuid.installing
previous=$extensions_dir/.$uuid.previous
launcher_name=ubuntu-window-spawner.desktop
launcher_dir=$data_dir/applications
launcher=$launcher_dir/$launcher_name
launcher_target=../gnome-shell/extensions/$uuid/$launcher_name

owns_launcher() {
    [[ -L $launcher && $(readlink -- "$launcher") == "$launcher_target" ]]
}

if [[ $data_dir != /* || $state_dir != /* ]]; then
    echo 'XDG data and state directories must use absolute paths.' >&2
    exit 1
fi

lock_installation() {
    exec 9<"$data_dir"
    flock --exclusive 9
}
