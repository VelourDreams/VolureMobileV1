// Android implementation of the platform boundary — STUB.
//
// Every method throws for now. This file exists so `npm run build:mobile`
// compiles and the build plumbing (Vite alias, Capacitor config) can be
// verified before the real implementation lands. Phases 3–5 replace these
// one group at a time:
//   - library / playlists  -> @capacitor-community/sqlite      (mobile/db.ts)
//   - syncLibrary / art    -> MediaStore via a custom plugin   (mobile/library.ts)
//   - getMediaUrl          -> Capacitor.convertFileSrc(content://…)
//   - onMedia* transport   -> events from the playback service (mobile/nowplaying.ts)

import type { Platform } from '../types'

function notReady(method: string): never {
  throw new Error(
    `[platform] "${method}" is not implemented in the Volure Android build yet`,
  )
}

export const platform: Platform = {
  target: 'mobile',

  // ---- library: tracks ----
  getTracks: () => notReady('getTracks'),
  getTracksInFolder: () => notReady('getTracksInFolder'),
  searchTracks: () => notReady('searchTracks'),
  scanLibrary: () => notReady('scanLibrary'),
  syncLibrary: () => notReady('syncLibrary'),
  setTrackInLibrary: () => notReady('setTrackInLibrary'),
  setTrackFavorite: () => notReady('setTrackFavorite'),
  setTracksOrder: () => notReady('setTracksOrder'),
  markPlayed: () => notReady('markPlayed'),
  getRecentlyPlayed: () => notReady('getRecentlyPlayed'),
  removeFromRecentlyPlayed: () => notReady('removeFromRecentlyPlayed'),
  updateTags: () => notReady('updateTags'),
  updateTagsBulk: () => notReady('updateTagsBulk'),
  updateTrackArt: () => notReady('updateTrackArt'),
  setDetectedKey: () => notReady('setDetectedKey'),

  // ---- library: folders / sections ----
  getFolders: () => notReady('getFolders'),
  renameFolder: () => notReady('renameFolder'),
  updateFolderArt: () => notReady('updateFolderArt'),
  removeFolder: () => notReady('removeFolder'),
  reorderFolders: () => notReady('reorderFolders'),

  // ---- playlists ----
  listPlaylists: () => notReady('listPlaylists'),
  createPlaylist: () => notReady('createPlaylist'),
  renamePlaylist: () => notReady('renamePlaylist'),
  deletePlaylist: () => notReady('deletePlaylist'),
  reorderPlaylists: () => notReady('reorderPlaylists'),
  getPlaylistTracks: () => notReady('getPlaylistTracks'),
  reorderPlaylistTracks: () => notReady('reorderPlaylistTracks'),
  addTracksToPlaylist: () => notReady('addTracksToPlaylist'),
  removeTracksFromPlaylist: () => notReady('removeTracksFromPlaylist'),

  // ---- media ----
  getMediaUrl: () => notReady('getMediaUrl'),
  getArt: () => notReady('getArt'),
  ensurePlayableAudio: () => notReady('ensurePlayableAudio'),
  listBackgroundImages: () => notReady('listBackgroundImages'),
  selectImage: () => notReady('selectImage'),
  selectFolder: () => notReady('selectFolder'),

  // ---- OS transport ----
  onMediaPlayPause: () => notReady('onMediaPlayPause'),
  onMediaNextTrack: () => notReady('onMediaNextTrack'),
  onMediaPrevTrack: () => notReady('onMediaPrevTrack'),
}
