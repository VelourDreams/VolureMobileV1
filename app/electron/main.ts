import { app, BrowserWindow, ipcMain, dialog, protocol, globalShortcut, session, desktopCapturer, shell, screen, clipboard, nativeImage } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import https from 'node:https'
import { parseFile } from 'music-metadata'
import ffmpegPath from 'ffmpeg-static'
import { autoUpdater } from 'electron-updater'
import { scanFolder, readTrackMetadata, AUDIO_EXTENSIONS } from './scanner'
import type { AudioExportFormat } from './audio'
import {
  getAllTracks,
  searchTracks,
  updateTrackTags,
  updateTracksTags,
  updateTrackArt,
  setTrackInLibrary,
  setTrackFavorite,
  setDetectedKey,
  markPlayed,
  getRecentlyPlayed,
  removeFromRecentlyPlayed,
  upsertTrack,
  isPathInLibraryFolder,
  getTrackById,
  getFolders,
  getTracksInFolder,
  renameFolder,
  removeFolder,
  updateFolderArt,
  createPlaylist,
  getPlaylists,
  renamePlaylist,
  deletePlaylist,
  getPlaylistTracks,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  reorderPlaylistTracks,
  reorderPlaylists,
  reorderFolders,
  setTracksOrder,
  getAdvancedTracks,
  setTrackInAdvancedLibrary,
  getBassIntervalsForTracks,
  addBassInterval,
  removeBassInterval,
  type Folder,
  type Track,
  db,
} from './db'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { stream: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true },
  },
])

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

const AUDIO_EXPORT_FILTERS: Record<AudioExportFormat, { name: string; extensions: string[] }> = {
  wav: { name: 'WAV Audio', extensions: ['wav'] },
  mp3: { name: 'MP3 Audio', extensions: ['mp3'] },
  flac: { name: 'FLAC Audio', extensions: ['flac'] },
}

// fs.rename is atomic but fails across drives/volumes (EXDEV), which a "Save
// As" dialog can easily point at (e.g. exporting to a USB drive or a OneDrive
// mount) — fall back to copy+delete in that case.
async function moveIntoPlace(sourcePath: string, destPath: string) {
  try {
    await fsp.rename(sourcePath, destPath)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // EXDEV is a cross-device rename. EPERM/EBUSY show up on Windows when
    // destPath is the file currently loaded/streaming in the player (an open
    // read handle from the media:// protocol handler blocks rename, which
    // needs exclusive access, even though the file's content can still be
    // overwritten in place).
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EBUSY') throw error
  }
  await fsp.copyFile(sourcePath, destPath)
  await fsp.unlink(sourcePath)
}

// Downloads a file over HTTPS, following redirects (GitHub release assets
// resolve through a couple of redirects to the actual object storage URL).
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (requestUrl: string, redirectsLeft: number) => {
      https
        .get(requestUrl, { headers: { 'User-Agent': 'volure' } }, (res) => {
          const location = res.headers.location
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
            res.resume()
            if (redirectsLeft <= 0) {
              reject(new Error('Too many redirects'))
              return
            }
            request(location, redirectsLeft - 1)
            return
          }
          if (res.statusCode !== 200) {
            res.resume()
            reject(new Error(`Download failed: HTTP ${res.statusCode}`))
            return
          }
          const file = fs.createWriteStream(destPath)
          res.pipe(file)
          file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())))
          file.on('error', reject)
        })
        .on('error', reject)
    }
    request(url, 5)
  })
}

// Backs the Studio "Converter" tab (see the ipcMain handler below) — yt-dlp
// is a standalone binary, not an npm package, since it needs to keep pace
// with YouTube's frequent obfuscation changes (much faster release cadence
// than any JS port). Downloaded once into userData and cached there,
// mirroring how ffmpeg-static ships its own binary.
async function ensureYtDlpBinary(): Promise<string> {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const binPath = path.join(app.getPath('userData'), binName)
  if (fs.existsSync(binPath)) return binPath

  const assetName =
    process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp'
  const scratchPath = `${binPath}.download`
  await downloadFile(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`, scratchPath)
  if (process.platform !== 'win32') await fsp.chmod(scratchPath, 0o755)
  await moveIntoPlace(scratchPath, binPath)
  return binPath
}

// Used by library:stageScreenRecording below to write a just-finished
// recording to destPath: an MP4 source from MediaRecorder is already the
// right container, so it's written straight through; a WebM (VP9/VP8+Opus)
// source is transcoded via ffmpeg. Scratch-then-move so a failed
// write/transcode never leaves a broken file at destPath.
async function writeRecordingBufferToFile(
  data: ArrayBuffer,
  sourceContainer: 'mp4' | 'webm',
  destPath: string
) {
  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'volure-recording-'))
  try {
    if (sourceContainer === 'mp4') {
      const scratchPath = path.join(scratchDir, 'out.mp4')
      await fsp.writeFile(scratchPath, Buffer.from(data))
      await moveIntoPlace(scratchPath, destPath)
      return
    }

    if (!ffmpegPath) throw new Error('ffmpeg is not available on this platform')
    const ffmpeg = ffmpegPath
    const sourcePath = path.join(scratchDir, 'source.webm')
    const scratchOutputPath = path.join(scratchDir, 'out.mp4')
    await fsp.writeFile(sourcePath, Buffer.from(data))
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpeg,
        [
          '-y',
          '-i',
          sourcePath,
          '-c:v',
          'libx264',
          // "ultrafast" trades bitrate efficiency for encode speed — the
          // user is actively waiting on this (either a Save As dialog or
          // the recording loading into the Video Viewer), not a background
          // cache warm like library:ensurePlayableVideo's own transcode.
          '-preset',
          'ultrafast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          scratchOutputPath,
        ],
        { windowsHide: true },
        (error: Error | null, _stdout: string, stderr: string) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()
      )
    })
    const outputStat = await fsp.stat(scratchOutputPath).catch(() => null)
    if (!outputStat || outputStat.size === 0) {
      throw new Error('ffmpeg produced an empty mp4 file')
    }
    await moveIntoPlace(scratchOutputPath, destPath)
  } finally {
    await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  }
}

function supportsDirectMetadataRewrite(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.mp3' || ext === '.flac'
}

function metadataWriteArgs(tags: Partial<Pick<Track, 'title' | 'artist' | 'album'>>): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined) continue
    args.push('-metadata', `${key}=${String(value ?? '')}`)
  }
  return args
}

// ffmpeg's mp3 muxer defaults to ID3v2.4, which a fair number of tools
// (older taggers, some Windows Explorer builds, some car/hardware players)
// still don't parse correctly — its synchsafe frame sizes get misread as
// plain integers, corrupting or hiding an otherwise-valid APIC/title frame.
// ID3v2.3 is the more universally understood target, and FLAC's own Vorbis
// comment + METADATA_BLOCK_PICTURE tagging has no equivalent versioning
// pitfall, so this only needs to apply to mp3 output.
function id3CompatArgs(filePath: string): string[] {
  return path.extname(filePath).toLowerCase() === '.mp3' ? ['-id3v2_version', '3'] : []
}

async function rewriteTrackMetadataFields(
  filePath: string,
  tags: Partial<Pick<Track, 'title' | 'artist' | 'album'>>,
) {
  if (!supportsDirectMetadataRewrite(filePath)) return false
  const metadataArgs = metadataWriteArgs(tags)
  if (metadataArgs.length === 0) return false
  if (!ffmpegPath) throw new Error('ffmpeg is not available on this platform')
  const ffmpeg = ffmpegPath

  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  // Keep the real extension on the end so ffmpeg can infer the output muxer
  // from the filename (it can't otherwise, since -f isn't passed here).
  const tempPath = path.join(dir, `.volure-tmp-${Date.now()}-${Math.random().toString(16).slice(2)}-${base}`)

  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpeg,
      [
        '-y',
        '-i',
        filePath,
        '-map_metadata',
        '0',
        ...metadataArgs,
        '-c',
        'copy',
        ...id3CompatArgs(filePath),
        tempPath,
      ],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`FFmpeg metadata rewrite failed for ${filePath}: ${stderr || error.message}`))
          return
        }
        resolve()
      },
    )
  })

  await moveIntoPlace(tempPath, filePath)
  return true
}

async function rewriteTrackArtTag(filePath: string, artPath: string) {
  if (!supportsDirectMetadataRewrite(filePath)) return false
  if (!ffmpegPath) throw new Error('ffmpeg is not available on this platform')
  const ffmpeg = ffmpegPath

  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  // Keep the real extension on the end so ffmpeg can infer the output muxer
  // from the filename (it can't otherwise, since -f isn't passed here).
  const tempPath = path.join(dir, `.volure-art-${Date.now()}-${Math.random().toString(16).slice(2)}-${base}`)

  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpeg,
      [
        '-y',
        '-i',
        filePath,
        '-i',
        artPath,
        '-map',
        '0:a',
        '-map',
        '1:v',
        '-c:a',
        'copy',
        '-c:v',
        'mjpeg',
        '-disposition:v',
        'attached_pic',
        '-metadata:s:v',
        'title=Album cover',
        '-metadata:s:v',
        'comment=Cover (front)',
        '-map_metadata',
        '0',
        ...id3CompatArgs(filePath),
        tempPath,
      ],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`FFmpeg cover-art rewrite failed for ${filePath}: ${stderr || error.message}`))
          return
        }
        resolve()
      },
    )
  })

  await moveIntoPlace(tempPath, filePath)
  return true
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
// Keep the repository layout for development, but use Electron's resources
// directory after installation. The installer copies the shared assets there.
const ASSET_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(app.getAppPath(), '..', 'assets')
const BACKGROUND_IMAGES_DIR = path.join(ASSET_ROOT, 'images', 'backgrounds')
// The Play tab's piano is driven by a single one-shot sample (tuned to C6),
// pitch-shifted per key in the renderer. Same repo-root-relative layout as
// the background images above.
const PLAY_SAMPLE_PATH = path.join(
  ASSET_ROOT,
  'audio',
  'play-samples',
  'default-sample1.wav',
)
const PLAY_SAMPLE2_PATH = path.join(
  ASSET_ROOT,
  'audio',
  'play-samples',
  'default-sample2-c3.wav',
)
const PLAY_SAMPLE3_PATH = path.join(
  ASSET_ROOT,
  'audio',
  'play-samples',
  'default-sample3-c4.wav',
)
const PLAY_SAMPLE4_PATH = path.join(
  ASSET_ROOT,
  'audio',
  'play-samples',
  'default-sample3-g4.wav',
)
// Live-recording indicator in Studio. Same repo-root-relative layout as the
// background images and play samples above.
const WAVE_LOTTIE_PATH = path.join(ASSET_ROOT, 'images', 'lotties', 'wave1.lottie')
// Studio's Listen tab — shown while capturing audio to detect its key.
const LISTENING_LOTTIE_PATH = path.join(ASSET_ROOT, 'images', 'lotties', 'listening.lottie')

function getDeveloperLayoutPath() {
  return path.join(app.getPath('userData'), 'developer-layout.json')
}

function getDeveloperElementLayoutPath() {
  return path.join(app.getPath('userData'), 'developer-element-layout.json')
}

async function readDeveloperLayout(): Promise<unknown | null> {
  try {
    const file = await fsp.readFile(getDeveloperLayoutPath(), 'utf8')
    return JSON.parse(file)
  } catch {
    return null
  }
}

async function writeDeveloperLayout(layout: unknown) {
  await fsp.mkdir(path.dirname(getDeveloperLayoutPath()), { recursive: true })
  await fsp.writeFile(getDeveloperLayoutPath(), `${JSON.stringify(layout, null, 2)}\n`, 'utf8')
}

async function readDeveloperElementLayout(): Promise<unknown | null> {
  try {
    const file = await fsp.readFile(getDeveloperElementLayoutPath(), 'utf8')
    return JSON.parse(file)
  } catch {
    return null
  }
}

async function writeDeveloperElementLayout(layout: unknown) {
  await fsp.mkdir(path.dirname(getDeveloperElementLayoutPath()), { recursive: true })
  await fsp.writeFile(getDeveloperElementLayoutPath(), `${JSON.stringify(layout, null, 2)}\n`, 'utf8')
}

function layoutBoxToCssRule(selector: string, box: { left: number; top: number; width: number; height: number }): string {
  return `${selector} {\n  left: ${box.left}%;\n  top: ${box.top}%;\n  width: ${box.width}%;\n  height: ${box.height}%;\n}\n`
}

async function exportDeveloperLayoutCss(layout: unknown): Promise<string | null> {
  if (!layout || typeof layout !== 'object') return null
  const typed = layout as Record<string, { left: number; top: number; width: number; height: number }>
  const css = [
    '/* Generated by Volure Developer Mode */',
    '.app.developer-mode .toolbar,',
    '.app.developer-mode .sidebar,',
    '.app.developer-mode .studio-view,',
    '.app.developer-mode .play-view,',
    '.app.developer-mode .library,',
    '.app.developer-mode .playback-bar {',
    '  position: absolute;',
    '}',
    typed.toolbar ? layoutBoxToCssRule('.app.developer-mode .toolbar', typed.toolbar) : '',
    typed.sidebar ? layoutBoxToCssRule('.app.developer-mode .sidebar', typed.sidebar) : '',
    typed.library ? layoutBoxToCssRule('.app.developer-mode .library', typed.library) : '',
    typed.studio ? layoutBoxToCssRule('.app.developer-mode .studio-view', typed.studio) : '',
    typed.play ? layoutBoxToCssRule('.app.developer-mode .play-view', typed.play) : '',
    typed.playback ? layoutBoxToCssRule('.app.developer-mode .playback-bar', typed.playback) : '',
  ].filter(Boolean).join('\n')

  const filePath = path.join(app.getPath('userData'), 'developer-layout.css')
  await fsp.writeFile(filePath, `${css}\n`, 'utf8')
  return filePath
}

const DEVELOPER_ELEMENT_SELECTORS: Record<string, string> = {
  headerBackButton: '[data-developer-id="headerBackButton"]',
  sidebarToggleButton: '[data-developer-id="sidebarToggleButton"]',
  nightModeToggle: '[data-developer-id="nightModeToggle"]',
  eqBackButton: '[data-developer-id="eqBackButton"]',
  fullscreenKeyBadge: '[data-developer-id="fullscreenKeyBadge"]',
  fullscreenEqualizerButton: '[data-developer-id="fullscreenEqualizerButton"]',
  fullscreenFavoriteButton: '[data-developer-id="fullscreenFavoriteButton"]',
  studioKeyBadge: '[data-developer-id="studioKeyBadge"]',
  playKeyBadge: '[data-developer-id="playKeyBadge"]',
  nowPlayingBackButton: '[data-developer-id="nowPlayingBackButton"]',
  nowPlayingArt: '[data-developer-id="nowPlayingArt"]',
  recordButton: '[data-developer-id="recordButton"]',
  shuffleButton: '[data-developer-id="shuffleButton"]',
  prevButton: '[data-developer-id="prevButton"]',
  playPauseButton: '[data-developer-id="playPauseButton"]',
  nextButton: '[data-developer-id="nextButton"]',
  loopButton: '[data-developer-id="loopButton"]',
  volumeButton: '[data-developer-id="volumeButton"]',
}

async function exportDeveloperElementLayoutCss(layout: unknown): Promise<string | null> {
  if (!layout || typeof layout !== 'object') return null
  const typed = layout as Record<string, { left: number; top: number; width: number; height: number }>
  const css = [
    '/* Generated by Volure Developer Mode */',
    ...Object.entries(DEVELOPER_ELEMENT_SELECTORS).flatMap(([id, selector]) => {
      const box = typed[id]
      if (!box) return []
      return [
        `${selector} {`,
        '  position: fixed;',
        `  left: ${box.left}%;`,
        `  top: ${box.top}%;`,
        `  width: ${box.width}%;`,
        `  height: ${box.height}%;`,
        '}',
      ]
    }),
  ].join('\n')

  const filePath = path.join(app.getPath('userData'), 'developer-element-layout.css')
  await fsp.writeFile(filePath, `${css}\n`, 'utf8')
  return filePath
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: 'rgba(0, 0, 0, 0)',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: 'rgba(0, 0, 0, 0)', symbolColor: '#ffffff' },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium throttles timers/rAF/Audio playback in this renderer once
      // the window is occluded or unfocused — exactly the state a delayed
      // screenshot (or the screen recorder's own countdown) runs in when
      // the user switches away to line up their shot. Without this, the
      // countdown tick, the capture, and its shutter sound all stall until
      // the window is focused again.
      backgroundThrottling: false,
    },
  })

  // Wait for the first real paint before showing the window. Showing
  // immediately races Chromium's draggable-region hit-testing (see
  // -webkit-app-region in App.css): the window becomes interactive before
  // the OS has the correct no-drag regions for header buttons like the
  // night-mode toggle and sidebar toggle, so early clicks on them get
  // swallowed as titlebar drags instead of reaching the renderer.
  win.once('ready-to-show', () => {
    win.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.alt && input.key?.toLowerCase() === 'd') {
      event.preventDefault()
      win.webContents.send('developer:toggle')
      return
    }
    if (input.key === 'F11' && input.type === 'keyDown') {
      event.preventDefault()
      win.setFullScreen(!win.isFullScreen())
    }
  })

  win.on('enter-full-screen', () => {
    win.webContents.send('window:fullscreenChange', true)
  })
  win.on('leave-full-screen', () => {
    win.webContents.send('window:fullscreenChange', false)
  })

  return win
}

let mainWindow: BrowserWindow | null = null
// Small always-on-top, click-through window that mirrors the in-app
// screenshot countdown outside the main Volure window (top-right of the
// primary display) — lets the user switch to whatever they're capturing
// while still seeing how long they have left.
let screenshotCountdownWindow: BrowserWindow | null = null
let screenshotCountdownReady = false
let screenshotCountdownPendingText: string | null = null

function setScreenshotCountdownText(win: BrowserWindow, text: string) {
  win.webContents
    .executeJavaScript(`document.getElementById('n').textContent = ${JSON.stringify(text)}`)
    .catch(() => {})
}

function ensureScreenshotCountdownWindow(): BrowserWindow {
  if (screenshotCountdownWindow && !screenshotCountdownWindow.isDestroyed()) {
    return screenshotCountdownWindow
  }
  const size = 64
  const margin = 24
  const workArea = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    width: size,
    height: size,
    x: workArea.x + workArea.width - size - margin,
    y: workArea.y + margin,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    show: false,
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  screenshotCountdownReady = false
  win.webContents.once('did-finish-load', () => {
    screenshotCountdownReady = true
    if (screenshotCountdownPendingText !== null) {
      setScreenshotCountdownText(win, screenshotCountdownPendingText)
      win.showInactive()
    }
  })
  win.loadURL(
    'data:text/html,' +
      encodeURIComponent(`<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">
<div id="n" style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;
font:700 26px -apple-system,Segoe UI,sans-serif;color:#fff;background:rgba(0,0,0,0.6);
border-radius:999px;border:2px solid rgba(255,255,255,0.3);box-sizing:border-box"></div>
</body></html>`)
  )
  win.on('closed', () => {
    if (screenshotCountdownWindow === win) screenshotCountdownWindow = null
    screenshotCountdownReady = false
    screenshotCountdownPendingText = null
  })
  screenshotCountdownWindow = win
  return win
}

function configureAutoUpdater() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (error) => {
    console.error('Volure update failed:', error)
  })

  autoUpdater.on('update-downloaded', async () => {
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Volure update ready',
      message: 'A new version of Volure is ready to install.',
      detail: 'Restart Volure now to finish updating.',
    })
    if (result.response === 0) autoUpdater.quitAndInstall()
  })

  void autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    console.error('Volure update check failed:', error)
  })
}

app.whenReady().then(() => {
  protocol.handle('media', async (request) => {
    const filePath = decodeURIComponent(request.url.slice('media://'.length).split('?')[0])
    const stat = await fsp.stat(filePath)
    const mimeType = mimeTypeFor(filePath)

    // Matches both a normal "bytes=<start>-[end]" range and a suffix range
    // "bytes=-<length>" (last N bytes, no start digit) — Chromium's media
    // pipeline uses the latter to locate the moov atom in MP4s that aren't
    // "fast-start" optimized (common for camera/phone output), so without
    // this the request silently fell through to the full-200-response
    // branch below and the video would hang forever with no error.
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('Range') ?? '')
    if (range && (range[1] || range[2])) {
      let start: number
      let end: number
      if (range[1]) {
        start = Number(range[1])
        end = range[2] ? Number(range[2]) : stat.size - 1
      } else {
        const suffixLength = Number(range[2])
        start = Math.max(stat.size - suffixLength, 0)
        end = stat.size - 1
      }
      const stream = Readable.toWeb(
        fs.createReadStream(filePath, { start, end })
      ) as NodeWebReadableStream
      return new Response(stream as unknown as ReadableStream<Uint8Array>, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': mimeType,
          'Cache-Control': 'no-store',
        },
      })
    }

    const stream = Readable.toWeb(fs.createReadStream(filePath)) as NodeWebReadableStream
    return new Response(stream as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        'Content-Length': String(stat.size),
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    })
  })

  // Chromium computes the frameless window's draggable region (see
  // -webkit-app-region in App.css) asynchronously relative to the
  // renderer's paints. createWindow()'s ready-to-show wait already guards
  // the startup race; this does the same for later layout changes — e.g.
  // switching to the Studio/Play tabs swaps the header's back button in
  // and resizes the title text, and without a nudge here Chromium can
  // keep hit-testing that screen area against the stale pre-switch
  // region for a moment, so a click on the (now no-drag) button gets
  // eaten as a titlebar drag instead of reaching the renderer. A no-op
  // bounds reset forces Chromium to recompute the region against the
  // current layout.
  ipcMain.handle('window:nudgeDragRegion', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.setBounds(win.getBounds())
  })

  ipcMain.handle('window:isFullscreen', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  })

  ipcMain.handle('window:exitFullscreen', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.setFullScreen(false)
  })

  ipcMain.handle('window:enterFullscreen', (event) => {
    // setFullScreen(true) already fills the whole screen; skipping an
    // explicit maximize() keeps the pre-fullscreen bounds Electron restores
    // on setFullScreen(false) equal to the window's actual original size,
    // not a maximized one.
    BrowserWindow.fromWebContents(event.sender)?.setFullScreen(true)
  })

  // setTitleBarOverlay is Windows/Linux-only — the overlay buttons are drawn
  // natively over the frameless window, so their contrast against light
  // image content can only be adjusted through this API, not CSS.
  ipcMain.handle('window:setTitleBarOverlay', (event, overlay: { color: string; symbolColor: string }) => {
    if (process.platform === 'darwin') return
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay(overlay)
  })

  ipcMain.handle('shell:showItemInFolder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  // Backs every navigator.mediaDevices.getDisplayMedia() call in the
  // renderer — Studio's internal-audio ("record what you hear") capture and
  // the Play view's screen recorder alike — with a handler that resolves
  // silently instead of showing Chromium's own screen/window picker UI.
  // Use a real screen source for the Play-view screen recorder so it captures
  // the entire desktop rather than only the Volure app window. Studio's
  // internal-audio capture discards the video track anyway, so it still works
  // with the same handler and loopback audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // Capture the full primary display (or the first available screen) — the
      // video source is only a spec requirement for getDisplayMedia, and the
      // actual video track is immediately stopped & saved by the recorder.
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
        const primaryDisplayId = screen.getPrimaryDisplay().id
        const source =
          sources.find((s) => Number(s.display_id) === Number(primaryDisplayId)) ??
          sources[0]
        if (!source) {
          callback({})
          return
        }
        callback({ video: source, audio: 'loopback' })
      })
    },
    { useSystemPicker: false }
  )

  ipcMain.handle('dialog:selectFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:selectImage', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:selectViewerImage', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('screen:takeScreenshot', async (_event, seconds: number) => {
    const delayMs = Math.max(0, Number(seconds) || 0) * 1000
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    })
    const primaryDisplayId = screen.getPrimaryDisplay().id
    const source =
      sources.find((item) => Number(item.display_id) === primaryDisplayId) ??
      sources.find((item) => Number(item.display_id) === Number(primaryDisplayId)) ??
      sources[0]

    if (!source) throw new Error('No screen available for capture')

    const screenshotDir = path.join(app.getPath('pictures'), 'Volure Screenshots')
    await fsp.mkdir(screenshotDir, { recursive: true })
    const fileName = `volure-screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    const filePath = path.join(screenshotDir, fileName)
    await fsp.writeFile(filePath, source.thumbnail.toPNG())
    return filePath
  })

  // Drives the floating top-right countdown badge (see
  // ensureScreenshotCountdownWindow) — the renderer sends the remaining
  // whole seconds on every tick of its own countdown, or null to hide it.
  // Closing it here (rather than leaving it up) matters: it must be gone
  // before screen:takeScreenshot's capture fires, or it'd show up baked
  // into the screenshot itself.
  ipcMain.on('screenshot-countdown:set', (_event, seconds: number | null) => {
    if (seconds === null) {
      screenshotCountdownPendingText = null
      if (screenshotCountdownWindow && !screenshotCountdownWindow.isDestroyed()) {
        screenshotCountdownWindow.close()
      }
      return
    }
    const text = String(seconds)
    screenshotCountdownPendingText = text
    const win = ensureScreenshotCountdownWindow()
    if (!screenshotCountdownReady) return
    setScreenshotCountdownText(win, text)
    if (!win.isVisible()) win.showInactive()
  })

  // Image Viewer's Save button — a plain converter/export. The renderer has
  // already done all the pixel work (crop + PNG/JPEG encode via canvas), so
  // this just prompts for a destination and writes the bytes through, same
  // scratch-then-move safety as dialog:saveAudioFile above.
  ipcMain.handle(
    'dialog:saveImageFile',
    async (_event, defaultName: string, data: ArrayBuffer, format: 'png' | 'jpg') => {
      if (data.byteLength === 0) throw new Error('Nothing to export: image was empty')

      const result = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [
          format === 'png'
            ? { name: 'PNG Image', extensions: ['png'] }
            : { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
        ],
      })
      if (result.canceled || !result.filePath) return null

      const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'volure-image-'))
      try {
        const scratchPath = path.join(scratchDir, `out.${format}`)
        await fsp.writeFile(scratchPath, Buffer.from(data))
        await moveIntoPlace(scratchPath, result.filePath)
        return result.filePath
      } finally {
        await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  )

  ipcMain.handle('dialog:selectViewerVideo', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'mov'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:selectAudioFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'dialog:saveAudioFile',
    async (
      _event,
      defaultName: string,
      data: ArrayBuffer,
      format: AudioExportFormat = 'wav',
      // What container `data` is actually encoded as. Defaults to 'wav' since
      // that's what the Studio EQ/speed/reverse render always produces; a
      // plain format-conversion save (no processing, e.g. a file dropped
      // straight into Studio) hands over the source file's own bytes as-is
      // and names its real container here instead.
      sourceExt: string = 'wav'
    ) => {
      if (data.byteLength === 0) throw new Error('Nothing to export: source audio was empty')

      const result = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [AUDIO_EXPORT_FILTERS[format]],
      })
      if (result.canceled || !result.filePath) return null

      // Every format is produced at a scratch path first and only moved into
      // the user's chosen destination once we've confirmed it's non-empty, so
      // a failed render/transcode can never leave a broken 0-byte file at the
      // path the user picked.
      const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'volure-export-'))
      try {
        if (format === sourceExt) {
          // Already the right container — write the bytes through untouched.
          const scratchPath = path.join(scratchDir, `out.${format}`)
          await fsp.writeFile(scratchPath, Buffer.from(data))
          await moveIntoPlace(scratchPath, result.filePath)
          return result.filePath
        }

        // Any other conversion is shelled out to ffmpeg.
        if (!ffmpegPath) throw new Error('ffmpeg is not available on this platform')
        const ffmpeg = ffmpegPath
        const sourcePath = path.join(scratchDir, `source.${sourceExt}`)
        const scratchOutputPath = path.join(scratchDir, `out.${format}`)
        await fsp.writeFile(sourcePath, Buffer.from(data))
        const codecArgs =
          format === 'mp3'
            ? ['-codec:a', 'libmp3lame', '-q:a', '2']
            : format === 'flac'
              ? ['-codec:a', 'flac']
              : ['-codec:a', 'pcm_s16le']
        await new Promise<void>((resolve, reject) => {
          execFile(
            ffmpeg,
            ['-y', '-i', sourcePath, ...codecArgs, scratchOutputPath],
            (error: Error | null, _stdout: string, stderr: string) =>
              error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()
          )
        })
        const outputStat = await fsp.stat(scratchOutputPath).catch(() => null)
        if (!outputStat || outputStat.size === 0) {
          throw new Error(`ffmpeg produced an empty ${format} file`)
        }
        await moveIntoPlace(scratchOutputPath, result.filePath)
        return result.filePath
      } finally {
        await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  )

  // Backs the Studio "Converter" tab — a developer-only tool, not part of the
  // shipped app (kept out of the official launch for legal reasons: no
  // rights to redistribute YouTube audio). Shells out to yt-dlp (see
  // ensureYtDlpBinary above) rather than a JS library — YouTube changes its
  // player obfuscation often enough that JS ports fall behind; yt-dlp ships
  // fixes far faster. yt-dlp does the extract-audio-and-transcode step
  // itself via --ffmpeg-location, reusing the ffmpeg-static binary already
  // bundled for Studio's own exports.
  //
  // player_client=android: YouTube now requires a "PO token" to serve
  // audio-only formats on most clients (ios/web/tv) without one, which
  // yt-dlp doesn't provide out of the box — those clients only expose
  // thumbnail-only "formats". The android client is still willing to hand
  // back a muxed (audio+video) format without one, so that's what's
  // requested here; ffmpeg then discards the video track during the audio
  // extract. --js-runtimes node lets yt-dlp solve YouTube's JS signature
  // challenge using the system's own Node instead of requiring Deno.
  const YTDLP_CLIENT_ARGS = ['--js-runtimes', 'node', '--extractor-args', 'youtube:player_client=android']

  ipcMain.handle(
    'converter:downloadYoutubeAudio',
    async (_event, url: string, format: AudioExportFormat = 'mp3') => {
      if (!/^https?:\/\/(www\.|music\.)?(youtube\.com|youtu\.be)\//i.test(url.trim())) {
        throw new Error("That doesn't look like a valid YouTube URL")
      }
      if (!ffmpegPath) throw new Error('ffmpeg is not available on this platform')
      const ffmpeg = ffmpegPath
      const ytDlpPath = await ensureYtDlpBinary()

      const title = await new Promise<string>((resolve, reject) => {
        execFile(
          ytDlpPath,
          [...YTDLP_CLIENT_ARGS, '--print', '%(title)s', '--skip-download', url],
          { windowsHide: true },
          (error: Error | null, stdout: string, stderr: string) =>
            error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout.trim())
        )
      })
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'audio'

      const result = await dialog.showSaveDialog({
        defaultPath: `${safeTitle}.${format}`,
        filters: [AUDIO_EXPORT_FILTERS[format]],
      })
      if (result.canceled || !result.filePath) return null

      const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'volure-yt-'))
      try {
        const scratchOutputPath = path.join(scratchDir, `out.${format}`)
        await new Promise<void>((resolve, reject) => {
          execFile(
            ytDlpPath,
            [
              ...YTDLP_CLIENT_ARGS,
              '-x',
              '--audio-format',
              format,
              // Ignored by yt-dlp for the lossless formats (wav/flac) — only
              // takes effect when transcoding to the lossy mp3 path.
              '--audio-quality',
              '2',
              '--ffmpeg-location',
              path.dirname(ffmpeg),
              '-o',
              path.join(scratchDir, 'out.%(ext)s'),
              url,
            ],
            { windowsHide: true },
            (error: Error | null, _stdout: string, stderr: string) =>
              error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()
          )
        })

        const outputStat = await fsp.stat(scratchOutputPath).catch(() => null)
        if (!outputStat || outputStat.size === 0) {
          throw new Error(`yt-dlp produced an empty ${format} file`)
        }
        await moveIntoPlace(scratchOutputPath, result.filePath)
        return result.filePath
      } finally {
        await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  )

  // Backs the Play view's screen recorder (see src/useScreenRecorder.ts):
  // finishing a recording is written only to a throwaway OS temp file — never
  // anywhere the user would consider "saved" — purely so it has a real file
  // to stream from in the Video Viewer. Nothing is written to a permanent
  // location unless the user explicitly downloads it (see
  // dialog:downloadScreenRecording below).
  ipcMain.handle(
    'library:stageScreenRecording',
    async (_event, data: ArrayBuffer, sourceContainer: 'mp4' | 'webm' = 'webm') => {
      if (data.byteLength === 0) throw new Error('Nothing to load: recording was empty')

      const stageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'volure-recording-'))
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const destPath = path.join(stageDir, `Screen Recording ${timestamp}.mp4`)

      await writeRecordingBufferToFile(data, sourceContainer, destPath)
      return destPath
    }
  )

  // Backs the Video Viewer's Download button for an as-yet-unsaved screen
  // recording — sourcePath is already a finished MP4 written by
  // library:stageScreenRecording above, so this just copies it to wherever
  // the user picks; no transcode needed.
  ipcMain.handle('dialog:downloadScreenRecording', async (_event, sourcePath: string, defaultName: string) => {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    })
    if (result.canceled || !result.filePath) return null
    await fsp.copyFile(sourcePath, result.filePath)
    return result.filePath
  })

  ipcMain.handle('clipboard:copyImage', async (_event, filePath: string, dataUrl?: string) => {
    const image = dataUrl ? nativeImage.createFromDataURL(dataUrl) : nativeImage.createFromPath(filePath)
    if (image.isEmpty()) throw new Error('Unable to read image')
    clipboard.writeImage(image)
  })

  ipcMain.handle('developer:getLayout', async () => {
    return readDeveloperLayout()
  })

  ipcMain.handle('developer:getElementLayout', async () => {
    return readDeveloperElementLayout()
  })

  ipcMain.handle('developer:saveLayout', async (_event, layout: unknown) => {
    await writeDeveloperLayout(layout)
    return layout
  })

  ipcMain.handle('developer:saveElementLayout', async (_event, layout: unknown) => {
    await writeDeveloperElementLayout(layout)
    return layout
  })

  ipcMain.handle('developer:exportLayoutCss', async (_event, layout: unknown) => {
    return exportDeveloperLayoutCss(layout)
  })

  ipcMain.handle('developer:exportElementLayoutCss', async (_event, layout: unknown) => {
    return exportDeveloperElementLayoutCss(layout)
  })

  ipcMain.handle('developer:resetLayout', async () => {
    try {
      await fsp.unlink(getDeveloperLayoutPath())
    } catch {
      // ignore missing file
    }
    return null
  })

  ipcMain.handle('developer:resetElementLayout', async () => {
    try {
      await fsp.unlink(getDeveloperElementLayoutPath())
    } catch {
      // ignore missing file
    }
    return null
  })

  globalShortcut.register('CommandOrControl+Alt+D', () => {
    mainWindow?.webContents.send('developer:toggle')
  })

  ipcMain.handle('library:listBackgroundImages', async () => {
    try {
      const entries = await fsp.readdir(BACKGROUND_IMAGES_DIR, { withFileTypes: true })
      return entries
        .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
        .map((e) => path.join(BACKGROUND_IMAGES_DIR, e.name))
        .sort()
    } catch {
      return []
    }
  })

  ipcMain.handle('library:getPlaySamplePath', async () => {
    try {
      await fsp.access(PLAY_SAMPLE_PATH)
      return PLAY_SAMPLE_PATH
    } catch {
      return null
    }
  })

  ipcMain.handle('library:getPlaySample2Path', async () => {
    try {
      await fsp.access(PLAY_SAMPLE2_PATH)
      return PLAY_SAMPLE2_PATH
    } catch {
      return null
    }
  })

  ipcMain.handle('library:getPlaySample3Path', async () => {
    try {
      await fsp.access(PLAY_SAMPLE3_PATH)
      return PLAY_SAMPLE3_PATH
    } catch {
      return null
    }
  })

  ipcMain.handle('library:getPlaySample4Path', async () => {
    try {
      await fsp.access(PLAY_SAMPLE4_PATH)
      return PLAY_SAMPLE4_PATH
    } catch {
      return null
    }
  })

  ipcMain.handle('library:getWaveLottiePath', async () => {
    try {
      await fsp.access(WAVE_LOTTIE_PATH)
      return WAVE_LOTTIE_PATH
    } catch {
      return null
    }
  })

  ipcMain.handle('library:getListeningLottiePath', async () => {
    try {
      await fsp.access(LISTENING_LOTTIE_PATH)
      return LISTENING_LOTTIE_PATH
    } catch {
      return null
    }
  })

  ipcMain.handle('library:scan', async (_event, folderPath: string, isolated?: boolean) => {
    return scanFolder(folderPath, isolated)
  })

  ipcMain.handle('library:getTracksInFolder', async (_event, folderPath: string) => {
    return getTracksInFolder(folderPath)
  })

  ipcMain.handle('library:getTracks', async () => {
    return getAllTracks()
  })

  ipcMain.handle('library:search', async (_event, query: string) => {
    return searchTracks(query)
  })

  ipcMain.handle('library:updateTags', async (_event, id: number, tags) => {
    const fileTrack = getTrackById(id)
    if (fileTrack && supportsDirectMetadataRewrite(fileTrack.filePath)) {
      try {
        await rewriteTrackMetadataFields(fileTrack.filePath, {
          title: tags?.title,
          artist: tags?.artist,
          album: tags?.album,
        })
      } catch (error) {
        console.error(`Failed to rewrite metadata for ${fileTrack.filePath}:`, error)
      }
    }

    updateTrackTags(id, tags)
    return getAllTracks()
  })

  ipcMain.handle('library:updateTagsBulk', async (_event, ids: number[], tags) => {
    const fileTracks = ids
      .map((id) => getTrackById(id))
      .filter((track): track is NonNullable<typeof track> => !!track)

    const failedIds: number[] = []
    for (const track of fileTracks) {
      const metadataPatch = {
        title: tags?.title,
        artist: tags?.artist,
        album: tags?.album,
      }
      if (!supportsDirectMetadataRewrite(track.filePath)) continue
      try {
        await rewriteTrackMetadataFields(track.filePath, metadataPatch)
      } catch (error) {
        console.error(`Failed to rewrite metadata for ${track.filePath}:`, error)
        failedIds.push(track.id)
      }
    }

    updateTracksTags(ids, tags)
    return { tracks: getAllTracks(), failedIds }
  })

  ipcMain.handle('library:updateTrackArt', async (_event, id: number, artPath: string | null, saveToMetadata: boolean = true) => {
    const track = getTrackById(id)
    // Mirrors library:updateTagsBulk's own failedIds — previously this
    // caught-and-logged the write failure but still reported success to the
    // renderer, so a track whose file couldn't actually be tagged (locked,
    // unwritable, a codec ffmpeg choked on) looked identical in the UI to
    // one that genuinely saved, with the only trace being a main-process
    // console line nobody sees.
    let metadataWriteFailed = false
    if (track && artPath && saveToMetadata && supportsDirectMetadataRewrite(track.filePath)) {
      try {
        await rewriteTrackArtTag(track.filePath, artPath)
      } catch (error) {
        console.error(`Failed to rewrite cover art for ${track.filePath}:`, error)
        metadataWriteFailed = true
      }
    }

    updateTrackArt(id, artPath)
    return { track: getTrackById(id) ?? null, metadataWriteFailed }
  })

  ipcMain.handle('library:setInLibrary', async (_event, id: number, inLibrary: boolean) => {
    setTrackInLibrary(id, inLibrary ? 1 : 0)
    return getTrackById(id) ?? null
  })

  ipcMain.handle('library:setFavorite', async (_event, id: number, favorite: boolean) => {
    setTrackFavorite(id, favorite ? 1 : 0)
    return getTrackById(id) ?? null
  })

  ipcMain.handle(
    'library:setDetectedKey',
    async (_event, id: number, key: string, keySignature: string, force = false) => {
      return setDetectedKey(id, key, keySignature, force) ?? null
    }
  )

  // "Date added" for a folder means the date it was added to the user's PC
  // (filesystem creation time), not the date it was scanned into Volure —
  // folders default to that order rather than DB insertion order. Folders
  // with a manual sortOrder (dragged in the Sections grid) sort first,
  // ascending; everything else falls back to the date-added order.
  async function getSortedFolders(): Promise<Folder[]> {
    const folders = getFolders()
    const withDates = await Promise.all(
      folders.map(async (folder) => {
        try {
          const stat = await fsp.stat(folder.path)
          return { folder, createdAt: stat.birthtimeMs }
        } catch {
          return { folder, createdAt: 0 }
        }
      })
    )
    withDates.sort((a, b) => {
      if (a.folder.sortOrder !== null && b.folder.sortOrder !== null) {
        return a.folder.sortOrder - b.folder.sortOrder
      }
      if (a.folder.sortOrder !== null) return -1
      if (b.folder.sortOrder !== null) return 1
      return b.createdAt - a.createdAt
    })
    return withDates.map((f) => f.folder)
  }

  ipcMain.handle('library:getFolders', async () => {
    return getSortedFolders()
  })

  ipcMain.handle('library:reorderFolders', async (_event, orderedPaths: string[]) => {
    reorderFolders(orderedPaths)
    return getSortedFolders()
  })

  ipcMain.handle('library:setTracksOrder', async (_event, orderedIds: number[]) => {
    setTracksOrder(orderedIds)
    return getAllTracks()
  })

  ipcMain.handle('library:renameFolder', async (_event, folderPath: string, name: string) => {
    renameFolder(folderPath, name)
    return getSortedFolders()
  })

  ipcMain.handle(
    'library:updateFolderArt',
    async (_event, folderPath: string, artPath: string | null) => {
      updateFolderArt(folderPath, artPath)
      return getSortedFolders()
    }
  )

  ipcMain.handle('library:removeFolder', async (_event, folderPath: string) => {
    removeFolder(folderPath)
    return { folders: await getSortedFolders(), tracks: getAllTracks() }
  })

  ipcMain.handle('playlist:list', async () => {
    return getPlaylists()
  })

  ipcMain.handle('playlist:create', async (_event, name: string) => {
    return createPlaylist(name)
  })

  ipcMain.handle('playlist:rename', async (_event, id: number, name: string) => {
    renamePlaylist(id, name)
    return getPlaylists()
  })

  ipcMain.handle('playlist:delete', async (_event, id: number) => {
    deletePlaylist(id)
    return getPlaylists()
  })

  ipcMain.handle('playlist:reorder', async (_event, orderedIds: number[]) => {
    reorderPlaylists(orderedIds)
    return getPlaylists()
  })

  ipcMain.handle('playlist:getTracks', async (_event, id: number) => {
    return getPlaylistTracks(id)
  })

  ipcMain.handle(
    'playlist:reorderTracks',
    async (_event, id: number, orderedTrackIds: number[]) => {
      reorderPlaylistTracks(id, orderedTrackIds)
      return getPlaylistTracks(id)
    }
  )

  ipcMain.handle('playlist:addTracks', async (_event, id: number, trackIds: number[]) => {
    addTracksToPlaylist(id, trackIds)
    return { playlists: getPlaylists(), tracks: getPlaylistTracks(id) }
  })

  ipcMain.handle('playlist:removeTracks', async (_event, id: number, trackIds: number[]) => {
    removeTracksFromPlaylist(id, trackIds)
    return { playlists: getPlaylists(), tracks: getPlaylistTracks(id) }
  })

  ipcMain.handle('advanced:getTracks', async () => {
    return getAdvancedTracks()
  })

  ipcMain.handle('advanced:setInLibrary', async (_event, id: number, included: boolean) => {
    setTrackInAdvancedLibrary(id, included ? 1 : 0)
    return getTrackById(id) ?? null
  })

  ipcMain.handle('advanced:updateTags', async (_event, id: number, tags) => {
    updateTrackTags(id, tags)
    return getTrackById(id) ?? null
  })

  ipcMain.handle('advanced:getBassIntervals', async (_event, trackIds: number[]) => {
    return getBassIntervalsForTracks(trackIds)
  })

  ipcMain.handle('advanced:addBassInterval', async (_event, trackId: number, sequence: string) => {
    return addBassInterval(trackId, sequence)
  })

  ipcMain.handle('advanced:removeBassInterval', async (_event, id: number) => {
    removeBassInterval(id)
  })

  ipcMain.handle('library:markPlayed', async (_event, id: number) => {
    markPlayed(id)
  })

  ipcMain.handle('library:getRecentlyPlayed', async () => {
    return getRecentlyPlayed()
  })

  ipcMain.handle('library:removeFromRecentlyPlayed', async (_event, id: number) => {
    removeFromRecentlyPlayed(id)
    return getRecentlyPlayed()
  })

  ipcMain.handle('library:playDroppedFile', async (_event, filePath: string) => {
    if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null
    try {
      const fields = await readTrackMetadata(filePath)
      const inLibrary = isPathInLibraryFolder(filePath) ? 1 : 0
      const { id, inserted } = upsertTrack({ ...fields, inLibrary })
      markPlayed(id)
      return { track: getTrackById(id) ?? null, inserted }
    } catch (err) {
      console.error(`Failed to read dropped file ${filePath}:`, err)
      return null
    }
  })

  // Chromium's <audio> element only decodes a narrow slice of WAV variants
  // (8/16-bit PCM) — files like 24-bit PCM WAV exports from DAWs (e.g. FL
  // Studio) report MEDIA_ERR_SRC_NOT_SUPPORTED and never play, in both Now
  // Playing and Studio. Called by the renderer as a one-time fallback when
  // playback fails: transcodes to a 16-bit PCM WAV Chromium can always
  // play, cached by source path + size + mtime so repeat plays of the same
  // file are instant after the first transcode.
  ipcMain.handle('library:ensurePlayableAudio', async (_event, filePath: string) => {
    try {
      const stat = await fsp.stat(filePath)
      const cacheDir = path.join(app.getPath('userData'), 'playback-cache')
      await fsp.mkdir(cacheDir, { recursive: true })
      const key = crypto
        .createHash('sha1')
        .update(`${filePath}:${stat.mtimeMs}:${stat.size}`)
        .digest('hex')
      const cachePath = path.join(cacheDir, `${key}.wav`)
      const alreadyCached = await fsp
        .stat(cachePath)
        .then(() => true)
        .catch(() => false)
      if (alreadyCached) return cachePath

      if (!ffmpegPath) return null
      const ffmpeg = ffmpegPath
      const scratchPath = path.join(cacheDir, `${key}.tmp-${process.pid}.wav`)
      await new Promise<void>((resolve, reject) => {
        execFile(
          ffmpeg,
          ['-y', '-i', filePath, '-codec:a', 'pcm_s16le', scratchPath],
          (error: Error | null, _stdout: string, stderr: string) =>
            error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()
        )
      })
      const outStat = await fsp.stat(scratchPath).catch(() => null)
      if (!outStat || outStat.size === 0) {
        await fsp.rm(scratchPath, { force: true })
        return null
      }
      await moveIntoPlace(scratchPath, cachePath)
      return cachePath
    } catch (err) {
      console.error(`Failed to prepare playable audio for ${filePath}:`, err)
      return null
    }
  })

  // Most camera/editor-exported MP4s write their "moov" index atom AFTER
  // the (huge) "mdat" media data instead of before it — fine for a real
  // <video src> over http/file, but reproducibly breaks over Electron's
  // custom protocol.handle: Chromium's media pipeline has to issue a
  // second range request seeking near the end of the file to find moov,
  // and that second request reliably comes back as
  // MEDIA_ERR_SRC_NOT_SUPPORTED when served through protocol.handle (byte-
  // identical serving logic works fine over a plain http/file source —
  // this was confirmed directly against this Electron build, so it's a
  // real platform limitation, not a bug in the range-serving code below).
  // Run before every video is ever handed to <video>: a `-c copy` remux
  // moves moov to the front without re-encoding, so Chromium never needs
  // that second request. This is cheap (a container rewrite, not a
  // transcode — well under a second even for a ~100MB file) and safe to
  // run unconditionally, including on files that are already fast-start.
  // Cached by source path + size + mtime; falls back to the original path
  // on any failure so playback still gets attempted.
  ipcMain.handle('library:prepareVideoForPlayback', async (_event, filePath: string) => {
    try {
      const stat = await fsp.stat(filePath)
      const cacheDir = path.join(app.getPath('userData'), 'playback-cache')
      await fsp.mkdir(cacheDir, { recursive: true })
      const key = crypto
        .createHash('sha1')
        .update(`${filePath}:${stat.mtimeMs}:${stat.size}:video-faststart`)
        .digest('hex')
      const cachePath = path.join(cacheDir, `${key}.mp4`)
      const alreadyCached = await fsp
        .stat(cachePath)
        .then(() => true)
        .catch(() => false)
      if (alreadyCached) return cachePath

      if (!ffmpegPath) return filePath
      const ffmpeg = ffmpegPath
      const scratchPath = path.join(cacheDir, `${key}.tmp-${process.pid}.mp4`)
      await new Promise<void>((resolve, reject) => {
        execFile(
          ffmpeg,
          ['-y', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', scratchPath],
          (error: Error | null, _stdout: string, stderr: string) =>
            error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()
        )
      })
      const outStat = await fsp.stat(scratchPath).catch(() => null)
      if (!outStat || outStat.size === 0) {
        await fsp.rm(scratchPath, { force: true })
        return filePath
      }
      await moveIntoPlace(scratchPath, cachePath)
      return cachePath
    } catch (err) {
      console.error(`Failed to prepare video for playback ${filePath}:`, err)
      return filePath
    }
  })

  // Chromium's <video> element has no HEVC/H.265 decoder at all (common for
  // phone-recorded .mp4/.mov), and even H.264 files fail if they use a
  // profile/chroma format its decoder rejects — both report a generic
  // MEDIA_ERR_SRC_NOT_SUPPORTED/MEDIA_ERR_DECODE and never play. Called by
  // the renderer as a one-time fallback when playback still errors after
  // the faststart remux above: transcodes to H.264 (yuv420p) + AAC, which
  // Chromium can always play, cached by source path + size + mtime so
  // repeat plays of the same file are instant after the first transcode.
  ipcMain.handle('library:ensurePlayableVideo', async (_event, filePath: string) => {
    try {
      const stat = await fsp.stat(filePath)
      const cacheDir = path.join(app.getPath('userData'), 'playback-cache')
      await fsp.mkdir(cacheDir, { recursive: true })
      const key = crypto
        .createHash('sha1')
        .update(`${filePath}:${stat.mtimeMs}:${stat.size}:video`)
        .digest('hex')
      const cachePath = path.join(cacheDir, `${key}.mp4`)
      const alreadyCached = await fsp
        .stat(cachePath)
        .then(() => true)
        .catch(() => false)
      if (alreadyCached) return cachePath

      if (!ffmpegPath) return null
      const ffmpeg = ffmpegPath
      const scratchPath = path.join(cacheDir, `${key}.tmp-${process.pid}.mp4`)
      await new Promise<void>((resolve, reject) => {
        execFile(
          ffmpeg,
          [
            '-y',
            '-i',
            filePath,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '20',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-movflags',
            '+faststart',
            scratchPath,
          ],
          (error: Error | null, _stdout: string, stderr: string) =>
            error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()
        )
      })
      const outStat = await fsp.stat(scratchPath).catch(() => null)
      if (!outStat || outStat.size === 0) {
        await fsp.rm(scratchPath, { force: true })
        return null
      }
      await moveIntoPlace(scratchPath, cachePath)
      return cachePath
    } catch (err) {
      console.error(`Failed to prepare playable video for ${filePath}:`, err)
      return null
    }
  })

  ipcMain.handle('library:getArt', async (_event, filePath: string) => {
    try {
      const meta = await parseFile(filePath)
      const picture = meta.common.picture?.[0]
      if (!picture) return null
      return {
        format: picture.format,
        data: Buffer.from(picture.data).toString('base64'),
      }
    } catch {
      return null
    }
  })

  mainWindow = createWindow()
  globalShortcut.register('MediaPlayPause', () => {
    mainWindow?.webContents.send('media:play-pause')
  })
  globalShortcut.register('MediaNextTrack', () => {
    mainWindow?.webContents.send('media:next-track')
  })
  globalShortcut.register('MediaPreviousTrack', () => {
    mainWindow?.webContents.send('media:prev-track')
  })
  configureAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  db.close()
  if (process.platform !== 'darwin') app.quit()
})
