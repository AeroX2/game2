import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

function stripCodeSplittingWarning() {
  return {
    name: 'strip-rollup-codesplitting-option',
    configResolved(config: { build: { rollupOptions?: { output?: unknown } } }) {
      const output = config.build.rollupOptions?.output;
      if (!output) return;

      const strip = (entry: unknown) => {
        if (entry && typeof entry === 'object' && 'codeSplitting' in entry) {
          delete (entry as { codeSplitting?: unknown }).codeSplitting;
        }
      };

      if (Array.isArray(output)) {
        for (const entry of output) strip(entry);
      } else {
        strip(output);
      }
    }
  };
}

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), stripCodeSplittingWarning()]
});
