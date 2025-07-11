import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // For now use node environment, can upgrade to Workers later
    globals: true,
    testTimeout: 10000
  }
})