import type { TargetAndTransition, Transition } from 'framer-motion';

export type TransitionStyle = 'fade' | 'slide' | 'zoom' | 'flip' | 'star';

// Classic 5-point star, as [x, y] percentages of the slide box.
const STAR_POINTS = [
    [50, 0], [61, 35], [98, 35], [68, 57], [79, 91],
    [50, 70], [21, 91], [32, 57], [2, 35], [39, 35],
];

// Star scaled around the center. scale 0 = collapsed to a point,
// scale 4 = big enough that the star's inner edges clear the screen corners.
const starPolygon = (scale: number) =>
    `polygon(${STAR_POINTS.map(([x, y]) => `${50 + (x - 50) * scale}% ${50 + (y - 50) * scale}%`).join(', ')})`;

interface SlideTransition {
    initial: TargetAndTransition;
    animate: TargetAndTransition;
    exit: TargetAndTransition;
    transition: Transition;
}

export const slideTransitions: Record<TransitionStyle, SlideTransition> = {
    fade: {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.3 },
    },
    slide: {
        initial: { x: '100%', opacity: 0 },
        animate: { x: 0, opacity: 1 },
        exit: { x: '-100%', opacity: 0 },
        transition: { type: 'tween', duration: 0.4, ease: 'easeInOut' },
    },
    zoom: {
        initial: { scale: 0.8, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        exit: { scale: 1.2, opacity: 0 },
        transition: { duration: 0.4 },
    },
    flip: {
        initial: { rotateY: 90, opacity: 0 },
        animate: { rotateY: 0, opacity: 1 },
        exit: { rotateY: -90, opacity: 0 },
        transition: { duration: 0.5 },
    },
    // Star wipe: the incoming slide is revealed through a growing star
    // while the outgoing slide stays fully visible underneath. Requires
    // AnimatePresence mode "sync" so both slides are mounted at once.
    // Do NOT add an opacity fade here — it degrades the wipe into a crossfade.
    star: {
        initial: { clipPath: starPolygon(0), zIndex: 2 },
        animate: { clipPath: starPolygon(4), zIndex: 2 },
        exit: {
            zIndex: 1,
            // Stay visible under the wipe, then disappear once fully covered.
            opacity: 0,
            transition: { duration: 0.01, delay: 0.65 },
        },
        transition: { duration: 0.6, ease: 'easeInOut' },
    },
};
