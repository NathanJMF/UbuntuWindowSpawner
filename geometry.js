// Frame dimensions use Mutter's logical pixels, including on scaled monitors.
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function layoutId(monitors) {
    return JSON.stringify(monitors.map(m => m.connector).sort());
}

export function sameFrame(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function overlap(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return Math.max(0, width) * Math.max(0, height);
}

// GNOME exposes mirrored outputs as one logical monitor. The work areas of
// distinct logical monitors do not overlap, so their coverage can be added.
export function spansDisplays(frame, anchor, areas) {
    if (areas.length < 2)
        return false;
    const size = frame.width * frame.height;
    const anchored = overlap(frame, anchor);
    return anchored > 0 && anchored < size &&
        areas.reduce((sum, area) => sum + overlap(frame, area), 0) === size;
}

export function rememberFrame(frame, area, workAreas = []) {
    const saved = {
        width: frame.width,
        height: frame.height,
        // Preserve a window against its chosen edge when the work area changes.
        xRatio: clamp((frame.x - area.x) / Math.max(1, area.width - frame.width), 0, 1),
        yRatio: clamp((frame.y - area.y) / Math.max(1, area.height - frame.height), 0, 1),
    };
    if (spansDisplays(frame, area, workAreas))
        saved.span = {x: frame.x - area.x, y: frame.y - area.y};
    return saved;
}

export function validFrame(frame) {
    return frame && Number.isSafeInteger(frame.width) && frame.width > 0 &&
        Number.isSafeInteger(frame.height) && frame.height > 0 &&
        Number.isFinite(frame.xRatio) && Number.isFinite(frame.yRatio);
}

export function fitFrame(frame, area, fixedSize = null, workAreas = []) {
    if (Number.isSafeInteger(frame.span?.x) && Number.isSafeInteger(frame.span?.y)) {
        const spanning = {x: area.x + frame.span.x, y: area.y + frame.span.y,
            width: fixedSize?.width ?? frame.width, height: fixedSize?.height ?? frame.height};
        if (spansDisplays(spanning, area, workAreas))
            return spanning;
    }
    const width = fixedSize?.width ?? Math.min(frame.width, area.width);
    const height = fixedSize?.height ?? Math.min(frame.height, area.height);
    return {
        x: area.x + Math.round(clamp(frame.xRatio, 0, 1) * Math.max(0, area.width - width)),
        y: area.y + Math.round(clamp(frame.yRatio, 0, 1) * Math.max(0, area.height - height)),
        width,
        height,
    };
}

export function monitorIndex(connector, monitors, primary) {
    return monitors.find(m => m.connector === connector)?.index ?? primary;
}
