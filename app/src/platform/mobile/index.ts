// Android implementation of the platform boundary.
//
// Library / playlist / folder methods are wired to SQLite (./db.ts). The rest
// still throw — later phases replace them:
//   - syncLibrary / getArt        -> MediaStore via a custom plugin (Phase 4)
//   - getMediaUrl                 -> Capacitor.convertFileSrc(content://…)   (Phase 4)
//   - listBackgroundImages        -> bundled assets                          (Phase 4)
//   - selectImage                 -> @capacitor/camera photo picker          (Phase 4)
//   - onMedia* transport          -> events from the playback service        (Phase 5)

import { Capacitor } from '@capacitor/core'
import type { Platform } from '../types'
import * as db from './db'
import * as library from './library'
import { installLegacyApiShim } from './legacyApiShim'

// Side effect on first import of the platform boundary — runs before any
// component mounts. Neutralizes the desktop-only window.api.* calls still
// scattered through App.tsx so the app can boot on Android.
installLegacyApiShim()

function notReady(method: string): never {
  throw new Error(
    `[platform] "${method}" is not implemented in the Volure Android build yet`,
  )
}

const noopUnsubscribe = () => () => {}

export const platform: Platform = {
  target: 'mobile',

  // ---- library: tracks ----
  getTracks: () => db.getAllTracks(),
  getTracksInFolder: (folderPath) => db.getTracksInFolder(folderPath),
  searchTracks: (query) => db.searchTracks(query),
  scanLibrary: () => notReady('scanLibrary'),
  syncLibrary: () => library.syncLibrary(),
  setTrackInLibrary: async (id, inLibrary) => {
    await db.setTrackInLibrary(id, inLibrary ? 1 : 0)
    return (await db.getTrackById(id)) ?? null
  },
  setTrackFavorite: async (id, favorite) => {
    await db.setTrackFavorite(id, favorite ? 1 : 0)
    return (await db.getTrackById(id)) ?? null
  },
  setTracksOrder: async (orderedIds) => {
    await db.setTracksOrder(orderedIds)
    return db.getAllTracks()
  },
  markPlayed: (id) => db.markPlayed(id),
  getRecentlyPlayed: () => db.getRecentlyPlayed(),
  removeFromRecentlyPlayed: async (id) => {
    await db.removeFromRecentlyPlayed(id)
    return db.getRecentlyPlayed()
  },
  updateTags: async (id, tags) => {
    await db.updateTrackTags(id, tags)
    return db.getAllTracks()
  },
  updateTagsBulk: async (ids, tags) => {
    await db.updateTracksTags(ids, tags)
    return { tracks: await db.getAllTracks(), failedIds: [] }
  },
  updateTrackArt: async (id, artPath) => {
    await db.updateTrackArt(id, artPath)
    return { track: (await db.getTrackById(id)) ?? null, metadataWriteFailed: false }
  },
  setDetectedKey: async (id, key, keySignature, force) => {
    return (await db.setDetectedKey(id, key, keySignature, force)) ?? null
  },

  // ---- library: folders / sections ----
  getFolders: () => db.getFolders(),
  renameFolder: async (folderPath, name) => {
    await db.renameFolder(folderPath, name)
    return db.getFolders()
  },
  updateFolderArt: async (folderPath, artPath) => {
    await db.updateFolderArt(folderPath, artPath)
    return db.getFolders()
  },
  removeFolder: async (folderPath) => {
    await db.removeFolder(folderPath)
    return { folders: await db.getFolders(), tracks: await db.getAllTracks() }
  },
  reorderFolders: async (orderedPaths) => {
    await db.reorderFolders(orderedPaths)
    return db.getFolders()
  },

  // ---- playlists ----
  listPlaylists: () => db.getPlaylists(),
  createPlaylist: (name) => db.createPlaylist(name),
  renamePlaylist: async (id, name) => {
    await db.renamePlaylist(id, name)
    return db.getPlaylists()
  },
  deletePlaylist: async (id) => {
    await db.deletePlaylist(id)
    return db.getPlaylists()
  },
  reorderPlaylists: async (orderedIds) => {
    await db.reorderPlaylists(orderedIds)
    return db.getPlaylists()
  },
  getPlaylistTracks: (id) => db.getPlaylistTracks(id),
  reorderPlaylistTracks: async (id, orderedTrackIds) => {
    await db.reorderPlaylistTracks(id, orderedTrackIds)
    return db.getPlaylistTracks(id)
  },
  addTracksToPlaylist: async (id, trackIds) => {
    await db.addTracksToPlaylist(id, trackIds)
    return { playlists: await db.getPlaylists(), tracks: await db.getPlaylistTracks(id) }
  },
  removeTracksFromPlaylist: async (id, trackIds) => {
    await db.removeTracksFromPlaylist(id, trackIds)
    return { playlists: await db.getPlaylists(), tracks: await db.getPlaylistTracks(id) }
  },

  // ---- media ----
  // `filePath` is a content:// URI from MediaStore (Phase 4). convertFileSrc
  // proxies it through Capacitor's local server so <audio> and fetch() work.
  getMediaUrl: (filePath) => Capacitor.convertFileSrc(filePath),
  getArt: (filePath) => library.getArt(filePath),
  ensurePlayableAudio: (filePath) => Promise.resolve(filePath),
  listBackgroundImages: () => Promise.resolve([]), // Phase 4 — bundled assets
  selectImage: () => notReady('selectImage'), // Phase 4 — photo picker
  selectFolder: () => notReady('selectFolder'),

  // ---- OS transport (Phase 5 — playback service) ----
  onMediaPlayPause: noopUnsubscribe,
  onMediaNextTrack: noopUnsubscribe,
  onMediaPrevTrack: noopUnsubscribe,
}
