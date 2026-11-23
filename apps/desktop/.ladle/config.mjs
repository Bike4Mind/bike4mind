/** @type {import('@ladle/react').UserConfig} */
export default {
  stories: 'src/renderer/src/**/*.stories.tsx',
  viteConfig: '.ladle/vite.config.ts',
  // Ladle's default is `build`, which here holds the electron-builder resources.
  outDir: '.ladle/dist',
  addons: {
    theme: { enabled: true, defaultState: 'auto' },
    a11y: { enabled: true },
    rtl: { enabled: false },
  },
};
