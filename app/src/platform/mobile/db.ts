// Android library database — the port of electron/db.ts onto
// @capacitor-community/sqlite. Same tables, same query logic; every function
// is async because the plugin is. The platform boundary is already async, so
// that difference stops here.
//
// Differences from the desktop version, all deliberate:
//   - greenfield schema: one CREATE TABLE per table with every column, no
//     incremental ALTER ladder (a fresh install has nothing to migrate)
//   - no bass_intervals / advanced-library tables (feature is cut on mobile)
//   - folder sort has no filesystem birthtime to fall back on, so it orders
//     by sortOrder then name then path
//   - path-prefix matching (getTracksInFolder / removeFolder) uses plain
//     string comparison; on mobile `filePath` is a content:// URI and the
//     "folder" grouping is defined in Phase 4 (MediaStore)

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import type { SQLiteDBConnection } from '@capacitor-community/sqlite'
import type { Track, Folder, Playlist } from '../types'

const DB_NAME = 'volure'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filePath TEXT UNIQUE NOT NULL,
  title TEXT,
  artist TEXT,
  album TEXT,
  genre TEXT,
  trackNo INTEGER,
  duration REAL,
  hasArt INTEGER NOT NULL DEFAULT 0,
  dateAdded INTEGER NOT NULL,
  modifiedAt INTEGER NOT NULL DEFAULT 0,
  lastPlayedAt INTEGER,
  inLibrary INTEGER NOT NULL DEFAULT 1,
  customArtPath TEXT,
  key TEXT,
  keySignature TEXT,
  sortOrder INTEGER,
  favorite INTEGER NOT NULL DEFAULT 0,
  favoriteAt INTEGER,
  mood TEXT,
  inAdvancedLibrary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  customArtPath TEXT,
  isolated INTEGER NOT NULL DEFAULT 0,
  sortOrder INTEGER
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  sortOrder INTEGER
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlistId INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  trackId INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlistId, trackId)
);
`

// ---- connection ----

let dbPromise: Promise<SQLiteDBConnection> | null = null

async function openDb(): Promise<SQLiteDBConnection> {
  const sqlite = new SQLiteConnection(CapacitorSQLite)
  const consistent = (await sqlite.checkConnectionsConsistency().catch(() => ({ result: false })))
    .result
  const alreadyOpen = (await sqlite.isConnection(DB_NAME, false)).result
  const db =
    consistent && alreadyOpen
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
  await db.open()
  await db.execute('PRAGMA foreign_keys = ON;')
  await db.execute(SCHEMA)
  return db
}

function conn(): Promise<SQLiteDBConnection> {
  if (!dbPromise) dbPromise = openDb()
  return dbPromise
}

async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await conn()
  const res = await db.query(sql, params as never[])
  return (res.values ?? []) as T[]
}

async function first<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await all<T>(sql, params))[0]
}

async function run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastId: number }> {
  const db = await conn()
  const res = await db.run(sql, params as never[])
  return { changes: res.changes?.changes ?? 0, lastId: res.changes?.lastId ?? -1 }
}

// Sequential UPDATEs sharing one statement — the drag-reorder pattern. Wrapped
// in a single transaction by the plugin.
async function runSet(statement: string, rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return
  const db = await conn()
  await db.executeSet(rows.map((values) => ({ statement, values: values as never[] })), true)
}

const TRACK_ORDER = 'ORDER BY artist, album, trackNo, title'

// ---- tracks ----

export async function getAllTracks(): Promise<Track[]> {
  return all<Track>(`SELECT * FROM tracks WHERE inLibrary = 1 ${TRACK_ORDER}`)
}

export async function getTrackById(id: number): Promise<Track | undefined> {
  return first<Track>('SELECT * FROM tracks WHERE id = ?', [id])
}

// Ignores inLibrary so an isolated folder can still be browsed/played.
export async function getTracksInFolder(folderPath: string): Promise<Track[]> {
  return all<Track>(
    `SELECT * FROM tracks WHERE filePath = ? OR filePath LIKE ? ${TRACK_ORDER}`,
    [folderPath, `${folderPath}/%`],
  )
}

export async function searchTracks(query: string): Promise<Track[]> {
  const like = `%${query}%`
  return all<Track>(
    `SELECT * FROM tracks
     WHERE inLibrary = 1 AND (title LIKE ? OR artist LIKE ? OR album LIKE ?)
     ${TRACK_ORDER}`,
    [like, like, like],
  )
}

export async function setTrackInLibrary(id: number, inLibrary: number): Promise<void> {
  await run('UPDATE tracks SET inLibrary = ? WHERE id = ?', [inLibrary, id])
}

export async function setTrackFavorite(id: number, favorite: number): Promise<void> {
  await run('UPDATE tracks SET favorite = ?, favoriteAt = ? WHERE id = ?', [
    favorite,
    favorite ? Date.now() : null,
    id,
  ])
}

export async function setTracksOrder(orderedIds: number[]): Promise<void> {
  await runSet(
    'UPDATE tracks SET sortOrder = ? WHERE id = ?',
    orderedIds.map((id, i) => [i, id]),
  )
}

export async function updateTrackArt(id: number, artPath: string | null): Promise<void> {
  await run('UPDATE tracks SET customArtPath = ? WHERE id = ?', [artPath, id])
}

// Only fills a key that isn't set yet, unless forced — never clobbers a
// user-entered or previously-detected key.
export async function setDetectedKey(
  id: number,
  key: string,
  keySignature: string,
  force = false,
): Promise<Track | undefined> {
  await run(
    `UPDATE tracks SET key = ?, keySignature = ? WHERE id = ?${force ? '' : ' AND key IS NULL'}`,
    [key, keySignature, id],
  )
  return getTrackById(id)
}

type TagFields = Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre' | 'mood' | 'key'>>

// A manually-entered key carries no mode, so clear any stale detected
// signature alongside a key edit.
function withKeySignatureReset(tags: TagFields): TagFields & { keySignature?: null } {
  return 'key' in tags ? { ...tags, keySignature: null } : tags
}

export async function updateTrackTags(id: number, tags: TagFields): Promise<void> {
  const resolved = withKeySignatureReset(tags)
  const fields = Object.keys(resolved)
  if (fields.length === 0) return
  const setClause = fields.map((f) => `${f} = ?`).join(', ')
  await run(`UPDATE tracks SET ${setClause} WHERE id = ?`, [
    ...fields.map((f) => (resolved as Record<string, unknown>)[f]),
    id,
  ])
}

export async function updateTracksTags(ids: number[], tags: TagFields): Promise<void> {
  const resolved = withKeySignatureReset(tags)
  const fields = Object.keys(resolved)
  if (fields.length === 0 || ids.length === 0) return
  const setClause = fields.map((f) => `${f} = ?`).join(', ')
  const values = fields.map((f) => (resolved as Record<string, unknown>)[f])
  await runSet(
    `UPDATE tracks SET ${setClause} WHERE id = ?`,
    ids.map((id) => [...values, id]),
  )
}

export async function markPlayed(id: number): Promise<void> {
  await run('UPDATE tracks SET lastPlayedAt = ? WHERE id = ?', [Date.now(), id])
}

export async function getRecentlyPlayed(limit = 50): Promise<Track[]> {
  return all<Track>(
    'SELECT * FROM tracks WHERE lastPlayedAt IS NOT NULL ORDER BY lastPlayedAt DESC LIMIT ?',
    [limit],
  )
}

export async function removeFromRecentlyPlayed(id: number): Promise<void> {
  await run('UPDATE tracks SET lastPlayedAt = NULL WHERE id = ?', [id])
}

type TrackUpsert = Omit<
  Track,
  'id' | 'dateAdded' | 'lastPlayedAt' | 'customArtPath' | 'key' | 'keySignature'
  | 'favorite' | 'favoriteAt' | 'mood' | 'inAdvancedLibrary' | 'sortOrder'
>

// Used by syncLibrary (Phase 4). inLibrary is left out of the UPDATE branch on
// purpose — a rescan must not undo a manual per-track override.
export async function upsertTrack(track: TrackUpsert): Promise<{ id: number; inserted: boolean }> {
  const existing = await first<{ id: number }>('SELECT id FROM tracks WHERE filePath = ?', [
    track.filePath,
  ])
  if (existing) {
    await run(
      `UPDATE tracks SET title = ?, artist = ?, album = ?, genre = ?, trackNo = ?,
         duration = ?, hasArt = ?, modifiedAt = ? WHERE filePath = ?`,
      [
        track.title, track.artist, track.album, track.genre, track.trackNo,
        track.duration, track.hasArt, track.modifiedAt, track.filePath,
      ],
    )
    return { id: existing.id, inserted: false }
  }
  const res = await run(
    `INSERT INTO tracks (filePath, title, artist, album, genre, trackNo, duration, hasArt, inLibrary, dateAdded, modifiedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      track.filePath, track.title, track.artist, track.album, track.genre, track.trackNo,
      track.duration, track.hasArt, track.inLibrary, Date.now(), track.modifiedAt,
    ],
  )
  return { id: res.lastId, inserted: true }
}

// ---- folders ----

export async function addFolder(folderPath: string, isolated = 0): Promise<void> {
  await run('INSERT OR IGNORE INTO folders (path, isolated) VALUES (?, ?)', [folderPath, isolated])
}

// Desktop falls back to filesystem birthtime; mobile has none, so: manual
// order first, then name, then path.
export async function getFolders(): Promise<Folder[]> {
  return all<Folder>(
    `SELECT * FROM folders
     ORDER BY sortOrder IS NULL, sortOrder ASC, COALESCE(name, path), path`,
  )
}

export async function renameFolder(folderPath: string, name: string): Promise<void> {
  await run('UPDATE folders SET name = ? WHERE path = ?', [name.trim() || null, folderPath])
}

export async function updateFolderArt(folderPath: string, artPath: string | null): Promise<void> {
  await run('UPDATE folders SET customArtPath = ? WHERE path = ?', [artPath, folderPath])
}

export async function reorderFolders(orderedPaths: string[]): Promise<void> {
  await runSet(
    'UPDATE folders SET sortOrder = ? WHERE path = ?',
    orderedPaths.map((p, i) => [i, p]),
  )
}

// Only forgets the folder and the tracks found under it — never touches the
// device. FK cascade clears any playlist entries for those tracks.
export async function removeFolder(folderPath: string): Promise<void> {
  await run('DELETE FROM tracks WHERE filePath = ? OR filePath LIKE ?', [
    folderPath,
    `${folderPath}/%`,
  ])
  await run('DELETE FROM folders WHERE path = ?', [folderPath])
}

// ---- playlists ----

const PLAYLIST_SELECT = `
  SELECT p.id, p.name, p.createdAt, p.sortOrder, COUNT(pt.trackId) AS trackCount
  FROM playlists p
  LEFT JOIN playlist_tracks pt ON pt.playlistId = p.id
  GROUP BY p.id
  ORDER BY p.sortOrder IS NULL, p.sortOrder ASC, p.createdAt DESC
`

export async function getPlaylists(): Promise<Playlist[]> {
  return all<Playlist>(PLAYLIST_SELECT)
}

export async function createPlaylist(name: string): Promise<Playlist> {
  const trimmed = name.trim() || 'New Playlist'
  const now = Date.now()
  const res = await run('INSERT INTO playlists (name, createdAt) VALUES (?, ?)', [trimmed, now])
  return { id: res.lastId, name: trimmed, createdAt: now, trackCount: 0, sortOrder: null }
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  await run('UPDATE playlists SET name = ? WHERE id = ?', [trimmed, id])
}

export async function deletePlaylist(id: number): Promise<void> {
  await run('DELETE FROM playlists WHERE id = ?', [id])
}

export async function reorderPlaylists(orderedIds: number[]): Promise<void> {
  await runSet(
    'UPDATE playlists SET sortOrder = ? WHERE id = ?',
    orderedIds.map((id, i) => [i, id]),
  )
}

export async function getPlaylistTracks(playlistId: number): Promise<Track[]> {
  return all<Track>(
    `SELECT t.* FROM tracks t
     JOIN playlist_tracks pt ON pt.trackId = t.id
     WHERE pt.playlistId = ?
     ORDER BY pt.position`,
    [playlistId],
  )
}

export async function addTracksToPlaylist(playlistId: number, trackIds: number[]): Promise<void> {
  if (trackIds.length === 0) return
  const row = await first<{ maxPosition: number }>(
    'SELECT COALESCE(MAX(position), -1) AS maxPosition FROM playlist_tracks WHERE playlistId = ?',
    [playlistId],
  )
  const base = (row?.maxPosition ?? -1) + 1
  await runSet(
    'INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position) VALUES (?, ?, ?)',
    trackIds.map((trackId, i) => [playlistId, trackId, base + i]),
  )
}

export async function removeTracksFromPlaylist(playlistId: number, trackIds: number[]): Promise<void> {
  if (trackIds.length === 0) return
  await runSet(
    'DELETE FROM playlist_tracks WHERE playlistId = ? AND trackId = ?',
    trackIds.map((trackId) => [playlistId, trackId]),
  )
}

export async function reorderPlaylistTracks(
  playlistId: number,
  orderedTrackIds: number[],
): Promise<void> {
  await runSet(
    'UPDATE playlist_tracks SET position = ? WHERE playlistId = ? AND trackId = ?',
    orderedTrackIds.map((trackId, i) => [i, playlistId, trackId]),
  )
}
