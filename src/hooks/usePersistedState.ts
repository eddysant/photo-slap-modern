import { useState, useEffect, useCallback } from 'react';

/**
 * Like useState, but hydrates from electron-store on mount and writes every
 * update back, so the value survives app restarts.
 */
export function usePersistedState<T>(key: string, initialValue: T) {
    const [value, setValue] = useState<T>(initialValue);

    useEffect(() => {
        let cancelled = false;
        window.api.getStore(key)
            .then(stored => {
                if (!cancelled && stored !== undefined) setValue(stored as T);
            })
            .catch(e => console.error(`Failed to load setting "${key}":`, e));
        return () => { cancelled = true; };
    }, [key]);

    const setAndPersist = useCallback((next: T) => {
        setValue(next);
        window.api.setStore(key, next);
    }, [key]);

    return [value, setAndPersist] as const;
}
