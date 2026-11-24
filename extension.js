import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {WindowPlacement} from './windows.js';
import {ShellDialogs} from './shellDialogs.js';

export default class WindowSpawner extends Extension {
    enable() {
        try {
            this._enable();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _enable() {
        this._settings = this.getSettings();
        this._placement = new WindowPlacement(this._settings);
        this._placement.enable();

        this._dialogs = new ShellDialogs(Main.layoutManager.modalDialogGroup,
            actor => actor instanceof ModalDialog.ModalDialog, ModalDialog.State,
            () => this._dialogIndex());
        this._dialogs.enable();

        this._settingsChanged = this._settings.connect('changed::dialog-monitor',
            () => this._dialogs.refresh());
        this._monitorsChanged = Main.layoutManager.connect('monitors-changed',
            () => this._dialogs.refresh());
    }

    _dialogIndex() {
        const target = this._settings.get_string('dialog-monitor');
        if (target === 'system' || !Main.layoutManager.primaryMonitor)
            return null;
        if (target !== 'primary') {
            const index = global.backend.get_monitor_manager().get_monitor_for_connector(target);
            if (index >= 0)
                return index;
        }
        return Main.layoutManager.primaryIndex;
    }

    disable() {
        if (this._settingsChanged)
            this._settings.disconnect(this._settingsChanged);
        if (this._monitorsChanged)
            Main.layoutManager.disconnect(this._monitorsChanged);
        this._settingsChanged = this._monitorsChanged = 0;
        this._dialogs?.disable();
        this._placement?.disable();
        this._dialogs = this._placement = this._settings = null;
    }
}
