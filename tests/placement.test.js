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
const leftArea = {x: -1000, y: 0, width: 1000, height: 700};
const rightArea = {x: 0, y: 0, width: 900, height: 700};
// A fully visible frame may be larger than either monitor.
const spanning = {x: -180, y: 20, width: 1050, height: 400};
const across = rememberFrame(spanning, rightArea, [leftArea, rightArea]);
equal(fitFrame(across, rightArea, null, [leftArea, rightArea]), spanning);
equal(fitFrame(across, rightArea, null, [rightArea]), {x: 0, y: 20, width: 900, height: 400});
const gap = {...leftArea, x: -1040};
equal(fitFrame(across, rightArea, null, [gap, rightArea]), {x: 0, y: 20, width: 900, height: 400});
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
    const {forgetSavedApp, listSavedApps, placementForLayout, savedAppState, writePlacement} = await import('../state.js');
    const readPlacement = (id, layout) => placementForLayout(savedAppState(id), layout);
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
    // A focused splash can close before or after the main window maps.
    // Its position has independent per-display memory under the same app ID.
    const fixed = {...external, frame: {...relative, width: 300, height: 350}};
    writePlacement(id, dockKey, fixed, undefined, true);
    equal(placementForLayout(savedAppState(id), soloKey, true), fixed);
    equal(readPlacement(id, soloKey), internal);
    equal(readPlacement(id, dockKey), external);
    writePlacement('Viewer.desktop', dockKey, external);
    equal(listSavedApps(), ['Viewer.desktop', id]);
    forgetSavedApp(id);
    forgetSavedApp(id);
    equal(listSavedApps(), ['Viewer.desktop']);
    equal(readPlacement(id, soloKey), null);
    equal(placementForLayout(savedAppState(id), dockKey, true), null);
    writePlacement(id, dockKey, external); // A pending write from before Forget.
    equal(readPlacement(id, dockKey), null);
    const generation = savedAppState(id).generation;
    writePlacement(id, soloKey, internal, generation); // A newly opened window.
    writePlacement(id, soloKey, external); // An older window remains open.
    equal(readPlacement(id, soloKey), internal);

    // A syntactically valid but malformed v1 record must not permanently stop recording.
    const stateDir = Gio.File.new_for_path(GLib.get_user_state_dir()).get_child('ubuntu-window-spawner');
    const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, id, -1);
    const file = stateDir.get_child(`${digest}.json`);
    for (const malformed of [{layouts: []}, {layouts: 'broken'}, {generation: {invalid: true}}]) {
        file.replace_contents(JSON.stringify({version: 1, appId: id, ...malformed}), null, false,
            Gio.FileCreateFlags.PRIVATE, null);
        const recovered = savedAppState(id);
        equal(placementForLayout(recovered, soloKey), null);
        writePlacement(id, soloKey, internal, recovered.generation);
        equal(readPlacement(id, soloKey), internal);
    }
}
