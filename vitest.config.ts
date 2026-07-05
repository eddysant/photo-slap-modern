import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: the electron plugin there would
// try to launch Electron when Vitest loads the config.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
    },
})
