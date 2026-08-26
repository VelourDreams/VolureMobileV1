import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'

const dbPath = path.join(app.getPath('userData'), 'library.db')
export const db = new Database(dbPath)

// Windows and (by default) macOS filesystems are case-insensitive, but Linux
// filesystems are case-sensitive — comparing paths case-insensitively there
// could treat distinct files/folders as the same one.
function normalizePathForCompare(p: string): string {
  return process.platform === 'linux' ? p : p.toLowerCase()
}

db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filePath TEXT UNIQUE NOT NULL,
    title TEXT,
    artist TEXT,
    album TEXT,
    genre TEXT,
    trackNo INTEGER,
    duration REAL,
    hasArt INTEGER DEFAULT 0,
    dateAdded INTEGER NOT NULL,
    modifiedAt INTEGER NOT NULL DEFAULT 0
  )
`)

const foldersTableExisted = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='folders'")
  .get()

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    path TEXT PRIMARY KEY NOT NULL
  )
`)

if (!foldersTableExisted) {
  // Folder tracking was added after some libraries already had tracks in them.
  // Backfill so files dropped into a folder that was scanned pre-migration are
  // still recognized as already part of the library.
  const existingDirs = db.prepare('SELECT DISTINCT filePath FROM tracks').all() as {
    filePath: string
  }[]
  const insertFolder = db.prepare('INSERT OR IGNORE INTO folders (path) VALUES (?)')
  const seen = new Set<string>()
  for (const { filePath } of existingDirs) {
    const dir = path.dirname(filePath)
    if (!seen.has(dir)) {
      seen.add(dir)
      insertFolder.run(dir)
    }
  }
}

const trackColumns = db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]
if (!trackColumns.some((c) => c.name === 'lastPlayedAt')) {
  db.exec('ALTER TABLE tracks ADD COLUMN lastPlayedAt INTEGER')
}
if (!trackColumns.some((c) => c.name === 'inLibrary')) {
  db.exec('ALTER TABLE tracks ADD COLUMN inLibrary INTEGER NOT NULL DEFAULT 1')
}
if (!trackColumns.some((c) => c.name === 'customArtPath')) {
  db.exec('ALTER TABLE tracks ADD COLUMN customArtPath TEXT')
}
if (!trackColumns.some((c) => c.name === 'key')) {
  db.exec('ALTER TABLE tracks ADD COLUMN key TEXT')
}
if (!trackColumns.some((c) => c.name === 'keySignature')) {
  db.exec('ALTER TABLE tracks ADD COLUMN keySignature TEXT')
}
if (!trackColumns.some((c) => c.name === 'genre')) {
  db.exec('ALTER TABLE tracks ADD COLUMN genre TEXT')
}
if (!trackColumns.some((c) => c.name === 'modifiedAt')) {
  db.exec('ALTER TABLE tracks ADD COLUMN modifiedAt INTEGER NOT NULL DEFAULT 0')
}
if (!trackColumns.some((c) => c.name === 'sortOrder')) {
  db.exec('ALTER TABLE tracks ADD COLUMN sortOrder INTEGER')
}
if (!trackColumns.some((c) => c.name === 'favorite')) {
  db.exec('ALTER TABLE tracks ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0')
}
if (!trackColumns.some((c) => c.name === 'favoriteAt')) {
  db.exec('ALTER TABLE tracks ADD COLUMN favoriteAt INTEGER')
}
if (!trackColumns.some((c) => c.name === 'mood')) {
  db.exec('ALTER TABLE tracks ADD COLUMN mood TEXT')
}
if (!trackColumns.some((c) => c.name === 'inAdvancedLibrary')) {
  db.exec('ALTER TABLE tracks ADD COLUMN inAdvancedLibrary INTEGER NOT NULL DEFAULT 0')
}

const folderColumns = db.prepare('PRAGMA table_info(folders)').all() as { name: string }[]
if (!folderColumns.some((c) => c.name === 'name')) {
  db.exec('ALTER TABLE folders ADD COLUMN name TEXT')
}
if (!folderColumns.some((c) => c.name === 'customArtPath')) {
  db.exec('ALTER TABLE folders ADD COLUMN customArtPath TEXT')
}
if (!folderColumns.some((c) => c.name === 'isolated')) {
  db.exec('ALTER TABLE folders ADD COLUMN isolated INTEGER NOT NULL DEFAULT 0')
}
if (!folderColumns.some((c) => c.name === 'sortOrder')) {
  db.exec('ALTER TABLE folders ADD COLUMN sortOrder INTEGER')
}

db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )
`)

const playlistColumns = db.prepare('PRAGMA table_info(playlists)').all() as { name: string }[]
if (!playlistColumns.some((c) => c.name === 'sortOrder')) {
  db.exec('ALTER TABLE playlists ADD COLUMN sortOrder INTEGER')
}

db.exec(`
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlistId INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    trackId INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlistId, trackId)
  )
`)

// One track can carry several bass progressions (the Advanced tab's "BS INV"
// column) — this is a one-to-many table rather than a single field.
db.exec(`
  CREATE TABLE IF NOT EXISTS bass_intervals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trackId INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    sequence TEXT NOT NULL,
    sortOrder INTEGER NOT NULL
  )
`)

export interface Track {
  id: number
  filePath: string
  title: string | null
  artist: string | null
  album: string | null
  genre: string | null
  trackNo: number | null
  duration: number | null
  hasArt: number
  dateAdded: number
  modifiedAt: number
  lastPlayedAt: number | null
  inLibrary: number
  customArtPath: string | null
  key: string | null
  // Full detected key (e.g. "F# Minor") — set only by background key
  // detection, alongside `key`. Manually-entered keys never populate this
  // (there's no mode info to go with a bare tonic), so it also doubles as
  // "was this ever actually detected" for the Show Info popup.
  keySignature: string | null
  // User-defined manual order for the "Custom" sort mode. Null until the
  // track is first dragged; nulls sort after every real value so untouched
  // tracks land at the end instead of shuffling to the top.
  sortOrder: number | null
  favorite: number
  favoriteAt: number | null
  mood: string | null
  // Whether this track has been "included" into the Advanced tab's library
  // via the per-folder Include button — independent of `inLibrary`, which
  // gates the Songs tab.
  inAdvancedLibrary: number
}

// inLibrary is deliberately left out of the ON CONFLICT SET: it's not just
// scan metadata, it can be manually overridden per-track (the Include column
// on an isolated folder), and a rescan of that folder must not clobber it.
const upsertStmt = db.prepare(`
  INSERT INTO tracks (filePath, title, artist, album, genre, trackNo, duration, hasArt, inLibrary, dateAdded, modifiedAt)
  VALUES (@filePath, @title, @artist, @album, @genre, @trackNo, @duration, @hasArt, @inLibrary, @dateAdded, @modifiedAt)
  ON CONFLICT(filePath) DO UPDATE SET
    title = excluded.title,
    artist = excluded.artist,
    album = excluded.album,
    genre = excluded.genre,
    trackNo = excluded.trackNo,
    duration = excluded.duration,
    hasArt = excluded.hasArt,
    modifiedAt = excluded.modifiedAt
`)

// `inserted` tells callers whether this row is brand new (as opposed to an
// existing file being rescanned) — key detection should only ever run once,
// on first sight of a file, so it needs this signal rather than just an id.
export function upsertTrack(
  track: Omit<Track, 'id' | 'dateAdded' | 'lastPlayedAt' | 'customArtPath' | 'key' | 'keySignature' | 'favorite' | 'favoriteAt' | 'mood' | 'inAdvancedLibrary'>
): { id: number; inserted: boolean } {
  const result = upsertStmt.run({ ...track, dateAdded: Date.now() })
  const insertedId = result.lastInsertRowid as number
  if (insertedId) {
    return { id: insertedId, inserted: true }
  }
  const row = db.prepare('SELECT id FROM tracks WHERE filePath = ?').get(track.filePath) as {
    id: number
  }
  return { id: row.id, inserted: false }
}

export interface Folder {
  path: string
  name: string | null
  customArtPath: string | null
  isolated: number
  sortOrder: number | null
}

export function addFolder(folderPath: string, isolated = 0) {
  db.prepare('INSERT OR IGNORE INTO folders (path, isolated) VALUES (?, ?)').run(folderPath, isolated)
}

export function isFolderIsolated(folderPath: string): boolean {
  const row = db.prepare('SELECT isolated FROM folders WHERE path = ?').get(folderPath) as
    | { isolated: number }
    | undefined
  return !!row?.isolated
}

// A dropped/played file under an isolated folder should stay out of the
// Songs tab just like the rest of that folder's tracks.
export function isPathInLibraryFolder(filePath: string): boolean {
  const folders = db.prepare('SELECT path, isolated FROM folders').all() as {
    path: string
    isolated: number
  }[]
  const normalized = normalizePathForCompare(filePath)
  return folders.some((f) => {
    if (f.isolated) return false
    const folder = normalizePathForCompare(f.path)
    return normalized === folder || normalized.startsWith(folder + path.sep)
  })
}

export function getFolders(): Folder[] {
  return db.prepare('SELECT * FROM folders').all() as Folder[]
}

export function renameFolder(folderPath: string, name: string) {
  const trimmed = name.trim()
  db.prepare('UPDATE folders SET name = ? WHERE path = ?').run(trimmed || null, folderPath)
}

export function updateFolderArt(folderPath: string, artPath: string | null) {
  db.prepare('UPDATE folders SET customArtPath = ? WHERE path = ?').run(artPath, folderPath)
}

export function reorderFolders(orderedPaths: string[]) {
  const stmt = db.prepare('UPDATE folders SET sortOrder = ? WHERE path = ?')
  const runAll = db.transaction((paths: string[]) => {
    paths.forEach((p, i) => stmt.run(i, p))
  })
  runAll(orderedPaths)
}

// Removing a folder only forgets it and the tracks Volure found there — it
// never touches anything on disk.
export function removeFolder(folderPath: string) {
  const normalized = normalizePathForCompare(folderPath)
  const tracks = db.prepare('SELECT id, filePath FROM tracks').all() as {
    id: number
    filePath: string
  }[]
  const toDelete = tracks.filter((t) => {
    const filePath = normalizePathForCompare(t.filePath)
    return filePath === normalized || filePath.startsWith(normalized + path.sep)
  })
  const deleteTrackStmt = db.prepare('DELETE FROM tracks WHERE id = ?')
  const runAll = db.transaction(() => {
    for (const t of toDelete) deleteTrackStmt.run(t.id)
    db.prepare('DELETE FROM folders WHERE path = ?').run(folderPath)
  })
  runAll()
}

export function getTrackById(id: number): Track | undefined {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Track | undefined
}

export function getAllTracks(): Track[] {
  return db
    .prepare('SELECT * FROM tracks WHERE inLibrary = 1 ORDER BY artist, album, trackNo, title')
    .all() as Track[]
}

// Unlike getAllTracks/searchTracks, this ignores inLibrary so a folder kept
// out of the Songs tab (isolated) can still be browsed and played directly.
export function getTracksInFolder(folderPath: string): Track[] {
  const normalized = normalizePathForCompare(folderPath)
  const all = db
    .prepare('SELECT * FROM tracks ORDER BY artist, album, trackNo, title')
    .all() as Track[]
  return all.filter((t) => {
    const filePath = normalizePathForCompare(t.filePath)
    return filePath === normalized || filePath.startsWith(normalized + path.sep)
  })
}

export function setTrackInLibrary(id: number, inLibrary: number) {
  db.prepare('UPDATE tracks SET inLibrary = ? WHERE id = ?').run(inLibrary, id)
}

export function setTrackFavorite(id: number, favorite: number) {
  db.prepare('UPDATE tracks SET favorite = ?, favoriteAt = ? WHERE id = ?').run(
    favorite,
    favorite ? Date.now() : null,
    id,
  )
}

// Persists a manual drag-reorder: assigns sequential sortOrder values to
// exactly the ids given (whatever list was visible when the drag happened),
// leaving every other track's sortOrder untouched.
export function setTracksOrder(orderedIds: number[]) {
  const stmt = db.prepare('UPDATE tracks SET sortOrder = ? WHERE id = ?')
  const runAll = db.transaction((ids: number[]) => {
    ids.forEach((id, i) => stmt.run(i, id))
  })
  runAll(orderedIds)
}

export function searchTracks(query: string): Track[] {
  const like = `%${query}%`
  return db
    .prepare(
      `SELECT * FROM tracks
       WHERE inLibrary = 1 AND (title LIKE ? OR artist LIKE ? OR album LIKE ?)
       ORDER BY artist, album, trackNo, title`
    )
    .all(like, like, like) as Track[]
}

export function updateTrackArt(id: number, artPath: string | null) {
  db.prepare('UPDATE tracks SET customArtPath = ? WHERE id = ?').run(artPath, id)
}

// Only ever applies to a track that has no key yet — background detection
// must never clobber a key the user typed in (or that detection already set).
export function setDetectedKey(
  id: number,
  key: string,
  keySignature: string,
  force = false,
): Track | undefined {
  if (force) {
    db.prepare('UPDATE tracks SET key = ?, keySignature = ? WHERE id = ?').run(key, keySignature, id)
  } else {
    db.prepare('UPDATE tracks SET key = ?, keySignature = ? WHERE id = ? AND key IS NULL').run(
      key,
      keySignature,
      id,
    )
  }
  return getTrackById(id)
}

// A manually-entered key has no known mode, so it can't stand behind a
// previously-detected full signature — clear it along with any key edit so
// Show Info doesn't keep reporting a now-stale detected signature.
function withKeySignatureReset<T extends { key?: string | null }>(
  tags: T
): T & { keySignature?: null } {
  return 'key' in tags ? { ...tags, keySignature: null } : tags
}

export function updateTrackTags(
  id: number,
  tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre' | 'mood' | 'key'>>
) {
  const resolved = withKeySignatureReset(tags)
  const fields = Object.keys(resolved)
  if (fields.length === 0) return
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE tracks SET ${setClause} WHERE id = @id`).run({ ...resolved, id })
}

export function updateTracksTags(
  ids: number[],
  tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre' | 'mood' | 'key'>>
) {
  const resolved = withKeySignatureReset(tags)
  const fields = Object.keys(resolved)
  if (fields.length === 0 || ids.length === 0) return
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  const stmt = db.prepare(`UPDATE tracks SET ${setClause} WHERE id = @id`)
  const runAll = db.transaction((ids: number[]) => {
    for (const id of ids) stmt.run({ ...resolved, id })
  })
  runAll(ids)
}

export function markPlayed(id: number) {
  db.prepare('UPDATE tracks SET lastPlayedAt = ? WHERE id = ?').run(Date.now(), id)
}

export function getRecentlyPlayed(limit = 50): Track[] {
  return db
    .prepare('SELECT * FROM tracks WHERE lastPlayedAt IS NOT NULL ORDER BY lastPlayedAt DESC LIMIT ?')
    .all(limit) as Track[]
}

export function removeFromRecentlyPlayed(id: number) {
  db.prepare('UPDATE tracks SET lastPlayedAt = NULL WHERE id = ?').run(id)
}

export interface Playlist {
  id: number
  name: string
  createdAt: number
  trackCount: number
  sortOrder: number | null
}

export function createPlaylist(name: string): Playlist {
  const trimmed = name.trim() || 'New Playlist'
  const result = db
    .prepare('INSERT INTO playlists (name, createdAt) VALUES (?, ?)')
    .run(trimmed, Date.now())
  return {
    id: result.lastInsertRowid as number,
    name: trimmed,
    createdAt: Date.now(),
    trackCount: 0,
    sortOrder: null,
  }
}

// Playlists with a manual sortOrder (set by dragging in the Playlists grid)
// sort first, ascending; everything else falls back to newest-created-first,
// same as before "Custom" sort existed.
export function getPlaylists(): Playlist[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.createdAt, p.sortOrder, COUNT(pt.trackId) AS trackCount
       FROM playlists p
       LEFT JOIN playlist_tracks pt ON pt.playlistId = p.id
       GROUP BY p.id
       ORDER BY p.sortOrder IS NULL, p.sortOrder ASC, p.createdAt DESC`
    )
    .all() as Playlist[]
}

export function renamePlaylist(id: number, name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(trimmed, id)
}

export function deletePlaylist(id: number) {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
}

export function reorderPlaylists(orderedIds: number[]) {
  const stmt = db.prepare('UPDATE playlists SET sortOrder = ? WHERE id = ?')
  const runAll = db.transaction((ids: number[]) => {
    ids.forEach((id, i) => stmt.run(i, id))
  })
  runAll(orderedIds)
}

export function getPlaylistTracks(playlistId: number): Track[] {
  return db
    .prepare(
      `SELECT t.* FROM tracks t
       JOIN playlist_tracks pt ON pt.trackId = t.id
       WHERE pt.playlistId = ?
       ORDER BY pt.position`
    )
    .all(playlistId) as Track[]
}

export function addTracksToPlaylist(playlistId: number, trackIds: number[]) {
  if (trackIds.length === 0) return
  const { maxPosition } = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS maxPosition FROM playlist_tracks WHERE playlistId = ?')
    .get(playlistId) as { maxPosition: number }
  const insert = db.prepare(
    'INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position) VALUES (?, ?, ?)'
  )
  const runAll = db.transaction((ids: number[]) => {
    ids.forEach((trackId, i) => insert.run(playlistId, trackId, maxPosition + 1 + i))
  })
  runAll(trackIds)
}

export function removeTracksFromPlaylist(playlistId: number, trackIds: number[]) {
  if (trackIds.length === 0) return
  const del = db.prepare('DELETE FROM playlist_tracks WHERE playlistId = ? AND trackId = ?')
  const runAll = db.transaction((ids: number[]) => {
    for (const trackId of ids) del.run(playlistId, trackId)
  })
  runAll(trackIds)
}

export function reorderPlaylistTracks(playlistId: number, orderedTrackIds: number[]) {
  const stmt = db.prepare(
    'UPDATE playlist_tracks SET position = ? WHERE playlistId = ? AND trackId = ?'
  )
  const runAll = db.transaction((ids: number[]) => {
    ids.forEach((trackId, i) => stmt.run(i, playlistId, trackId))
  })
  runAll(orderedTrackIds)
}

// Advanced tab

// Mirrors the Songs tab's library by default (inLibrary = 1) so the
// Advanced tab isn't empty until the user opts in — inAdvancedLibrary only
// has to do work for isolated-folder tracks, which Include pulls in here
// without exposing them on the Songs tab.
export function getAdvancedTracks(): Track[] {
  return db
    .prepare('SELECT * FROM tracks WHERE inLibrary = 1 OR inAdvancedLibrary = 1 ORDER BY title')
    .all() as Track[]
}

export function setTrackInAdvancedLibrary(id: number, included: number) {
  db.prepare('UPDATE tracks SET inAdvancedLibrary = ? WHERE id = ?').run(included, id)
}

export interface BassInterval {
  id: number
  trackId: number
  sequence: string
}

// Keyed by trackId so a table of mixed tracks can look up its own bass
// intervals in one round trip instead of one query per row.
export function getBassIntervalsForTracks(trackIds: number[]): Record<number, BassInterval[]> {
  const map: Record<number, BassInterval[]> = {}
  if (trackIds.length === 0) return map
  const placeholders = trackIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM bass_intervals WHERE trackId IN (${placeholders}) ORDER BY sortOrder`)
    .all(...trackIds) as BassInterval[]
  for (const row of rows) {
    if (!map[row.trackId]) map[row.trackId] = []
    map[row.trackId].push(row)
  }
  return map
}

export function addBassInterval(trackId: number, sequence: string): BassInterval {
  const { maxOrder } = db
    .prepare('SELECT COALESCE(MAX(sortOrder), -1) AS maxOrder FROM bass_intervals WHERE trackId = ?')
    .get(trackId) as { maxOrder: number }
  const result = db
    .prepare('INSERT INTO bass_intervals (trackId, sequence, sortOrder) VALUES (?, ?, ?)')
    .run(trackId, sequence, maxOrder + 1)
  return { id: result.lastInsertRowid as number, trackId, sequence }
}

export function removeBassInterval(id: number) {
  db.prepare('DELETE FROM bass_intervals WHERE id = ?').run(id)
}
