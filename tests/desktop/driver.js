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

async function open(backend = 'wayland') {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('GDK_BACKEND', backend, true);
    launcher.spawnv(['gjs', '-m', client]);
    const window = await wait(() => byTitle(title), `GTK ${backend} client`);
    // Allow the app to acknowledge configure events and Shell to finish mapping.
    await delay(800);
    return window;
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

async function checkApplicationDialog(primary) {
    Gio.Subprocess.new(['gapplication', 'action', 'org.example.SpawnerTest', 'dialog'], Gio.SubprocessFlags.NONE);
    const dialog = await wait(() => byTitle('Placement dialog'), 'standalone transient dialog');
    await delay(650);
    const area = dialog.get_work_area_for_monitor(primary);
    const rect = dialog.get_frame_rect();
    check(dialog.get_monitor() === primary &&
        Math.abs(rect.x + rect.width / 2 - area.x - area.width / 2) <= 2 &&
        Math.abs(rect.y + rect.height / 2 - area.y - area.height / 2) <= 2,
    'Transient dialog centered on primary monitor');
    await close(dialog);
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
    await delay(1600);
    Main.overview.hide();
    await delay(600);
    check(global.display.get_n_monitors() === 2, 'Two virtual monitors');
    const primary = global.display.get_primary_monitor();
    const other = 1 - primary;
    const extension = activeExtension(uuid);
    check(!quickSettingsActors().some(actor => actor.title === 'Window Placement'),
        'Initial enable leaves the Window Placement tile out of Quick Settings');
    await checkPreferencesLauncher();

    let window = await open();
    check(window.get_client_type() === Meta.WindowClientType.WAYLAND, 'Native Wayland client');
    const area = window.get_work_area_for_monitor(other);
    window.move_to_monitor(other);
    window.move_resize_frame(true, area.x + 95, area.y + 68, 620, 380);
    await delay(950);
    const stored = frame(window);
    check(window.get_monitor() === other && stored.endsWith(',620,380'), 'User moved and resized the window');
    await close(window);
    window = await open();
    check(frame(window) === stored, 'Wayland reopens at its saved position and size');
    window.maximize();
    await wait(() => window.is_maximized(), 'maximize');
    await delay(600);
    await close(window);
    window = await open();
    check(window.is_maximized() && window.get_monitor() === other, 'Restored maximized on the remembered monitor');
    window.unmaximize();
    await delay(800);
    check(frame(window) === stored, 'Unmaximizing restores the normal frame');
    await checkApplicationDialog(primary);
    if (companions)
        window = await checkSnapping(window, stored);
    await close(window);
    await checkAuthenticationDialog(extension, primary, other);

    window = await open('x11');
    check(window.get_client_type() === Meta.WindowClientType.X11, 'XWayland client');
    window.move_resize_frame(true, area.x + 108, area.y + 76, 580, 340);
    await delay(800);
    const xFrame = frame(window);
    check(window.get_monitor() === other && xFrame.endsWith(',580,340'), 'XWayland window moved and resized');
    await close(window);
    window = await open('x11');
    check(frame(window) === xFrame, 'XWayland reopens at its saved position and size');
    await close(window);

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
