import GLib from 'gi://GLib';

import {fitFrame, sameFrame} from './geometry.js';

// Monotonic timestamps are in microseconds. The polling source only runs
// while a newly mapped window is negotiating its placement with Mutter.
const RESTORE_LIMIT_US = 750_000;
const CONSTRAINED_FRAME_GRACE_US = 140_000;
const CONSTRAINED_FRAME_STABLE_US = 100_000;
const ALLOCATION_STABLE_US = 32_000;
const POLL_INTERVAL_MS = 12;

// Mutter's maximize flags can change before a Wayland client draws the new
// buffer. Finish each configure before issuing the next one. Throughout this
// short launch transaction the actor stays mapped, so clients still get their
// frames and Shell retains ownership of animation opacity.
export function restoreAtMap(window, actor, record, index, done) {
    const area = window.get_work_area_for_monitor(index);
    const initial = window.get_frame_rect();
    const initialFlags = window.get_maximize_flags();
    const finalFlags = window.can_maximize() ? record.maximized : 0;

    function bufferReady() {
        const surface = actor.get_first_child();
        if (!surface?.has_allocation())
            return false;
        const [width, height] = surface.get_size();
        const buffer = window.get_buffer_rect();
        return Math.abs(width - buffer.width) <= 1 && Math.abs(height - buffer.height) <= 1;
    }

    if (!initialFlags && !finalFlags && window.get_monitor() === index && bufferReady() &&
        (!record.frame || sameFrame(initial, fitFrame(record.frame, area,
            window.allows_resize() ? null : initial))))
        return null;

    const started = GLib.get_monotonic_time();
    const deadline = started + RESTORE_LIMIT_US;
    const acceptConstrainedAt = started + CONSTRAINED_FRAME_GRACE_US;
    const originalOpacity = actor.get_opacity_override();
    const userTime = window.get_user_time();
    let phase = 'normal';
    let target = null;
    let beforeResize = null;
    let source = 0;
    let stableFrom = 0;
    let lastFrame = null;

    function cancel() {
        if (source) {
            GLib.Source.remove(source);
            source = 0;
        }
        if (!actor.is_destroyed() && actor.get_opacity_override() === 0) {
            actor.set_opacity_override(originalOpacity);
            actor.queue_redraw();
        }
    }

    function applyFrame() {
        phase = 'frame';
        beforeResize = window.get_frame_rect();
        if (window.get_monitor() !== index)
            window.move_to_monitor(index);
        if (record.frame && window.allows_move()) {
            const resizable = window.allows_resize();
            target = fitFrame(record.frame, area, resizable ? null : window.get_frame_rect());
            if (resizable)
                window.move_resize_frame(false, target.x, target.y, target.width, target.height);
            else
                window.move_frame(false, target.x, target.y);
        }
    }

    function finalFrame() {
        const frame = window.get_frame_rect();
        if (window.get_monitor() !== index || window.get_maximize_flags() !== finalFlags)
            return false;
        if (finalFlags & 1 && (frame.x !== area.x || frame.width !== area.width))
            return false;
        if (finalFlags & 2 && (frame.y !== area.y || frame.height !== area.height))
            return false;
        return true;
    }

    function advance() {
        const now = GLib.get_monotonic_time();
        const frame = window.get_frame_rect();
        if (!lastFrame || !sameFrame(lastFrame, frame)) {
            lastFrame = frame;
            stableFrom = now;
        }
        if (phase === 'normal') {
            // Wait for the acknowledgement of the app's *own* initial maximize.
            // Otherwise its later unmaximize configure can overwrite our move.
            if (window.get_maximize_flags() || (sameFrame(frame, initial) && now < acceptConstrainedAt))
                return false;
            applyFrame();
            return false;
        }
        if (phase === 'frame') {
            if (window.get_monitor() !== index)
                return false;
            // Fixed/increment-sized clients may accept a nearby size. Give the
            // real configure time to arrive before accepting a constrained frame.
            if (target && !sameFrame(frame, target)) {
                const acceptedSize = frame.width === target.width && frame.height === target.height;
                const resized = frame.width !== beforeResize.width || frame.height !== beforeResize.height;
                const moved = frame.x !== beforeResize.x || frame.y !== beforeResize.y;
                if ((!resized && !(acceptedSize && moved)) || now < acceptConstrainedAt ||
                    now - stableFrom < CONSTRAINED_FRAME_STABLE_US)
                    return false;
            }
            if (!bufferReady())
                return false;
            phase = 'final';
            if (finalFlags && window.get_maximize_flags() !== finalFlags)
                window.set_maximize_flags(finalFlags);
            return false;
        }
        // Keep a complete allocation cycle between a confirmed client frame
        // and reveal. Frame geometry alone can precede the actor's allocation.
        return finalFrame() && bufferReady() && now - stableFrom >= ALLOCATION_STABLE_US;
    }

    actor.set_opacity_override(0);
    try {
        if (initialFlags && (record.frame || initialFlags !== finalFlags)) {
            window.unmaximize();
        } else {
            applyFrame();
        }
        source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            let settled = false;
            try {
                const interrupted = GLib.get_monotonic_time() >= deadline || window.minimized ||
                    window.is_fullscreen() || window.get_user_time() !== userTime;
                if (!interrupted) {
                    settled = advance();
                    if (!settled)
                        return GLib.SOURCE_CONTINUE;
                }
            } catch (error) {
                console.error('Window Spawner could not finish a launch placement.', error);
            }
            source = 0;
            cancel();
            done(settled);
            return GLib.SOURCE_REMOVE;
        });
    } catch (error) {
        cancel();
        throw error;
    }
    return cancel;
}
