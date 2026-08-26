// The platform boundary — see ./types.ts.
//
// App.tsx and the hooks import `platform` from here. `@platform-impl` resolves
// to ./desktop by default; the Vite config aliases it to ./mobile for the
// Android build (VOLURE_TARGET=mobile), with no change to this file's
// consumers. tsconfig maps the same alias to ./desktop for type-checking.

export { platform } from '@platform-impl'

export type { Platform, PlatformTarget, TrackArt, TagPatch, ScanResult } from './types'
export type { Track, Folder, Playlist, BassInterval } from './types'
