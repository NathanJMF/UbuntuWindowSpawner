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

function addDialogSettings(page, settings, window) {
    const group = new Adw.PreferencesGroup({
        title: 'Dialogs',
        description: 'Choose where file choosers, confirmation windows, and administrator prompts open.',
    });
    page.add(group);
    const where = new Adw.ComboRow({
        title: 'Where should dialogs open?',
        use_subtitle: true,
        model: Gtk.StringList.new(['Centered on my main display', 'Centered on a specific display', 'Let Ubuntu decide']),
    });
    const picker = new Adw.ComboRow({title: 'Display', use_markup: false});
    group.add(where);
    group.add(picker);

    const monitors = window.get_display().get_monitors();
    let choices = [];
    let updating = false;
    let names = new Map();

    const update = () => {
        updating = true;
        const selected = settings.get_string('dialog-monitor');
        const specific = selected !== 'primary' && selected !== 'system';
        where.selected = specific ? 1 : selected === 'system' ? 2 : 0;
        choices = [];
        for (let i = 0; i < monitors.get_n_items(); i++) {
            const monitor = monitors.get_item(i);
            const connector = monitor.get_connector();
            if (connector)
                choices.push({connector, name: names.get(connector) || monitor.get_model() || connector});
        }
        const labels = choices.map(({connector, name}) =>
            choices.filter(other => other.name === name).length > 1 ? `${name} (${connector})` : name);
        let index = choices.findIndex(item => item.connector === selected);
        const disconnected = specific && index < 0;
        if (disconnected) {
            index = choices.length;
            choices.push({connector: selected});
            labels.push(`${selected} (disconnected)`);
        }
        picker.model = Gtk.StringList.new(labels);
        picker.selected = index < 0 ? 0 : index;
        picker.subtitle = disconnected ? 'Using your main display until this one reconnects.' : '';
        picker.visible = specific;
        updating = false;
    };

    where.connect('notify::selected', () => {
        if (updating)
            return;
        const choice = where.selected;
        if (choice === 1 && !choices.length) {
            update();
            return;
        }
        const target = choice === 0 ? 'primary' : choice === 2 ? 'system' : choices[0].connector;
        settings.set_string('dialog-monitor', target);
    });
    picker.connect('notify::selected', () => {
        const choice = choices[picker.selected];
        if (!updating && choice)
            settings.set_string('dialog-monitor', choice.connector);
    });

    // Mutter supplies the friendly names shown in Ubuntu's Displays panel.
    // GDK keeps the picker usable while the asynchronous lookup is pending.
    const cancel = new Gio.Cancellable();
    let revision = 0;
    const refreshNames = () => {
        update();
        const current = ++revision;
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', null, null,
            Gio.DBusCallFlags.NONE, 3000, cancel, (bus, result) => {
                let reply;
                try {
                    reply = bus.call_finish(result);
                } catch {
                    return;
                }
                if (current !== revision || cancel.is_cancelled())
                    return;
                const [, physical] = reply.deepUnpack();
                names = new Map(physical.map(([[connector], _modes, props]) =>
                    [connector, props['display-name']?.unpack()]));
                update();
            });
    };
    const displaysChanged = monitors.connect('items-changed', refreshNames);
    const settingChanged = settings.connect('changed::dialog-monitor', update);
    refreshNames();
    return () => {
        cancel.cancel();
        monitors.disconnect(displaysChanged);
        settings.disconnect(settingChanged);
    };
}

export default class WindowSpawnerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Window Placement'});
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'Windows'});
        page.add(general);
        const remember = new Adw.SwitchRow({
            title: 'Remember window size and position',
            subtitle: 'Reopen apps where you last used them.',
        });
        general.add(remember);
        settings.bind('remember-windows', remember, 'active', Gio.SettingsBindFlags.DEFAULT);

        const closeDialogSettings = addDialogSettings(page, settings, window);

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
            closeDialogSettings();
            settings.disconnect(changed);
            return false;
        });
    }
}
