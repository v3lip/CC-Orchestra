import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 20000,
    pool: 'forks',
    // Run files one at a time: with both server suites (each with live sockets and a
    // WASM Lua VM) in parallel, a worker process crashed in ~1 of 15 runs on Windows.
    fileParallelism: false,
  },
});
