/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** True in the Capacitor Android build (VOLURE_TARGET=mobile). Injected by vite.config. */
  readonly VOLURE_MOBILE: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
