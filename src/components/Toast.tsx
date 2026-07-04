import { AnimatePresence, motion } from 'framer-motion';

export function Toast({ message }: { message: string | null }) {
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
                    {message}
                </motion.div>
            )}
        </AnimatePresence>
    );
}
