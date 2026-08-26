import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { upsertTrack, getAllTracks, addFolder, isFolderIsolated, type Track } from './db'

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac'])

function clean(value: string | undefined | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export async function readTrackMetadata(
  filePath: string
): Promise<
  Omit<Track, 'id' | 'dateAdded' | 'lastPlayedAt' | 'inLibrary' | 'customArtPath' | 'key' | 'keySignature' | 'favorite' | 'favoriteAt' | 'mood' | 'inAdvancedLibrary'>
> {
  const meta = await parseFile(filePath)
  const { common, format } = meta
  const stat = await fs.stat(filePath)
  const genre = Array.isArray(common.genre)
    ? common.genre.join(', ')
    : common.genre ?? null

  return {
    filePath,
    title: clean(common.title) ?? path.basename(filePath, path.extname(filePath)),
    artist: clean(common.artist) ?? 'Unknown Artist',
    album: clean(common.album) ?? 'Unknown Album',
    genre: clean(genre) ?? 'Unknown Genre',
    trackNo: common.track?.no ?? null,
    duration: format.duration ?? null,
    hasArt: common.picture && common.picture.length > 0 ? 1 : 0,
    modifiedAt: stat.mtimeMs,
    sortOrder: null,
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full)
    }
  }
  return files
}

export interface ScanResult {
  tracks: Track[]
  // Files seen for the very first time by this scan — the only ones key
  // detection should ever touch. Rescanned/already-known files are excluded
  // so existing data (including a user-entered key) is left alone.
  newTracks: { id: number; filePath: string }[]
}

export async function scanFolder(folderPath: string, isolated?: boolean): Promise<ScanResult> {
  const resolvedIsolated = isolated ?? isFolderIsolated(folderPath)
  addFolder(folderPath, resolvedIsolated ? 1 : 0)
  const files = await walk(folderPath)

  const newTracks: { id: number; filePath: string }[] = []
  for (const filePath of files) {
    try {
      const fields = await readTrackMetadata(filePath)
      const { id, inserted } = upsertTrack({ ...fields, inLibrary: resolvedIsolated ? 0 : 1 })
      if (inserted) newTracks.push({ id, filePath })
    } catch (err) {
      console.error(`Failed to read metadata for ${filePath}:`, err)
    }
  }

  return { tracks: getAllTracks(), newTracks }
}
