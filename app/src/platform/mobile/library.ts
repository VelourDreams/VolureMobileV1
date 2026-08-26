// syncLibrary + getArt — the MediaStore side of the platform boundary.
// Reads the device music library through VolureLibraryPlugin, maps each row
// into Volure's Track shape, and mirrors it into SQLite.

import type { Track, TrackArt } from '../types'
import * as db from './db'
import { VolureLibrary, type MediaStoreTrack } from './plugins'

function toUpsert(r: MediaStoreTrack) {
  return {
    filePath: r.uri,
    title: r.title || null,
    artist: r.artist || null,
    album: r.album || null,
    genre: r.genre || null,
    trackNo: r.trackNo || null,
    // MediaStore reports milliseconds; Track.duration is seconds (matches the
    // desktop music-metadata value).
    duration: r.durationMs > 0 ? r.durationMs / 1000 : null,
    // Optimistic — getArt falls back to null per track when there's no artwork.
    hasArt: 1,
    modifiedAt: r.dateModifiedSec * 1000,
    inLibrary: 1,
  }
}

export async function syncLibrary(): Promise<Track[]> {
  let rows: MediaStoreTrack[]
  try {
    rows = (await VolureLibrary.queryAudio()).tracks
  } catch (err) {
    // Permission denied, or the query failed — keep whatever's already cached.
    console.error('[volure] music library sync failed:', err)
    return db.getAllTracks()
  }
  await db.bulkUpsertTracks(rows.map(toUpsert))
  await db.pruneTracksNotIn(rows.map((r) => r.uri))
  return db.getAllTracks()
}

// `filePath` is a content:// URI; its trailing segment is the MediaStore id.
export async function getArt(filePath: string): Promise<TrackArt | null> {
  const id = filePath.split('/').pop() ?? ''
  if (!/^\d+$/.test(id)) return null
  try {
    const res = await VolureLibrary.getArt({ id })
    if (!res.data) return null
    return { format: res.format ?? 'image/jpeg', data: res.data }
  } catch {
    return null
  }
}
