import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {fitFrame, layoutId, monitorIndex, rememberFrame} from './geometry.js';
import {readPlacement, writePlacement} from './state.js';

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
        this.layoutSettlesAt = 0;
        this.signals = [];
    }

    enable() {
        const connect = (object, signal, fn) =>
            this.signals.push([object, object.connect(signal, fn)]);
        this.layout = layoutId(connectedMonitors());
        connect(global.window_manager, 'map', (_wm, actor) => this._track(actor, true));
        connect(global.display, 'grab-op-begin', (_display, window) => {
            const entry = this.windows.get(window);
            if (entry)
                this._cancelRestore(entry);
        });
        connect(this.settings, 'changed::remember-windows', () => {
            if (!this.settings.get_boolean('remember-windows'))
                this.pending.clear();
        });
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
            app: null, firstFrame: 0, restoreTimer: 0, finishRestore: null};
        this.windows.set(window, entry);
        const on = (signal, fn) => entry.signals.push(window.connect(signal, fn));
        on('unmanaging', () => this._release(entry));
        if (role === 'app') {
            on('focus', () => this._focus(entry));
            const changed = () => {
                if (entry.finishRestore)
                    entry.finishRestore(false);
                else
                    this._capture(entry);
            };
            for (const signal of ['position-changed', 'size-changed',
                'notify::maximized-horizontally', 'notify::maximized-vertically'])
                on(signal, changed);
        }
        if (opening) {
            entry.firstFrame = actor.connect('first-frame', () => {
                actor.disconnect(entry.firstFrame);
                entry.firstFrame = 0;
                this._start(entry, true);
            });
        } else {
            this._start(entry, false);
        }
    }

    _start(entry, opening) {
        if (entry.role === 'dialog') {
            if (opening)
                this._centerDialog(entry.window);
            return;
        }

        entry.app = appId(entry.window);
        if (opening && this._remembering(entry)) {
            this._flushApp(entry.app);
            const monitors = connectedMonitors();
            const record = readPlacement(entry.app, layoutId(monitors));
            if (record && monitors.length)
                this._restore(entry, record, monitors);
        }
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
        if (window.get_maximize_flags())
            window.unmaximize();
        window.move_to_monitor(index);
        let target = null;
        if (record.frame && window.allows_move()) {
            const resizable = window.allows_resize();
            target = fitFrame(record.frame, window.get_work_area_for_monitor(index),
                resizable ? null : window.get_frame_rect());
            if (resizable)
                window.move_resize_frame(false, target.x, target.y, target.width, target.height);
            else
                window.move_frame(false, target.x, target.y);
        }

        // A Wayland client may acknowledge its normal frame later. Preserve the
        // saved frame through that handshake, including a subsequent maximize.
        entry.finishRestore = force => {
            const frame = window.get_frame_rect();
            if (!force && target &&
                (frame.x !== target.x || frame.y !== target.y ||
                    frame.width !== target.width || frame.height !== target.height))
                return;
            this._cancelRestore(entry);
            if (record.maximized && window.can_maximize())
                window.set_maximize_flags(record.maximized);
            this._capture(entry);
        };
        entry.restoreTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            entry.restoreTimer = 0;
            entry.finishRestore(true);
            return GLib.SOURCE_REMOVE;
        });
        entry.finishRestore(false);
    }

    _cancelRestore(entry) {
        if (entry.restoreTimer) {
            GLib.Source.remove(entry.restoreTimer);
            entry.restoreTimer = 0;
        }
        entry.finishRestore = null;
    }

    _remembering(entry) {
        return entry.app && this.settings.get_boolean('remember-windows') &&
            !this.settings.get_strv('excluded-apps').includes(entry.app);
    }

    _focus(entry) {
        if (!entry.ready)
            return;
        entry.app ??= appId(entry.window);
        if (entry.app) {
            this.owners.set(entry.app, entry);
            this._capture(entry);
        }
    }

    _capture(entry) {
        const window = entry.window;
        if (!entry.ready || entry.finishRestore || this.owners.get(entry.app) !== entry ||
            !this._remembering(entry) || window.minimized || window.is_fullscreen())
            return;

        const monitors = connectedMonitors();
        const layout = layoutId(monitors);
        if (this.layout !== layout) {
            // Mutter is moving existing windows to fit the new desktop. Do not
            // replace either layout's saved positions with these transitory frames.
            this._flush();
            this.layout = layout;
            this.layoutSettlesAt = GLib.get_monotonic_time() + 750_000;
        }
        if (GLib.get_monotonic_time() < this.layoutSettlesAt)
            return;
        const current = monitors.find(m => m.index === window.get_monitor());
        if (!current)
            return;
        const area = window.get_work_area_for_monitor(current.index);
        const frame = window.get_frame_rect();
        if (frame.width <= 0 || frame.height <= 0 || area.width <= 0 || area.height <= 0)
            return;
        const maximized = window.get_maximize_flags();
        if (!maximized)
            entry.normal = rememberFrame(frame, area);
        this.pending.set(entry.app, {entry, layout,
            record: {connector: current.connector, frame: entry.normal, maximized}});
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
                writePlacement(app, pending.layout, pending.record);
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
        if (entry.firstFrame)
            entry.actor.disconnect(entry.firstFrame);
        for (const id of entry.signals)
            entry.window.disconnect(id);
        this.windows.delete(entry.window);
    }
}
