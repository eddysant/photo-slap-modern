export type CullingKeyAction = 'keep' | 'reject' | null;

export function cullingActionForKey(key: string): CullingKeyAction {
    if (key === 'Enter' || key.toLowerCase() === 'k') return 'keep';
    if (key.toLowerCase() === 'x') return 'reject';
    return null;
}
