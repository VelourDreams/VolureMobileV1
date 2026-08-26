import type { CapacitorConfig } from '@capacitor/cli'

// Android shell config. The web build in dist/ (produced by
// `npm run build:mobile`) is what gets packaged; `npx cap sync` copies it
// into the generated android/ project.
//
// server.androidScheme defaults to 'https', so the app loads from
// https://localhost — a stable origin for localStorage and for proxying
// content:// media URLs through convertFileSrc.
const config: CapacitorConfig = {
  appId: 'com.volure.app',
  appName: 'Volure',
  webDir: 'dist',
}

export default config
