import { AnimatePresence, motion } from 'framer-motion';

export interface ToastAction {
    label: string;
    onAction: () => void;
}

export function Toast({ message, action }: { message: string | null; action?: ToastAction | null }) {
    return (
        <AnimatePresence>
            {message && (
                <motion.div
                    className="toast"
                    initial={{ y: 40, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 40, opacity: 0 }}
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
