import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {validFrame} from './geometry.js';

const directory = GLib.build_filenamev([GLib.get_user_state_dir(), 'ubuntu-window-spawner']);

function appFile(appId) {
    const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, appId, -1);
    return Gio.File.new_for_path(GLib.build_filenamev([directory, `${digest}.json`]));
}

function readFile(file) {
    let etag = null;
    try {
        const [, bytes, revision] = file.load_contents(null);
        etag = revision;
        const data = JSON.parse(new TextDecoder().decode(bytes));
        if (data?.version === 1) {
            // Keep a malformed field from blocking subsequent writes to this app.
            if (typeof data.layouts !== 'object' || Array.isArray(data.layouts))
                delete data.layouts;
            if (typeof data.generation !== 'string')
                delete data.generation;
            return {data, etag};
        }
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn('Window Spawner could not read a saved placement.');
    }
    return {data: {}, etag};
}

export function savedAppState(appId) {
    return readFile(appFile(appId)).data;
}

export function placementForLayout(data, layout) {
    const record = data.layouts?.[layout] ?? data.layouts?.[data.latestLayout];
    if (!record || typeof record.connector !== 'string' ||
        !Number.isInteger(record.maximized) || record.maximized < 0 || record.maximized > 3 ||
        (record.frame !== null && !validFrame(record.frame)))
        return null;
    return record;
}

function replace(file, data, etag) {
    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error('Could not create the window placement directory.');
    file.replace_contents(JSON.stringify(data), etag, false, Gio.FileCreateFlags.PRIVATE, null);
}

export function writePlacement(appId, layout, record, generation) {
    const file = appFile(appId);
    const {data, etag} = readFile(file);
    // Open windows retain their generation. Forgetting an app invalidates its
    // delayed writes too, even if another window has since started recording.
    if (data.generation !== generation)
        return;
    if (layout === data.latestLayout && JSON.stringify(data.layouts?.[layout]) === JSON.stringify(record))
        return;

    data.version = 1;
    data.appId = appId;
    data.latestLayout = layout;
    data.layouts ??= {};
    data.layouts[layout] = record;
    try {
        replace(file, data, etag);
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.WRONG_ETAG))
            throw error;
    }
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
            const {data} = readFile(dir.get_child(name));
            if (typeof data.appId === 'string')
                apps.push(data.appId);
        }
    } finally {
        files.close(null);
    }
    return apps.sort();
}

export function forgetSavedApp(appId) {
    // Only a nonce remains so existing windows can recognize the reset. The
    // next launch can learn a placement immediately, including for the same ID.
    replace(appFile(appId), {version: 1, generation: GLib.uuid_string_random()}, null);
}
