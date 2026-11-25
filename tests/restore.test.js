import GLib from 'gi://GLib';
import {rememberFrame, sameFrame} from '../geometry.js';
import {restoreAtMap} from '../restore.js';

const area = {x: 0, y: 30, width: 1280, height: 770};
const target = {x: 60, y: 100, width: 620, height: 420};
const saved = {frame: rememberFrame(target, area), maximized: 0};

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function delayedClient(responds) {
    let frame = {x: 450, y: 220, width: 340, height: 260};
    let drawn = frame;
    let opacity = -1;
    const visibleFrames = [];
    const surface = {
        has_allocation: () => true,
        get_size: () => [drawn.width, drawn.height],
    };
    const actor = {
        is_destroyed: () => false,
        get_opacity_override: () => opacity,
        set_opacity_override(value) {
            opacity = value;
            if (value !== 0)
                visibleFrames.push(drawn);
        },
        get_first_child: () => surface,
        queue_redraw() {},
    };
    const window = {
        get_work_area_for_monitor: () => area,
        get_frame_rect: () => frame,
        get_buffer_rect: () => frame,
        get_monitor: () => 0,
        get_maximize_flags: () => 0,
        can_maximize: () => true,
        allows_move: () => true,
        allows_resize: () => true,
        get_min_size: () => [false, 0, 0],
        get_max_size: () => [false, 0, 0],
        is_fullscreen: () => false,
        get_user_time: () => 1,
        move_resize_frame(_user, x, y, width, height) {
            if (responds) {
                // A client can acknowledge frame geometry before its surface is allocated.
                GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 250, () => {
                    frame = {x, y, width, height};
                });
                GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 380, () => {
                    drawn = frame;
                });
            }
        },
    };
    const settled = await new Promise((resolve, reject) => {
        const watchdog = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 4000, () =>
            reject(new Error('Restore did not reveal an unresponsive client')));
        restoreAtMap(window, actor, saved, 0, success => {
            GLib.Source.remove(watchdog);
            resolve(success);
        });
    });
    assert(settled === responds, 'Only acknowledged placement may update the saved record');
    assert(opacity === -1 && visibleFrames.length === 1, 'Reveal once and release the opacity override');
    if (responds)
        assert(sameFrame(visibleFrames[0], target), 'Reveal after the correctly sized client frame is allocated');
}

await delayedClient(true);
await delayedClient(false);
print('Delayed and unresponsive restore checks passed');
