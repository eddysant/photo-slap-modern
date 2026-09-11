import { AnimatePresence, motion } from 'framer-motion';

export interface ToastAction {
    label: string;
    onAction: () => void;
}

export function Toast({ message, action, positionLeft = false }: {
    message: string | null;
    action?: ToastAction | null;
    /** Controls are on the left, so the right edge carries the title bar. */
    positionLeft?: boolean;
}) {
    return (
        <AnimatePresence>
            {message && (
                <motion.div
                    className={`toast ${positionLeft ? 'position-left' : ''}`}
                    // Slides in from the right edge it now sits against
                    initial={{ x: 40, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 40, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <span>{message}</span>
                    {action && (
                        <button className="toast-action" onClick={action.onAction}>
                            {action.label}
                        </button>
                    )}
                </motion.div>
            )}
        </AnimatePresence>
    );
}
