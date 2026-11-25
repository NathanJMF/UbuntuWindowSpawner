// Optional test driver for a locally installed Chromium executable.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const id = 'chromium_chromium.desktop';
const delay = ms => new Promise(resolve => GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ms, resolve));

async function wait(read, message) {
    for (let attempt = 0; attempt < 120; attempt++) {
        const result = read();
        if (result)
            return result;
        await delay(100);
    }
    throw new Error(message);
}

function browserActor() {
    return global.get_window_actors().find(actor => {
        const window = actor.meta_window;
        return window?.get_window_type() === Meta.WindowType.NORMAL &&
            Shell.WindowTracker.get_default().get_window_app(window)?.get_id() === id;
    });
}

async function run() {
    await delay(1800);
    Main.overview.hide();
    await delay(550);
    const app = Shell.AppSystem.get_default().lookup_app(id);
    const primary = global.display.get_primary_monitor();
    const target = 1 - primary;
    const display = Main.layoutManager.monitors[primary];
    const seat = global.stage.context.get_backend().get_default_seat();

    async function launch() {
        // Dash to Panel and Shell app icons use Shell.App.activate(). Force
        // Mutter's current monitor to a different display before that call.
        seat.warp_pointer(display.x + 100, display.y + 100);
        await delay(150);
        if (global.display.get_current_monitor() !== primary)
            throw new Error('Launcher monitor was not selected');
        app.activate();
        return (await wait(browserActor, 'Chromium did not launch')).meta_window;
    }

    async function close(window) {
        window.delete(global.get_current_time());
        await wait(() => !browserActor() && app.state === Shell.AppState.STOPPED, 'Chromium did not close');
        await delay(300);
    }

    let window = await launch();
    Main.activateWindow(window);
    await wait(() => window.has_focus(), 'Browser did not gain focus');
    const area = window.get_work_area_for_monitor(target);
    window.move_to_monitor(target);
    window.move_resize_frame(true, area.x + 90, area.y + 65, 835, 512);
    await wait(() => window.get_monitor() === target && window.get_frame_rect().width === 835,
        'Browser did not accept user move and resize');
    window.maximize();
    await wait(() => window.is_maximized() && window.get_frame_rect().width === area.width,
        'Browser did not maximize');
    await delay(400);
    await close(window);

    for (const mode of ['last maximized', 'fresh windowed']) {
        if (mode === 'fresh windowed')
            GLib.file_set_contents(`${GLib.get_user_runtime_dir()}/windowed-profile`, '');
        let visible = 0;
        let wrong = null;
        const painted = global.stage.connect('after-paint', () => {
            const actor = browserActor();
            const clone = actor?.__animationInfo?.clone;
            if (clone?.is_mapped() && clone.get_paint_opacity())
                wrong ??= 'a visible snapshot at the old position';
            if (!actor?.is_mapped() || actor.get_opacity_override() === 0 || !actor.get_paint_opacity())
                return;
            visible++;
            const w = actor.meta_window;
            const r = w.get_frame_rect();
            const [x, y] = actor.get_transformed_position().map(Math.round);
            const [width, height] = actor.get_transformed_size().map(Math.round);
            if (w.get_monitor() !== target || !w.is_maximized() ||
                r.x !== area.x || r.y !== area.y || r.width !== area.width || r.height !== area.height ||
                x !== area.x || y !== area.y || width !== area.width || height !== area.height ||
                actor.get_paint_opacity() !== 255)
                wrong ??= `monitor ${w.get_monitor()} at ${x},${y} ${width}×${height}, opacity ${actor.get_paint_opacity()}`;
        });
        try {
            window = await launch();
            await wait(() => visible, 'Browser did not become visible');
            await delay(850);
            if (wrong || window.get_monitor() !== target || !window.is_maximized())
                throw new Error(`Chromium (${mode}) revealed an incorrect placement: ${wrong}`);
            console.log(`Window Spawner test: Chromium (${mode}) revealed maximized on its remembered monitor`);
        } finally {
            global.stage.disconnect(painted);
        }
        await close(window);
    }
}

export default class ChromiumTest extends Extension {
    enable() {
        const result = `${GLib.get_user_runtime_dir()}/spawner-test-result`;
        run().then(() => GLib.file_set_contents(result, 'PASS\n'))
            .catch(error => GLib.file_set_contents(result, `FAIL ${error.message}\n${error.stack}`));
    }
    disable() {}
}
