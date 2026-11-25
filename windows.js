import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {layoutId, monitorIndex, rememberFrame, sameFrame} from './geometry.js';
import {restoreAtMap} from './restore.js';
import {placementForLayout, savedAppState, writePlacement} from './state.js';

// Wayland clients can publish their app ID after mapping. Keep this shorter
// than the placement handshake so an anonymous window promptly becomes usable.
const IDENTITY_WAIT_MS = 160;

function connectedMonitors() {
    const logical = global.backend.get_monitor_manager().get_logical_monitors();
    return logical.map(monitor => ({
        index: monitor.get_number(),
        connector: monitor.get_monitors()[0].get_connector(),
    }));
}

function appId(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return (app && !app.is_window_backed() && app.get_id()) ||
        window.get_gtk_application_id() || window.get_sandboxed_app_id() ||
        window.get_wm_class() || null;
}

function kind(window) {
    if (window.is_override_redirect())
        return null;
    const type = window.get_window_type();
    if (type === Meta.WindowType.DIALOG || type === Meta.WindowType.MODAL_DIALOG ||
        (type === Meta.WindowType.NORMAL && window.get_transient_for()))
        return 'dialog';
    return type === Meta.WindowType.NORMAL && !window.is_skip_taskbar() ? 'app' : null;
}

export class WindowPlacement {
    constructor(settings) {
        this.settings = settings;
        this.windows = new Map();
        this.owners = new Map();
        this.pending = new Map();
        this.timer = 0;
        this.layout = null;
        this.signals = [];
    }

    enable() {
        const connect = (object, signal, fn) =>
            this.signals.push([object, object.connect(signal, fn)]);
        this.layout = layoutId(connectedMonitors());
        connect(global.backend.get_monitor_manager(), 'monitors-changed', () =>
            this._monitorChange(layoutId(connectedMonitors())));
        connect(global.window_manager, 'map', (_wm, actor) => this._track(actor, true));
        connect(global.display, 'grab-op-begin', (_display, window) => {
            const entry = this.windows.get(window);
            if (entry) {
                entry.grabbed = true;
                if (!entry.app)
                    entry.userMovedBeforeId = true;
                entry.awaitUserMove = null;
                entry.layoutSettlesAt = 0;
                // Starting a grab hands placement to the user immediately.
                // Escape can end it with the unacknowledged launch frame intact.
                if (entry.cancelRestore)
                    entry.unconfirmed = {frame: window.get_frame_rect(), flags: window.get_maximize_flags()};
                this._cancelRestore(entry);
            }
        });
        connect(global.display, 'grab-op-end', (_display, window) => {
            const entry = this.windows.get(window);
            if (entry) {
                this._capture(entry);
                entry.grabbed = false;
            }
        });
        const updateMemory = () => {
            for (const entry of this.windows.values()) {
                if (!this._remembering(entry)) {
                    this._cancelRestore(entry);
                    this.pending.delete(entry.app);
                } else if (entry.ready && entry.window.has_focus()) {
                    this._focus(entry);
                }
            }
        };
        connect(this.settings, 'changed::remember-windows', updateMemory);
        connect(this.settings, 'changed::excluded-apps', updateMemory);
        for (const actor of global.get_window_actors())
            this._track(actor, false);
    }

    disable() {
        for (const [object, id] of this.signals)
            object.disconnect(id);
        this.signals = [];
        if (this.timer) {
            GLib.Source.remove(this.timer);
            this.timer = 0;
        }
        this._flush();
        for (const entry of this.windows.values())
            this._release(entry);
    }

    _track(actor, opening) {
        const window = actor.meta_window;
        const role = kind(window);
        if (!role || this.windows.has(window))
            return;

        const entry = {window, actor, role, signals: [], ready: false, normal: null,
            app: null, cancelRestore: null,
            layoutSettlesAt: 0, grabbed: false};
        this.windows.set(window, entry);
        const on = (signal, fn) => entry.signals.push(window.connect(signal, fn));
        on('unmanaging', () => this._release(entry));
        if (role === 'app') {
            on('focus', () => this._focus(entry));
            const changed = () => {
                if (!entry.ready && entry.identitySignals &&
                    entry.window.get_user_time() !== entry.identityUserTime) {
                    entry.userMovedBeforeId = true;
                    entry.endIdentityWait?.();
                }
                this._capture(entry, true);
            };
            // Mutter can emit both geometry signals before assigning the new
            // monitor. Capture the final connector and its local work area too.
            for (const signal of ['position-changed', 'size-changed', 'notify::main-monitor',
                'notify::maximized-horizontally', 'notify::maximized-vertically'])
                on(signal, changed);
        }
        this._start(entry, opening);
    }

    _start(entry, opening) {
        if (entry.role === 'dialog') {
            if (opening)
                this._centerDialog(entry.window);
            return;
        }

        const id = appId(entry.window);
        if (id) {
            this._identify(entry, id, opening);
            return;
        }

        // Listen only on this unidentified window. A focused window can
        // publish its ID without another focus event.
        entry.identityUserTime = entry.window.get_user_time();
        const resolve = () => this._resolveIdentity(entry);
        entry.identitySignals = ['notify::wm-class', 'notify::gtk-application-id']
            .map(signal => entry.window.connect(signal, resolve));
        if (!opening || !this.settings.get_boolean('remember-windows') || entry.window.is_fullscreen())
            return;

        const previousOpacity = entry.actor.get_opacity_override();
        entry.identityDeadline = GLib.get_monotonic_time() + IDENTITY_WAIT_MS * 1000;
        entry.actor.set_opacity_override(0);
        let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IDENTITY_WAIT_MS, () => {
            timer = 0;
            entry.endIdentityWait();
            this._resolveIdentity(entry);
            return GLib.SOURCE_REMOVE;
        });
        entry.endIdentityWait = () => {
            if (timer)
                GLib.Source.remove(timer);
            if (!entry.actor.is_destroyed() && entry.actor.get_opacity_override() === 0) {
                entry.actor.set_opacity_override(previousOpacity);
                entry.actor.queue_redraw();
            }
            entry.endIdentityWait = null;
        };
    }

    _resolveIdentity(entry) {
        if (entry.app)
            return;
        const id = appId(entry.window);
        if (!id)
            return;
        const canRestore = entry.endIdentityWait && GLib.get_monotonic_time() < entry.identityDeadline &&
            entry.window.get_user_time() === entry.identityUserTime;
        entry.endIdentityWait?.();
        for (const signal of entry.identitySignals)
            entry.window.disconnect(signal);
        entry.identitySignals = null;
        this._identify(entry, id, canRestore, !canRestore && !entry.userMovedBeforeId);
    }

    _identify(entry, id, opening, protectSaved = false) {
        entry.app = id;
        this._flushApp(id);
        const monitors = connectedMonitors();
        const data = savedAppState(id);
        entry.generation = data.generation;
        const record = placementForLayout(data, layoutId(monitors));
        entry.normal = record?.frame ?? null;
        if (opening && this._remembering(entry) && record && monitors.length)
            this._restore(entry, record, monitors);
        else if (protectSaved && record)
            entry.awaitUserMove = {userTime: entry.window.get_user_time()};
        entry.ready = true;
        if (entry.window.has_focus())
            this._focus(entry);
    }

    _centerDialog(window) {
        const connector = this.settings.get_string('dialog-monitor');
        // Attached sheets follow their parent. Moving them as windows can drag the parent.
        if (connector === 'system' || window.is_attached_dialog() || !window.allows_move())
            return;
        const index = monitorIndex(connector, connectedMonitors(), global.display.get_primary_monitor());
        if (index < 0)
            return;
        window.move_to_monitor(index);
        const area = window.get_work_area_for_monitor(index);
        const frame = window.get_frame_rect();
        window.move_frame(false, area.x + Math.max(0, Math.round((area.width - frame.width) / 2)),
            area.y + Math.max(0, Math.round((area.height - frame.height) / 2)));
    }

    _restore(entry, record, monitors) {
        const window = entry.window;
        if (window.is_fullscreen())
            return;
        const index = monitorIndex(record.connector, monitors, global.display.get_primary_monitor());
        if (index < 0)
            return;

        entry.normal = record.frame;
        const finish = settled => {
            entry.cancelRestore = null;
            if (settled) {
                this._capture(entry);
            } else {
                // A client that hasn't accepted its request can appear in its
                // own default frame. Keep the saved placement until it changes.
                entry.unconfirmed = {frame: window.get_frame_rect(), flags: window.get_maximize_flags()};
            }
        };
        try {
            const areas = record.frame?.span || record.partial?.span
                ? monitors.map(m => window.get_work_area_for_monitor(m.index)) : [];
            entry.cancelRestore = restoreAtMap(window, entry.actor, record, index, finish, areas);
        } catch (error) {
            console.error('Window Spawner could not start a launch placement.', error);
            finish(false);
        }
    }

    _cancelRestore(entry) {
        entry.endIdentityWait?.();
        entry.cancelRestore?.();
        entry.cancelRestore = null;
    }

    _remembering(entry) {
        return entry.app && this.settings.get_boolean('remember-windows') &&
            !this.settings.get_strv('excluded-apps').includes(entry.app);
    }

    _focus(entry) {
        if (!entry.ready) {
            if (entry.identitySignals)
                this._resolveIdentity(entry);
            return;
        }
        this.owners.set(entry.app, entry);
        this._capture(entry);
    }

    _monitorChange(layout) {
        // Only windows already on the desktop can be moved by reconfiguration.
        this._flush();
        this.layout = layout;
        const until = GLib.get_monotonic_time() + 750_000;
        for (const entry of this.windows.values()) {
            this._cancelRestore(entry);
            entry.layoutSettlesAt = entry.grabbed ? 0 : until;
            entry.layoutUserTime = entry.window.get_user_time();
        }
    }

    _capture(entry, geometryChanged = false) {
        const window = entry.window;
        if (!entry.ready || entry.cancelRestore || this.owners.get(entry.app) !== entry ||
            !this._remembering(entry) || window.minimized || window.is_fullscreen())
            return;

        // If the ID came after reveal, avoid both a visible jump and saving
        // the launcher's default frame over the previous deliberate placement.
        if (entry.awaitUserMove) {
            if (!geometryChanged || entry.awaitUserMove.userTime === window.get_user_time())
                return;
            entry.awaitUserMove = null;
        }

        const monitors = connectedMonitors();
        const layout = layoutId(monitors);
        // Geometry can arrive before the monitor manager emits monitors-changed.
        if (this.layout !== layout)
            this._monitorChange(layout);
        if (GLib.get_monotonic_time() < entry.layoutSettlesAt &&
            entry.layoutUserTime === window.get_user_time())
            return;
        const currentIndex = monitors.findIndex(m => m.index === window.get_monitor());
        if (currentIndex < 0)
            return;
        const current = monitors[currentIndex];
        const workAreas = monitors.map(m => window.get_work_area_for_monitor(m.index));
        const area = workAreas[currentIndex];
        const frame = window.get_frame_rect();
        if (frame.width <= 0 || frame.height <= 0 || area.width <= 0 || area.height <= 0)
            return;
        const maximized = window.get_maximize_flags();
        if (entry.unconfirmed) {
            const previous = entry.unconfirmed;
            if (sameFrame(frame, previous.frame) && previous.flags === maximized)
                return;
            entry.unconfirmed = null;
        }
        const record = {connector: current.connector, frame: entry.normal, maximized};
        if (maximized) {
            entry.maximizedFrame = frame;
            // Mutter keeps the entire pre-maximize rectangle for unmaximize.
            // A user can separately move and resize the free axis.
            const horizontal = maximized === Meta.MaximizeFlags.HORIZONTAL &&
                frame.x === area.x && frame.width === area.width;
            const vertical = maximized === Meta.MaximizeFlags.VERTICAL &&
                frame.y === area.y && frame.height === area.height;
            if (horizontal || vertical)
                record.partial = rememberFrame(frame, area, workAreas);
        } else if (!entry.maximizedFrame || !sameFrame(entry.maximizedFrame, frame)) {
            // Unmaximize changes the flags before the client supplies its normal
            // frame. A rapid remaximize or close must retain the earlier normal size.
            entry.normal = rememberFrame(frame, area, workAreas);
            record.frame = entry.normal;
            entry.maximizedFrame = null;
        }
        this.pending.set(entry.app, {entry, layout, record});
        // Coalesce an interactive drag and flush its last sample on close or relaunch.
        if (this.timer)
            GLib.Source.remove(this.timer);
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this.timer = 0;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushApp(app) {
        const pending = this.pending.get(app);
        this.pending.delete(app);
        if (pending && this._remembering(pending.entry)) {
            try {
                writePlacement(app, pending.layout, pending.record, pending.entry.generation);
            } catch (error) {
                console.error('Window Spawner could not save a window placement.', error);
            }
        }
    }

    _flush() {
        for (const app of this.pending.keys())
            this._flushApp(app);
    }

    _release(entry) {
        if (this.owners.get(entry.app) === entry) {
            this._flushApp(entry.app);
            this.owners.delete(entry.app);
        }
        this._cancelRestore(entry);
        for (const id of [...entry.signals, ...(entry.identitySignals ?? [])])
            entry.window.disconnect(id);
        this.windows.delete(entry.window);
    }
}
