import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Load environment variables.
  const env = loadEnv(mode, process.cwd(), '');

  // Validate exact hostnames for temporary development tunnels.
  const isExactHostname = (host) => {
    if (!host || host.length > 253 || !host.includes('.') || host.includes('*')) {
      return false;
    }

    return host.split('.').every((label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    );
  };

  const allowedHosts = (
    process.env.CLIPFINDER_DEV_ALLOWED_HOSTS ||
    env.CLIPFINDER_DEV_ALLOWED_HOSTS ||
    ''
  )
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(isExactHostname);

  return {
    // React plugin
    plugins: [react()],

    // Import aliases
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },

    // Worker configuration
    worker: {
      format: 'es',
    },

    // Development server
    server: {
      port: 5173,
      strictPort: true,
      allowedHosts,
    },
  };
});