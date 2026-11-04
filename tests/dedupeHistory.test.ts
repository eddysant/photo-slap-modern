import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    MAX_DECISIONS, type DedupeHistory,
    fileStamp, isDecided, loadHistory, pairKey, prune, recordGroup, recordPair, undecidedFrom,
} from '../src/dedupeHistory';

const stat = (size: number, mtimeMs = 1000) => ({ size, mtimeMs });
const stats = (entries: Record<string, { size: number; mtimeMs: number }>) => entries;

describe('pairKey', () => {
    it('is the same whichever side the review puts a file on', () => {
        expect(pairKey('/a.jpg', '/b.jpg')).toBe(pairKey('/b.jpg', '/a.jpg'));
    });

    it('tells different pairs apart', () => {
        expect(pairKey('/a.jpg', '/b.jpg')).not.toBe(pairKey('/a.jpg', '/c.jpg'));
    });

    /**
     * The separator has to be a byte no path can contain, or two different
     * pairs could share a key and one decision would silently answer for the
     * other.
     */
    it('cannot be forged by a path that contains the separator', () => {
        expect(pairKey('/a', '/b\u0000/c')).not.toBe(pairKey('/a\u0000/b', '/c'));
    });
});

describe('isDecided', () => {
    it('says no about a pair never seen', () => {
        expect(isDecided({}, '/a.jpg', '/b.jpg')).toBe(false);
    });

    /**
     * Asked with real, *different* stamps on the two sides: the stored pair
     * remembers them in sorted order, so a lookup that paired them up by
     * argument order instead would compare each side's stamp against the
     * other file's and report an unchanged pair as changed.
     */
    it('says yes about a pair kept, whichever way round it is asked', () => {
        const seen = stats({ '/a.jpg': stat(100), '/b.jpg': stat(200) });
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept', seen);
        expect(isDecided(h, '/a.jpg', '/b.jpg', seen)).toBe(true);
        expect(isDecided(h, '/b.jpg', '/a.jpg', seen)).toBe(true);
    });

    /**
     * A skip and a keep-both suppress the same question. The verdict is still
     * stored, because "the app is not asking because you skipped it" and
     * "because you said keep both" are different facts about the user's
     * library, and only one of them is a judgement about the photos.
     */
    it('treats a skipped pair the same as a kept one', () => {
        expect(isDecided(recordPair({}, '/a.jpg', '/b.jpg', 'skipped'), '/a.jpg', '/b.jpg')).toBe(true);
    });

    it('does not answer for a different pair', () => {
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept');
        expect(isDecided(h, '/a.jpg', '/c.jpg')).toBe(false);
    });

    /**
     * The decision was about the files as the user saw them. Edit one and the
     * pair is a different question — most pointedly, edit one of two photos
     * you kept apart and they may now actually be the same photo.
     */
    it('asks again when a file has changed since', () => {
        const before = stats({ '/a.jpg': stat(100), '/b.jpg': stat(200) });
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept', before);
        expect(isDecided(h, '/a.jpg', '/b.jpg', before)).toBe(true);
        expect(isDecided(h, '/a.jpg', '/b.jpg', stats({ '/a.jpg': stat(100), '/b.jpg': stat(222) }))).toBe(false);
    });

    it('notices a file rewritten to the same length', () => {
        const before = stats({ '/a.jpg': stat(100, 1000), '/b.jpg': stat(200, 1000) });
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept', before);
        const touched = stats({ '/a.jpg': stat(100, 9999), '/b.jpg': stat(200, 1000) });
        expect(isDecided(h, '/a.jpg', '/b.jpg', touched)).toBe(false);
    });

    /**
     * An unknown stamp cannot contradict anything, so it does not. The
     * alternative is re-asking about a pair because `files:getInfo` happened
     * to miss a file — nagging on the strength of no evidence at all.
     */
    it('honours a decision when the stamps are not known', () => {
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept');
        expect(isDecided(h, '/a.jpg', '/b.jpg', stats({ '/a.jpg': stat(100) }))).toBe(true);
        const withStamps = recordPair({}, '/a.jpg', '/b.jpg', 'kept', stats({ '/a.jpg': stat(100), '/b.jpg': stat(200) }));
        expect(isDecided(withStamps, '/a.jpg', '/b.jpg')).toBe(true);
    });

    it('checks the stamp against the right side of the pair', () => {
        // '/b.jpg' sorts second, so a swap of the two stamps must not pass.
        const before = stats({ '/a.jpg': stat(100), '/b.jpg': stat(200) });
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept', before);
        expect(isDecided(h, '/a.jpg', '/b.jpg', stats({ '/a.jpg': stat(200), '/b.jpg': stat(100) }))).toBe(false);
    });
});

describe('fileStamp', () => {
    it('is empty for a file nothing could stat', () => {
        expect(fileStamp(undefined)).toBe('');
    });

    it('covers both size and mtime', () => {
        expect(fileStamp(stat(100, 5))).not.toBe(fileStamp(stat(100, 6)));
        expect(fileStamp(stat(100, 5))).not.toBe(fileStamp(stat(101, 5)));
    });
});

describe('recordGroup', () => {
    /**
     * The review walks a group pairwise. Recording only the pair on screen
     * left a three-file group asking about its third file on the next scan,
     * which is not what skipping it looked like.
     */
    it('settles every pair in the group, not just the one on screen', () => {
        const h = recordGroup({}, ['/a.jpg', '/b.jpg', '/c.jpg'], 'skipped');
        expect(Object.keys(h).length).toBe(3);
        expect(isDecided(h, '/a.jpg', '/b.jpg')).toBe(true);
        expect(isDecided(h, '/a.jpg', '/c.jpg')).toBe(true);
        expect(isDecided(h, '/b.jpg', '/c.jpg')).toBe(true);
    });

    it('and so the group never comes back', () => {
        const files = ['/a.jpg', '/b.jpg', '/c.jpg'];
        expect(undecidedFrom(files, recordGroup({}, files, 'skipped'))).toBeNull();
    });

    it('records nothing for a group of one', () => {
        expect(recordGroup({}, ['/a.jpg'], 'skipped')).toEqual({});
    });

    it('leaves other decisions alone', () => {
        const h = recordPair({}, '/x.jpg', '/y.jpg', 'kept');
        expect(isDecided(recordGroup(h, ['/a.jpg', '/b.jpg'], 'skipped'), '/x.jpg', '/y.jpg')).toBe(true);
    });
});

describe('undecidedFrom', () => {
    it('hands back a wholly undecided group unchanged', () => {
        const files = ['/a.jpg', '/b.jpg', '/c.jpg'];
        expect(undecidedFrom(files, {})).toEqual(files);
    });

    /**
     * Dropped exactly the way "Keep Both" drops a challenger — the keeper
     * stays and faces the next file. A second rule here could disagree with
     * the live review about which file survives.
     */
    it('drops a decided challenger and keeps the keeper facing the rest', () => {
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept');
        expect(undecidedFrom(['/a.jpg', '/b.jpg', '/c.jpg'], h)).toEqual(['/a.jpg', '/c.jpg']);
    });

    it('walks past several decided challengers in a row', () => {
        let h = recordPair({}, '/a.jpg', '/b.jpg', 'kept');
        h = recordPair(h, '/a.jpg', '/c.jpg', 'skipped');
        expect(undecidedFrom(['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'], h)).toEqual(['/a.jpg', '/d.jpg']);
    });

    it('returns null when the keeper has answered for everyone', () => {
        let h = recordPair({}, '/a.jpg', '/b.jpg', 'kept');
        h = recordPair(h, '/a.jpg', '/c.jpg', 'kept');
        expect(undecidedFrom(['/a.jpg', '/b.jpg', '/c.jpg'], h)).toBeNull();
    });

    /**
     * A decision between two challengers is not an answer to the question the
     * review is about to ask, which is always keeper-versus-challenger.
     */
    it('does not treat a decision between two challengers as an answer', () => {
        const h = recordPair({}, '/b.jpg', '/c.jpg', 'kept');
        expect(undecidedFrom(['/a.jpg', '/b.jpg', '/c.jpg'], h)).toEqual(['/a.jpg', '/b.jpg', '/c.jpg']);
    });

    it('returns null for a group that cannot be compared at all', () => {
        expect(undecidedFrom(['/a.jpg'], {})).toBeNull();
        expect(undecidedFrom([], {})).toBeNull();
    });

    it('asks again about a pair whose file has changed', () => {
        const before = stats({ '/a.jpg': stat(100), '/b.jpg': stat(200) });
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept', before);
        const now = stats({ '/a.jpg': stat(100), '/b.jpg': stat(300) });
        expect(undecidedFrom(['/a.jpg', '/b.jpg'], h, now)).toEqual(['/a.jpg', '/b.jpg']);
    });
});

describe('prune', () => {
    const many = (n: number): DedupeHistory => {
        const h: DedupeHistory = {};
        for (let i = 0; i < n; i++) h[`k${i}`] = { verdict: 'kept', at: i, stamps: ['', ''] };
        return h;
    };

    it('leaves a history under the cap alone', () => {
        const h = many(10);
        expect(prune(h, 10)).toBe(h);
    });

    it('drops the oldest decisions first', () => {
        const kept = prune(many(5), 2);
        expect(Object.keys(kept).sort()).toEqual(['k3', 'k4']);
    });

    it('is applied by the recording functions', () => {
        expect(Object.keys(recordPair(many(MAX_DECISIONS), '/a.jpg', '/b.jpg', 'kept')).length)
            .toBe(MAX_DECISIONS);
        expect(Object.keys(recordGroup(many(MAX_DECISIONS), ['/a.jpg', '/b.jpg', '/c.jpg'], 'skipped')).length)
            .toBe(MAX_DECISIONS);
    });

    /** The newest decision is the one the user just made. */
    it('keeps the decision that caused the overflow', () => {
        const h = recordPair(many(MAX_DECISIONS), '/a.jpg', '/b.jpg', 'kept');
        expect(isDecided(h, '/a.jpg', '/b.jpg')).toBe(true);
    });
});

describe('loadHistory', () => {
    it('survives an empty store', () => {
        expect(loadHistory(undefined)).toEqual({});
        expect(loadHistory(null)).toEqual({});
        expect(loadHistory('nonsense')).toEqual({});
    });

    it('round-trips what was saved', () => {
        const h = recordPair({}, '/a.jpg', '/b.jpg', 'kept', stats({ '/a.jpg': stat(1), '/b.jpg': stat(2) }));
        expect(loadHistory(JSON.parse(JSON.stringify(h)))).toEqual(h);
    });

    it('drops entries it cannot make sense of rather than trusting them', () => {
        const loaded = loadHistory({
            good: { verdict: 'kept', at: 5, stamps: ['1:2', '3:4'] },
            noVerdict: { at: 5, stamps: ['', ''] },
            wrongVerdict: { verdict: 'maybe', at: 5, stamps: ['', ''] },
            notAnObject: 7,
        });
        expect(Object.keys(loaded)).toEqual(['good']);
    });

    it('fills in fields an older or damaged entry is missing', () => {
        const loaded = loadHistory({ k: { verdict: 'skipped' } });
        expect(loaded.k).toEqual({ verdict: 'skipped', at: 0, stamps: ['', ''] });
    });
});

/**
 * Reads the source. The history is only worth anything if the review consults
 * it in both places a pair can come up — the groups a scan found, and the
 * remainder of a group after a deletion — and if every non-destructive answer
 * is written down. A decision the app forgets to record is worse than no
 * history at all, because the user believes it was remembered.
 */
describe('the review actually consults and feeds the history', () => {
    const source = fs.readFileSync(
        path.join(import.meta.dirname, '../src/components/DedupeModal.tsx'), 'utf8');

    it('filters the groups a scan found', () => {
        const body = source.slice(source.indexOf('const enterReview'), source.indexOf('const hashVideoFrame'));
        expect(body).toMatch(/undecidedFrom\(group\.files, historyRef\.current/);
    });

    it('filters the remainder of a group after a deletion', () => {
        const body = source.slice(source.indexOf('const resolveConflict'));
        expect(body).toMatch(/undecidedFrom\(remaining, historyRef\.current/);
    });

    it('records keep-both as a pair and skip as the whole group', () => {
        const body = source.slice(source.indexOf('const resolveConflict'));
        expect(body).toMatch(/recordGroup\(historyRef\.current, groupFiles, 'skipped'/);
        expect(body).toMatch(/recordPair\(historyRef\.current, leftImage, rightImage, 'kept'/);
    });

    /**
     * Both record sites go through `saveHistory`, which is the only thing
     * that writes to the store — a decision kept only in the ref is forgotten
     * the moment the modal closes, and nothing on screen would say so.
     */
    it('persists every decision it records', () => {
        const records = [...source.matchAll(/record(?:Pair|Group)\(/g)];
        expect(records.length).toBe(2);
        for (const m of records) {
            expect(source.slice(Math.max(0, m.index - 40), m.index)).toContain('saveHistory(');
        }
        expect(source).toMatch(/setStore\('dedupeDecisions'/);
        expect((source.match(/setStore\(/g) ?? []).length).toBe(1);
    });

    /** A scan that found sixteen groups and shows four has to say so. */
    it('tells the user how many groups it did not ask about', () => {
        expect(source).toMatch(/setSuppressed\(found\.length - open\.length\)/);
        expect(source).toMatch(/suppressed > 0/);
    });

    it('offers a way to forget', () => {
        expect(source).toMatch(/saveHistory\(\{\}\)/);
    });

    /**
     * Not about the history, but about the same review's other promise — to
     * report the files it could not trash. `file:delete` answers with
     * `{ ok, reason? }`, and an object is always truthy: `if (ok)` counted
     * every refusal as a success, so the final screen's count of files the
     * Trash would not take was permanently zero.
     */
    it('reads the trash outcome rather than its truthiness', () => {
        const body = source.slice(source.indexOf('const deleteFile'), source.indexOf('const resolveConflict'));
        expect(body).toMatch(/await window\.api\.deleteFile\(path\)/);
        expect(body).toMatch(/if \(outcome\.ok\)/);
        expect(body).toMatch(/return outcome\.ok;/);
    });
});
