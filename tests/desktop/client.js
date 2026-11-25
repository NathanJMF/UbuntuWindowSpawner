import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const mode = GLib.getenv('SPAWNER_TEST_WINDOW_MODE');
const app = new Gtk.Application({
    application_id: mode === 'fixed' ? 'org.example.SpawnerUtility' : 'org.example.SpawnerTest',
});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app, title: 'Placement test', default_width: 360, default_height: 240,
        resizable: mode !== 'fixed',
    });
    if (mode === 'startup') {
        window.set_default_size(1080, 660);
        window.set_size_request(940, 500);
    } else if (mode === 'wide') {
        window.set_size_request(920, 420);
    }
    const show = new Gio.SimpleAction({name: 'dialog'});
    show.connect('activate', () => {
        const dialog = new Gtk.Window({
            title: 'Placement dialog', transient_for: window, default_width: 300, default_height: 160,
        });
        dialog.present();
    });
    app.add_action(show);
    if (mode === 'startup') {
        const splash = new Gtk.ApplicationWindow({
            application: app, title: 'Starting test app', default_width: 300, default_height: 350,
            decorated: false, resizable: false,
        });
        const finish = new Gio.SimpleAction({name: 'finish-startup'});
        finish.connect('activate', () => {
            window.present();
            GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 200, () => splash.close());
        });
        app.add_action(finish);
        splash.present();
    } else {
        window.present();
    }
});
app.run([]);
