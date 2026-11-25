import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export async function checkApplications(monitor, {check, wait, delay, close, observeOpening, paintedGeometry}) {
    // The harness supplies a private home and bus. Writer also gets a separate
    // profile so the launch can never be forwarded to another Writer process.
    const runtime = Gio.File.new_for_path(GLib.get_user_runtime_dir());
    const document = runtime.get_child('Placement test.txt');
    GLib.file_set_contents(document.get_path(), 'Window placement test.');
    const profile = runtime.get_child('writer-profile').get_uri();
    const apps = [
        {name: 'XTerm', match: /^xterm$/i, args: ['xterm', '-e', 'sleep', '180']},
        {name: 'Calculator', match: /^org\.gnome\.Calculator$/i, args: ['gnome-calculator']},
        {name: 'Writer', match: /^libreoffice/i, args: [
            'libreoffice', `-env:UserInstallation=${profile}`, '--nologo', '--norestore', '--writer', document.get_path(),
        ]},
    ];
    for (const {name, match, args} of apps) {
        check(GLib.find_program_in_path(args[0]), `${name} is installed for the application tests`);
        const find = () => global.get_window_actors().map(actor => actor.meta_window)
            .find(w => w?.get_window_type() === Meta.WindowType.NORMAL && match.test(w.get_wm_class() ?? ''));
        const launch = async () => {
            Gio.Subprocess.new(args, Gio.SubprocessFlags.NONE);
            const window = await wait(find, `opening ${name}`);
            await delay(900);
            return window;
        };
        let window = await launch();
        Main.activateWindow(window);
        await wait(() => window.has_focus(), `focusing ${name}`);
        window.unmaximize();
        await delay(150);
        window.move_to_monitor(monitor);
        const area = window.get_work_area_for_monitor(monitor);
        window.move_resize_frame(true, area.x + 88, area.y + 56, 773, 453);
        await delay(650);
        // Compare the size the application actually accepted. XTerm rounds to
        // character-cell increments and Calculator has a minimum height.
        const expected = paintedGeometry(window);
        check(window.get_monitor() === monitor && expected, `${name} accepted its initial placement`);
        for (let reopen = 1; reopen <= 2; reopen++) {
            await close(window);
            const opened = await observeOpening(find, launch);
            window = opened.window;
            check(window.get_monitor() === monitor && opened.seen.size === 1 && opened.seen.has(expected),
                `${name} reopen ${reopen} paints ${expected} (saw ${[...opened.seen].join(' → ')})`);
        }
        await close(window);
    }
}
