// Desktop implementation of the platform boundary: a thin pass-through to the
// Electron preload bridge (`window.api`, typed in src/electron.d.ts). No
// behavior changes here — this only routes the calls App.tsx used to make on
// `window.api` directly through one file, so the Android build can substitute
// its own implementation of the same interface.

import type { Platform } from '../types'

export const desktopPlatform: Platform = {
  target: 'desktop',

  // ---- library: tracks ----
  getTracks: () => window.api.getTracks(),
  getTracksInFolder: (folderPath) => window.api.getTracksInFolder(folderPath),
  searchTracks: (query) => window.api.searchTracks(query),
  scanLibrary: (folderPath, isolated) => window.api.scanLibrary(folderPath, isolated),
  syncLibrary: () => window.api.getTracks(),
  setTrackInLibrary: (id, inLibrary) => window.api.setTrackInLibrary(id, inLibrary),
  setTrackFavorite: (id, favorite) => window.api.setTrackFavorite(id, favorite),
  setTracksOrder: (orderedIds) => window.api.setTracksOrder(orderedIds),
  markPlayed: (id) => window.api.markPlayed(id),
  getRecentlyPlayed: () => window.api.getRecentlyPlayed(),
  removeFromRecentlyPlayed: (id) => window.api.removeFromRecentlyPlayed(id),
  updateTags: (id, tags) => window.api.updateTags(id, tags),
  updateTagsBulk: (ids, tags) => window.api.updateTagsBulk(ids, tags),
  updateTrackArt: (id, artPath, saveToMetadata) =>
    window.api.updateTrackArt(id, artPath, saveToMetadata),
  setDetectedKey: (id, key, keySignature, force) =>
    window.api.setDetectedKey(id, key, keySignature, force),

  // ---- library: folders / sections ----
  getFolders: () => window.api.getFolders(),
  renameFolder: (folderPath, name) => window.api.renameFolder(folderPath, name),
  updateFolderArt: (folderPath, artPath) => window.api.updateFolderArt(folderPath, artPath),
  removeFolder: (folderPath) => window.api.removeFolder(folderPath),
  reorderFolders: (orderedPaths) => window.api.reorderFolders(orderedPaths),

  // ---- playlists ----
  listPlaylists: () => window.api.listPlaylists(),
  createPlaylist: (name) => window.api.createPlaylist(name),
  renamePlaylist: (id, name) => window.api.renamePlaylist(id, name),
  deletePlaylist: (id) => window.api.deletePlaylist(id),
  reorderPlaylists: (orderedIds) => window.api.reorderPlaylists(orderedIds),
  getPlaylistTracks: (id) => window.api.getPlaylistTracks(id),
  reorderPlaylistTracks: (id, orderedTrackIds) =>
    window.api.reorderPlaylistTracks(id, orderedTrackIds),
  addTracksToPlaylist: (id, trackIds) => window.api.addTracksToPlaylist(id, trackIds),
  removeTracksFromPlaylist: (id, trackIds) => window.api.removeTracksFromPlaylist(id, trackIds),

  // ---- media ----
  getMediaUrl: (filePath) => window.api.getMediaUrl(filePath),
  getArt: (filePath) => window.api.getArt(filePath),
  ensurePlayableAudio: (filePath) => window.api.ensurePlayableAudio(filePath),
  listBackgroundImages: () => window.api.listBackgroundImages(),
  selectImage: () => window.api.selectImage(),
  selectFolder: () => window.api.selectFolder(),

  // ---- OS transport ----
  onMediaPlayPause: (callback) => window.api.onMediaPlayPause(callback),
  onMediaNextTrack: (callback) => window.api.onMediaNextTrack(callback),
  onMediaPrevTrack: (callback) => window.api.onMediaPrevTrack(callback),
}
