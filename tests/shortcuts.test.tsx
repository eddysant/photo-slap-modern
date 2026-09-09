import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShortcutsOverlay } from '../src/components/ShortcutsOverlay';
import { SHORTCUTS, SHORTCUT_GROUPS, shortcutsByGroup } from '../src/shortcuts';
import { cullingActionForKey } from '../src/culling';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

/** Keys the App's keydown switch actually handles. */
const handledCases = new Set(
    [...appSource.matchAll(/case '([^']+)':/g)].map(m => m[1]),
);

/** Displayed key -> the KeyboardEvent.key the handler switches on. */
const KEY_TO_EVENT: Record<string, string> = {
    '←': 'ArrowLeft', '→': 'ArrowRight', 'Space': ' ', 'Esc': 'Escape',
    'Del': 'Delete', 'Backspace': 'Backspace', '?': '?',
    'H': 'h', 'T': 't', 'M': 'm', 'N': 'n', 'G': 'g', 'P': 'p', 'F': 'f',
    '1': '1', '2': '2', '3': '3',
};

describe('documented shortcuts match the handler', () => {
    it('every documented key is either a switch case or a culling key', () => {
        const undocumented: string[] = [];
        for (const shortcut of SHORTCUTS) {
            for (const key of shortcut.keys) {
                const eventKey = KEY_TO_EVENT[key];
                if (eventKey && handledCases.has(eventKey)) continue;
                // K / Enter / X are routed through cullingActionForKey rather
                // than the switch, so they never appear as a case.
                if (cullingActionForKey(key) !== null) continue;
                undocumented.push(`${shortcut.label}: ${key}`);
            }
        }
        expect(undocumented).toEqual([]);
    });

    it('lists the culling keys that the culling handler recognises', () => {
        expect(cullingActionForKey('k')).toBe('keep');
        expect(cullingActionForKey('Enter')).toBe('keep');
        expect(cullingActionForKey('x')).toBe('reject');
    });

    it('assigns every shortcut to a rendered group', () => {
        expect(SHORTCUTS.every(s => SHORTCUT_GROUPS.includes(s.group))).toBe(true);
        expect(SHORTCUT_GROUPS.every(g => shortcutsByGroup(g).length > 0)).toBe(true);
    });

    it('has no duplicate labels', () => {
        expect(new Set(SHORTCUTS.map(s => s.label)).size).toBe(SHORTCUTS.length);
    });
});

describe('ShortcutsOverlay', () => {
    const html = renderToStaticMarkup(<ShortcutsOverlay onClose={() => {}} />);

    const escape = (text: string) => text.replace(/&/g, '&amp;');

    it('renders every shortcut', () => {
        for (const shortcut of SHORTCUTS) {
            expect(html).toContain(escape(shortcut.label));
            for (const key of shortcut.keys) expect(html).toContain(`<kbd>${key}</kbd>`);
        }
    });

    it('renders each group heading', () => {
        for (const group of SHORTCUT_GROUPS) {
            expect(html).toContain(`>${group}<`);
        }
    });

    it('is announced as a dialog', () => {
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="true"');
    });

    it('tells the user delete can be undone', () => {
        expect(html).toContain('undoable');
    });
});
