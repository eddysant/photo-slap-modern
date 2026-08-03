import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IntroScreen } from '../src/components/IntroScreen';

describe('landing page actions', () => {
    it('uses the same size class for every primary landing action', () => {
        const html = renderToStaticMarkup(<IntroScreen
            isLoading={false}
            onOpenDirectory={() => {}}
            lastDirName="Pictures"
            onResume={() => {}}
            onOpenSettings={() => {}}
            onFindDuplicates={() => {}}
            onScanHealth={() => {}}
        />);
        expect((html.match(/intro-action-button/g) ?? [])).toHaveLength(4);
        expect(html).toContain('OPEN FOLDER');
        expect(html).toContain('LIBRARY HEALTH');
    });
});
