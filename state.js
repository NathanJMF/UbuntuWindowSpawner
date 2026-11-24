import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {validFrame} from './geometry.js';

const directory = GLib.build_filenamev([GLib.get_user_state_dir(), 'ubuntu-window-spawner']);

function fileName(appId) {
    const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, appId, -1);
    return GLib.build_filenamev([directory, `${digest}.json`]);
}

function readFile(path) {
    const file = Gio.File.new_for_path(path);
    try {
        const [, bytes] = file.load_contents(null);
        const state = JSON.parse(new TextDecoder().decode(bytes));
        if (state?.version === 1 && typeof state.appId === 'string' &&
            state.layouts && typeof state.layouts === 'object' && !Array.isArray(state.layouts))
            return state;
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn('Window Spawner could not read a saved placement.');
    }
    return null;
}

export function readPlacement(appId, layout) {
    const data = readFile(fileName(appId));
    if (data?.appId !== appId)
        return null;

    const record = data.layouts[layout] ?? data.layouts[data.latestLayout];
    if (!record || typeof record.connector !== 'string' ||
        !Number.isInteger(record.maximized) || record.maximized < 0 || record.maximized > 3 ||
        (record.frame !== null && !validFrame(record.frame)))
        return null;
    return record;
}

export function writePlacement(appId, layout, record) {
    const path = fileName(appId);
    const data = readFile(path) ?? {version: 1, appId, layouts: {}};
    if (layout === data.latestLayout &&
        JSON.stringify(data.layouts[layout]) === JSON.stringify(record))
        return;

    data.latestLayout = layout;
    data.layouts[layout] = record;
    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error('Could not create the window placement directory.');
    GLib.file_set_contents_full(path, JSON.stringify(data),
        GLib.FileSetContentsFlags.CONSISTENT, 0o600);
}

export function listSavedApps() {
    const dir = Gio.File.new_for_path(directory);
    let files;
    try {
        files = dir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return [];
        throw error;
    }

    const apps = [];
    try {
        for (let file = files.next_file(null); file; file = files.next_file(null)) {
            const name = file.get_name();
            if (file.get_file_type() !== Gio.FileType.REGULAR || !/^[a-f0-9]{64}\.json$/.test(name))
                continue;
            const data = readFile(dir.get_child(name).get_path());
            if (data?.appId)
                apps.push(data.appId);
        }
    } finally {
        files.close(null);
    }
    return apps.sort();
}

export function forgetSavedApp(appId) {
    try {
        Gio.File.new_for_path(fileName(appId)).delete(null);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
    }
}
