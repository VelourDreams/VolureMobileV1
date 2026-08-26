import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Track, Folder, Playlist, BassInterval } from './db'
import type { AudioExportFormat } from './audio'

export interface TrackArt {
  format: string
  data: string
}

const api = {
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFolder'),
  selectImage: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectImage'),
  selectViewerImage: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectViewerImage'),
  selectViewerVideo: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectViewerVideo'),
  selectAudioFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectAudioFile'),
  saveAudioFile: (
    defaultName: string,
    data: ArrayBuffer,
    format?: AudioExportFormat,
    sourceExt?: string
  ): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveAudioFile', defaultName, data, format, sourceExt),
  // Silent — no Save dialog — writes a just-finished screen recording to a
  // throwaway temp file so it can be loaded into the Video Viewer. Nothing
  // is permanently saved until downloadScreenRecording below is called.
  stageScreenRecording: (data: ArrayBuffer, sourceContainer: 'mp4' | 'webm'): Promise<string> =>
    ipcRenderer.invoke('library:stageScreenRecording', data, sourceContainer),
  // The Video Viewer's Download button — copies the staged temp file (see
  // above) to a user-picked destination via the native Save dialog.
  downloadScreenRecording: (sourcePath: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:downloadScreenRecording', sourcePath, defaultName),
  saveImageFile: (
    defaultName: string,
    data: ArrayBuffer,
    format: 'png' | 'jpg'
  ): Promise<string | null> => ipcRenderer.invoke('dialog:saveImageFile', defaultName, data, format),
  copyImageToClipboard: (filePath: string, dataUrl?: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:copyImage', filePath, dataUrl),
  captureScreenshot: (seconds: number): Promise<string | null> =>
    ipcRenderer.invoke('screen:takeScreenshot', seconds),
  // Mirrors the in-viewer screenshot countdown in a small always-on-top
  // window pinned to the top-right of the screen, so it stays visible even
  // if the user switches away from Volure to line up their shot. Pass null
  // to hide it.
  setScreenshotCountdownOverlay: (seconds: number | null): void =>
    ipcRenderer.send('screenshot-countdown:set', seconds),
  getDeveloperLayout: (): Promise<unknown | null> => ipcRenderer.invoke('developer:getLayout'),
  getDeveloperElementLayout: (): Promise<unknown | null> => ipcRenderer.invoke('developer:getElementLayout'),
  saveDeveloperLayout: (layout: unknown): Promise<unknown> =>
    ipcRenderer.invoke('developer:saveLayout', layout),
  saveDeveloperElementLayout: (layout: unknown): Promise<unknown> =>
    ipcRenderer.invoke('developer:saveElementLayout', layout),
  exportDeveloperLayoutCss: (layout: unknown): Promise<string | null> =>
    ipcRenderer.invoke('developer:exportLayoutCss', layout),
  exportDeveloperElementLayoutCss: (layout: unknown): Promise<string | null> =>
    ipcRenderer.invoke('developer:exportElementLayoutCss', layout),
  resetDeveloperLayout: (): Promise<null> => ipcRenderer.invoke('developer:resetLayout'),
  resetDeveloperElementLayout: (): Promise<null> => ipcRenderer.invoke('developer:resetElementLayout'),
  listBackgroundImages: (): Promise<string[]> =>
    ipcRenderer.invoke('library:listBackgroundImages'),
  getPlaySamplePath: (): Promise<string | null> =>
    ipcRenderer.invoke('library:getPlaySamplePath'),
  getPlaySample2Path: (): Promise<string | null> =>
    ipcRenderer.invoke('library:getPlaySample2Path'),
  getPlaySample3Path: (): Promise<string | null> =>
    ipcRenderer.invoke('library:getPlaySample3Path'),
  getPlaySample4Path: (): Promise<string | null> =>
    ipcRenderer.invoke('library:getPlaySample4Path'),
  getWaveLottiePath: (): Promise<string | null> =>
    ipcRenderer.invoke('library:getWaveLottiePath'),
  getListeningLottiePath: (): Promise<string | null> =>
    ipcRenderer.invoke('library:getListeningLottiePath'),
  scanLibrary: (
    folderPath: string,
    isolated?: boolean
  ): Promise<{ tracks: Track[]; newTracks: { id: number; filePath: string }[] }> =>
    ipcRenderer.invoke('library:scan', folderPath, isolated),
  getTracks: (): Promise<Track[]> => ipcRenderer.invoke('library:getTracks'),
  getTracksInFolder: (folderPath: string): Promise<Track[]> =>
    ipcRenderer.invoke('library:getTracksInFolder', folderPath),
  searchTracks: (query: string): Promise<Track[]> =>
    ipcRenderer.invoke('library:search', query),
  updateTags: (
    id: number,
    tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>
  ): Promise<Track[]> => ipcRenderer.invoke('library:updateTags', id, tags),
  updateTagsBulk: (
    ids: number[],
    tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>
  ): Promise<{ tracks: Track[]; failedIds: number[] }> =>
    ipcRenderer.invoke('library:updateTagsBulk', ids, tags),
  updateTrackArt: (
    id: number,
    artPath: string | null,
    saveToMetadata?: boolean
  ): Promise<{ track: Track | null; metadataWriteFailed: boolean }> =>
    ipcRenderer.invoke('library:updateTrackArt', id, artPath, saveToMetadata ?? true),
  setTrackInLibrary: (id: number, inLibrary: boolean): Promise<Track | null> =>
    ipcRenderer.invoke('library:setInLibrary', id, inLibrary),
  setTrackFavorite: (id: number, favorite: boolean): Promise<Track | null> =>
    ipcRenderer.invoke('library:setFavorite', id, favorite),
  setTracksOrder: (orderedIds: number[]): Promise<Track[]> =>
    ipcRenderer.invoke('library:setTracksOrder', orderedIds),
  setDetectedKey: (
    id: number,
    key: string,
    keySignature: string,
    force?: boolean,
  ): Promise<Track | null> =>
    ipcRenderer.invoke('library:setDetectedKey', id, key, keySignature, force),
  getFolders: (): Promise<Folder[]> => ipcRenderer.invoke('library:getFolders'),
  renameFolder: (folderPath: string, name: string): Promise<Folder[]> =>
    ipcRenderer.invoke('library:renameFolder', folderPath, name),
  updateFolderArt: (folderPath: string, artPath: string | null): Promise<Folder[]> =>
    ipcRenderer.invoke('library:updateFolderArt', folderPath, artPath),
  removeFolder: (folderPath: string): Promise<{ folders: Folder[]; tracks: Track[] }> =>
    ipcRenderer.invoke('library:removeFolder', folderPath),
  reorderFolders: (orderedPaths: string[]): Promise<Folder[]> =>
    ipcRenderer.invoke('library:reorderFolders', orderedPaths),
  listPlaylists: (): Promise<Playlist[]> => ipcRenderer.invoke('playlist:list'),
  createPlaylist: (name: string): Promise<Playlist> => ipcRenderer.invoke('playlist:create', name),
  renamePlaylist: (id: number, name: string): Promise<Playlist[]> =>
    ipcRenderer.invoke('playlist:rename', id, name),
  deletePlaylist: (id: number): Promise<Playlist[]> => ipcRenderer.invoke('playlist:delete', id),
  reorderPlaylists: (orderedIds: number[]): Promise<Playlist[]> =>
    ipcRenderer.invoke('playlist:reorder', orderedIds),
  getPlaylistTracks: (id: number): Promise<Track[]> => ipcRenderer.invoke('playlist:getTracks', id),
  reorderPlaylistTracks: (id: number, orderedTrackIds: number[]): Promise<Track[]> =>
    ipcRenderer.invoke('playlist:reorderTracks', id, orderedTrackIds),
  addTracksToPlaylist: (
    id: number,
    trackIds: number[]
  ): Promise<{ playlists: Playlist[]; tracks: Track[] }> =>
    ipcRenderer.invoke('playlist:addTracks', id, trackIds),
  removeTracksFromPlaylist: (
    id: number,
    trackIds: number[]
  ): Promise<{ playlists: Playlist[]; tracks: Track[] }> =>
    ipcRenderer.invoke('playlist:removeTracks', id, trackIds),
  getAdvancedTracks: (): Promise<Track[]> => ipcRenderer.invoke('advanced:getTracks'),
  setTrackInAdvancedLibrary: (id: number, included: boolean): Promise<Track | null> =>
    ipcRenderer.invoke('advanced:setInLibrary', id, included),
  updateAdvancedTags: (
    id: number,
    tags: Partial<Pick<Track, 'key' | 'mood'>>
  ): Promise<Track | null> => ipcRenderer.invoke('advanced:updateTags', id, tags),
  getBassIntervals: (trackIds: number[]): Promise<Record<number, BassInterval[]>> =>
    ipcRenderer.invoke('advanced:getBassIntervals', trackIds),
  addBassInterval: (trackId: number, sequence: string): Promise<BassInterval> =>
    ipcRenderer.invoke('advanced:addBassInterval', trackId, sequence),
  removeBassInterval: (id: number): Promise<void> =>
    ipcRenderer.invoke('advanced:removeBassInterval', id),
  getArt: (filePath: string): Promise<TrackArt | null> =>
    ipcRenderer.invoke('library:getArt', filePath),
  markPlayed: (id: number): Promise<void> => ipcRenderer.invoke('library:markPlayed', id),
  getRecentlyPlayed: (): Promise<Track[]> => ipcRenderer.invoke('library:getRecentlyPlayed'),
  removeFromRecentlyPlayed: (id: number): Promise<Track[]> =>
    ipcRenderer.invoke('library:removeFromRecentlyPlayed', id),
  playDroppedFile: (filePath: string): Promise<{ track: Track | null; inserted: boolean } | null> =>
    ipcRenderer.invoke('library:playDroppedFile', filePath),
  ensurePlayableAudio: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('library:ensurePlayableAudio', filePath),
  ensurePlayableVideo: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('library:ensurePlayableVideo', filePath),
  prepareVideoForPlayback: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('library:prepareVideoForPlayback', filePath),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  getMediaUrl: (filePath: string): string => `media://${encodeURIComponent(filePath)}`,
  nudgeDragRegion: (): Promise<void> => ipcRenderer.invoke('window:nudgeDragRegion'),
  isWindowFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullscreen'),
  exitWindowFullscreen: (): Promise<void> => ipcRenderer.invoke('window:exitFullscreen'),
  enterWindowFullscreen: (): Promise<void> => ipcRenderer.invoke('window:enterFullscreen'),
  setTitleBarOverlay: (overlay: { color: string; symbolColor: string }): Promise<void> =>
    ipcRenderer.invoke('window:setTitleBarOverlay', overlay),
  showItemInFolder: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', filePath),
  // Dev-only YouTube → audio downloader backing the Studio "Converter" tab —
  // see the ipcMain handler for why this doesn't ship in the official build.
  downloadYoutubeAudio: (url: string, format: AudioExportFormat): Promise<string | null> =>
    ipcRenderer.invoke('converter:downloadYoutubeAudio', url, format),
  onWindowFullscreenChange: (callback: (fullscreen: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, fullscreen: boolean) => callback(fullscreen)
    ipcRenderer.on('window:fullscreenChange', listener)
    return () => ipcRenderer.removeListener('window:fullscreenChange', listener)
  },
  onDeveloperToggle: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('developer:toggle', listener)
    return () => ipcRenderer.removeListener('developer:toggle', listener)
  },
  onMediaPlayPause: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('media:play-pause', listener)
    return () => ipcRenderer.removeListener('media:play-pause', listener)
  },
  onMediaNextTrack: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('media:next-track', listener)
    return () => ipcRenderer.removeListener('media:next-track', listener)
  },
  onMediaPrevTrack: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('media:prev-track', listener)
    return () => ipcRenderer.removeListener('media:prev-track', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
