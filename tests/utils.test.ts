import { describe, it, expect } from 'vitest';
import { getFileUrl, formatBytes } from '../src/utils';

describe('formatBytes', () => {
    it('formats each magnitude', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
        expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
    });
});

describe('getFileUrl', () => {
    it('builds a media:// URL with the local placeholder host', () => {
        expect(getFileUrl('/Users/me/pic.jpg')).toBe('media://local/Users/me/pic.jpg');
    });

    it('percent-encodes special characters per segment', () => {
        expect(getFileUrl('/Users/me/my photos/#1 pick.jpg'))
            .toBe('media://local/Users/me/my%20photos/%231%20pick.jpg');
    });

    it('handles Windows paths', () => {
        expect(getFileUrl('C:\\Users\\me\\pic.jpg')).toBe('media://local/C%3A/Users/me/pic.jpg');
    });

    it('round-trips through URL parsing without host-swallowing', () => {
        const url = new URL(getFileUrl('/Users/me/pic.jpg'));
        expect(url.host).toBe('local');
        expect(decodeURIComponent(url.pathname)).toBe('/Users/me/pic.jpg');
    });
});
