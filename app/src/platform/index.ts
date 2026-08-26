// The platform boundary — see ./types.ts.
//
// App.tsx and the hooks import `platform` from here. Today it resolves to the
// desktop implementation directly. The Vite-config step adds a build-time alias
// so `VOLURE_TARGET=mobile vite build` swaps in ./mobile instead, without any
// change to this file's consumers.

import { desktopPlatform } from './desktop'
import type { Platform } from './types'

export const platform: Platform = desktopPlatform

export type { Platform, PlatformTarget, TrackArt, TagPatch, ScanResult } from './types'
export type { Track, Folder, Playlist, BassInterval } from './types'
