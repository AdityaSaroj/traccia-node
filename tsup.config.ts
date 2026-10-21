import { defineConfig } from 'tsup';

const shared = {
  splitting: false as const,
  sourcemap: true,
  treeshake: true,
  minify: false,
};

export default defineConfig([
  {
    ...shared,
    entry: [
      'src/index.ts',
      'src/auto.ts',
      'src/tracer/index.ts',
      'src/integrations/index.ts',
    ],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    // Optional provider SDKs are devDependencies (for tests) but must never be
    // bundled: auto-instrumentation patches the copy the host application loads.
    external: ['openai', '@anthropic-ai/sdk'],
  },
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    dts: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['openai', '@anthropic-ai/sdk'],
  },
]);
