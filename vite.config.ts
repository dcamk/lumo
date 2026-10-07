import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    // Duas páginas: o app do PC (index.html) e o app do celular/tablet (mobile/), que a
    // Ponte Lumo serve na rede local. Os assets ficam juntos em dist/assets.
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          mobile: path.resolve(__dirname, 'mobile/index.html'),
        },
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
