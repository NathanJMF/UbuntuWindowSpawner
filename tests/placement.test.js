import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {fitFrame, layoutId, monitorIndex, rememberFrame} from '../geometry.js';

function equal(actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const above = {x: -600, y: -900, width: 1300, height: 860};
const frame = {x: -515, y: -710, width: 760, height: 440};
const relative = rememberFrame(frame, above);
equal(fitFrame(relative, above), frame);
equal(fitFrame(relative, {x: 0, y: 32, width: 600, height: 300}),
    {x: 0, y: 32, width: 600, height: 300});
const right = rememberFrame({x: 400, y: 300, width: 600, height: 200},
    {x: 0, y: 0, width: 1000, height: 500});
equal(fitFrame(right, {x: -1600, y: 40, width: 1600, height: 860}),
    {x: -600, y: 700, width: 600, height: 200});
equal(fitFrame(right, {x: 0, y: 0, width: 600, height: 500}, {width: 640, height: 400}),
    {x: 0, y: 100, width: 640, height: 400});

const docked = [{connector: 'DP-1', index: 1}, {connector: 'eDP-1', index: 0}];
const dockKey = layoutId(docked);
const soloKey = layoutId([docked[1]]);
equal(dockKey, layoutId(docked.toReversed()));
equal(monitorIndex('DP-1', docked, 0), 1);
equal(monitorIndex('unplugged', docked, 0), 0);

// Set XDG_STATE_HOME before importing the state module in a fresh GJS process.
// GLib caches XDG paths, so a subprocess also prevents writes to desktop state.
if (ARGV[0] !== '--state-test') {
    const sandbox = GLib.dir_make_tmp('ubuntu-window-spawner-test-XXXXXX');
    try {
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.setenv('XDG_STATE_HOME', sandbox, true);
        const script = Gio.File.new_for_uri(import.meta.url).get_path();
        launcher.spawnv(['gjs', '-m', script, '--state-test']).wait_check(null);
    } finally {
        const dir = Gio.File.new_for_path(sandbox);
        const state = dir.get_child('ubuntu-window-spawner');
        if (state.query_exists(null)) {
            const files = state.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (const file of files)
                state.get_child(file.get_name()).delete(null);
            files.close(null);
            state.delete(null);
        }
        dir.delete(null);
    }
    print('Placement geometry and per-app state passed.');
} else {
    const {forgetSavedApp, listSavedApps, readPlacement, writePlacement} = await import('../state.js');
    const id = 'example/../Editor.desktop'; // IDs cannot escape the state directory.
    const external = {connector: 'DP-1', maximized: 0, frame: relative};
    const internal = {connector: 'eDP-1', maximized: 3, frame: right};
    equal(listSavedApps(), []);
    equal(readPlacement(id, dockKey), null);
    writePlacement(id, dockKey, external);
    equal(readPlacement(id, soloKey), external);
    writePlacement(id, soloKey, internal);
    equal(readPlacement(id, dockKey), external);
    equal(readPlacement(id, soloKey), internal);
    writePlacement('Viewer.desktop', dockKey, external);
    equal(listSavedApps(), ['Viewer.desktop', id]);
    forgetSavedApp(id);
    forgetSavedApp(id);
    equal(listSavedApps(), ['Viewer.desktop']);
    equal(readPlacement(id, soloKey), null);
}
