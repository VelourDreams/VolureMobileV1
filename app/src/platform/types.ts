// The platform boundary.
//
// Everything in src/ talks to the host (library database, media files, OS
// integration) through the `platform` object exported from ./index — never
// `window.api` directly. Desktop implements it over Electron IPC; the Android
// build implements it over Capacitor plugins. The two implementations satisfy
// this one interface, so App.tsx doesn't branch on target.
//
// Data types (Track/Folder/Playlist/BassInterval) are re-exported from their
// current home for now. The wiring step reverses that import — electron/db.ts
// will pull them FROM here — so the Android build never has to typecheck
// electron/.

export type { Track, Folder, Playlist, BassInterval } from '../../electron/db'
import type { Track, Folder, Playlist } from '../../electron/db'

/** Embedded cover art, base64-encoded, as returned by getArt. */
export interface TrackArt {
  format: string
  data: string
}

/** The subset of tag fields that are user-editable from Now Playing. */
export type TagPatch = Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>

export interface ScanResult {
  tracks: Track[]
  /** Files seen for the first time by this scan — the only ones key detection touches. */
  newTracks: { id: number; filePath: string }[]
}

export type PlatformTarget = 'desktop' | 'mobile'

/**
 * Methods marked "mobile: NOT_IN_V1" exist so App.tsx's desktop code paths keep
 * type-checking; the Android implementation throws if they're ever reached. All
 * such call sites sit inside Studio / Play / viewer UI that the mobile build
 * gates out, so they never actually run there.
 */
export interface Platform {
  readonly target: PlatformTarget

  // ---- library: tracks ----
  getTracks(): Promise<Track[]>
  getTracksInFolder(folderPath: string): Promise<Track[]>
  searchTracks(query: string): Promise<Track[]>
  /** Desktop: scan a picked folder. Mobile: NOT_IN_V1 (there's no folder picker — see syncLibrary). */
  scanLibrary(folderPath: string, isolated?: boolean): Promise<ScanResult>
  /** Mobile: refresh from MediaStore and return the library. Desktop: just getTracks(). */
  syncLibrary(): Promise<Track[]>
  setTrackInLibrary(id: number, inLibrary: boolean): Promise<Track | null>
  setTrackFavorite(id: number, favorite: boolean): Promise<Track | null>
  setTracksOrder(orderedIds: number[]): Promise<Track[]>
  markPlayed(id: number): Promise<void>
  getRecentlyPlayed(): Promise<Track[]>
  removeFromRecentlyPlayed(id: number): Promise<Track[]>
  /** Tag edits. Mobile writes the DB override only — never back to the file. */
  updateTags(id: number, tags: TagPatch): Promise<Track[]>
  updateTagsBulk(ids: number[], tags: TagPatch): Promise<{ tracks: Track[]; failedIds: number[] }>
  updateTrackArt(
    id: number,
    artPath: string | null,
    saveToMetadata?: boolean,
  ): Promise<{ track: Track | null; metadataWriteFailed: boolean }>
  /** Planned mobile follow-up (OTA, pure JS). Desktop: real. Mobile v1: NOT_IN_V1. */
  setDetectedKey(id: number, key: string, keySignature: string, force?: boolean): Promise<Track | null>

  // ---- library: folders / sections ----
  getFolders(): Promise<Folder[]>
  renameFolder(folderPath: string, name: string): Promise<Folder[]>
  updateFolderArt(folderPath: string, artPath: string | null): Promise<Folder[]>
  removeFolder(folderPath: string): Promise<{ folders: Folder[]; tracks: Track[] }>
  reorderFolders(orderedPaths: string[]): Promise<Folder[]>

  // ---- playlists ----
  listPlaylists(): Promise<Playlist[]>
  createPlaylist(name: string): Promise<Playlist>
  renamePlaylist(id: number, name: string): Promise<Playlist[]>
  deletePlaylist(id: number): Promise<Playlist[]>
  reorderPlaylists(orderedIds: number[]): Promise<Playlist[]>
  getPlaylistTracks(id: number): Promise<Track[]>
  reorderPlaylistTracks(id: number, orderedTrackIds: number[]): Promise<Track[]>
  addTracksToPlaylist(id: number, trackIds: number[]): Promise<{ playlists: Playlist[]; tracks: Track[] }>
  removeTracksFromPlaylist(
    id: number,
    trackIds: number[],
  ): Promise<{ playlists: Playlist[]; tracks: Track[] }>

  // ---- media ----
  /** `filePath` is an absolute path on desktop, a content:// URI on mobile. */
  getMediaUrl(filePath: string): string
  getArt(filePath: string): Promise<TrackArt | null>
  /** Desktop: transcode unsupported WAVs. Mobile: returns the URL unchanged. */
  ensurePlayableAudio(filePath: string): Promise<string | null>
  listBackgroundImages(): Promise<string[]>
  /** Custom background / custom art. Desktop: native dialog. Mobile: photo picker, copied into app data. */
  selectImage(): Promise<string | null>
  /** Desktop: "add folder" dialog. Mobile: NOT_IN_V1. */
  selectFolder(): Promise<string | null>

  // ---- OS transport (media keys / lock screen) ----
  onMediaPlayPause(callback: () => void): () => void
  onMediaNextTrack(callback: () => void): () => void
  onMediaPrevTrack(callback: () => void): () => void
}
