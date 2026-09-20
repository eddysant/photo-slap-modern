import type { Variants, Transition } from 'framer-motion';

export type TransitionStyle = 'fade' | 'slide' | 'zoom' | 'flip' | 'star' | 'crt' | 'random';

/** The concrete styles — everything `random` can actually pick from. */
export type ConcreteTransitionStyle = Exclude<TransitionStyle, 'random'>;

// Classic 5-point star, as [x, y] percentages of the slide box.
const STAR_POINTS = [
    [50, 0], [61, 35], [98, 35], [68, 57], [79, 91],
    [50, 70], [21, 91], [32, 57], [2, 35], [39, 35],
];

// Star scaled around the center. scale 0 = collapsed to a point,
// scale 4 = big enough that the star's inner edges clear the screen corners.
export const starPolygon = (scale: number) =>
    `polygon(${STAR_POINTS.map(([x, y]) => `${50 + (x - 50) * scale}% ${50 + (y - 50) * scale}%`).join(', ')})`;

export interface SlideTransition {
    variants: Variants;
    transition: Transition;
}

/**
 * Slide transitions as framer-motion variants. The `custom` value is the
 * navigation direction (1 = forward, -1 = backward); directional styles are
 * mirrored when going back. Passing direction through AnimatePresence's
 * `custom` prop (not baked into the exit prop at render time) is what keeps
 * the *outgoing* slide's exit correct when the direction just changed.
 */
export const slideTransitions: Record<ConcreteTransitionStyle, SlideTransition> = {
    fade: {
        variants: {
            enter: { opacity: 0 },
            center: { opacity: 1 },
            exit: { opacity: 0 },
        },
        transition: { duration: 0.3 },
    },
    slide: {
        variants: {
            enter: (dir: number) => ({ x: dir >= 0 ? '100%' : '-100%', opacity: 0 }),
            center: { x: 0, opacity: 1 },
            exit: (dir: number) => ({ x: dir >= 0 ? '-100%' : '100%', opacity: 0 }),
        },
        transition: { type: 'tween', duration: 0.4, ease: 'easeInOut' },
    },
    zoom: {
        variants: {
            enter: (dir: number) => ({ scale: dir >= 0 ? 0.8 : 1.2, opacity: 0 }),
            center: { scale: 1, opacity: 1 },
            exit: (dir: number) => ({ scale: dir >= 0 ? 1.2 : 0.8, opacity: 0 }),
        },
        transition: { duration: 0.4 },
    },
    flip: {
        variants: {
            enter: (dir: number) => ({ rotateY: dir >= 0 ? 90 : -90, opacity: 0 }),
            center: { rotateY: 0, opacity: 1 },
            exit: (dir: number) => ({ rotateY: dir >= 0 ? -90 : 90, opacity: 0 }),
        },
        transition: { duration: 0.5 },
    },
    /*
     * CRT power-on: the slide collapses to a horizontal line and snaps back
     * out, overshooting sideways the way an old tube did. Not directional — a
     * tube doesn't care which way you navigated.
     */
    crt: {
        variants: {
            enter: { scaleY: 0.004, scaleX: 1.4, opacity: 1, boxShadow: '0px 0px 70px 30px rgba(255,255,255,0.9)' },
            center: { scaleY: 1, scaleX: 1, opacity: 1, boxShadow: '0px 0px 0px 0px rgba(255,255,255,0)' },
            exit: { scaleY: 0.004, scaleX: 1.4, opacity: 0, boxShadow: '0px 0px 70px 30px rgba(255,255,255,0.9)' },
        },
        transition: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
    },
    // Star wipe: the incoming slide is revealed through a growing star
    // while the outgoing slide stays fully visible underneath. Requires
    // AnimatePresence mode "sync" so both slides are mounted at once.
    // Do NOT add an opacity fade to enter/center — it degrades the wipe
    // into a crossfade. Not directional (a star grows the same both ways).
    star: {
        variants: {
            enter: { clipPath: starPolygon(0), zIndex: 2 },
            center: { clipPath: starPolygon(4), zIndex: 2 },
            exit: {
                zIndex: 1,
                // Stay visible under the wipe, then disappear once fully covered.
                opacity: 0,
                transition: { duration: 0.01, delay: 0.65 },
            },
        },
        transition: { duration: 0.6, ease: 'easeInOut' },
    },
};

export const CONCRETE_TRANSITIONS: ConcreteTransitionStyle[] =
    Object.keys(slideTransitions) as ConcreteTransitionStyle[];

/**
 * Resolve the configured style to the one a given slide should actually use.
 *
 * `random` picks per slide, avoiding an immediate repeat so a long slideshow
 * doesn't land on the same wipe twice in a row (which is the monotony the
 * setting exists to break). Anything else resolves to itself.
 */
export function resolveTransition(
    style: TransitionStyle,
    previous: ConcreteTransitionStyle | null,
    random: () => number = Math.random,
): ConcreteTransitionStyle {
    if (style !== 'random') return style;
    const pool = CONCRETE_TRANSITIONS.filter(name => name !== previous);
    return pool[Math.floor(random() * pool.length)] ?? CONCRETE_TRANSITIONS[0];
}

/**
 * AnimatePresence mode for a given transition. The star wipe needs both
 * slides mounted at once ("sync") so the outgoing one stays visible under the
 * growing clip-path; everything else reads better with the outgoing slide
 * gone first ("wait").
 */
export const presenceModeFor = (style: ConcreteTransitionStyle): 'sync' | 'wait' =>
    (style === 'star' ? 'sync' : 'wait');
