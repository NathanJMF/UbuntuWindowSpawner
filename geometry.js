// Frame dimensions use Mutter's logical pixels, including on scaled monitors.
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function layoutId(monitors) {
    return JSON.stringify(monitors.map(m => m.connector).sort());
}

export function rememberFrame(frame, area) {
    return {
        width: frame.width,
        height: frame.height,
        // Preserve a window against its chosen edge when the work area changes.
        xRatio: clamp((frame.x - area.x) / Math.max(1, area.width - frame.width), 0, 1),
        yRatio: clamp((frame.y - area.y) / Math.max(1, area.height - frame.height), 0, 1),
    };
}

export function validFrame(frame) {
    return frame && Number.isSafeInteger(frame.width) && frame.width > 0 &&
        Number.isSafeInteger(frame.height) && frame.height > 0 &&
        Number.isFinite(frame.xRatio) && Number.isFinite(frame.yRatio);
}

export function fitFrame(frame, area, fixedSize = null) {
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
