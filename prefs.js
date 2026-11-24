import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {forgetSavedApp, listSavedApps} from './state.js';

function appName(id) {
    const desktopId = id.endsWith('.desktop') ? id : `${id}.desktop`;
    return GioUnix.DesktopAppInfo.new(desktopId)?.get_display_name() ?? id;
}

function setExcluded(settings, id, excluded) {
    const ids = new Set(settings.get_strv('excluded-apps'));
    if (excluded)
        ids.add(id);
    else
        ids.delete(id);
    settings.set_strv('excluded-apps', [...ids].sort());
}

function chooseException(window, settings) {
    const chooser = new Gtk.AppChooserDialog({
        transient_for: window,
        modal: true,
        title: 'Choose an app',
        content_type: 'application/octet-stream',
    });
    chooser.set_heading('Which app should manage its own windows?');
    chooser.get_widget().show_all = true;
    chooser.connect('response', (_dialog, response) => {
        if (response === Gtk.ResponseType.OK) {
            const id = chooser.get_app_info()?.get_id();
            if (id)
                setExcluded(settings, id, true);
        }
        chooser.destroy();
    });
    chooser.present();
}

export default class WindowSpawnerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Window Placement'});
        window.add(page);

        const general = new Adw.PreferencesGroup();
        page.add(general);
        const remember = new Adw.SwitchRow({
            title: 'Remember window size and position',
            subtitle: 'Reopen apps where you last used them.',
        });
        general.add(remember);
        settings.bind('remember-windows', remember, 'active', Gio.SettingsBindFlags.DEFAULT);

        const apps = new Adw.PreferencesGroup({
            title: 'App preferences',
            description: 'Let individual apps manage their own windows, or forget a saved position.',
        });
        page.add(apps);
        const choose = new Gtk.Button({label: 'Add exception…', valign: Gtk.Align.CENTER});
        choose.connect('clicked', () => chooseException(window, settings));
        apps.header_suffix = choose;

        let rows = [];
        const refresh = () => {
            for (const row of rows)
                apps.remove(row);
            rows = [];
            const saved = new Set(listSavedApps());
            const excluded = new Set(settings.get_strv('excluded-apps'));
            const appsByName = [...new Set([...saved, ...excluded])]
                .map(id => ({id, name: appName(id)}))
                .sort((a, b) => a.name.localeCompare(b.name));
            for (const {id, name} of appsByName) {
                const row = new Adw.ActionRow({
                    title: name,
                    use_markup: false,
                    subtitle: excluded.has(id) ? 'App manages its own windows' : 'Remembering window placement',
                });
                const toggle = new Gtk.Switch({
                    active: !excluded.has(id),
                    valign: Gtk.Align.CENTER,
                    tooltip_text: `Remember window placement for ${name}`,
                });
                toggle.update_property([Gtk.AccessibleProperty.LABEL], [toggle.tooltip_text]);
                toggle.connect('notify::active', () => setExcluded(settings, id, !toggle.active));
                row.add_suffix(toggle);
                row.activatable_widget = toggle;
                if (saved.has(id)) {
                    const forget = new Gtk.Button({label: 'Forget', valign: Gtk.Align.CENTER});
                    forget.update_property([Gtk.AccessibleProperty.LABEL], [`Forget saved position for ${name}`]);
                    forget.connect('clicked', () => {
                        forgetSavedApp(id);
                        refresh();
                    });
                    row.add_suffix(forget);
                }
                rows.push(row);
            }
            if (!rows.length)
                rows.push(new Adw.ActionRow({title: 'No saved windows yet', subtitle: 'Apps appear here as you use them.'}));
            for (const row of rows)
                apps.add(row);
        };
        refresh();
        const changed = settings.connect('changed::excluded-apps', refresh);
        window.connect('close-request', () => {
            settings.disconnect(changed);
            return false;
        });
    }
}
