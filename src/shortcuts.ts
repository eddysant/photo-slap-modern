/**
 * The single list of keyboard shortcuts, used by the `?` help overlay.
 * Keeping it beside the keydown handler means the documented keys and the
 * handled keys can be checked against each other in a test.
 */

export interface Shortcut {
    keys: string[];
    label: string;
    group: ShortcutGroup;
}

export type ShortcutGroup = 'Navigate' | 'Organize' | 'Video' | 'Windows';

export const SHORTCUTS: Shortcut[] = [
    { keys: ['←', '→'], label: 'Previous / next slide', group: 'Navigate' },
    { keys: ['Space'], label: 'Play / pause slideshow', group: 'Navigate' },
    { keys: ['?'], label: 'Show this list', group: 'Navigate' },
    { keys: ['Esc'], label: 'Close any open panel', group: 'Navigate' },

    { keys: ['H'], label: 'Toggle favorite', group: 'Organize' },
    { keys: ['T'], label: 'Edit tags', group: 'Organize' },
    { keys: ['K', 'Enter'], label: 'Culling: keep & next', group: 'Organize' },
    { keys: ['X'], label: 'Culling: reject & next', group: 'Organize' },
    { keys: ['1', '2', '3'], label: 'Quick-move to folder 1–3', group: 'Organize' },
    { keys: ['Del', 'Backspace'], label: 'Move to Trash (undoable)', group: 'Organize' },

    { keys: ['M'], label: 'Skip forward 10s', group: 'Video' },
    { keys: ['N'], label: 'Skip back 10s', group: 'Video' },

    { keys: ['G'], label: 'Grid view', group: 'Windows' },
    { keys: ['P'], label: 'Photo frame overlay', group: 'Windows' },
    { keys: ['F'], label: 'Reveal in Finder', group: 'Windows' },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['Navigate', 'Organize', 'Video', 'Windows'];

export function shortcutsByGroup(group: ShortcutGroup): Shortcut[] {
    return SHORTCUTS.filter(s => s.group === group);
}
