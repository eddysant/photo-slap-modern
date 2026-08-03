import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuarantineManager } from '../src/components/QuarantineManager';

describe('quarantine manager', () => {
    it('exposes recovery, permanent deletion, export, and refresh actions', () => {
        const html = renderToStaticMarkup(
            <QuarantineManager roots={['/photos']} onBack={() => {}} onRestored={() => {}} />,
        );

        expect(html).toContain('Health report');
        expect(html).toContain('Restore selected');
        expect(html).toContain('Delete selected');
        expect(html).toContain('Export manifest');
        expect(html).toContain('Refresh quarantine');
        expect(html).toContain('Reading quarantine manifest');
    });
});
