import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { splitKnown, inScanOrder, withStamps, scanStatus } from '../src/hashReuse';
import { groupSimilar } from '../src/similarity';

const paths = ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'];
const hashOf: Record<string, string> = {
    '/a.jpg': 'f'.repeat(64), '/b.jpg': 'f'.repeat(64), '/c.jpg': '0'.repeat(64), '/d.jpg': 'f'.repeat(63) + 'e',
};

describe('splitting a scan into remembered and still-to-do', () => {
    it('keeps the scan order in both halves', () => {
        const { cached, missing } = splitKnown(paths, { '/d.jpg': 'dd', '/b.jpg': 'bb' });
        expect(cached).toEqual([{ path: '/b.jpg', hash: 'bb' }, { path: '/d.jpg', hash: 'dd' }]);
        expect(missing).toEqual(['/a.jpg', '/c.jpg']);
    });

    it('ignores remembered hashes for files this scan did not list', () => {
        expect(splitKnown(['/a.jpg'], { '/elsewhere.jpg': 'ee' })).toEqual({ cached: [], missing: ['/a.jpg'] });
    });
});

describe('putting the hashes back together', () => {
    const all = paths.map(p => ({ path: p, hash: hashOf[p] }));

    it('restores scan order whatever order they arrive in', () => {
        expect(inScanOrder(paths, [...all].reverse())).toEqual(all);
    });

    it('leaves out a file that produced no hash', () => {
        expect(inScanOrder(paths, all.filter(h => h.path !== '/b.jpg')).map(h => h.path))
            .toEqual(['/a.jpg', '/c.jpg', '/d.jpg']);
    });

    /*
     * The reason this module exists. The review keeps a group's first file
     * by default, so which hashes happened to be cached must not be able to
     * move a file to the front.
     */
    it('gives the grouping the same list — and so the same keepers — however much was cached', () => {
        const fresh = groupSimilar(all, 4);
        for (const cachedPaths of [[], ['/d.jpg'], ['/b.jpg', '/d.jpg'], paths]) {
            const known = Object.fromEntries(cachedPaths.map(p => [p, hashOf[p]]));
            const { cached, missing } = splitKnown(paths, known);
            const hashedNow = missing.map(p => ({ path: p, hash: hashOf[p] }));
            const rejoined = inScanOrder(paths, [...cached, ...hashedNow]);
            expect(rejoined).toEqual(all);
            expect(groupSimilar(rejoined, 4)).toEqual(fresh);
        }
        // and the check is not vacuous: order does change the keeper
        expect(groupSimilar([...all].reverse(), 4)).not.toEqual(fresh);
    });
});

describe('attaching stamps', () => {
    it('pairs each hash with the stamp its file had when the scan began', () => {
        expect(withStamps([{ path: '/a.jpg', hash: 'aa' }], { '/a.jpg': '10:1' }))
            .toEqual([{ path: '/a.jpg', stamp: '10:1', hash: 'aa' }]);
    });

    it('drops a hash with nothing to hold it against', () => {
        expect(withStamps([{ path: '/a.jpg', hash: 'aa' }, { path: '/b.jpg', hash: 'bb' }], { '/b.jpg': '1:1' }))
            .toEqual([{ path: '/b.jpg', stamp: '1:1', hash: 'bb' }]);
    });
});

describe('what the scan says it is doing', () => {
    it('says nothing about reuse when there was none', () => {
        expect(scanStatus(12, 0)).toBe('Processing 12 files...');
        expect(scanStatus(1, 0)).toBe('Processing 1 file...');
    });

    it('says why there is less to do', () => {
        expect(scanStatus(3, 40)).toBe('Processing 3 files (40 already hashed in an earlier scan)...');
    });

    it('says why there is nothing to do', () => {
        expect(scanStatus(0, 40)).toBe('All 40 files already hashed in an earlier scan...');
    });
});

/*
 * Drift guard: the modal has to ask before it hashes and store what it
 * computes, in both places a hash is made, or the cache is decoration.
 */
describe('the duplicate scan uses the hash cache', () => {
    const modal = fs.readFileSync(path.join(import.meta.dirname, '../src/components/DedupeModal.tsx'), 'utf8');
    const worker = fs.readFileSync(path.join(import.meta.dirname, '../src/workers/phashWorker.ts'), 'utf8');

    it('asks what is already known before hashing anything', () => {
        const ask = modal.indexOf('getCachedHashes(');
        const spawn = modal.indexOf('new Worker(');
        expect(ask).toBeGreaterThan(-1);
        expect(spawn).toBeGreaterThan(ask);
    });

    it('hands only the missing images to the worker', () => {
        expect(modal).toMatch(/postMessage\(\{\s*paths:\s*img\.missing\s*\}/);
    });

    it('stores image hashes as batches arrive and video hashes as each is made', () => {
        // one door to the cache, used from both places a hash is made
        expect(modal.match(/putCachedHashes\(/g)).toHaveLength(1);
        expect(modal).toMatch(/type === 'hashes'[\s\S]{0,300}remember\(e\.data\.hashes\)/);
        expect(modal).toMatch(/hashVideoFrame\([\s\S]{0,300}remember\(\[entry\]\)/);
    });

    it('groups from the scan-ordered list', () => {
        expect(modal).toMatch(/groupSimilar\(\s*inScanOrder\(/);
    });

    it('and the worker hands hashes over as it goes, not only at the end', () => {
        // posted, not merely declared in the message type
        expect(worker).toMatch(/post\(\{\s*type:\s*'hashes'/);
    });
});
