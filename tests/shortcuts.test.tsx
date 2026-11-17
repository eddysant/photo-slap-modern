import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShortcutsOverlay } from '../src/components/ShortcutsOverlay';
import { SHORTCUTS, SHORTCUT_GROUPS, isUndoChord, shortcutsByGroup } from '../src/shortcuts';
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
                // ⌘Z is a chord, checked by isUndoChord before the switch.
                if (key === '⌘Z' && /if \(isUndoChord\(e\)\) \{[\s\S]{0,80}undoLastDelete\(\)/.test(appSource)) continue;
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

describe('the undo chord', () => {
    const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) =>
        ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

    it('is ⌘Z, and Ctrl+Z off the Mac', () => {
        expect(isUndoChord(key('z', { metaKey: true }))).toBe(true);
        expect(isUndoChord(key('z', { ctrlKey: true }))).toBe(true);
        // Caps Lock reports the capital
        expect(isUndoChord(key('Z', { metaKey: true }))).toBe(true);
    });

    it('is not a bare Z, nor redo, nor another chord', () => {
        expect(isUndoChord(key('z'))).toBe(false);
        expect(isUndoChord(key('z', { metaKey: true, shiftKey: true }))).toBe(false);
        expect(isUndoChord(key('z', { metaKey: true, altKey: true }))).toBe(false);
        expect(isUndoChord(key('x', { metaKey: true }))).toBe(false);
    });

    it('is checked after the form-control rule, so a text field keeps its own undo', () => {
        const formRule = appSource.indexOf("['INPUT', 'SELECT', 'TEXTAREA'].includes");
        const chord = appSource.indexOf('if (isUndoChord(e))');
        const modifierRule = appSource.indexOf('if (e.metaKey || e.ctrlKey || e.altKey) return;');
        expect(formRule).toBeGreaterThan(-1);
        expect(chord).toBeGreaterThan(formRule);
        expect(modifierRule).toBeGreaterThan(chord);
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
