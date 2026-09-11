import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface RemoteOptions {
    enabled: boolean;
    currentFile: MediaFile | null;
    currentIndex: number;
    total: number;
    isPlaying: boolean;
    isFavorite: boolean;
    /** Slides guests have queued and not yet seen. */
    queued: number;
    /** The playable list, mirrored to main so guests can browse it. */
    library: MediaFile[];
    /** First opened folder — guest uploads land in <root>/guests. */
    root: string | null;
    onUploaded: (file: MediaFile) => void;
}

/**
 * The LAN phone remote: server lifecycle, the status feed it polls, the QR
 * code for joining, incoming emoji reactions, and guest uploads.
 */
export function useRemote({
    enabled, currentFile, currentIndex, total, isPlaying, isFavorite, queued, library, root, onUploaded,
}: RemoteOptions) {
    const [url, setUrl] = useState<string | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [reactions, setReactions] = useState<{ id: number; emoji: string; x: number }[]>([]);

    // Start/stop the server with the setting
    useEffect(() => {
        let cancelled = false;
        window.api.setRemoteEnabled(enabled)
            .then(next => { if (!cancelled) setUrl(next); })
            .catch(() => { if (!cancelled) setUrl(null); });
        return () => { cancelled = true; };
    }, [enabled]);

    // Feed the status the remote page polls. Skipped entirely while the
    // remote is off — there is nothing on the other end to read it.
    useEffect(() => {
        if (!enabled) return;
        window.api.sendRemoteStatus({
            name: currentFile?.name ?? null,
            index: currentFile ? currentIndex + 1 : null,
            total,
            playing: isPlaying,
            favorite: isFavorite,
            queued,
            // path/root stay in the main process for the thumbnail and upload
            // endpoints; they are stripped from anything sent to phones.
            path: currentFile?.path ?? null,
            root,
        });
    }, [enabled, currentFile, currentIndex, total, isPlaying, isFavorite, queued, root]);

    // Mirror the playable list so the remote's browse grid can offer it.
    // Only the list identity changes (a re-derive), not every slide.
    useEffect(() => {
        if (!enabled) return;
        window.api.sendRemoteLibrary(library);
    }, [enabled, library]);

    // QR code for the join URL, shown in settings
    useEffect(() => {
        if (!url) {
            setQr(null);
            return;
        }
        let cancelled = false;
        QRCode.toDataURL(url, { margin: 1, width: 180 })
            .then(data => { if (!cancelled) setQr(data); })
            .catch(() => { if (!cancelled) setQr(null); });
        return () => { cancelled = true; };
    }, [url]);

    // Emoji reactions float up over the show
    const reactionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
    useEffect(() => {
        return window.api.on('remote:reaction', (_event, emoji: string) => {
            const id = Date.now() + Math.random();
            setReactions(prev => [...prev.slice(-30), { id, emoji, x: 8 + Math.random() * 84 }]);
            const timer = setTimeout(() => {
                setReactions(prev => prev.filter(r => r.id !== id));
            }, 3000);
            reactionTimers.current.push(timer);
        });
    }, []);

    useEffect(() => () => {
        reactionTimers.current.forEach(clearTimeout);
        reactionTimers.current = [];
    }, []);

    // Held in a ref so a new callback identity doesn't tear down and
    // re-register the IPC listener on every render.
    const onUploadedRef = useRef(onUploaded);
    useEffect(() => { onUploadedRef.current = onUploaded; }, [onUploaded]);

    // Guest uploads join the running show
    useEffect(() => {
        return window.api.on('remote:uploaded', (_event, file: MediaFile) => {
            onUploadedRef.current(file);
        });
    }, []);

    const dismissReaction = useCallback((id: number) => {
        setReactions(prev => prev.filter(r => r.id !== id));
    }, []);

    return { url, qr, reactions, dismissReaction };
}
