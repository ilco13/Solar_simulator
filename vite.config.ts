import { defineConfig } from 'vite';

// PVGIS n'autorise pas les appels directs depuis un navigateur (pas de CORS) :
// en local (npm run dev / preview), on passe par ce proxy.
const pvgisProxy = {
  '/pvgis-api': {
    target: 'https://re.jrc.ec.europa.eu',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/pvgis-api/, '/api/v5_3'),
  },
};

export default defineConfig({
  base: './',
  server: { proxy: pvgisProxy },
  preview: { proxy: pvgisProxy },
  worker: { format: 'es' },
});
