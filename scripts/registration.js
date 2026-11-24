// Update only our membership of GNOME's shared extension lists.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [action, uuid] = ARGV;
if (!['enable', 'remove'].includes(action) || !uuid)
    throw new Error('Expected enable or remove and an extension UUID.');

const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
shell.delay();
for (const key of ['enabled-extensions', 'disabled-extensions']) {
    const current = shell.get_strv(key);
    const shouldInclude = action === 'enable' && key === 'enabled-extensions';
    if (current.includes(uuid) === shouldInclude)
        continue;

    if (!shell.is_writable(key))
        throw new Error(`GNOME has locked the ${key} setting.`);

    const next = shouldInclude ? [...current, uuid] : current.filter(id => id !== uuid);
    const value = new GLib.Variant('as', next);
    if (shell.get_default_value(key).equal(value))
        shell.reset(key);
    else if (!shell.set_value(key, value))
        throw new Error(`Could not update ${key}.`);
}
shell.apply();
Gio.Settings.sync();
