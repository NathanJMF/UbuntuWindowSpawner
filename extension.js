import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {WindowPlacement} from './windows.js';
import {ShellDialogs} from './shellDialogs.js';

const ICON = 'preferences-desktop-display-symbolic';

function activeDisplays() {
    const manager = global.backend.get_monitor_manager();
    return manager.get_logical_monitors().map(logical => {
        const monitor = logical.get_monitors()[0];
        return {
            name: monitor.get_display_name(),
            connector: monitor.get_connector(),
        };
    });
}

export default class WindowSpawner extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._placement = new WindowPlacement(this._settings);
        this._placement.enable();

        this._dialogs = new ShellDialogs(Main.layoutManager.modalDialogGroup,
            actor => actor instanceof ModalDialog.ModalDialog, ModalDialog.State,
            () => this._dialogIndex());
        this._dialogs.enable();

        this._indicator = new SystemIndicator();
        this._tile = new QuickMenuToggle({
            title: 'Window Placement',
            iconName: ICON,
            toggleMode: true,
            menuButtonAccessibleName: 'Open window placement settings',
        });
        this._indicator.quickSettingsItems.push(this._tile);
        this._settings.bind('remember-windows', this._tile, 'checked', Gio.SettingsBindFlags.DEFAULT);

        const menu = this._tile.menu;
        menu.setHeader(ICON, 'Window Placement');
        const memorySwitch = new PopupMenu.PopupSwitchMenuItem(
            'Remember window size and position', this._tile.checked);
        menu.addMenuItem(memorySwitch);
        this._settings.bind('remember-windows', memorySwitch, 'state', Gio.SettingsBindFlags.DEFAULT);
        this._settings.connectObject('changed::remember-windows', () => this._updateSubtitle(), this._tile);
        this._updateSubtitle();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Where should dialogs open?'));
        this._destinations = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._destinations);
        this._chooseDisplay = new PopupMenu.PopupSubMenuMenuItem('Choose a specific display…', false);
        menu.addMenuItem(this._chooseDisplay);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Preferences…', () => {
            Main.panel.closeQuickSettings();
            this.openPreferences();
        }, 'preferences-system-symbolic');

        this._settings.connectObject('changed::dialog-monitor', () => this._updateDisplays(), this._tile);
        Main.layoutManager.connectObject('monitors-changed', () => this._updateDisplays(), this._tile);
        this._updateDisplays();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    _updateSubtitle() {
        this._tile.subtitle = this._settings.get_boolean('remember-windows')
            ? 'Remembering windows' : 'Window memory off';
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

    _updateDisplays() {
        this._dialogs.refresh();
        this._destinations.removeAll();
        this._chooseDisplay.menu.removeAll();
        const selected = this._settings.get_string('dialog-monitor');
        const add = (section, label, value) => {
            const item = section.addAction(label, () => this._settings.set_string('dialog-monitor', value));
            item.setOrnament(value === selected ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        };
        add(this._destinations, 'Centered on my main display', 'primary');
        add(this._destinations, 'Let Ubuntu decide', 'system');

        const displays = activeDisplays();
        for (const {name, connector} of displays) {
            const duplicateName = displays.some(other => other.name === name && other.connector !== connector);
            add(this._chooseDisplay.menu, duplicateName ? `${name} (${connector})` : name || connector, connector);
        }
        const specific = selected !== 'primary' && selected !== 'system';
        if (specific && !displays.some(display => display.connector === selected)) {
            const offline = new PopupMenu.PopupMenuItem(
                'Saved display disconnected · using main display', {reactive: false, can_focus: false});
            this._chooseDisplay.menu.addMenuItem(offline);
        }
        const selectedDisplay = displays.find(display => display.connector === selected);
        this._chooseDisplay.label.text = specific
            ? `Display: ${selectedDisplay?.name || selected}` : 'Choose a specific display…';
        this._chooseDisplay.setOrnament(specific ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    disable() {
        this._tile.menu.close(0);
        this._tile.menu.destroy();
        this._tile.destroy();
        this._indicator.destroy();
        this._dialogs.disable();
        this._placement.disable();
        this._chooseDisplay = this._destinations = null;
        this._tile = this._indicator = this._dialogs = this._placement = this._settings = null;
    }
}
