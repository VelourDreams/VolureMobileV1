import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import renderer from 'vite-plugin-electron-renderer'

// `npm run build:mobile` (VOLURE_TARGET=mobile) builds the plain web bundle for
// the Capacitor Android shell: no Electron plugins, and the platform boundary
// resolves to src/platform/mobile instead of src/platform/desktop.
const mobile = process.env.VOLURE_TARGET === 'mobile'

const platformImpl = fileURLToPath(
  new URL(
    mobile ? './src/platform/mobile/index.ts' : './src/platform/desktop/index.ts',
    import.meta.url,
  ),
)

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@platform-impl': platformImpl,
    },
  },
  define: {
    'import.meta.env.VOLURE_MOBILE': JSON.stringify(mobile),
  },
  plugins: [
    react(),
    ...(mobile
      ? []
      : [
          electron({
            main: {
              entry: 'electron/main.ts',
              vite: {
                build: {
                  outDir: 'dist-electron',
                  rolldownOptions: {
                    external: ['electron', 'better-sqlite3', 'music-metadata', 'ffmpeg-static'],
                  },
                },
              },
            },
            preload: {
              input: 'electron/preload.ts',
              vite: {
                build: {
                  outDir: 'dist-electron',
                },
              },
            },
          }),
          renderer(),
        ]),
  ],
})
