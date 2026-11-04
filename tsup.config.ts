import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'normalizer/index': 'src/normalizer/index.ts',
    'deid/index': 'src/deid/index.ts',
    'compiler/index': 'src/compiler/index.ts',
    'verifier/index': 'src/verifier/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
});
