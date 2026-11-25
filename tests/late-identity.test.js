// monitor-change.test.sh supplies private state and the compositor typelibs.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {WindowPlacement} from '../windows.js';
import {layoutId} from '../geometry.js';
import {placementForLayout, savedAppState, writePlacement} from '../state.js';

function check(ok, message) {
    if (!ok)
        throw new Error(message);
}

check(ARGV[0] === GLib.get_user_state_dir(), 'Run this test with its private state directory');
const app = 'org.example.Delayed';
const layout = layoutId([{connector: 'Virtual'}]);
const saved = {connector: 'Virtual', frame: {width: 720, height: 360, xRatio: 0, yRatio: 0}, maximized: 0};
const currentRecord = () => placementForLayout(savedAppState(app), layout);
const wait = ms => new Promise(resolve => GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ms, resolve));

class Signals {
    handlers = new Map();
    connect(name, fn) {
        const id = Symbol(name);
        this.handlers.set(id, {name, fn});
        return id;
    }
    disconnect(id) { this.handlers.delete(id); }
    emit(name, ...args) {
        for (const item of [...this.handlers.values()])
            if (item.name === name) item.fn(this, ...args);
    }
}

class TestWindow extends Signals {
    id = null;
    width = 400;
    userTime = 1;
    is_override_redirect() { return false; }
    get_window_type() { return Meta.WindowType.NORMAL; }
    get_transient_for() { return null; }
    is_skip_taskbar() { return false; }
    get_gtk_application_id() { return this.id; }
    get_sandboxed_app_id() { return null; }
    get_wm_class() { return null; }
    get_user_time() { return this.userTime; }
    has_focus() { return true; }
    is_fullscreen() { return false; }
    get_monitor() { return 0; }
    get_work_area_for_monitor() { return {x: 0, y: 0, width: 1280, height: 720}; }
    get_frame_rect() { return {x: 0, y: 0, width: this.width, height: 220}; }
    get_maximize_flags() { return 0; }
    identify() {
        this.id = app;
        this.emit('notify::gtk-application-id');
    }
}

const manager = new Signals();
manager.get_logical_monitors = () => [{
    get_number: () => 0, get_monitors: () => [{get_connector: () => 'Virtual'}],
}];
globalThis.global = {
    backend: {get_monitor_manager: () => manager},
    window_manager: new Signals(), display: new Signals(), get_window_actors: () => [],
};
Shell.WindowTracker.get_default = () => ({get_window_app: () => null});
const settings = new Signals();
settings.get_boolean = () => true;
settings.get_strv = () => [];
const placement = new WindowPlacement(settings);
let restores = 0;
placement._restore = (entry, record) => {
    restores++;
    entry.window.width = record.frame.width;
};
function map() {
    writePlacement(app, layout, saved);
    const window = new TestWindow();
    const actor = {
        meta_window: window, opacity: -1, is_destroyed: () => false, queue_redraw() {},
        get_opacity_override() { return this.opacity; },
        set_opacity_override(opacity) { this.opacity = opacity; },
    };
    global.window_manager.emit('map', actor);
    return {window, actor};
}

placement.enable();
try {
    let {window, actor} = map();
    check(actor.opacity === 0, 'Anonymous opening window was exposed before identity lookup');
    window.identify();
    check(restores === 1 && window.width === 720 && actor.opacity === -1, 'Timely ID failed one-shot restore');
    window.identify();
    check(restores === 1, 'Duplicate ID notification replayed restore');
    window.emit('unmanaging');

    ({window, actor} = map());
    await wait(250);
    check(actor.opacity === -1, 'Anonymous window remained hidden past the deadline');
    window.identify();
    window.emit('focus');
    window.width = 450;
    window.emit('size-changed'); // An automatic configure after identification.
    placement._flush();
    check(restores === 1 && currentRecord().frame.width === 720, 'Late ID jumped or erased a good record');
    global.display.emit('grab-op-begin', window);
    window.width = 660;
    global.display.emit('grab-op-end', window);
    window.emit('unmanaging');
    check(currentRecord().frame.width === 660, 'User move after a late ID was lost');

    ({window, actor} = map());
    global.display.emit('grab-op-begin', window);
    window.width = 830;
    global.display.emit('grab-op-end', window);
    window.identify();
    window.emit('unmanaging');
    check(restores === 1 && currentRecord().frame.width === 830 && actor.opacity === -1,
        'User move before the app identified itself was overwritten');

    ({window, actor} = map());
    window.userTime++;
    window.width = 855;
    window.emit('size-changed'); // Keyboard placement without a compositor grab.
    window.identify();
    window.emit('unmanaging');
    check(restores === 1 && currentRecord().frame.width === 855 && actor.opacity === -1,
        'Keyboard placement before identification was overwritten');

    ({window, actor} = map());
    placement.disable();
    check(actor.opacity === -1 && window.handlers.size === 0, 'Disable leaked a hidden actor or identity signal');
} finally {
    placement.disable();
}
print('Late window identity tests passed.');
