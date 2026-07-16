import { useEffect, useState } from 'react';
import { FiHeart } from 'react-icons/fi';

interface FrameOverlayProps {
    fileName: string;
    /** Date the photo was taken (ms), if known. */
    dateTaken?: number | null;
    tags: string[];
    favorite: boolean;
}

/**
 * Ambient "photo frame" overlay: a clock and date for wall-screen use,
 * plus the current photo's capture date and tags.
 */
export function FrameOverlay({ fileName, dateTaken, tags, favorite }: FrameOverlayProps) {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 10_000);
        return () => clearInterval(timer);
    }, []);

    const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const taken = dateTaken
        ? new Date(dateTaken).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
        : null;

    return (
        <div className="frame-overlay">
            <div className="frame-clock">{time}</div>
            <div className="frame-date">{date}</div>
            <div className="frame-photo-info">
                {favorite && <FiHeart className="frame-heart" />}
                <span title={fileName}>{taken ?? fileName}</span>
                {tags.length > 0 && <span className="frame-tags">{tags.join(' · ')}</span>}
            </div>
        </div>
    );
}
