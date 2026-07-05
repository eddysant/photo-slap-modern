export function hammingDistance(a: string, b: string): number {
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) dist++;
    }
    return dist;
}

/**
 * Group perceptually-similar images by hash distance, transitively:
 * if A~B and B~C, all three land in one group even when A and C are just
 * over the threshold apart (union-find over all close pairs).
 */
export function groupSimilar(
    hashes: { path: string; hash: string }[],
    threshold: number,
): string[][] {
    const parent = hashes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    for (let i = 0; i < hashes.length; i++) {
        for (let j = i + 1; j < hashes.length; j++) {
            if (hammingDistance(hashes[i].hash, hashes[j].hash) <= threshold) union(i, j);
        }
    }

    const groups = new Map<number, string[]>();
    hashes.forEach((h, i) => {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root)!.push(h.path);
    });

    return [...groups.values()].filter(g => g.length > 1);
}
