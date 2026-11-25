import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Component as AuthenticationAgent} from 'resource:///org/gnome/shell/ui/components/polkitAgent.js';

const uuid = 'ubuntu-window-spawner@local';
const title = 'Placement test';
const client = GLib.getenv('SPAWNER_TEST_CLIENT');
const companions = GLib.getenv('SPAWNER_TEST_COMPANIONS') === '1';
const delay = ms => new Promise(resolve => GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ms, resolve));

function check(condition, message) {
    if (!condition)
        throw new Error(message);
    console.log(`Window Spawner test: ${message}`);
}

async function wait(read, description) {
    for (let attempt = 0; attempt < 80; attempt++) {
        const value = read();
        if (value)
            return value;
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${description}`);
}

function activeExtension(id) {
    const extension = Main.extensionManager.lookup(id);
    check(extension?.state === ExtensionState.ACTIVE, `Active extension ${id}`);
    return extension.stateObj;
}

function byTitle(name) {
    return global.get_window_actors().map(actor => actor.meta_window)
        .find(window => window?.get_title() === name);
}

function frame(window) {
    const {x, y, width, height} = window.get_frame_rect();
    return [x, y, width, height].join(',');
}

async function open(backend = 'wayland', mode = '') {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('GDK_BACKEND', backend, true);
    launcher.setenv('SPAWNER_TEST_WINDOW_MODE', mode, true);
    launcher.spawnv(['gjs', '-m', client]);
    if (mode === 'startup') {
        const splash = await wait(() => byTitle('Starting test app'), 'fixed startup window');
        Main.activateWindow(splash);
        await wait(() => splash.has_focus(), 'startup window to take focus');
        check(splash.get_window_type() === Meta.WindowType.NORMAL && !splash.allows_resize(),
            'Startup window is a fixed-size normal window');
        await delay(1200); // Include a slow startup that outlasts placement and write timers.
        Gio.Subprocess.new(['gapplication', 'action', 'org.example.SpawnerTest', 'finish-startup'], Gio.SubprocessFlags.NONE);
    }
    const window = await wait(() => byTitle(title), `GTK ${backend} client`);
    // Allow the app to acknowledge configure events and Shell to finish mapping.
    await delay(800);
    return window;
}

// An actor can report the final frame while its pixels are still translating,
// scaling or fading. Sample the rendered surface and any Shell resize clone.
function paintedGeometry(window) {
    const actor = window?.get_compositor_private();
    const clone = actor?.__animationInfo?.clone;
    if (clone?.is_mapped() && clone.get_paint_opacity())
        return 'Shell resize overlay';
    const surface = actor?.get_first_child();
    if (!surface?.is_mapped() || actor.get_opacity_override() === 0 || !surface.get_paint_opacity())
        return null;
    const [width, height] = surface.get_size();
    if (!width || !height)
        return null;
    const painted = [...surface.get_transformed_position(), ...surface.get_transformed_size()]
        .map(value => Math.round(value * 10) / 10);
    return `${frame(window)} (client ${width}×${height}, stage ${painted}, opacity ${surface.get_paint_opacity()})`;
}

async function observeOpening(findWindow, launch) {
    const seen = new Set();
    const observer = global.stage.connect('after-paint', () => {
        const sample = paintedGeometry(findWindow());
        if (sample)
            seen.add(sample);
    });
    try {
        const window = await launch();
        return {window, seen};
    } finally {
        global.stage.disconnect(observer);
    }
}

async function reopenAtSavedFrame(window, backend = 'wayland', mode = '') {
    const expected = paintedGeometry(window);
    check(Boolean(expected), 'Original client has a painted frame');
    await close(window);
    const {window: reopened, seen} = await observeOpening(() => byTitle(title), () => open(backend, mode));
    check(seen.size === 1 && seen.has(expected),
        `${backend} paints the saved frame from launch (expected ${expected}, saw ${[...seen].join(' → ')})`);
    return reopened;
}

async function close(window) {
    const name = window.get_title();
    window.delete(global.get_current_time());
    await wait(() => !byTitle(name), `close ${name}`);
    await delay(350);
}

function quickSettingsActors() {
    const quick = Main.panel.statusArea.quickSettings;
    return [...quick.menu._grid.get_children(), ...quick._indicators.get_children()];
}

function sameActors(previous, current) {
    return previous.length === current.length && previous.every(actor => current.includes(actor));
}

async function checkPreferencesLauncher() {
    const launcher = Shell.AppSystem.get_default().lookup_app('ubuntu-window-spawner.desktop');
    check(launcher?.get_app_info()?.should_show(), 'Preferences launcher is discoverable in Show Apps');
    launcher.activate();
    const prefs = await wait(() => byTitle('Ubuntu Window Spawner'), 'app launcher to open preferences');
    check(prefs.get_client_type() === Meta.WindowClientType.WAYLAND, 'App launcher opened native preferences');
    await close(prefs);
}

async function checkClientMinimum(monitor) {
    const {window, seen} = await observeOpening(() => byTitle(title), () => open('wayland', 'wide'));
    const rect = window.get_frame_rect();
    const area = window.get_work_area_for_monitor(monitor);
    check(window.get_monitor() === monitor && rect.width >= 920 && rect.height >= 420 &&
        rect.x + rect.width === area.x + area.width && rect.y + rect.height === area.y + area.height &&
        seen.size === 1 && seen.has(paintedGeometry(window)),
    'First visible frame keeps the bottom-right corner after the app raises its minimum size');
    const x = area.x + 88;
    const y = area.y + 55;
    window.move_frame(true, x, y);
    await delay(900);
    const moved = window.get_frame_rect();
    check(moved.x === x && moved.y === y, 'User can reposition a constrained window after it opens');
    await close(window);
}

async function checkApplicationDialog(primary) {
    const frames = new Set();
    const observer = global.stage.connect('after-paint', () => {
        const geometry = paintedGeometry(byTitle('Placement dialog'));
        if (geometry)
            frames.add(geometry);
    });
    let dialog;
    try {
        Gio.Subprocess.new(['gapplication', 'action', 'org.example.SpawnerTest', 'dialog'], Gio.SubprocessFlags.NONE);
        dialog = await wait(() => byTitle('Placement dialog'), 'standalone transient dialog');
        await wait(() => frames.size > 0, 'first visible dialog frame');
        await delay(220);
    } finally {
        global.stage.disconnect(observer);
    }
    const area = dialog.get_work_area_for_monitor(primary);
    const rect = dialog.get_frame_rect();
    check(frames.size === 1 && frames.has(paintedGeometry(dialog)) &&
        dialog.get_monitor() === primary &&
        Math.abs(rect.x + rect.width / 2 - area.x - area.width / 2) <= 2 &&
        Math.abs(rect.y + rect.height / 2 - area.y - area.height / 2) <= 2,
    'Transient dialog centered on its first visible frame');
    dialog.move_frame(true, area.x + 60, area.y + 45);
    await delay(650);
    const moved = dialog.get_frame_rect();
    check(moved.x === area.x + 60 && moved.y === area.y + 45,
        'Moving an open dialog keeps the new position');
    await close(dialog);
}

async function checkStartupHandoff(monitor, backend) {
    let window = await open(backend, 'startup');
    if (backend === 'wayland')
        check(window.get_frame_rect().width === 1080,
            `First launch preserves the main window's 1080-pixel default width (saw ${frame(window)})`);
    const area = window.get_work_area_for_monitor(monitor);
    window.unmaximize();
    window.move_to_monitor(monitor);
    window.move_resize_frame(true, area.x + 80, area.y + 65, 1060, 620);
    await wait(() => window.get_frame_rect().width === 1060 && window.has_focus(), 'main window resized');
    await delay(350);
    const original = frame(window);
    window = await reopenAtSavedFrame(window, backend, 'startup');
    window.maximize();
    await wait(() => window.is_maximized() && window.get_frame_rect().width === area.width, 'main window maximized');
    await delay(350);
    window = await reopenAtSavedFrame(window, backend, 'startup');
    check(window.is_maximized() && window.get_monitor() === monitor,
        `${backend} startup window preserves the main window's maximized state`);
    window.unmaximize();
    await wait(() => frame(window) === original, 'main window retains its floating frame');
    await close(window);
}

async function checkFixedUtility(monitor) {
    let window = await open('wayland', 'fixed');
    check(!window.allows_resize(), 'Fixed-size utility opened');
    const area = window.get_work_area_for_monitor(monitor);
    window.move_to_monitor(monitor);
    window.move_frame(true, area.x + 136, area.y + 93);
    await wait(() => window.get_monitor() === monitor && window.get_frame_rect().x === area.x + 136,
        'fixed-size utility moved');
    await delay(350);
    window = await reopenAtSavedFrame(window, 'wayland', 'fixed');
    check(window.get_monitor() === monitor, 'Fixed-size utility remembers its chosen display');
    await close(window);
}

async function checkFiles(other) {
    // Files remembers maximization itself. This exercises a client that already
    // mapped maximized on the launch monitor before our first configure.
    if (!GLib.find_program_in_path('nautilus')) {
        console.log('Window Spawner test: Files check skipped (Nautilus unavailable)');
        return;
    }
    const folder = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_runtime_dir(), 'Placement test folder',
    ]));
    folder.make_directory(null);
    const name = folder.get_basename();
    async function openFiles() {
        Gio.Subprocess.new(['nautilus', '--new-window', folder.get_path()], Gio.SubprocessFlags.NONE);
        const window = await wait(() => byTitle(name), 'Files test folder');
        await delay(800);
        return window;
    }

    let window = await openFiles();
    window.unmaximize();
    const area = window.get_work_area_for_monitor(other);
    window.move_to_monitor(other);
    window.move_resize_frame(true, area.x + 100, area.y + 70, 820, 460);
    await delay(450);
    const normal = frame(window);
    check(window.get_monitor() === other && normal.endsWith(',820,460'), 'Files moved to the secondary display');
    await close(window);
    window = await openFiles();
    check(frame(window) === normal, 'Files reopens at its saved floating frame');
    window.maximize();
    await delay(450);
    const maximized = paintedGeometry(window);
    check(window.is_maximized() && maximized, 'Files maximized on the secondary display');
    // Flags update synchronously, but Files has not acknowledged a new buffer.
    // The maximized frame in between these requests must never become its normal size.
    window.unmaximize();
    window.maximize();
    await delay(400);
    await close(window);

    const observed = await observeOpening(() => byTitle(name), openFiles);
    window = observed.window;
    check(window.is_maximized() && window.get_monitor() === other &&
        observed.seen.size === 1 && observed.seen.has(maximized),
    'Files opens maximized on the saved monitor from its first visible frame');
    window.unmaximize();
    await delay(500);
    check(frame(window) === normal, 'Unmaximizing Files restores its saved floating frame');
    await close(window);
}

async function checkAuthenticationDialog(extension, primary, other) {
    const monitors = global.backend.get_monitor_manager().get_logical_monitors();
    const monitor = monitors.find(display => display.get_number() === other);
    extension._settings.set_string('dialog-monitor', monitor.get_monitors()[0].get_connector());
    // Exercise the actual Shell prompt with a synthetic request on our private bus.
    const agent = {_onDialogDone(dialog) { dialog.close(); }};
    AuthenticationAgent.prototype._onInitiate.call(agent, null, 'org.example.test',
        'Window placement test', '', 'test-request', [GLib.get_user_name()]);
    const prompt = agent._currentDialog;
    check(prompt.open(), 'Shell authentication dialog opens');
    await delay(450);
    check(prompt._monitorConstraint.index === other && prompt.contains(global.stage.key_focus),
        'Authentication prompt has keyboard focus on the chosen monitor');
    extension._settings.set_string('dialog-monitor', 'primary');
    await wait(() => prompt._monitorConstraint.index === primary, 'prompt follows primary display selection');
    prompt.cancel();
    await wait(() => !Main.layoutManager.modalDialogGroup.get_children().includes(prompt), 'prompt cancellation');
}

async function checkPartialMaximization(window, area) {
    const original = frame(window);
    for (const flags of [Meta.MaximizeFlags.HORIZONTAL, Meta.MaximizeFlags.VERTICAL]) {
        const horizontal = flags === Meta.MaximizeFlags.HORIZONTAL;
        window.set_maximize_flags(flags);
        await wait(() => horizontal ? window.get_frame_rect().width === area.width :
            window.get_frame_rect().height === area.height, 'partial maximize');
        const rect = window.get_frame_rect();
        const edited = horizontal ? [rect.x, area.y + 75, rect.width, 400] :
            [area.x + 70, rect.y, 770, rect.height];
        window.move_resize_frame(true, ...edited);
        await wait(() => frame(window) === edited.join(','), 'adjust free axis');
        await delay(350);
        window = await reopenAtSavedFrame(window);
        check(window.get_maximize_flags() === flags && frame(window) === edited.join(','),
            'Partial maximize retains the edited free axis');
        window.unmaximize();
        await wait(() => frame(window) === original, 'native unmaximize restores both original axes');
        await delay(150);
    }
    return window;
}

async function checkSnapping(window, originalFrame) {
    const snap = activeExtension('keyboard-monitor-snap@local');
    activeExtension('tiling-assistant@ubuntu.com');
    activeExtension('nightfall-popups@ubuntu-nightfall.local');
    Main.panel.statusArea.quickSettings.menu.open();
    await delay(250);
    Main.panel.statusArea.quickSettings.menu.close();
    await snap._snap('left', window);
    await delay(850);
    const snapped = frame(window);
    check(snapped !== originalFrame, 'Companion snapped the test window');
    await close(window);
    window = await open();
    check(frame(window) === snapped, 'Reopened window retained the snapped frame');
    await snap._snap('right', window);
    await delay(700);
    check(frame(window) !== snapped, 'Companion can snap again after restoring');
    return window;
}

async function run() {
    await wait(() => Main.extensionManager.lookup(uuid)?.state === ExtensionState.ACTIVE, 'Window Spawner to enable');
    await wait(() => !Main.layoutManager._startingUp, 'Shell startup to complete');
    Main.overview.hide();
    await delay(600);
    check(global.display.get_n_monitors() === 2, 'Two virtual monitors');
    const primary = global.display.get_primary_monitor();
    const other = 1 - primary;
    const extension = activeExtension(uuid);
    check(!quickSettingsActors().some(actor => actor.title === 'Window Placement'),
        'Initial enable leaves the Window Placement tile out of Quick Settings');
    await checkStartupHandoff(other, 'wayland');
    await checkStartupHandoff(other, 'x11');
    await checkFixedUtility(other);
    await checkPreferencesLauncher();

    let window = await open();
    check(window.get_client_type() === Meta.WindowClientType.WAYLAND, 'Native Wayland client');
    const area = window.get_work_area_for_monitor(other);
    window.move_to_monitor(other);
    window.move_resize_frame(true, area.x + 95, area.y + 68, 620, 380);
    await delay(950);
    const stored = frame(window);
    check(window.get_monitor() === other && stored.endsWith(',620,380'), 'User moved and resized the window');
    window = await reopenAtSavedFrame(window);
    check(frame(window) === stored, 'Wayland reopens at its saved position and size');
    window.maximize();
    await wait(() => window.is_maximized(), 'maximize');
    await delay(600);
    window = await reopenAtSavedFrame(window);
    check(window.is_maximized() && window.get_monitor() === other, 'Restored maximized on the remembered monitor');
    window.unmaximize();
    await delay(800);
    check(frame(window) === stored, 'Unmaximizing restores the normal frame');
    window = await checkPartialMaximization(window, area);
    await checkApplicationDialog(primary);
    if (companions)
        window = await checkSnapping(window, stored);
    await close(window);
    await checkAuthenticationDialog(extension, primary, other);
    await checkFiles(other);

    window = await open('x11');
    check(window.get_client_type() === Meta.WindowClientType.X11, 'XWayland client');
    window.move_resize_frame(true, area.x + 108, area.y + 76, 580, 340);
    await delay(800);
    const xFrame = frame(window);
    check(window.get_monitor() === other && xFrame.endsWith(',580,340'), 'XWayland window moved and resized');
    window = await reopenAtSavedFrame(window, 'x11');
    check(frame(window) === xFrame, 'XWayland reopens at its saved position and size');
    const small = window.get_frame_rect();
    const neighbour = window.get_work_area_for_monitor(primary);
    const seamX = area.x > neighbour.x ? area.x - 160 : area.x + area.width - small.width + 160;
    window.move_frame(true, seamX, Math.max(area.y, neighbour.y) + 60);
    await delay(350);
    check(window.get_frame_rect().x === seamX, 'Window spans both displays');
    window = await reopenAtSavedFrame(window, 'x11');
    window.move_frame(true, area.x + area.width - small.width, area.y + area.height - small.height);
    await delay(350);
    await close(window);

    // Both backends of this synthetic GTK app use the same application ID.
    await checkClientMinimum(other);
    if (GLib.getenv('SPAWNER_TEST_APPLICATIONS') === '1') {
        const {checkApplications} = await import('./applications.js');
        await checkApplications(other, {check, wait, delay, close, observeOpening, paintedGeometry});
    }

    const activeActors = quickSettingsActors();
    Main.extensionManager.disableExtension(uuid);
    await wait(() => Main.extensionManager.lookup(uuid)?.state === ExtensionState.INACTIVE, 'disabled extension');
    check(sameActors(activeActors, quickSettingsActors()), 'Disabling leaves Quick Settings controls unchanged');
    window = await open('x11');
    check(frame(window) !== xFrame, 'Disabled extension leaves window placement to Shell');
    await close(window);
    const disabledActors = quickSettingsActors();
    Main.extensionManager.enableExtension(uuid);
    await wait(() => Main.extensionManager.lookup(uuid)?.state === ExtensionState.ACTIVE, 're-enabled extension');
    check(sameActors(disabledActors, quickSettingsActors()), 'Re-enabling adds no Quick Settings tile or indicator');
}

export default class Driver extends Extension {
    enable() {
        const result = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'spawner-test-result']);
        run().then(() => GLib.file_set_contents(result, 'PASS\n'))
            .catch(error => GLib.file_set_contents(result, `FAIL ${error.message}\n${error.stack}`));
    }

    disable() {}
}
