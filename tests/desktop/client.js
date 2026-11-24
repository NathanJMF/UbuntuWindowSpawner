import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

const app = new Gtk.Application({application_id: 'org.example.SpawnerTest'});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app, title: 'Placement test', default_width: 360, default_height: 240,
    });
    const show = new Gio.SimpleAction({name: 'dialog'});
    show.connect('activate', () => {
        const dialog = new Gtk.Window({
            title: 'Placement dialog', transient_for: window, default_width: 300, default_height: 160,
        });
        dialog.present();
    });
    app.add_action(show);
    window.present();
});
app.run([]);
