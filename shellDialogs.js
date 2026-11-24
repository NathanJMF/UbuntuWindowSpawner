// GNOME Shell 50 sets the dialog's monitor just before announcing OPENING.
// Remember its choice so turning this rule off can restore an open dialog.
export class ShellDialogs {
    constructor(group, isDialog, states, targetIndex) {
        this.group = group;
        this.isDialog = isDialog;
        this.states = states;
        this.targetIndex = targetIndex;
        this.dialogs = new Map();
    }

    enable() {
        this.added = this.group.connect('child-added', (_group, dialog) => this.watch(dialog));
        this.removed = this.group.connect('child-removed', (_group, dialog) => this.unwatch(dialog));
        this.group.get_children().forEach(dialog => this.watch(dialog));
    }

    watch(dialog) {
        if (!this.isDialog(dialog) || this.dialogs.has(dialog))
            return;

        const record = {original: null};
        this.dialogs.set(dialog, record);
        record.signal = dialog.connect('notify::state', () => {
            if (dialog.state === this.states.OPENING) {
                record.original = null;
                this.apply(dialog, record);
            } else if (dialog.state === this.states.CLOSED) {
                record.original = null;
            }
        });
        this.apply(dialog, record);
    }

    apply(dialog, record) {
        if (dialog.state !== this.states.OPENING && dialog.state !== this.states.OPENED)
            return;

        const constraint = dialog._monitorConstraint;
        if (!constraint)
            return;

        const index = this.targetIndex();
        if (index === null) {
            this.restore(dialog, record);
        } else {
            record.original ??= {primary: constraint.primary, index: constraint.index};
            constraint.index = index;
        }
    }

    restore(dialog, record) {
        if (!record.original)
            return;
        const constraint = dialog._monitorConstraint;
        if (constraint) {
            if (record.original.primary)
                constraint.primary = true;
            else
                constraint.index = record.original.index;
        }
        record.original = null;
    }

    refresh() {
        for (const [dialog, record] of this.dialogs)
            this.apply(dialog, record);
    }

    unwatch(dialog) {
        const record = this.dialogs.get(dialog);
        if (record) {
            dialog.disconnect(record.signal);
            this.dialogs.delete(dialog);
        }
    }

    disable() {
        if (this.added)
            this.group.disconnect(this.added);
        if (this.removed)
            this.group.disconnect(this.removed);
        this.added = this.removed = 0;
        for (const [dialog, record] of this.dialogs) {
            this.restore(dialog, record);
            this.unwatch(dialog);
        }
    }
}
