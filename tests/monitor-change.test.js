// Run on Ubuntu with the Shell and Mutter typelib paths as in monitor-change.test.sh.
import {WindowPlacement} from '../windows.js';

function assert(ok, message) {
    if (!ok)
        throw new Error(message);
}

class Signals {
    handlers = new Map();

    connect(name, callback) {
        const id = Symbol(name);
        this.handlers.set(id, {name, callback});
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    emit(name, ...args) {
        for (const handler of this.handlers.values()) {
            if (handler.name === name)
                handler.callback(this, ...args);
        }
    }
}

let connectors = ['eDP-1'];
const manager = new Signals();
manager.get_logical_monitors = () => connectors.map((connector, index) => ({
    get_number: () => index,
    get_monitors: () => [{get_connector: () => connector}],
}));
globalThis.global = {
    backend: {get_monitor_manager: () => manager},
    window_manager: new Signals(),
    display: new Signals(),
    get_window_actors: () => [],
};
const settings = new Signals();
settings.get_boolean = () => true;
settings.get_strv = () => [];
const placement = new WindowPlacement(settings);
const app = 'Editor.desktop';
let userTime = 5;
const window = {
    get_user_time: () => userTime,
    get_monitor: () => 0,
    is_fullscreen: () => false,
    get_work_area_for_monitor: () => ({x: 0, y: 0, width: 600, height: 400}),
    get_frame_rect: () => ({x: 20, y: 30, width: 320, height: 240}),
    get_maximize_flags: () => 0,
};
function track() {
    const entry = {app, window, ready: true, signals: [], layoutSettlesAt: 0};
    placement.windows.set(window, entry);
    placement.owners.set(app, entry);
    return entry;
}
let saved;
placement._flushApp = id => {
    saved = placement.pending.get(id);
    placement.pending.delete(id);
};

placement.enable();
try {
    connectors = ['eDP-1', 'DP-1'];
    manager.emit('monitors-changed'); // No app existed at reconfiguration time.
    let entry = track();
    placement._capture(entry);
    placement._release(entry);
    assert(saved?.record.frame.width === 320, 'First move followed by close was lost');

    entry = track();
    connectors = ['eDP-1'];
    placement._capture(entry); // Mutter geometry arrives before its monitor signal.
    assert(!placement.pending.has(app), 'Early automatic geometry overwrote the saved layout');
    manager.emit('monitors-changed');
    placement._capture(entry);
    assert(!placement.pending.has(app), 'Automatic geometry after monitor signal was recorded');

    global.display.emit('grab-op-begin', window);
    placement._capture(entry);
    assert(placement.pending.has(app), 'Deliberate drag during reconfiguration was discarded');
    global.display.emit('grab-op-end', window);
    placement._flush();
    manager.emit('monitors-changed');
    userTime++; // Keyboard-driven window placement.
    placement._capture(entry);
    assert(placement.pending.has(app), 'Post-change input was treated as automatic movement');
} finally {
    placement.disable();
}
assert(manager.handlers.size === 0, 'Monitor listener survived disable');
print('Monitor-change placement timing passed.');
