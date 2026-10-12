import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: {
    // KaTeX's smaller fonts would otherwise become data: URLs and violate the
    // desktop font policy. Keep all assets local without weakening the CSP.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'vendor-react';
          if (id.includes('/lucide-react/')) return 'vendor-icons';
          return 'vendor';
        },
      },
    },
  },
});
