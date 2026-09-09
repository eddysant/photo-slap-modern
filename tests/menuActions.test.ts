import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

/** Every action(label, accel, name) entry in the Actions menu. */
const menuItems = [...mainSource.matchAll(/action\('([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g)]
    .map(([, label, accelerator, name]) => ({ label, accelerator, name }));

/** Keys of the `actions` record the renderer dispatches menu:action through. */
const handlerNames = new Set(
    [...appSource.matchAll(/^\s*'([a-z-]+)':\s/gm)].map(m => m[1]),
);

describe('Actions menu', () => {
    it('is not empty (the source scrape still works)', () => {
        expect(menuItems.length).toBeGreaterThan(10);
    });

    it('has a renderer handler for every menu item', () => {
        const orphans = menuItems.filter(item => !handlerNames.has(item.name));
        expect(orphans.map(o => `${o.label} -> ${o.name}`)).toEqual([]);
    });

    it('never registers its accelerators — the renderer owns the keys', () => {
        // Registering Space/letter accelerators would swallow them from inputs
        const actionHelper = /const action = \([^)]*\)[^=]*=> \(\{[\s\S]*?\}\);/.exec(mainSource);
        expect(actionHelper?.[0]).toContain('registerAccelerator: false');
    });
});

describe('culling menu items are non-destructive', () => {
    const cullingItems = menuItems.filter(item => item.label.startsWith('Culling:'));

    it('offers both a keep and a reject item', () => {
        expect(cullingItems).toHaveLength(2);
    });

    it('routes them to the culling actions, not to delete', () => {
        // Regression: these used to dispatch 'next' and 'delete', so the menu
        // item labelled "reject" trashed the file while the X key it claimed
        // to mirror only recorded a decision in the sidecar.
        expect(cullingItems.map(i => i.name).sort()).toEqual(['culling-keep', 'culling-reject']);
    });

    it('does not describe rejection as trashing', () => {
        expect(cullingItems.some(i => /trash/i.test(i.label))).toBe(false);
    });

    it('keeps exactly one genuinely destructive item, clearly labelled', () => {
        const destructive = menuItems.filter(i => i.name === 'delete');
        expect(destructive).toHaveLength(1);
        expect(destructive[0].label).toMatch(/trash/i);
    });
});
