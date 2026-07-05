import { useRef, useEffect, useCallback } from 'react';

interface ZoomPanProps {
    /** Zoom/pan reset whenever this changes (use the file path). */
    resetKey: string;
    onZoomChange?: (zoomed: boolean) => void;
    children: React.ReactNode;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;

/**
 * Wheel-zoom toward the cursor, drag-pan while zoomed, double-click to
 * toggle. Transform state lives in refs and is applied straight to the DOM
 * so panning doesn't re-render the slide on every pointer move.
 */
export function ZoomPan({ resetKey, onZoomChange, children }: ZoomPanProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const state = useRef({ scale: 1, tx: 0, ty: 0 });
    const drag = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);
    const zoomedRef = useRef(false);

    const apply = useCallback(() => {
        const { scale, tx, ty } = state.current;
        const el = contentRef.current;
        if (el) {
            el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
            el.style.cursor = scale > 1 ? 'grab' : '';
        }
        const zoomed = scale > 1.001;
        if (zoomed !== zoomedRef.current) {
            zoomedRef.current = zoomed;
            onZoomChange?.(zoomed);
        }
    }, [onZoomChange]);

    // Keep the (container-sized) content covering the viewport
    const clampPan = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        const s = state.current;
        s.tx = Math.min(0, Math.max(el.clientWidth * (1 - s.scale), s.tx));
        s.ty = Math.min(0, Math.max(el.clientHeight * (1 - s.scale), s.ty));
    }, []);

    // Zoom keeping the point under (px, py) fixed. transform-origin is 0 0,
    // so the world point u maps to px = tx + scale * u.
    const zoomAt = useCallback((px: number, py: number, targetScale: number) => {
        const s = state.current;
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetScale));
        s.tx = px - (newScale / s.scale) * (px - s.tx);
        s.ty = py - (newScale / s.scale) * (py - s.ty);
        s.scale = newScale;
        clampPan();
        apply();
    }, [apply, clampPan]);

    // Reset on slide change
    useEffect(() => {
        state.current = { scale: 1, tx: 0, ty: 0 };
        apply();
    }, [resetKey, apply]);

    // Wheel zoom — attached manually so it can be non-passive (preventDefault)
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const factor = Math.exp(-e.deltaY * 0.0022);
            zoomAt(e.clientX - rect.left, e.clientY - rect.top, state.current.scale * factor);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [zoomAt]);

    const onPointerDown = (e: React.PointerEvent) => {
        if (state.current.scale <= 1) return;
        containerRef.current?.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startY: e.clientY, tx: state.current.tx, ty: state.current.ty };
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (!drag.current) return;
        state.current.tx = drag.current.tx + (e.clientX - drag.current.startX);
        state.current.ty = drag.current.ty + (e.clientY - drag.current.startY);
        clampPan();
        apply();
    };

    const endDrag = () => { drag.current = null; };

    const onDoubleClick = (e: React.MouseEvent) => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (state.current.scale > 1) {
            state.current = { scale: 1, tx: 0, ty: 0 };
            apply();
        } else {
            zoomAt(e.clientX - rect.left, e.clientY - rect.top, 2.5);
        }
    };

    return (
        <div
            ref={containerRef}
            className="zoom-pan"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
        >
            <div ref={contentRef} className="zoom-pan-content">
                {children}
            </div>
        </div>
    );
}
