import { registerPlugin } from '@capacitor/core'

/** One row from MediaStore.Audio, as returned by VolureLibraryPlugin.queryAudio. */
export interface MediaStoreTrack {
  /** MediaStore id (also the trailing segment of `uri`). */
  id: number
  /** content:// URI — stored as Track.filePath and fed to convertFileSrc. */
  uri: string
  title: string
  artist: string
  album: string
  genre: string | null
  trackNo: number
  durationMs: number
  dateAddedSec: number
  dateModifiedSec: number
  relativePath: string | null
  albumId: number
}

export interface VolureLibraryPlugin {
  /** Queries the device music library. Prompts for the audio permission on first call. */
  queryAudio(): Promise<{ tracks: MediaStoreTrack[] }>
  /** Album/embedded artwork for a track, base64. `data` is null when there is none. */
  getArt(options: { id: string }): Promise<{ format?: string; data: string | null }>
}

export const VolureLibrary = registerPlugin<VolureLibraryPlugin>('VolureLibrary')
