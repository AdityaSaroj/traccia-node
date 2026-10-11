import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/auto.ts',
    'src/tracer/index.ts',
    'src/integrations/index.ts'
  ],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  // Optional provider SDKs are devDependencies (for tests) but must never be
  // bundled: auto-instrumentation patches the copy the host application loads.
  external: ['openai', '@anthropic-ai/sdk']
});
