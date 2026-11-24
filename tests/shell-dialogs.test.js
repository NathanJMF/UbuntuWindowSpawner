import {ShellDialogs} from '../shellDialogs.js';

function assert(ok, message) {
    if (!ok)
        throw new Error(message);
}

class Signals {
    signals = new Map();

    connect(name, handler) {
        const id = Symbol();
        this.signals.set(id, {name, handler});
        return id;
    }

    disconnect(id) {
        assert(this.signals.delete(id), 'Signal disconnected twice');
    }

    emit(name, ...args) {
        for (const signal of this.signals.values()) {
            if (signal.name === name)
                signal.handler(this, ...args);
        }
    }
}

const states = {OPENING: 0, OPENED: 1, CLOSED: 2};
const group = new Signals();
const dialog = new Signals();
dialog.state = states.CLOSED;
const existing = new Signals();
existing.state = states.OPENED;
existing._monitorConstraint = {index: 2, primary: false};
group.get_children = () => [existing];
let target = 0;
const controller = new ShellDialogs(group, actor => actor === dialog || actor === existing,
    states, () => target);
controller.enable();
assert(existing._monitorConstraint.index === 0, 'Already-open dialog was skipped');

group.emit('child-added', dialog);
const other = new Signals();
group.emit('child-added', other);
assert(other.signals.size === 0, 'Unrelated actor was observed');
dialog._monitorConstraint = {index: 1, primary: false};
dialog.state = states.OPENING;
dialog.emit('notify::state');
assert(dialog._monitorConstraint.index === 0, 'Dialog did not open on the selected monitor');

dialog.state = states.OPENED;
target = 2;
controller.refresh();
assert(dialog._monitorConstraint.index === 2, 'Open dialog ignored changed monitor');
target = null;
controller.refresh();
assert(dialog._monitorConstraint.index === 1, 'System default did not restore original monitor');

target = 0;
controller.refresh();
dialog.state = states.CLOSED;
dialog.emit('notify::state');
dialog._monitorConstraint.index = 3;
dialog.state = states.OPENING;
dialog.emit('notify::state');
assert(dialog._monitorConstraint.index === 0, 'Reopened dialog lost placement rule');
group.emit('child-removed', existing);
assert(existing.signals.size === 0, 'Removed dialog still has a listener');
controller.disable();
assert(dialog._monitorConstraint.index === 3, 'Disable used an earlier opening’s monitor');
assert(dialog.signals.size === 0 && group.signals.size === 0, 'Disable leaked signal handlers');
print('Shell dialog placement and cleanup passed');
