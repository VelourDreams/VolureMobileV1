import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Track, Folder, Playlist, BassInterval } from './platform'
import type { AudioExportFormat } from '../electron/audio'
import { platform } from './platform'
import type { KeyDetectionRequest, KeyDetectionResponse } from './keyDetectionWorker'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { formatTime } from './formatTime'
import { useTrackArt } from './useTrackArt'
import { useWaveformPeaks, computePeaksFromBuffer } from './useWaveformPeaks'
import { audioBufferToWav } from './audioBufferToWav'
import { sliceAndFadeBuffer, type FadeSetting } from './audioTrim'
import { useAudioRecorder } from './useAudioRecorder'
import { useScreenRecorder } from './useScreenRecorder'
import { useFilePlayback } from './useFilePlayback'
import { EQ_BANDS, formatEqFreq } from './eq'
import { PitchShifterWorklet as PitchShifter, warmPitchShiftWorklet, renderPitchShiftOffline } from './pitchShiftWorkletNode'
import { PITCH_SEMITONES_MIN, PITCH_SEMITONES_MAX, PITCH_SHIFT_BUFFER_SIZE } from './pitchShift'
import { DotLottie } from '@lottiefiles/dotlottie-web'
import dotlottieWasmUrl from '@lottiefiles/dotlottie-web/dotlottie-player.wasm?url'
import './App.css'
// Mobile (Capacitor) layout overrides. Every rule is scoped under `.app.mobile`
// — a class App only sets on the mobile build target — so this is inert on
// desktop. Imported statically (not gated) so the mobile build never flashes
// the desktop layout before the stylesheet loads.
import './mobile.css'

// Points the player at its WASM binary via Vite's own asset pipeline instead
// of the library's default (a jsDelivr/unpkg fetch), which would otherwise
// make the live-recording animation depend on internet access.
DotLottie.setWasmUrl(dotlottieWasmUrl)

const DEFAULT_ART = './album-art/default1.png'

const IS_DEVELOPER_BUILD = import.meta.env.DEV

type DeveloperLayoutId = 'toolbar' | 'sidebar' | 'library' | 'studio' | 'play' | 'playback'

type DeveloperLayoutBox = {
  left: number
  top: number
  width: number
  height: number
}

type DeveloperLayoutMap = Record<DeveloperLayoutId, DeveloperLayoutBox>

type DeveloperElementId =
  | 'headerBackButton'
  | 'sidebarToggleButton'
  | 'nightModeToggle'
  | 'eqBackButton'
  | 'fullscreenKeyBadge'
  | 'fullscreenEqualizerButton'
  | 'fullscreenFavoriteButton'
  | 'studioKeyBadge'
  | 'playKeyBadge'
  | 'nowPlayingBackButton'
  | 'nowPlayingArt'
  | 'recordButton'
  | 'playRecordButton'
  | 'shuffleButton'
  | 'prevButton'
  | 'playPauseButton'
  | 'nextButton'
  | 'loopButton'
  | 'volumeButton'

type DeveloperElementMap = Partial<Record<DeveloperElementId, DeveloperLayoutBox>>

type DeveloperInteractionMode = 'move' | 'resize'

type DeveloperInteraction = {
  id: DeveloperLayoutId
  mode: DeveloperInteractionMode
  startX: number
  startY: number
  startBox: DeveloperLayoutBox
  rootRect: DOMRect
}

type DeveloperElementInteraction = {
  id: DeveloperElementId
  mode: DeveloperInteractionMode
  startX: number
  startY: number
  startBox: DeveloperLayoutBox
  rootRect: DOMRect
}

const DEVELOPER_LAYOUT_LABELS: Record<DeveloperLayoutId, string> = {
  toolbar: 'Toolbar',
  sidebar: 'Sidebar',
  library: 'Library View',
  studio: 'Studio View',
  play: 'Play View',
  playback: 'Playback Bar',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function roundLayoutValue(value: number): number {
  return Math.round(value * 100) / 100
}

function rectToLayoutBox(rect: DOMRect, rootRect: DOMRect): DeveloperLayoutBox {
  return {
    left: roundLayoutValue(((rect.left - rootRect.left) / rootRect.width) * 100),
    top: roundLayoutValue(((rect.top - rootRect.top) / rootRect.height) * 100),
    width: roundLayoutValue((rect.width / rootRect.width) * 100),
    height: roundLayoutValue((rect.height / rootRect.height) * 100),
  }
}

function layoutBoxToStyle(box: DeveloperLayoutBox | undefined, selected: boolean): CSSProperties | undefined {
  if (!box) return undefined
  return {
    position: 'absolute',
    left: `${box.left}%`,
    top: `${box.top}%`,
    width: `${box.width}%`,
    height: `${box.height}%`,
    zIndex: selected ? 60 : 20,
  }
}

function DeveloperEditableNode({
  id,
  tag,
  className,
  children,
  devMode,
  selected,
  layout,
  rootRef,
  onMeasure,
  onSelect,
  onBeginInteraction,
  onClick,
  onContextMenu,
  title,
  type,
  ariaPressed,
  ariaChecked,
  disabled,
  ariaLabel,
  role,
  src,
  alt,
  draggable,
}: {
  id: DeveloperElementId
  tag: 'button' | 'div' | 'img'
  className: string
  children?: ReactNode
  devMode: boolean
  selected: boolean
  layout: DeveloperElementMap
  rootRef: React.RefObject<HTMLDivElement | null>
  onMeasure: (id: DeveloperElementId, box: DeveloperLayoutBox) => void
  onSelect: (id: DeveloperElementId) => void
  onBeginInteraction: (
    id: DeveloperElementId,
    mode: DeveloperInteractionMode,
    event: React.PointerEvent<HTMLElement>,
    box: DeveloperLayoutBox,
    rootRect: DOMRect,
  ) => void
  onClick?: () => void
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
  title?: string
  type?: 'button'
  ariaPressed?: boolean
  ariaChecked?: boolean
  disabled?: boolean
  ariaLabel?: string
  role?: string
  src?: string
  alt?: string
  draggable?: boolean
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const divRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const box = layout[id]

  useLayoutEffect(() => {
    if (!devMode || box) return
    const node = tag === 'button' ? buttonRef.current : tag === 'img' ? imgRef.current : divRef.current
    const root = rootRef.current
    if (!node || !root) return
    const rootRect = root.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    if (rootRect.width <= 0 || rootRect.height <= 0) return
    onMeasure(id, rectToLayoutBox(nodeRect, rootRect))
  }, [box, devMode, id, onMeasure, rootRef, tag])

  const hiddenStyle: CSSProperties | undefined = devMode && box
    ? { opacity: 0, pointerEvents: 'none' }
    : undefined

  const cloneStyle = box
    ? ({
        position: 'fixed',
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
        zIndex: selected ? 91 : 90,
      } as CSSProperties)
    : undefined

  const cloneClassName = `${className} developer-editable-clone${selected ? ' selected' : ''}`

  const renderClone = () => {
    if (!devMode || !box) return null
    if (tag === 'button') {
      return (
        <button
          type={type ?? 'button'}
          className={cloneClassName}
          style={cloneStyle}
          title={title}
          role={role}
          disabled={disabled}
          aria-pressed={ariaPressed}
          aria-checked={ariaChecked}
          aria-label={ariaLabel}
          data-developer-id={id}
          onPointerDown={(event) => {
            if (!box || !rootRef.current) return
            onBeginInteraction(id, 'move', event, box, rootRef.current.getBoundingClientRect())
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onSelect(id)
          }}
          onContextMenu={onContextMenu}
        >
          {children}
        </button>
      )
    }

    if (tag === 'img') {
      return (
        <img
          className={cloneClassName}
          style={cloneStyle}
          title={title}
          src={src}
          alt={alt ?? ''}
          draggable={draggable}
          data-developer-id={id}
          onPointerDown={(event) => {
            if (!box || !rootRef.current) return
            onBeginInteraction(id, 'move', event, box, rootRef.current.getBoundingClientRect())
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onSelect(id)
          }}
        />
      )
    }

    return (
      <div
        className={cloneClassName}
        style={cloneStyle}
        title={title}
        data-developer-id={id}
        onPointerDown={(event) => {
          if (!box || !rootRef.current) return
          onBeginInteraction(id, 'move', event, box, rootRef.current.getBoundingClientRect())
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSelect(id)
        }}
      >
        {children}
      </div>
    )
  }

  if (tag === 'button') {
    return (
      <>
        <button
          ref={buttonRef}
          className={className}
          style={hiddenStyle}
          type={type ?? 'button'}
          title={title}
          role={role}
          disabled={disabled}
          aria-pressed={ariaPressed}
          aria-checked={ariaChecked}
          aria-label={ariaLabel}
          onClick={onClick}
          onContextMenu={onContextMenu}
          data-developer-id={id}
        >
          {children}
        </button>
        {renderClone()}
      </>
    )
  }

  if (tag === 'img') {
    return (
      <>
        <img
          ref={imgRef}
          className={className}
          style={hiddenStyle}
          title={title}
          src={src}
          alt={alt ?? ''}
          draggable={draggable}
          onClick={onClick}
          data-developer-id={id}
        />
        {renderClone()}
      </>
    )
  }

  return (
    <>
      <div
        ref={divRef}
        className={className}
        style={hiddenStyle}
        title={title}
        onClick={onClick}
        data-developer-id={id}
      >
        {children}
      </div>
      {renderClone()}
    </>
  )
}

function folderBaseName(folderPath: string): string {
  const trimmed = folderPath.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}


// Skip the eager whole-file decode below this size; decoding a very large
// (e.g. long/uncompressed) file to PCM can stall the main thread for a while.
const MAX_GAPLESS_DECODE_BYTES = 60 * 1024 * 1024

// Floor for the Studio dB meter — RMS levels below this just render as
// "silent" rather than sliding all the way to -Infinity.
const STUDIO_METER_FLOOR_DB = -60

// A left/right pair of dB readings — the Studio meter's level and peak-hold
// state are both always tracked per channel.
type StereoDb = { l: number; r: number }

// How long (ms) a channel's peak-hold marker sits still after the last new
// high before it starts easing back down, and how fast (dB per 33ms tick)
// it falls once it does — mirrors the hold/decay behavior of a hardware
// mixing-console meter.
const STUDIO_METER_PEAK_HOLD_MS = 1200
const STUDIO_METER_PEAK_DECAY_DB_PER_TICK = 0.6

// dB values the meter draws scale ticks at.
const STUDIO_METER_SCALE_MARKS = [0, -6, -12, -24, -48]

// Maps a dB reading onto the meter's 0-100% fill height. Rather than a
// straight linear map (which crams -6/-12 into the top ~20% of the meter
// and leaves the rest of the scale for the rarely-used -12..-60 tail), each
// scale mark is pinned to an evenly spaced 20% step and dB values are
// interpolated linearly between the marks that bracket them. Keeps 0dB at
// the top and the floor at the bottom while giving -12dB a fixed spot at
// the 60% mark.
const STUDIO_METER_CURVE: [db: number, percent: number][] = [
  [0, 100],
  [-6, 80],
  [-12, 60],
  [-24, 40],
  [-48, 20],
  [STUDIO_METER_FLOOR_DB, 0],
]

function studioMeterPercent(db: number): number {
  if (db >= STUDIO_METER_CURVE[0][0]) return STUDIO_METER_CURVE[0][1]
  const last = STUDIO_METER_CURVE[STUDIO_METER_CURVE.length - 1]
  if (db <= last[0]) return last[1]

  for (let i = 0; i < STUDIO_METER_CURVE.length - 1; i++) {
    const [hiDb, hiPercent] = STUDIO_METER_CURVE[i]
    const [loDb, loPercent] = STUDIO_METER_CURVE[i + 1]
    if (db <= hiDb && db >= loDb) {
      const t = (db - loDb) / (hiDb - loDb)
      return loPercent + t * (hiPercent - loPercent)
    }
  }
  return 0
}

// Also the size of one semitone step in speed — see speedToSemitoneShift.
const SPEED_SNAP_INTERVAL = 0.05
// Must be smaller than half of SPEED_SNAP_INTERVAL (0.025) or every value
// would snap somewhere, killing fine-grained control — but bigger than the
// slider's 0.01 step, or a plain step away from the grid point (which is
// most of them) never comes within range and nothing ever visibly snaps.
const SPEED_SNAP_THRESHOLD = 0.02

// 1.00 (normal speed) and the two most commonly reached-for offsets get a
// wider, stickier snap zone than the rest of the 0.05 grid.
const SPEED_HARD_SNAP_VALUES = [0.75, 1, 1.25]
const SPEED_HARD_SNAP_THRESHOLD = 0.035

// Snaps to 0.75/1.00/1.25 first (wide net), then to the nearest 0.05 step
// (0.90, 0.95, 1.00, ...) while within a smaller margin of it, so dragging
// still lands exactly on those checkpoints but passes freely through
// in-between values like 0.92.
function snapPlaybackSpeed(value: number): number {
  for (const hardSnapValue of SPEED_HARD_SNAP_VALUES) {
    if (Math.abs(value - hardSnapValue) <= SPEED_HARD_SNAP_THRESHOLD) return hardSnapValue
  }
  const nearest = Math.round(value / SPEED_SNAP_INTERVAL) * SPEED_SNAP_INTERVAL
  return Math.abs(value - nearest) <= SPEED_SNAP_THRESHOLD ? nearest : value
}

// The key badge moves one semitone for every 0.05 the speed slider moves
// away from 1.00 (0.90 = -2, 0.75 = -5, 1.10 = +2).
function speedToSemitoneShift(speed: number): number {
  return Math.round((speed - 1) / SPEED_SNAP_INTERVAL)
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

// Disabling the browser's default call-oriented DSP (echo cancellation,
// noise suppression, auto-gain) is what keeps a vocal/instrument take
// sounding like the raw mic signal instead of thin, metallic, and
// inconsistently leveled the way that processing makes it — see studio mic
// recording.
async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Non-standard Chromium constraint (no TS typing) — see
      // getInternalAudioStream below for why this needs to be disabled.
      ...({ googDucking: false } as MediaTrackConstraints),
    },
  })
}

// Captures the computer's audio output ("what you hear") rather than the
// microphone. getDisplayMedia is the only web API with access to system
// loopback audio, and it requires a video track by spec even though only
// the audio matters here — electron/main.ts's setDisplayMediaRequestHandler
// answers it silently (no picker UI) with the primary screen for video and
// loopback for audio, and the video track is stopped immediately below.
//
// Even though the audio itself comes from a native OS loopback capture (not
// a mic), Chromium still runs any getDisplayMedia audio track through the
// same constraint-driven WebRTC processing pipeline as getUserMedia unless
// told not to — echo cancellation in particular has nothing real to cancel
// here and instead just degrades the signal (muffled/warped, quieter). As
// with the mic (getMicStream above), disabling it is what keeps this a
// faithful, unaltered capture of the system audio.
//
// googDucking is the other, easy-to-miss piece: on Windows, opening any
// Chromium audio *capture* stream (including this loopback one) tags it as
// a "communications" session, which makes Windows itself duck — attenuate,
// by as much as 80% — every other app's audio output for as long as
// capture is running. Because this stream is a loopback capture of that
// same system output, it records the already-ducked (quieter) signal, so
// the saved take ends up noticeably quieter than the source audio actually
// was. Disabling googDucking stops Windows from ducking in the first
// place, so what gets captured matches what was actually playing.
async function getInternalAudioStream(): Promise<MediaStream> {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Non-standard Chromium constraint, not in the TS lib's
      // MediaTrackConstraints — see comment above.
      ...({ googDucking: false } as MediaTrackConstraints),
    },
  })
  const audioTracks = displayStream.getAudioTracks()
  displayStream.getVideoTracks().forEach((track) => track.stop())
  if (audioTracks.length === 0) {
    throw new Error('No system audio track available to record')
  }
  return new MediaStream(audioTracks)
}

function TrackArtThumb({ track, size }: { track: Track; size: number }) {
  const art = useTrackArt(track.filePath)
  const src = track.customArtPath ? platform.getMediaUrl(track.customArtPath) : (art ?? DEFAULT_ART)
  return (
    <img
      src={src}
      width={size}
      height={size}
      className="art-thumb"
      alt=""
      draggable={false}
    />
  )
}

const IDLE_WAVEFORM_BARS = Array.from({ length: 96 }, () => 0.06)

// Must match the .image-viewer-closing/.video-viewer-closing animation
// duration in App.css.
const VIEWER_TRANSITION_MS = 220

const STUDIO_EXPORT_FORMATS: AudioExportFormat[] = ['wav', 'mp3', 'flac']

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

function baseFileNameWithoutExt(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? 'image'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function StudioSaveMenu({
  onSave,
  saving,
  failed,
  idleLabel = 'Save',
  savingLabel = 'Saving…',
  failedLabel = 'Save failed',
  idleTitle = 'Save the current studio audio to your computer',
  failedTitle = 'Save failed — click to try again',
  disabled,
}: {
  onSave: (format: AudioExportFormat) => void
  saving?: boolean
  failed?: boolean
  idleLabel?: string
  savingLabel?: string
  failedLabel?: string
  idleTitle?: string
  failedTitle?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="studio-save-menu" ref={menuRef}>
      <button
        type="button"
        className={`btn-primary studio-save-button${failed ? ' failed' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        disabled={saving || disabled}
        title={failed ? failedTitle : idleTitle}
      >
        <SaveIcon />
        {saving ? savingLabel : failed ? failedLabel : idleLabel}
        <span className="studio-save-menu-chevron">
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className="studio-save-menu-dropdown">
          {STUDIO_EXPORT_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              className="studio-save-menu-item"
              onClick={() => {
                setOpen(false)
                onSave(format)
              }}
            >
              {format.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ImageSaveMenu({
  onSave,
  saving,
  failed,
}: {
  onSave: (format: 'png' | 'jpg') => void
  saving?: boolean
  failed?: boolean
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="image-viewer-save-menu" ref={menuRef}>
      <button
        type="button"
        className={`image-viewer-save${failed ? ' failed' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        disabled={saving}
        title={failed ? 'Save failed — click to try again' : 'Save image as PNG or JPG'}
      >
        <SaveIcon />
      </button>
      {open && (
        <div className="image-viewer-save-menu-dropdown">
          {(['png', 'jpg'] as const).map((format) => (
            <button
              key={format}
              type="button"
              className="image-viewer-save-menu-item"
              onClick={() => {
                setOpen(false)
                onSave(format)
              }}
            >
              {format.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ImageScreenshotMenu({
  onCapture,
  countdown,
}: {
  onCapture: (seconds: number) => void
  countdown: number | null
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="image-viewer-screenshot-menu" ref={menuRef}>
      <button
        type="button"
        className={`image-viewer-screenshot-button${countdown !== null ? ' waiting' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          if (countdown !== null) return
          setOpen((v) => !v)
        }}
        title={countdown !== null ? `Screenshot in ${countdown}s` : 'Take a screenshot'}
      >
        {countdown !== null ? (
          <span className="image-viewer-screenshot-countdown">{countdown}</span>
        ) : (
          <ScreenshotIcon />
        )}
      </button>
      {open && countdown === null && (
        <div className="image-viewer-screenshot-menu-dropdown">
          {[3, 5, 10].map((seconds) => (
            <button
              key={seconds}
              type="button"
              className="image-viewer-screenshot-menu-item"
              onClick={() => {
                setOpen(false)
                onCapture(seconds)
              }}
            >
              {seconds}s
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function VideoScreenRecordMenu({
  onRecord,
  onStop,
  recording,
  pendingSeconds,
}: {
  onRecord: (seconds: number) => void
  onStop: () => void
  recording: boolean
  pendingSeconds: number | null
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="video-viewer-record-menu" ref={menuRef}>
      <button
        type="button"
        className={`video-viewer-record-button${recording ? ' active' : ''}${pendingSeconds !== null ? ' waiting' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          if (pendingSeconds !== null) return
          if (recording) {
            onStop()
            return
          }
          setOpen((v) => !v)
        }}
        title={
          pendingSeconds !== null
            ? `Recording starts in ${pendingSeconds}s`
            : recording
              ? 'Stop recording'
              : 'Record your screen'
        }
      >
        <ScreenRecordIcon />
        {pendingSeconds !== null && <span className="video-viewer-record-countdown">{pendingSeconds}</span>}
      </button>
      {open && !recording && (
        <div className="video-viewer-record-menu-dropdown">
          {[3, 5, 10].map((seconds) => (
            <button
              key={seconds}
              type="button"
              className="video-viewer-record-menu-item"
              onClick={() => {
                setOpen(false)
                onRecord(seconds)
              }}
            >
              {seconds}s
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type ImageCropRect = { x: number; y: number; width: number; height: number }
type ImageCropBounds = { left: number; top: number; width: number; height: number }

const IMAGE_CROP_MIN_SIZE = 24

// How far the image viewer lets scrolling shrink a photo below its
// fit-to-container size (1x) — 0.2 means it can shrink to a fifth of that.
const IMAGE_MIN_ZOOM = 0.2

// Hover bands (from the viewer's edges) that reveal the HUD in the
// fullscreen image view — see handleImageViewerMouseMove.
const IMAGE_HUD_TOP_ZONE_PX = 72
const IMAGE_HUD_BOTTOM_ZONE_PX = 120

// Mirrors the transparent overlay main.ts configures at window creation.
const TITLEBAR_OVERLAY_DEFAULT = { color: 'rgba(0, 0, 0, 0)', symbolColor: '#ffffff' }
// Subtle backing so the native minimize/maximize/close buttons stay legible
// over bright image content.
const TITLEBAR_OVERLAY_SUBTLE = { color: 'rgba(0, 0, 0, 0.35)', symbolColor: '#ffffff' }
// Fully transparent buttons AND symbols — used in the immersive fullscreen
// image view so nothing is drawn until the HUD is revealed.
const TITLEBAR_OVERLAY_INVISIBLE = { color: 'rgba(0, 0, 0, 0)', symbolColor: 'rgba(255, 255, 255, 0)' }

// Drag handling lives entirely in local refs (no re-renders mid-drag beyond
// the onChange the parent needs to redraw the rect) — pointer capture keeps
// move/up events routed here even once the cursor leaves the handle.
function ImageCropOverlay({
  bounds,
  rect,
  onChange,
}: {
  bounds: ImageCropBounds
  rect: ImageCropRect
  onChange: (rect: ImageCropRect) => void
}) {
  const dragRef = useRef<{
    mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'
    startX: number
    startY: number
    startRect: ImageCropRect
  } | null>(null)

  function clampRect(r: ImageCropRect): ImageCropRect {
    const width = Math.min(Math.max(r.width, IMAGE_CROP_MIN_SIZE), bounds.width)
    const height = Math.min(Math.max(r.height, IMAGE_CROP_MIN_SIZE), bounds.height)
    const x = Math.min(Math.max(r.x, 0), bounds.width - width)
    const y = Math.min(Math.max(r.y, 0), bounds.height - height)
    return { x, y, width, height }
  }

  function startDrag(mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') {
    return (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.target as Element).setPointerCapture(e.pointerId)
      dragRef.current = { mode, startX: e.clientX, startY: e.clientY, startRect: rect }
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    const { startRect, mode } = drag
    if (mode === 'move') {
      onChange(clampRect({ ...startRect, x: startRect.x + dx, y: startRect.y + dy }))
      return
    }
    let { x, y, width, height } = startRect
    if (mode === 'nw' || mode === 'sw') {
      x = startRect.x + dx
      width = startRect.width - dx
    }
    if (mode === 'ne' || mode === 'se') {
      width = startRect.width + dx
    }
    if (mode === 'nw' || mode === 'ne') {
      y = startRect.y + dy
      height = startRect.height - dy
    }
    if (mode === 'sw' || mode === 'se') {
      height = startRect.height + dy
    }
    onChange(clampRect({ x, y, width, height }))
  }

  function handlePointerUp() {
    dragRef.current = null
  }

  return (
    <div
      className="image-crop-overlay"
      style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div
        className="image-crop-rect"
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        onPointerDown={startDrag('move')}
      >
        {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
          <div
            key={corner}
            className={`image-crop-handle image-crop-handle-${corner}`}
            onPointerDown={startDrag(corner)}
          />
        ))}
      </div>
    </div>
  )
}

function StudioWaveform({
  track,
  currentTime,
  onSeek,
  playing,
  onTogglePlay,
  onActivateToggle,
  volume,
  onVolumeChange,
  onRemove,
  showRemove,
  onSave,
  showSave,
  saving,
  saveFailed,
  selectable,
  selectLabel,
  onSelect,
  peaksOverride,
  durationOverride,
  overlay,
}: {
  track: Track | null | undefined
  currentTime: number
  onSeek: (time: number) => void
  playing: boolean
  onTogglePlay: () => void
  onActivateToggle?: () => void
  volume: number
  onVolumeChange: (volume: number) => void
  onRemove?: () => void
  showRemove?: boolean
  onSave?: (format: AudioExportFormat) => void
  showSave?: boolean
  saving?: boolean
  saveFailed?: boolean
  selectable?: boolean
  selectLabel?: string
  onSelect?: () => void
  // Silence removal can't cut the underlying file, so once it's been applied
  // the waveform (and the duration used for seek-bar math) need to come from
  // the trimmed in-memory buffer instead of the original file on disk.
  peaksOverride?: number[] | null
  durationOverride?: number | null
  // Trim Audio's draggable start/end handles and fade tilt-lines, rendered
  // on top of the bars/cursor below — passed in rather than built here so
  // this component doesn't need to know about Trim Audio's state at all.
  overlay?: React.ReactNode
}) {
  const filePeaks = useWaveformPeaks(track?.filePath)
  const peaks = peaksOverride ?? filePeaks
  const duration = durationOverride ?? track?.duration ?? 0
  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0
  const bars = peaks ?? IDLE_WAVEFORM_BARS

  function seekFromEvent(e: React.PointerEvent<HTMLDivElement>) {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    onSeek(ratio * duration)
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    seekFromEvent(e)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons !== 1) return
    seekFromEvent(e)
  }

  return (
    <div className="studio-waveform-wrap">
      <div className="studio-waveform-row">
        {selectable && (
          <button
            type="button"
            className="studio-waveform-select"
            onClick={onSelect}
            title={`Select for ${selectLabel ?? 'Time Stretch'}`}
          >
            <CheckIcon />
          </button>
        )}
        <button
          type="button"
          className="studio-recording-play"
          onClick={() => {
            onActivateToggle?.()
            onTogglePlay()
          }}
          aria-pressed={playing}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div
          className="studio-waveform"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
        >
          {bars.map((height, index) => {
            const barRatio = bars.length > 1 ? index / (bars.length - 1) : 0
            return (
              <span
                key={index}
                className={`studio-waveform-bar${barRatio <= progress ? ' played' : ''}`}
                style={{ height: `${Math.max(6, height * 100)}%` }}
              />
            )
          })}
          <div className="studio-waveform-cursor" style={{ left: `${progress * 100}%` }} />
          {overlay}
        </div>
        <input
          type="range"
          className="studio-waveform-volume"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          title="Studio volume"
        />
      </div>
      <div className={`studio-recording-controls${saving || saveFailed ? ' studio-recording-controls-active' : ''}`}>
        {showRemove && onRemove && (
          <button
            type="button"
            className="studio-waveform-remove"
            onClick={onRemove}
            title="Remove audio from Studio"
          >
            <CloseIcon />
          </button>
        )}
        {showSave && onSave && <StudioSaveMenu onSave={onSave} saving={saving} failed={saveFailed} />}
      </div>
    </div>
  )
}

function StudioEmptyState({ onImport }: { onImport: () => void }) {
  return (
    <div className="studio-waveform-wrap">
      <div className="studio-empty-state">
        <p>Studio Is Currently Empty</p>
        <button
          type="button"
          className="studio-empty-import-button"
          onClick={onImport}
          title="Import an audio file from your computer"
        >
          <PlusIcon />
        </button>
      </div>
    </div>
  )
}

// Resolved once and reused — the .lottie file lives outside the app bundle
// (see WAVE_LOTTIE_PATH in electron/main.ts, same repo-root-relative assets/
// layout as background images and play samples), so it's fetched by path
// through the media:// protocol rather than imported as a module asset.
let waveLottieSrcPromise: Promise<string | null> | null = null
function getWaveLottieSrc(): Promise<string | null> {
  if (!waveLottieSrcPromise) {
    waveLottieSrcPromise = window.api
      .getWaveLottiePath()
      .then((filePath) => (filePath ? platform.getMediaUrl(filePath) : null))
  }
  return waveLottieSrcPromise
}

// Same lazy-resolve-and-cache pattern as getWaveLottieSrc above, for the
// Listen tab's own animation (LISTENING_LOTTIE_PATH in electron/main.ts).
let listeningLottieSrcPromise: Promise<string | null> | null = null
function getListeningLottieSrc(): Promise<string | null> {
  if (!listeningLottieSrcPromise) {
    listeningLottieSrcPromise = window.api
      .getListeningLottiePath()
      .then((filePath) => (filePath ? platform.getMediaUrl(filePath) : null))
  }
  return listeningLottieSrcPromise
}

// Shown in the recording's waveform slot while the mic is live, in place of
// real peaks (there's no finished buffer to analyze yet) — a looping Lottie
// animation just signals "audio is being captured right now."
function RecordingLiveWave({ label = 'Recording…' }: { label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [lottieSrc, setLottieSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getWaveLottieSrc().then((src) => {
      if (!cancelled) setLottieSrc(src)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !lottieSrc) return
    const player = new DotLottie({
      canvas,
      src: lottieSrc,
      loop: true,
      autoplay: true,
      layout: { fit: 'cover' },
      renderConfig: { autoResize: true },
    })
    return () => {
      player.destroy()
    }
  }, [lottieSrc])

  return (
    <div className="studio-waveform-wrap">
      <div className="studio-waveform studio-waveform-recording studio-waveform-live">
        <canvas ref={canvasRef} className="studio-live-wave-canvas" />
        <span className="studio-live-wave-label">
          <span className="studio-live-wave-dot" />
          {label}
        </span>
      </div>
    </div>
  )
}

// The Listen tab's animation — deliberately its own component rather than a
// reuse of RecordingLiveWave above: that one is sized to sit inline in a
// waveform "slot" alongside other Studio tools, while this is Listen mode's
// entire panel content, so it gets a large canvas centered on its own
// (studio-listen-panel is itself centered on screen — see App.css).
function ListeningWave({ label }: { label: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [lottieSrc, setLottieSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getListeningLottieSrc().then((src) => {
      if (!cancelled) setLottieSrc(src)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !lottieSrc) return
    const player = new DotLottie({
      canvas,
      src: lottieSrc,
      loop: true,
      autoplay: true,
      layout: { fit: 'contain' },
      renderConfig: { autoResize: true },
    })
    return () => {
      player.destroy()
    }
  }, [lottieSrc])

  return (
    <div className="studio-listen-wave-wrap">
      <canvas ref={canvasRef} className="studio-listen-wave-canvas" />
      <p className="studio-listen-hint">{label}</p>
    </div>
  )
}

// Static preview of a finished mic take, with playback (see RecordingWaveform's
// props below) rather than the live sine wave shown while still recording.
function RecordingWaveform({
  peaks,
  duration,
  currentTime,
  playing,
  volume,
  onSeek,
  onTogglePlay,
  onActivateToggle,
  onVolumeChange,
  onSave,
  showSave,
  saving,
  saveFailed,
  onRemove,
  selectable,
  selectLabel,
  onSelect,
  overlay,
}: {
  peaks: number[]
  duration: number
  currentTime: number
  playing: boolean
  volume: number
  onSeek: (time: number) => void
  onTogglePlay: () => void
  onActivateToggle?: () => void
  onVolumeChange: (volume: number) => void
  onSave: (format: AudioExportFormat) => void
  showSave?: boolean
  saving?: boolean
  saveFailed?: boolean
  onRemove: () => void
  selectable?: boolean
  selectLabel?: string
  onSelect?: () => void
  // See StudioWaveform's identical prop.
  overlay?: React.ReactNode
}) {
  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0

  function seekFromEvent(e: React.PointerEvent<HTMLDivElement>) {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    onSeek(ratio * duration)
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    seekFromEvent(e)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons !== 1) return
    seekFromEvent(e)
  }

  return (
    <div className="studio-waveform-wrap">
      <div className="studio-waveform-row">
        {selectable && (
          <button
            type="button"
            className="studio-waveform-select"
            onClick={onSelect}
            title={`Select for ${selectLabel ?? 'Time Stretch'}`}
          >
            <CheckIcon />
          </button>
        )}
        <button
          type="button"
          className="studio-recording-play"
          onClick={() => {
            onActivateToggle?.()
            onTogglePlay()
          }}
          aria-pressed={playing}
          title={playing ? 'Pause recording' : 'Play recording'}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div
          className="studio-waveform studio-waveform-recording"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
        >
          {peaks.map((height, index) => {
            const barRatio = peaks.length > 1 ? index / (peaks.length - 1) : 0
            return (
              <span
                key={index}
                className={`studio-waveform-bar recording${barRatio <= progress ? ' played' : ''}`}
                style={{ height: `${Math.max(6, height * 100)}%` }}
              />
            )
          })}
          <div className="studio-waveform-cursor" style={{ left: `${progress * 100}%` }} />
          {overlay}
        </div>
        <input
          type="range"
          className="studio-waveform-volume"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          title="Recording volume"
        />
      </div>
      <div className={`studio-recording-controls${saving || saveFailed ? ' studio-recording-controls-active' : ''}`}>
        <button
          type="button"
          className="studio-waveform-remove"
          onClick={onRemove}
          title="Discard this recording"
        >
          <CloseIcon />
        </button>
        {showSave && <StudioSaveMenu onSave={onSave} saving={saving} failed={saveFailed} />}
      </div>
    </div>
  )
}

// Keeps a fade ratio (fraction of the current selection a fade ramp spans)
// from collapsing to a zero-length or whole-selection ramp while its handle
// is dragged.
function clampFadeRatio(ratio: number): number {
  return Math.min(0.9, Math.max(0.02, ratio))
}

// Draggable start/end trim handles overlaid on the Trim Audio tool's
// selected waveform, plus (once Fade In/Fade Out is toggled on) a diagonal
// tilt handle at that edge of the selection for shaping how quickly the fade
// ramps. Mirrors StudioWaveform/RecordingWaveform's own pointer-capture
// scrub handling, and PlaybackSpeedControl's commit-on-release pattern — a
// drag only moves the handle (cheap re-render), the actual re-slice/re-fade
// (a real buffer copy, passed in as the on*Change callbacks' `commit` flag)
// only runs once on release.
function TrimOverlay({
  trimStart,
  trimEnd,
  onTrimStartChange,
  onTrimEndChange,
  fadeInOn,
  fadeInRatio,
  onFadeInRatioChange,
  fadeOutOn,
  fadeOutRatio,
  onFadeOutRatioChange,
}: {
  trimStart: number
  trimEnd: number
  onTrimStartChange: (value: number, commit: boolean) => void
  onTrimEndChange: (value: number, commit: boolean) => void
  fadeInOn: boolean
  fadeInRatio: number
  onFadeInRatioChange: (value: number, commit: boolean) => void
  fadeOutOn: boolean
  fadeOutRatio: number
  onFadeOutRatioChange: (value: number, commit: boolean) => void
}) {
  const MIN_GAP = 0.02

  // Measured against the handle's own offset parent (.trim-overlay, which
  // exactly covers .studio-waveform via position: absolute; inset: 0) — the
  // same box the waveform bars and cursor already position themselves
  // against.
  function ratioFromEvent(e: React.PointerEvent<HTMLDivElement>): number {
    const rect = e.currentTarget.offsetParent?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  }

  function dragHandlers(onChange: (value: number, commit: boolean) => void, clamp: (ratio: number) => number) {
    return {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        onChange(clamp(ratioFromEvent(e)), false)
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation()
        if (e.buttons !== 1) return
        onChange(clamp(ratioFromEvent(e)), false)
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        e.stopPropagation()
        onChange(clamp(ratioFromEvent(e)), true)
      },
      onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation()
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {}
      },
      onClick: (e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault()
        e.stopPropagation()
      },
    }
  }

  const selectionWidth = Math.max(1e-6, trimEnd - trimStart)

  return (
    <div className="trim-overlay" onPointerDown={(e) => e.stopPropagation()}>
      <div className="trim-dim trim-dim-start" style={{ width: `${trimStart * 100}%` }} />
      <div className="trim-dim trim-dim-end" style={{ width: `${(1 - trimEnd) * 100}%` }} />
      {fadeInOn && (
        <svg
          className="trim-fade-line"
          style={{ left: `${trimStart * 100}%`, width: `${selectionWidth * 100}%` }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <line x1="0" y1="100" x2={fadeInRatio * 100} y2="0" />
        </svg>
      )}
      {fadeOutOn && (
        <svg
          className="trim-fade-line"
          style={{ left: `${trimStart * 100}%`, width: `${selectionWidth * 100}%` }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <line x1={100 - fadeOutRatio * 100} y1="0" x2="100" y2="100" />
        </svg>
      )}
      <div
        className="trim-handle trim-handle-start"
        style={{ left: `${trimStart * 100}%` }}
        title="Drag to set trim start"
        {...dragHandlers(onTrimStartChange, (r) => Math.min(r, trimEnd - MIN_GAP))}
      />
      <div
        className="trim-handle trim-handle-end"
        style={{ left: `${trimEnd * 100}%` }}
        title="Drag to set trim end"
        {...dragHandlers(onTrimEndChange, (r) => Math.max(r, trimStart + MIN_GAP))}
      />
      {fadeInOn && (
        <div
          className="trim-fade-handle trim-fade-handle-in"
          style={{ left: `${(trimStart + fadeInRatio * selectionWidth) * 100}%` }}
          title="Drag to adjust fade-in speed"
          {...dragHandlers(
            (positionRatio, commit) =>
              onFadeInRatioChange(clampFadeRatio((positionRatio - trimStart) / selectionWidth), commit),
            (r) => r
          )}
        />
      )}
      {fadeOutOn && (
        <div
          className="trim-fade-handle trim-fade-handle-out"
          style={{ left: `${(trimEnd - fadeOutRatio * selectionWidth) * 100}%` }}
          title="Drag to adjust fade-out speed"
          {...dragHandlers(
            (positionRatio, commit) =>
              onFadeOutRatioChange(clampFadeRatio((trimEnd - positionRatio) / selectionWidth), commit),
            (r) => r
          )}
        />
      )}
    </div>
  )
}

// Studio's Equalizer "lock" tool — when on, dragging one band to `value`
// shifts every band by the same delta instead of moving just that one, so
// an already-shaped curve can be boosted/cut as a whole. The delta is
// clamped to whatever the tightest band allows (rather than clamping each
// band's own new value individually), which is what keeps their relative
// spacing exactly intact instead of flattening whichever one hits ±40dB
// first.
function applyLockedEqBandChange(
  gains: number[],
  index: number,
  value: number,
  setBandGain: (index: number, value: number) => void
) {
  const requestedDelta = value - gains[index]
  if (requestedDelta === 0) return
  const maxDelta = Math.min(...gains.map((g) => 40 - g))
  const minDelta = Math.max(...gains.map((g) => -40 - g))
  const delta = Math.min(maxDelta, Math.max(minDelta, requestedDelta))
  if (delta === 0) return
  gains.forEach((g, i) => setBandGain(i, g + delta))
}

// The 7-band graphic EQ, shared by the Customize (Equalizer) menu and
// Studio's own per-slot Equalizer tool — same bands/markup either way, bound
// to whichever gains/setter the caller passes so each slot (or the aligned
// Now Playing stream) keeps its own independent EQ.
function EqualizerBands({
  gains,
  onChange,
  onReset,
}: {
  gains: number[]
  onChange: (index: number, value: number) => void
  onReset: () => void
}) {
  return (
    <>
      <div className="equalizer-bands">
        {EQ_BANDS.map((band, i) => (
          <div className="equalizer-band" key={band.freq}>
            <span className="equalizer-band-gain">
              {gains[i] > 0 ? `+${gains[i]}` : gains[i]} dB
            </span>
            <div className="equalizer-slider">
              <input
                type="range"
                min={-40}
                max={40}
                step={0.5}
                value={gains[i]}
                onChange={(e) => onChange(i, Number(e.target.value))}
              />
            </div>
            <span className="equalizer-band-label">{formatEqFreq(band.freq)}</span>
          </div>
        ))}
      </div>
      <button type="button" className="equalizer-reset" onClick={onReset}>
        Reset
      </button>
    </>
  )
}

// Shared by the Customize (Equalizer) menu and Studio's Time Stretch panel —
// same slider, same snap/apply behavior, bound to the same playbackSpeed
// state either way, so speed set from one place is reflected in the other.
function PlaybackSpeedControl({
  playbackSpeed,
  setPlaybackSpeed,
  applyPlaybackSpeed,
  speedSnapEnabled,
  onToggleSnap,
  variant,
}: {
  playbackSpeed: number
  setPlaybackSpeed: (value: number) => void
  applyPlaybackSpeed: (rate: number) => void
  speedSnapEnabled: boolean
  onToggleSnap: () => void
  variant: 'customize' | 'studio'
}) {
  const variantClass = variant === 'customize' ? 'playback-speed-customize' : 'playback-speed-studio'
  return (
    <div className={`playback-speed ${variantClass}`}>
      <div className="playback-speed-header">
        <span className="playback-speed-label">Playback Speed</span>
        <button
          className={`playback-speed-snap-toggle${speedSnapEnabled ? ' active' : ''}`}
          onClick={onToggleSnap}
          title={speedSnapEnabled ? 'Snap to intervals: on' : 'Snap to intervals: off'}
          aria-pressed={speedSnapEnabled}
        >
          <MagnetIcon />
        </button>
      </div>
      <div className="playback-speed-control">
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.01}
          value={playbackSpeed}
          onChange={(e) => {
            // Only updates the slider position/label while dragging — the
            // actual time-stretch is applied on release (below), not on
            // every intermediate value.
            const raw = Number(e.target.value)
            setPlaybackSpeed(speedSnapEnabled ? snapPlaybackSpeed(raw) : raw)
          }}
          // Re-derives the snapped value here instead of trusting the DOM's
          // current .value — these fire as native events separate from
          // onChange, so relying on a controlled re-render having already
          // landed by this point is fragile. Without this, the displayed
          // label could read a snapped 1.00 while the actually-applied
          // rate was still the raw, unsnapped drag position.
          onMouseUp={(e) => {
            const raw = Number(e.currentTarget.value)
            applyPlaybackSpeed(speedSnapEnabled ? snapPlaybackSpeed(raw) : raw)
          }}
          onTouchEnd={(e) => {
            const raw = Number(e.currentTarget.value)
            applyPlaybackSpeed(speedSnapEnabled ? snapPlaybackSpeed(raw) : raw)
          }}
          onKeyUp={(e) => {
            const raw = Number(e.currentTarget.value)
            applyPlaybackSpeed(speedSnapEnabled ? snapPlaybackSpeed(raw) : raw)
          }}
        />
        <span className="playback-speed-value">{playbackSpeed.toFixed(2)}x</span>
      </div>
    </div>
  )
}

// Shared by the Customize (Equalizer) menu and Studio's Time Stretch panel —
// see PlaybackSpeedControl above. setPitchSemitones is a plain setter (like
// PlaybackSpeedControl's setPlaybackSpeed) rather than a functional updater,
// since Studio's per-slot engines expose theirs that way too.
function PitchShiftControl({
  pitchSemitones,
  setPitchSemitones,
}: {
  pitchSemitones: number
  setPitchSemitones: (value: number) => void
}) {
  return (
    <div className="pitch-shift">
      <span className="pitch-shift-label">Pitch</span>
      <div className="pitch-shift-control">
        <button
          className="pitch-shift-button"
          onClick={() => setPitchSemitones(Math.max(PITCH_SEMITONES_MIN, pitchSemitones - 1))}
          disabled={pitchSemitones <= PITCH_SEMITONES_MIN}
          title="Pitch down one semitone"
        >
          &minus;
        </button>
        <span className="pitch-shift-value">
          {pitchSemitones > 0 ? `+${pitchSemitones}` : pitchSemitones}
        </span>
        <button
          className="pitch-shift-button"
          onClick={() => setPitchSemitones(Math.min(PITCH_SEMITONES_MAX, pitchSemitones + 1))}
          disabled={pitchSemitones >= PITCH_SEMITONES_MAX}
          title="Pitch up one semitone"
        >
          +
        </button>
      </div>
    </div>
  )
}

function EditableCell({
  value,
  onSave,
}: {
  value: string
  onSave: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) {
      onSave(trimmed)
    } else {
      setDraft(value)
    }
  }

  if (editing) {
    return (
      <td onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="tag-edit-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft(value)
              setEditing(false)
            }
          }}
        />
      </td>
    )
  }

  return (
    <td
      className="tag-cell"
      onClick={(e) => {
        e.stopPropagation()
        setDraft(value)
        setEditing(true)
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {value}
    </td>
  )
}

const KEY_ALIASES: Record<string, string> = {
  A: 'A',
  'A#': 'A#',
  BB: 'A#',
  B: 'B',
  C: 'C',
  'C#': 'C#',
  DB: 'C#',
  D: 'D',
  'D#': 'D#',
  EB: 'D#',
  E: 'E',
  F: 'F',
  'F#': 'F#',
  GB: 'F#',
  G: 'G',
  'G#': 'G#',
  AB: 'G#',
}

function normalizeKey(input: string): string | null {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '')
  return KEY_ALIASES[cleaned] ?? null
}

const KEY_SEMITONE_MAP: Record<string, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
}

const SEMITONE_TO_KEY = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function shiftKeyBySemitones(key: string | null | undefined, semitones: number): string | null {
  if (!key) return null
  const normalized = normalizeKey(key)
  if (!normalized) return key
  const baseSemitone = KEY_SEMITONE_MAP[normalized]
  if (baseSemitone === undefined) return key
  const shifted = (baseSemitone + semitones + 12) % 12
  return SEMITONE_TO_KEY[shifted]
}

function KeyCell({ value, onSave }: { value: string | null; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  function commit() {
    setEditing(false)
    const normalized = normalizeKey(draft)
    if (normalized && normalized !== value) onSave(normalized)
  }

  if (editing) {
    return (
      <td onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="tag-edit-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft(value ?? '')
              setEditing(false)
            }
          }}
        />
      </td>
    )
  }

  return (
    <td
      className="tag-cell"
      onClick={(e) => {
        e.stopPropagation()
        setDraft(value ?? '')
        setEditing(true)
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {value ?? 'N/A'}
    </td>
  )
}

// div-based counterpart to EditableCell, for the Show Info modal (which
// lays fields out as rows, not a table).
function EditableInfoField({
  label,
  value,
  onSave,
}: {
  label: string
  value: string
  onSave: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) {
      onSave(trimmed)
    } else {
      setDraft(value)
    }
  }

  return (
    <div className="track-info-field">
      <span className="track-info-label">{label}</span>
      {editing ? (
        <input
          className="tag-edit-input track-info-edit-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft(value)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span
          className="track-info-value track-info-value-editable"
          onClick={() => {
            setDraft(value)
            setEditing(true)
          }}
        >
          {value || 'Unknown'}
        </span>
      )}
    </div>
  )
}

// Same as EditableInfoField, but for the Key field's KeyCell-style
// normalization (accepts flats like "Db", stores the sharp form).
function EditableInfoKeyField({
  label,
  value,
  displayValue,
  onSave,
}: {
  label: string
  value: string | null
  // What to show while not editing (e.g. "C Major") when it differs from the
  // raw stored key being edited (e.g. "C").
  displayValue?: string | null
  onSave: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  function commit() {
    setEditing(false)
    const normalized = normalizeKey(draft)
    if (normalized && normalized !== value) onSave(normalized)
    else setDraft(value ?? '')
  }

  return (
    <div className="track-info-field">
      <span className="track-info-label">{label}</span>
      {editing ? (
        <input
          className="tag-edit-input track-info-edit-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft(value ?? '')
              setEditing(false)
            }
          }}
        />
      ) : (
        <span
          className="track-info-value track-info-value-editable"
          onClick={() => {
            setDraft(value ?? '')
            setEditing(true)
          }}
        >
          {displayValue ?? value ?? 'Unknown'}
        </span>
      )}
    </div>
  )
}

const PIANO_WHITE_KEYS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const PIANO_BLACK_KEYS = [
  { key: 'C#', afterIndex: 0 },
  { key: 'D#', afterIndex: 1 },
  { key: 'F#', afterIndex: 3 },
  { key: 'G#', afterIndex: 4 },
  { key: 'A#', afterIndex: 5 },
]

function PianoKeySelector({
  availableKeys,
  selectedKey,
  onSelect,
}: {
  availableKeys: Set<string>
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  return (
    <div className="piano">
      {PIANO_BLACK_KEYS.map(({ key: k, afterIndex }) => {
        const present = availableKeys.has(k)
        const leftPercent = ((afterIndex + 1) / PIANO_WHITE_KEYS.length) * 100
        return (
          <button
            key={k}
            type="button"
            disabled={!present}
            className={`piano-key piano-key-sharp${present ? ' present' : ''}${selectedKey === k ? ' selected' : ''}`}
            style={{ left: `${leftPercent}%` }}
            onClick={() => onSelect(k)}
          >
            {k}
          </button>
        )
      })}
      <div className="piano-naturals">
        {PIANO_WHITE_KEYS.map((k) => {
          const present = availableKeys.has(k)
          return (
            <div key={k} className="piano-key-cell">
              <button
                type="button"
                disabled={!present}
                className={`piano-key piano-key-natural${present ? ' present' : ''}${selectedKey === k ? ' selected' : ''}`}
                onClick={() => onSelect(k)}
              >
                {k}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function KeyHeaderCell({
  keyFilter,
  onKeyFilterChange,
  availableKeys,
}: {
  keyFilter: string | null
  onKeyFilterChange: (key: string | null) => void
  availableKeys: Set<string>
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <th className={`key-th${keyFilter ? ' active' : ''}`}>
      <div className="key-filter" ref={menuRef}>
        <button type="button" className="key-filter-btn" onClick={() => setOpen((v) => !v)}>
          KEY{keyFilter ? `: ${keyFilter}` : ''}
        </button>
        {open && (
          <div className="key-filter-popover" onClick={(e) => e.stopPropagation()}>
            <PianoKeySelector
              availableKeys={availableKeys}
              selectedKey={keyFilter}
              onSelect={(k) => {
                onKeyFilterChange(keyFilter === k ? null : k)
                setOpen(false)
              }}
            />
          </div>
        )}
      </div>
    </th>
  )
}

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return null
  return <span className="sort-arrow">{dir === 'asc' ? '▲' : '▼'}</span>
}

function SortMenu<T extends string>({
  value,
  onChange,
  labels = SORT_LABELS as unknown as Partial<Record<T, string>>,
}: {
  value: T
  onChange: (value: T) => void
  labels?: Partial<Record<T, string>>
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="sort-menu" ref={menuRef}>
      <button className="sort-menu-btn" onClick={() => setOpen((v) => !v)}>
        <span>{labels[value] ?? value}</span>
        <span className="sort-menu-chevron">
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className="sort-menu-dropdown">
          {(Object.keys(labels) as T[]).map((option) => (
            <button
              key={option}
              className={option === value ? 'active' : ''}
              onClick={() => {
                onChange(option)
                setOpen(false)
              }}
            >
              {labels[option]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" />
    </svg>
  )
}

function RecentTile({
  track,
  onPlay,
  onRemove,
  onOpenInStudio,
  onContextMenu,
}: {
  track: Track
  onPlay: () => void
  onRemove: () => void
  onOpenInStudio: () => void
  onContextMenu?: (track: Track, e: React.MouseEvent) => void
}) {
  const art = useTrackArt(track.filePath)
  const src = track.customArtPath ? platform.getMediaUrl(track.customArtPath) : (art ?? DEFAULT_ART)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  return (
    <div
      className="recent-tile"
      onClick={onPlay}
      onContextMenu={(e) => {
        if (onContextMenu) {
          e.preventDefault()
          e.stopPropagation()
          onContextMenu(track, e)
        }
      }}
    >
      <div className="recent-tile-art-wrap">
        <img src={src} className="recent-tile-art" alt="" draggable={false} />
        <div className="recent-tile-menu" ref={menuRef}>
          <button
            className="recent-tile-menu-btn"
            aria-label="More options"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <div className="recent-tile-menu-dropdown">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onOpenInStudio()
                }}
              >
                Open In Studio
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onRemove()
                }}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="recent-tile-title">{track.title}</div>
      <div className="recent-tile-artist">{track.artist}</div>
    </div>
  )
}

// Applied to a grid tile's root element to make it drag-sortable —
// dragHandle is undefined outside a DndContext/SortableContext (e.g. a
// picker view), in which case the tile is just static.
type TileDragProps = {
  setNodeRef: (el: HTMLElement | null) => void
  style: CSSProperties
  attributes: ReturnType<typeof useSortable>['attributes']
  listeners: ReturnType<typeof useSortable>['listeners']
}

function SortableGridItem({
  id,
  children,
}: {
  id: string | number
  children: (dragHandle: TileDragProps) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <>
      {children({
        setNodeRef,
        style: {
          transform: CSS.Transform.toString(transform),
          transition,
          opacity: isDragging ? 0.5 : undefined,
          cursor: isDragging ? 'grabbing' : 'grab',
        },
        attributes,
        listeners,
      })}
    </>
  )
}

function FolderTile({
  folder,
  onOpen,
  onRename,
  onRemove,
  onSelectArt,
  onUploadArt,
  onRemoveArt,
  dragHandle,
}: {
  folder: Folder
  onOpen: () => void
  onRename: (name: string) => void
  onRemove: () => void
  onSelectArt: (filePath: string) => void
  onUploadArt: () => void
  onRemoveArt: () => void
  dragHandle?: TileDragProps
}) {
  const displayName = folder.name?.trim() || folderBaseName(folder.path)
  const artSrc = folder.customArtPath ? platform.getMediaUrl(folder.customArtPath) : DEFAULT_ART
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [pickingImage, setPickingImage] = useState(false)
  const [draft, setDraft] = useState(displayName)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false)
        setPickingImage(false)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  function commitRename() {
    setRenaming(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== displayName) onRename(trimmed)
    else setDraft(displayName)
  }

  return (
    <div
      className="folder-tile"
      ref={dragHandle?.setNodeRef}
      style={dragHandle?.style}
      {...dragHandle?.attributes}
      {...dragHandle?.listeners}
    >
      <div className="folder-tile-art-wrap">
        <img
          src={artSrc}
          className="folder-tile-art"
          alt=""
          draggable={false}
          onClick={onOpen}
        />
        <div className="folder-tile-menu" ref={menuRef}>
          <button
            className="folder-tile-menu-btn"
            aria-label="More options"
            onClick={(e) => {
              e.stopPropagation()
              setPickingImage(false)
              setMenuOpen((v) => !v)
            }}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <div
              className={
                pickingImage ? 'folder-tile-menu-dropdown picking-image' : 'folder-tile-menu-dropdown'
              }
            >
              {pickingImage ? (
                <ImagePickerPanel
                  hasCustomArt={!!folder.customArtPath}
                  onSelectPreset={(filePath) => {
                    setMenuOpen(false)
                    setPickingImage(false)
                    onSelectArt(filePath)
                  }}
                  onUploadCustom={() => {
                    setMenuOpen(false)
                    setPickingImage(false)
                    onUploadArt()
                  }}
                  onRemove={() => {
                    setMenuOpen(false)
                    setPickingImage(false)
                    onRemoveArt()
                  }}
                />
              ) : (
                <>
                  <button
                    className="folder-tile-menu-item"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDraft(displayName)
                      setRenaming(true)
                      setMenuOpen(false)
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="folder-tile-menu-item"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPickingImage(true)
                    }}
                  >
                    Change Image
                  </button>
                  <button
                    className="folder-tile-menu-item"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      onRemove()
                    }}
                  >
                    Remove
                  </button>
                  {folder.customArtPath && (
                    <button
                      className="folder-tile-menu-item"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpen(false)
                        onRemoveArt()
                      }}
                    >
                      Remove Image
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {renaming ? (
        <input
          className="tag-edit-input folder-tile-rename-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft(displayName)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <div className="folder-tile-title-row">
          <div className="folder-tile-title">{displayName}</div>
          {folder.isolated ? <span className="isolated-badge">Isolated</span> : null}
        </div>
      )}
    </div>
  )
}

function PlaylistIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
}

function PlaylistTile({
  playlist,
  onOpen,
  onRename,
  onDelete,
  dragHandle,
}: {
  playlist: Playlist
  onOpen: () => void
  onRename: (name: string) => void
  onDelete: () => void
  dragHandle?: TileDragProps
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(playlist.name)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  function commitRename() {
    setRenaming(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== playlist.name) onRename(trimmed)
    else setDraft(playlist.name)
  }

  return (
    <div
      className="folder-tile"
      ref={dragHandle?.setNodeRef}
      style={dragHandle?.style}
      {...dragHandle?.attributes}
      {...dragHandle?.listeners}
    >
      <div className="folder-tile-art-wrap">
        <div className="folder-tile-art playlist-tile-art" onClick={onOpen}>
          <PlaylistIcon />
        </div>
        <div className="folder-tile-menu" ref={menuRef}>
          <button
            className="folder-tile-menu-btn"
            aria-label="More options"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <div className="folder-tile-menu-dropdown">
              <button
                className="folder-tile-menu-item"
                onClick={(e) => {
                  e.stopPropagation()
                  setDraft(playlist.name)
                  setRenaming(true)
                  setMenuOpen(false)
                }}
              >
                Rename
              </button>
              <button
                className="folder-tile-menu-item"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onDelete()
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {renaming ? (
        <input
          className="tag-edit-input folder-tile-rename-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft(playlist.name)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <div className="folder-tile-title">{playlist.name}</div>
      )}
      <div className="playlist-tile-count">
        {playlist.trackCount} {playlist.trackCount === 1 ? 'song' : 'songs'}
      </div>
    </div>
  )
}

function NewPlaylistTile({ onCreate }: { onCreate: () => void }) {
  return (
    <button className="folder-tile new-playlist-tile" onClick={onCreate}>
      <div className="folder-tile-art-wrap">
        <div className="folder-tile-art playlist-tile-art new-playlist-tile-art">
          <span className="new-playlist-plus">+</span>
        </div>
      </div>
      <div className="folder-tile-title">New Playlist</div>
    </button>
  )
}

function ImagePickerPanel({
  hasCustomArt,
  onSelectPreset,
  onUploadCustom,
  onRemove,
  onOpenInStudio,
}: {
  hasCustomArt: boolean
  onSelectPreset: (filePath: string) => void
  onUploadCustom: () => void
  onRemove: () => void
  onOpenInStudio?: () => void
}) {
  const [presets, setPresets] = useState<string[] | null>(null)

  useEffect(() => {
    platform.listBackgroundImages().then(setPresets)
  }, [])

  return (
    <>
      <div className="art-menu-label">Change Image</div>
      <div className="art-menu-grid">
        {(presets ?? []).map((filePath) => (
          <button
            key={filePath}
            className="art-menu-thumb"
            onClick={() => onSelectPreset(filePath)}
          >
            <img src={platform.getMediaUrl(filePath)} alt="" draggable={false} />
          </button>
        ))}
      </div>
      <button className="art-menu-upload" onClick={onUploadCustom}>
        Upload your own...
      </button>
      {hasCustomArt && (
        <button className="art-menu-remove" onClick={onRemove}>
          Remove
        </button>
      )}
      {onOpenInStudio && (
        <button className="art-menu-open-studio" onClick={onOpenInStudio}>
          Open In Studio
        </button>
      )}
    </>
  )
}

function ArtChangeMenu({
  hasCustomArt,
  onSelectPreset,
  onUploadCustom,
  onRemove,
  onOpenInStudio,
}: {
  hasCustomArt: boolean
  onSelectPreset: (filePath: string) => void
  onUploadCustom: () => void
  onRemove: () => void
  onOpenInStudio?: () => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="art-menu" ref={menuRef}>
      <button
        className="art-menu-btn"
        aria-label="Change image"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="art-menu-dropdown">
          <ImagePickerPanel
            hasCustomArt={hasCustomArt}
            onSelectPreset={(filePath) => {
              setOpen(false)
              onSelectPreset(filePath)
            }}
            onUploadCustom={() => {
              setOpen(false)
              onUploadCustom()
            }}
            onRemove={() => {
              setOpen(false)
              onRemove()
            }}
            onOpenInStudio={
              onOpenInStudio
                ? () => {
                    setOpen(false)
                    onOpenInStudio()
                  }
                : undefined
            }
          />
        </div>
      )}
    </div>
  )
}

function QueueMenu({
  queue,
  onPlay,
  onRemove,
  onClear,
}: {
  queue: Track[]
  onPlay: (index: number) => void
  onRemove: (index: number) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="queue-menu" ref={menuRef}>
      <button
        type="button"
        className="queue-menu-btn"
        aria-label="Queue"
        title="Queue"
        onClick={() => setOpen((v) => !v)}
      >
        <QueueIcon />
        {queue.length > 0 && <span className="queue-badge">{queue.length}</span>}
      </button>
      {open && (
        <div className="queue-menu-dropdown">
          <div className="queue-menu-header">
            <span>Up Next</span>
            {queue.length > 0 && (
              <button type="button" className="queue-menu-clear" onClick={onClear}>
                Clear
              </button>
            )}
          </div>
          {queue.length === 0 ? (
            <div className="queue-menu-empty">
              Queue is empty. Right-click a song and choose "Add to Queue".
            </div>
          ) : (
            <ul className="queue-menu-list">
              {queue.map((track, i) => (
                <li key={`${track.id}-${i}`} className="queue-menu-item">
                  <button type="button" className="queue-menu-item-play" onClick={() => onPlay(i)}>
                    <div className="queue-menu-item-title">{track.title}</div>
                    <div className="queue-menu-item-artist">{track.artist}</div>
                  </button>
                  <button
                    type="button"
                    className="queue-menu-item-remove"
                    aria-label="Remove from queue"
                    onClick={() => onRemove(i)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function PresetsMenu({
  presets,
  defaultPresetName,
  favoritePresetNames,
  onApply,
  onSave,
  onDelete,
  onToggleFavorite,
}: {
  presets: CustomizePreset[]
  defaultPresetName: string
  favoritePresetNames: string[]
  onApply: (preset: CustomizePreset) => void
  onSave: (name: string) => void
  onDelete: (name: string) => void
  onToggleFavorite: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const trimmedName = newName.trim()
  const isReservedName = trimmedName.toLowerCase() === defaultPresetName.toLowerCase()
  const favoriteRankByName = useMemo(
    () => new Map(favoritePresetNames.map((name, index) => [name, index + 1])),
    [favoritePresetNames],
  )
  const sortedPresets = useMemo(() => {
    return [...presets].sort((a, b) => {
      const aRank = favoriteRankByName.get(a.name)
      const bRank = favoriteRankByName.get(b.name)
      const aIsFavorite = aRank !== undefined
      const bIsFavorite = bRank !== undefined

      // Keep favorites at the top, ordered by their pinned slot (1..6).
      if (aIsFavorite && bIsFavorite) return aRank - bRank
      if (aIsFavorite) return -1
      if (bIsFavorite) return 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }, [presets, favoriteRankByName])

  function submitSave() {
    if (!trimmedName || isReservedName) return
    onSave(trimmedName)
    setNewName('')
  }

  return (
    <div className="presets-menu" ref={menuRef}>
      <button
        className="presets-menu-btn"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        Presets
        <span className="presets-menu-btn-chevron">
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className="presets-menu-dropdown">
          <div className="presets-menu-list">
            {sortedPresets.map((preset) => {
              const isDefault = preset.name === defaultPresetName
              const favoriteRank = favoriteRankByName.get(preset.name)
              const isFavorite = favoriteRank !== undefined
              const favoriteDisabled = !isFavorite && favoritePresetNames.length >= MAX_FAVORITE_PRESETS
              return (
                <div className="presets-menu-row" key={preset.name}>
                  <button
                    className={`presets-menu-item-favorite${isFavorite ? ' active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleFavorite(preset.name)
                    }}
                    disabled={favoriteDisabled}
                    title={
                      favoriteDisabled
                        ? `Up to ${MAX_FAVORITE_PRESETS} favorites`
                        : isFavorite
                          ? `Unfavorite ${preset.name}`
                          : `Favorite ${preset.name}`
                    }
                    aria-label={isFavorite ? `Unfavorite ${preset.name}` : `Favorite ${preset.name}`}
                    aria-pressed={isFavorite}
                  >
                    {favoriteRank ?? ''}
                  </button>
                  <button
                    className="presets-menu-item"
                    onClick={() => {
                      onApply(preset)
                      setOpen(false)
                    }}
                  >
                    {preset.name}
                  </button>
                  {!isDefault && (
                    <button
                      className="presets-menu-item-delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(preset.name)
                      }}
                      title={`Delete ${preset.name}`}
                      aria-label={`Delete ${preset.name}`}
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="presets-menu-save">
            <input
              type="text"
              className="presets-menu-input"
              placeholder="Preset name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSave()
              }}
            />
            <button
              className="presets-menu-save-btn"
              disabled={!trimmedName || isReservedName}
              title={isReservedName ? `"${defaultPresetName}" is reserved` : undefined}
              onClick={submitSave}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function EqPresetsMenu({
  presets,
  onApply,
  onSave,
  onDelete,
}: {
  presets: EqPreset[]
  onApply: (preset: EqPreset) => void
  onSave: (name: string) => void
  onDelete: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const trimmedName = newName.trim()
  const isReservedName = isStockEqPresetName(trimmedName)
  // Stock presets stay in their defined order up top; user presets follow, A-Z.
  const sortedPresets = useMemo(() => {
    const stock = presets.filter((p) => isStockEqPresetName(p.name))
    const custom = presets
      .filter((p) => !isStockEqPresetName(p.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return [...stock, ...custom]
  }, [presets])

  function submitSave() {
    if (!trimmedName || isReservedName) return
    onSave(trimmedName)
    setNewName('')
  }

  return (
    <div className="presets-menu eq-presets-menu" ref={menuRef}>
      <button
        className="presets-menu-btn presets-menu-btn-icon"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        title="Equalizer presets"
        aria-label="Equalizer presets"
      >
        <EqualizerIcon />
      </button>
      {open && (
        <div className="presets-menu-dropdown">
          <div className="presets-menu-list">
            {sortedPresets.map((preset) => {
              const isStock = isStockEqPresetName(preset.name)
              return (
                <div className="presets-menu-row" key={preset.name}>
                  <button
                    className="presets-menu-item"
                    onClick={() => {
                      onApply(preset)
                      setOpen(false)
                    }}
                  >
                    {preset.name}
                  </button>
                  {!isStock && (
                    <button
                      className="presets-menu-item-delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(preset.name)
                      }}
                      title={`Delete ${preset.name}`}
                      aria-label={`Delete ${preset.name}`}
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="presets-menu-save">
            <input
              type="text"
              className="presets-menu-input"
              placeholder="Preset name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSave()
              }}
            />
            <button
              className="presets-menu-save-btn"
              disabled={!trimmedName || isReservedName}
              title={isReservedName ? `"${trimmedName}" is a built-in preset name` : undefined}
              onClick={submitSave}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function AddToPlaylistMenu({
  playlists,
  onAdd,
  onCreateAndAdd,
}: {
  playlists: Playlist[]
  onAdd: (playlistId: number) => void
  onCreateAndAdd: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  function submitCreate() {
    const trimmed = newName.trim()
    if (!trimmed) return
    onCreateAndAdd(trimmed)
    setNewName('')
    setOpen(false)
  }

  return (
    <div className="add-to-playlist-menu" ref={menuRef}>
      <button className="btn-primary" onClick={() => setOpen((v) => !v)}>
        Add to Playlist
      </button>
      {open && (
        <div className="add-to-playlist-dropdown">
          {playlists.length > 0 && (
            <div className="add-to-playlist-list">
              {playlists.map((p) => (
                <button
                  key={p.id}
                  className="add-to-playlist-item"
                  onClick={() => {
                    onAdd(p.id)
                    setOpen(false)
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
          <div className="add-to-playlist-new">
            <input
              type="text"
              placeholder="New playlist name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate()
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <button onClick={submitCreate} disabled={!newName.trim()}>
              Create
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SelectionToolbar({
  count,
  playlists,
  onAddToPlaylist,
  onCreatePlaylistAndAdd,
  onRemoveFromPlaylist,
  onClear,
}: {
  count: number
  playlists: Playlist[]
  onAddToPlaylist: (playlistId: number) => void
  onCreatePlaylistAndAdd: (name: string) => void
  onRemoveFromPlaylist?: () => void
  onClear: () => void
}) {
  return (
    <div className="selection-toolbar">
      <span className="selection-toolbar-count">{count} selected</span>
      <AddToPlaylistMenu
        playlists={playlists}
        onAdd={onAddToPlaylist}
        onCreateAndAdd={onCreatePlaylistAndAdd}
      />
      {onRemoveFromPlaylist && (
        <button className="btn-primary" onClick={onRemoveFromPlaylist}>
          Remove from Playlist
        </button>
      )}
      <button className="selection-toolbar-clear" onClick={onClear} aria-label="Clear selection">
        <CloseIcon />
      </button>
    </div>
  )
}

function sortTracks(tracks: Track[], sortBy: SortOption, sortDir: SortDir): Track[] {
  const sorted = [...tracks]
  const dir = sortDir === 'desc' ? -1 : 1
  if (sortBy === 'title') {
    sorted.sort((a, b) => dir * (a.title ?? '').localeCompare(b.title ?? ''))
  } else if (sortBy === 'artist') {
    sorted.sort((a, b) => dir * (a.artist ?? '').localeCompare(b.artist ?? ''))
  } else if (sortBy === 'album') {
    sorted.sort((a, b) => dir * (a.album ?? '').localeCompare(b.album ?? ''))
  } else if (sortBy === 'key') {
    sorted.sort((a, b) => dir * (a.key ?? '').localeCompare(b.key ?? ''))
  } else if (sortBy === 'duration') {
    sorted.sort((a, b) => dir * ((a.duration ?? 0) - (b.duration ?? 0)))
  } else if (sortBy === 'dateAdded') {
    sorted.sort((a, b) => b.dateAdded - a.dateAdded)
  } else if (sortBy === 'dateModified') {
    sorted.sort((a, b) => dir * ((a.modifiedAt ?? 0) - (b.modifiedAt ?? 0)))
  } else if (sortBy === 'favorite') {
    sorted.sort((a, b) => {
      const aFavorited = a.favoriteAt ?? 0
      const bFavorited = b.favoriteAt ?? 0
      if (aFavorited !== bFavorited) return bFavorited - aFavorited
      return (a.title ?? '').localeCompare(b.title ?? '')
    })
  } else if (sortBy === 'custom') {
    sorted.sort((a, b) => {
      const aOrder = a.sortOrder
      const bOrder = b.sortOrder
      if (aOrder !== null && bOrder !== null) return dir * (aOrder - bOrder)
      if (aOrder !== null) return -1
      if (bOrder !== null) return 1
      return 0
    })
  } else {
    sorted.sort((a, b) => {
      const aPlayed = a.lastPlayedAt ?? null
      const bPlayed = b.lastPlayedAt ?? null
      if (aPlayed !== null && bPlayed !== null) return bPlayed - aPlayed
      if (aPlayed !== null) return -1
      if (bPlayed !== null) return 1
      return (a.title ?? '').localeCompare(b.title ?? '')
    })
  }
  return sorted
}

interface TrackExtraColumn {
  label: string
  isChecked: (track: Track) => boolean
  onToggle: (track: Track) => void
}

function TrackTable({
  tracks,
  sortBy,
  sortDir,
  onSortChange,
  currentTrackId,
  selectedIds,
  onToggleSelected,
  onPlay,
  onOpenNowPlaying,
  onSaveTag,
  pendingTagEdits,
  onApplyPendingTagUpdate,
  keyFilter,
  onKeyFilterChange,
  availableKeys,
  emptyMessage,
  extraColumn,
  onRowContextMenu,
  onReorder: onReorderProp,
  getCustomOrder,
}: {
  tracks: Track[]
  sortBy: SortOption
  sortDir: SortDir
  onSortChange: (value: SortOption) => void
  currentTrackId: number | null
  selectedIds: Set<number>
  onToggleSelected: (id: number) => void
  onPlay: (id: number) => void
  onOpenNowPlaying?: (id: number) => void
  onSaveTag: (track: Track, tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>) => void
  pendingTagEdits: Record<number, { tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>; expiresAt: number }>
  onApplyPendingTagUpdate: (track: Track) => void
  keyFilter: string | null
  onKeyFilterChange: (key: string | null) => void
  availableKeys: Set<string>
  emptyMessage: string
  extraColumn?: TrackExtraColumn
  onRowContextMenu?: (track: Track, e: React.MouseEvent) => void
  // Presence enables drag-to-reorder; called with the full new visible
  // track-id order on drop, and switches the sort control to "Custom".
  onReorder?: (orderedIds: number[]) => void
  // Overrides what "Custom" order means for this table. Defaults to the
  // track's own (global) sortOrder field — used as-is for the Songs tab and
  // an open folder's tracks. An open playlist's track list passes its own
  // (per-playlist) position-derived order instead.
  getCustomOrder?: (track: Track) => number
}) {
  // Drag-to-reorder is disabled on touch: the rows would need
  // `touch-action: none`, which eats vertical scrolling of the list.
  const onReorder = import.meta.env.VOLURE_MOBILE ? undefined : onReorderProp

  const sortedTracks = useMemo(() => {
    if (sortBy === 'extra' && extraColumn) {
      const dir = sortDir === 'desc' ? -1 : 1
      return [...tracks].sort(
        (a, b) => dir * (Number(extraColumn.isChecked(a)) - Number(extraColumn.isChecked(b)))
      )
    }
    if (sortBy === 'custom' && getCustomOrder) {
      const dir = sortDir === 'desc' ? -1 : 1
      return [...tracks].sort((a, b) => dir * (getCustomOrder(a) - getCustomOrder(b)))
    }
    return sortTracks(tracks, sortBy, sortDir)
  }, [tracks, sortBy, sortDir, extraColumn, getCustomOrder])

  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!onReorder || !over || active.id === over.id) return
    const oldIndex = sortedTracks.findIndex((t) => t.id === active.id)
    const newIndex = sortedTracks.findIndex((t) => t.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const newOrder = arrayMove(sortedTracks, oldIndex, newIndex)
    if (sortBy !== 'custom') onSortChange('custom')
    onReorder(newOrder.map((t) => t.id))
  }

  // FLIP animation: when a row's position changes (e.g. a track jumps to the
  // top under the "Most Recent" sort), slide it from its old spot to its new
  // one instead of letting it snap there instantly.
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map())
  const rowPositions = useRef<Map<number, number>>(new Map())
  const orderKey = useMemo(() => sortedTracks.map((t) => t.id).join(','), [sortedTracks])

  useLayoutEffect(() => {
    const newPositions = new Map<number, number>()
    rowRefs.current.forEach((el, id) => {
      newPositions.set(id, el.getBoundingClientRect().top)
    })

    rowRefs.current.forEach((el, id) => {
      const prevTop = rowPositions.current.get(id)
      const newTop = newPositions.get(id)
      if (prevTop === undefined || newTop === undefined) return
      const delta = prevTop - newTop
      if (delta === 0) return
      el.style.transition = 'none'
      el.style.transform = `translateY(${delta}px)`
      el.getBoundingClientRect() // force reflow so the starting transform registers
      el.style.transition = 'transform 0.4s ease'
      el.style.transform = ''
    })

    rowPositions.current = newPositions
  }, [orderKey])

  if (tracks.length === 0) {
    return (
      <div className="empty-state">
        <p>{keyFilter ? `No songs in key ${keyFilter}.` : emptyMessage}</p>
      </div>
    )
  }

  return (
    <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={sortedTracks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <table className="track-table">
      <thead>
        <tr>
          <th></th>
          <th></th>
          <th className="sort-th">
            <SortMenu value={sortBy} onChange={onSortChange} />
            <span
              className={`sortable-th-label${sortBy === 'title' ? ' active' : ''}`}
              onClick={() => onSortChange('title')}
            >
              Title
              <SortArrow active={sortBy === 'title'} dir={sortDir} />
            </span>
          </th>
          <th
            className={`sortable-th${sortBy === 'artist' ? ' active' : ''}`}
            onClick={() => onSortChange('artist')}
          >
            Artist
            <SortArrow active={sortBy === 'artist'} dir={sortDir} />
          </th>
          <th
            className={`sortable-th${sortBy === 'album' ? ' active' : ''}`}
            onClick={() => onSortChange('album')}
          >
            Album
            <SortArrow active={sortBy === 'album'} dir={sortDir} />
          </th>
          <KeyHeaderCell
            keyFilter={keyFilter}
            onKeyFilterChange={onKeyFilterChange}
            availableKeys={availableKeys}
          />
          <th
            className={`sortable-th${sortBy === 'duration' ? ' active' : ''}`}
            onClick={() => onSortChange('duration')}
          >
            Duration
            <SortArrow active={sortBy === 'duration'} dir={sortDir} />
          </th>
          {extraColumn && (
            <th
              className={`sortable-th${sortBy === 'extra' ? ' active' : ''}`}
              onClick={() => onSortChange('extra')}
            >
              {extraColumn.label}
              <SortArrow active={sortBy === 'extra'} dir={sortDir} />
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {sortedTracks.map((track) => (
          <TrackRow
            key={track.id}
            track={track}
            draggable={!!onReorder}
            registerRowRef={(id, el) => {
              if (el) rowRefs.current.set(id, el)
              else rowRefs.current.delete(id)
            }}
            currentTrackId={currentTrackId}
            selectedIds={selectedIds}
            extraColumn={extraColumn}
            onToggleSelected={onToggleSelected}
            onPlay={onPlay}
            onOpenNowPlaying={onOpenNowPlaying}
            onSaveTag={onSaveTag}
            pendingTagEdits={pendingTagEdits}
            onApplyPendingTagUpdate={onApplyPendingTagUpdate}
            onRowContextMenu={onRowContextMenu}
          />
        ))}
      </tbody>
        </table>
      </SortableContext>
    </DndContext>
  )
}

function TrackRow({
  track,
  draggable,
  registerRowRef,
  currentTrackId,
  selectedIds,
  extraColumn,
  onToggleSelected,
  onPlay,
  onOpenNowPlaying,
  onSaveTag,
  pendingTagEdits,
  onApplyPendingTagUpdate,
  onRowContextMenu,
}: {
  track: Track
  draggable: boolean
  registerRowRef: (id: number, el: HTMLTableRowElement | null) => void
  currentTrackId: number | null
  selectedIds: Set<number>
  extraColumn?: TrackExtraColumn
  onToggleSelected: (id: number) => void
  onPlay: (id: number) => void
  onOpenNowPlaying?: (id: number) => void
  onSaveTag: (track: Track, tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>) => void
  pendingTagEdits: Record<number, { tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>; expiresAt: number }>
  onApplyPendingTagUpdate: (track: Track) => void
  onRowContextMenu?: (track: Track, e: React.MouseEvent) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.id,
  })

  return (
    <tr
      ref={(el) => {
        setNodeRef(el)
        registerRowRef(track.id, el)
      }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
      }}
      className={[
        'track-row',
        draggable ? 'row-draggable' : '',
        track.id === currentTrackId ? 'active' : '',
        selectedIds.has(track.id) ? 'selected' : '',
        extraColumn?.isChecked(track) ? 'row-included' : '',
      ].join(' ')}
      onContextMenu={(e) => {
        if (!onRowContextMenu) return
        e.preventDefault()
        onRowContextMenu(track, e)
      }}
      {...(draggable ? attributes : undefined)}
      {...(draggable ? listeners : undefined)}
    >
      <td className="row-select-cell">
        {pendingTagEdits[track.id] ? (
          <button
            type="button"
            className="pending-tag-update-button"
            onClick={(e) => {
              e.stopPropagation()
              onApplyPendingTagUpdate(track)
            }}
            title="Update file metadata"
          >
            Update
          </button>
        ) : (
          <input
            type="checkbox"
            className="row-checkbox"
            checked={selectedIds.has(track.id)}
            onChange={() => onToggleSelected(track.id)}
          />
        )}
      </td>
      <td
        className="track-art-cell"
        onClick={() => onPlay(track.id)}
        onDoubleClick={() => onOpenNowPlaying?.(track.id)}
      >
        <TrackArtThumb track={track} size={46} />
      </td>
      {import.meta.env.VOLURE_MOBILE ? (
        <>
          {/* Touch: a tap anywhere on the row plays the track. Inline tag
              editing is desktop-only — it fires on a stray tap otherwise. */}
          <td className="tag-cell" onClick={() => onPlay(track.id)}>
            {track.title || 'Unknown title'}
          </td>
          <td className="tag-cell" onClick={() => onPlay(track.id)}>
            {track.artist || 'Unknown artist'}
          </td>
          <td className="tag-cell" onClick={() => onPlay(track.id)}>
            {track.album || ''}
          </td>
          <td onClick={() => onPlay(track.id)}>{track.key || ''}</td>
        </>
      ) : (
        <>
          <EditableCell
            value={track.title ?? ''}
            onSave={(title) => onSaveTag(track, { title })}
          />
          <EditableCell
            value={track.artist ?? ''}
            onSave={(artist) => onSaveTag(track, { artist })}
          />
          <EditableCell
            value={track.album ?? ''}
            onSave={(album) => onSaveTag(track, { album })}
          />
          <KeyCell
            value={track.key}
            onSave={(key) => onSaveTag(track, { key })}
          />
        </>
      )}
      <td>{formatTime(track.duration)}</td>
      {extraColumn && (
        <td className="extra-column-cell">
          <input
            type="checkbox"
            className="extra-checkbox"
            checked={extraColumn.isChecked(track)}
            onChange={() => extraColumn.onToggle(track)}
          />
        </td>
      )}
    </tr>
  )
}

// Digits only — each keystroke re-derives the dashed sequence from scratch,
// so backspacing through a dash removes the digit before it instead of
// getting stuck on a stray separator.
function formatBassSequence(raw: string): string {
  return raw.replace(/\D/g, '').split('').join('-')
}

// A bass sequence is "included" in a track's stored progression if the
// query appears anywhere as an unbroken run read starting from any point in
// its own cycle — querying "1-3-4" matches a stored "3-4-1" or "4-1-3", not
// just an exact "1-3-4" — but never reversed (a cyclic reading only makes
// sense for 3+ notes; a 2-note "cycle" is just an alternation, so 1- and
// 2-digit queries match literally, in the order typed, with no rotation).
function bassSequenceIncludes(storedSequence: string, query: string): boolean {
  const stored = storedSequence.split('-').map(Number)
  const pattern = query.split('-').map(Number)
  if (pattern.length === 0 || pattern.length > stored.length) return false
  const rotations =
    pattern.length >= 3
      ? pattern.map((_, i) => [...pattern.slice(i), ...pattern.slice(0, i)])
      : [pattern]
  for (let start = 0; start <= stored.length - pattern.length; start++) {
    const window = stored.slice(start, start + pattern.length)
    if (rotations.some((rotation) => rotation.every((digit, i) => digit === window[i]))) return true
  }
  return false
}

function BassIntervalCell({
  entries,
  onAdd,
}: {
  entries: BassInterval[]
  onAdd: (sequence: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function commit() {
    setEditing(false)
    if (draft) onAdd(draft)
    setDraft('')
  }

  if (editing) {
    return (
      <td onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="tag-edit-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(formatBassSequence(e.target.value))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft('')
              setEditing(false)
            }
          }}
        />
      </td>
    )
  }

  return (
    <td
      className="tag-cell bass-interval-cell"
      onClick={(e) => {
        e.stopPropagation()
        setDraft('')
        setEditing(true)
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {entries.length === 0 ? (
        'N/A'
      ) : (
        entries.map((entry, i) => (
          <span key={entry.id} className="bass-interval-chip">
            {i > 0 && <span className="bass-interval-sep">|</span>}
            <span className="bass-interval-sequence">{entry.sequence}</span>
          </span>
        ))
      )}
    </td>
  )
}

// Add-only input used in the track info panel — the table cell has its own
// click-to-edit version of this same "type digits, auto-dash" behavior.
function BassIntervalAddRow({ onAdd }: { onAdd: (sequence: string) => void }) {
  const [draft, setDraft] = useState('')

  function commit() {
    if (!draft) return
    onAdd(draft)
    setDraft('')
  }

  return (
    <div className="bass-interval-add-row">
      <input
        className="tag-edit-input bass-interval-add-input"
        placeholder="Add sequence (e.g. 176)"
        value={draft}
        onChange={(e) => setDraft(formatBassSequence(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <button
        type="button"
        className="modal-btn modal-btn-secondary bass-interval-add-btn"
        disabled={!draft}
        onClick={commit}
      >
        Add
      </button>
    </div>
  )
}

function BassIntervalHeaderCell({
  filter,
  onFilterChange,
}: {
  filter: string | null
  onFilterChange: (sequence: string | null) => void
}) {
  return (
    <th className={`key-th${filter ? ' active' : ''}`}>
      <input
        type="text"
        className="bass-interval-filter-input"
        placeholder="BASS"
        title="Bass Interval — type a progression to filter (e.g. 176)"
        value={filter ?? ''}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onFilterChange(formatBassSequence(e.target.value) || null)}
      />
    </th>
  )
}

type AdvancedSortOption = 'recent' | 'dateAdded' | 'dateModified' | 'title' | 'genre'

const ADVANCED_SORT_LABELS: Record<AdvancedSortOption, string> = {
  recent: 'Recently Played',
  dateAdded: 'Recently Added',
  dateModified: 'Date Modified',
  title: 'Title',
  genre: 'Genre',
}

function sortAdvancedTracks(tracks: Track[], sortBy: AdvancedSortOption): Track[] {
  const sorted = [...tracks]
  if (sortBy === 'title') {
    sorted.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
  } else if (sortBy === 'genre') {
    sorted.sort((a, b) => (a.genre ?? '').localeCompare(b.genre ?? ''))
  } else if (sortBy === 'dateAdded') {
    // dateAdded is when the track was first scanned into Volure, not the
    // file's on-disk creation date.
    sorted.sort((a, b) => b.dateAdded - a.dateAdded)
  } else if (sortBy === 'dateModified') {
    sorted.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
  } else {
    sorted.sort((a, b) => {
      const aPlayed = a.lastPlayedAt ?? null
      const bPlayed = b.lastPlayedAt ?? null
      if (aPlayed !== null && bPlayed !== null) return bPlayed - aPlayed
      if (aPlayed !== null) return -1
      if (bPlayed !== null) return 1
      return (a.title ?? '').localeCompare(b.title ?? '')
    })
  }
  return sorted
}

function AdvancedTrackTable({
  tracks,
  bassIntervalsByTrack,
  currentTrackId,
  selectedIds,
  onToggleSelected,
  onPlay,
  onOpenNowPlaying,
  onSaveTag,
  onAddBassInterval,
  bassIntervalFilter,
  onBassIntervalFilterChange,
  sortBy,
  onSortChange,
  emptyMessage,
  extraColumn,
  onRowContextMenu,
}: {
  tracks: Track[]
  bassIntervalsByTrack: Record<number, BassInterval[]>
  currentTrackId: number | null
  selectedIds: Set<number>
  onToggleSelected: (id: number) => void
  onPlay: (id: number) => void
  onOpenNowPlaying?: (id: number) => void
  onSaveTag: (track: Track, tags: Partial<Pick<Track, 'key' | 'mood'>>) => void
  onAddBassInterval: (track: Track, sequence: string) => void
  bassIntervalFilter: string | null
  onBassIntervalFilterChange: (sequence: string | null) => void
  sortBy: AdvancedSortOption
  onSortChange: (value: AdvancedSortOption) => void
  emptyMessage: string
  extraColumn?: TrackExtraColumn
  onRowContextMenu?: (track: Track, e: React.MouseEvent) => void
}) {
  const sortedTracks = useMemo(() => sortAdvancedTracks(tracks, sortBy), [tracks, sortBy])

  if (tracks.length === 0) {
    return (
      <div className="empty-state">
        <p>{bassIntervalFilter ? `No songs with bass sequence ${bassIntervalFilter}.` : emptyMessage}</p>
      </div>
    )
  }

  return (
    <table className="track-table advanced-track-table">
      <thead>
        <tr>
          <th></th>
          <th></th>
          <th className="sort-th">
            <SortMenu value={sortBy} onChange={onSortChange} labels={ADVANCED_SORT_LABELS} />
            <span
              className={`sortable-th-label${sortBy === 'title' ? ' active' : ''}`}
              onClick={() => onSortChange('title')}
            >
              Title
            </span>
          </th>
          <th>Key</th>
          <th>Energy</th>
          <BassIntervalHeaderCell
            filter={bassIntervalFilter}
            onFilterChange={onBassIntervalFilterChange}
          />
          {extraColumn && <th>{extraColumn.label}</th>}
        </tr>
      </thead>
      <tbody>
        {sortedTracks.map((track) => (
          <tr
            key={track.id}
            className={[
              'track-row',
              track.id === currentTrackId ? 'active' : '',
              selectedIds.has(track.id) ? 'selected' : '',
              extraColumn?.isChecked(track) ? 'row-included' : '',
            ].join(' ')}
            onContextMenu={(e) => {
              if (!onRowContextMenu) return
              e.preventDefault()
              onRowContextMenu(track, e)
            }}
          >
            <td className="row-select-cell">
              <input
                type="checkbox"
                className="row-checkbox"
                checked={selectedIds.has(track.id)}
                onChange={() => onToggleSelected(track.id)}
              />
            </td>
            <td
              className="track-art-cell"
              onClick={() => onPlay(track.id)}
              onDoubleClick={() => onOpenNowPlaying?.(track.id)}
            >
              <TrackArtThumb track={track} size={46} />
            </td>
            <td className="track-title-cell" onClick={() => onPlay(track.id)}>
              {track.title || folderBaseName(track.filePath)}
            </td>
            <KeyCell value={track.key} onSave={(key) => onSaveTag(track, { key })} />
            <EditableCell value={track.mood ?? ''} onSave={(mood) => onSaveTag(track, { mood })} />
            <BassIntervalCell
              entries={bassIntervalsByTrack[track.id] ?? []}
              onAdd={(sequence) => onAddBassInterval(track, sequence)}
            />
            {extraColumn && (
              <td className="extra-column-cell">
                <input
                  type="checkbox"
                  className="extra-checkbox"
                  checked={extraColumn.isChecked(track)}
                  onChange={() => extraColumn.onToggle(track)}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ChevronIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function ScreenshotIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">
      <path d="M0 0h24v24H0z" fill="none" />
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
        <path d="M3 13c3.6-8 14.4-8 18 0" />
        <path d="M12 17a3 3 0 1 1 0-6a3 3 0 0 1 0 6" />
      </g>
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="8" width="12" height="12" rx="1.5" />
      <path d="M16 8V6.5A1.5 1.5 0 0 0 14.5 5h-8A1.5 1.5 0 0 0 5 6.5v8A1.5 1.5 0 0 0 6.5 16H8" />
    </svg>
  )
}

function RemoveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path d="M0 0h24v24H0z" fill="none" />
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M21 18.25c0 .485-.13.945-.35 1.34l1.13 1.13l-1.06 1.06l-18.5-18.5l1.06-1.06l1.13 1.13c.4-.22.856-.35 1.34-.35h12.5A2.755 2.755 0 0 1 21 5.75zm-6.684-4.995l5.17 5.17h.005l.006-.053q.008-.056.009-.117v-3.19l-3.5-3.5zM18.25 4.5H5.75a1 1 0 0 0-.17.015l7.67 7.675l1.865-1.865a1.26 1.26 0 0 1 1.77 0L19.5 12.94V5.75c0-.69-.56-1.25-1.25-1.25M4.535 18.525c.125.56.62.975 1.215.975h10.57l1.5 1.5H5.75A2.755 2.755 0 0 1 3 18.25V6.18l1.5 1.5v8.76l3.365-3.365a1.26 1.26 0 0 1 1.77 0L12.06 15.5L11 16.56l-2.25-2.25z"
        clipRule="evenodd"
      />
    </svg>
  )
}

function MagnetIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 13V9a5 5 0 0 1 10 0v4" />
      <rect x="5" y="13" width="4" height="6" rx="1" />
      <rect x="15" y="13" width="4" height="6" rx="1" />
      <line x1="5" y1="16" x2="9" y2="16" />
      <line x1="15" y1="16" x2="19" y2="16" />
    </svg>
  )
}

function EqualizerIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="5" y1="19" x2="5" y2="10" />
      <line x1="12" y1="19" x2="12" y2="5" />
      <line x1="19" y1="19" x2="19" y2="13" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

// Wraps CheckIcon so it only stays on screen for a few seconds after the
// underlying "done" flag turns true, rather than lingering for as long as
// that flag stays true (some of which — e.g. studioTrimDone — never reset).
// Re-arms on every false->true edge, so a flag that can toggle (like
// studioAudioReversed) shows the check again each time it re-completes.
function TimedCheck({ active, durationMs = 3000 }: { active: boolean; durationMs?: number }) {
  const [visible, setVisible] = useState(active)

  useEffect(() => {
    if (!active) {
      setVisible(false)
      return
    }
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), durationMs)
    return () => clearTimeout(timer)
  }, [active, durationMs])

  return visible ? <CheckIcon /> : null
}

function CloseIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  )
}

function ShuffleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </svg>
  )
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {muted ? (
        <>
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      )}
    </svg>
  )
}

function FullscreenIcon({ active }: { active: boolean }) {
  return active ? (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path d="M0 0h24v24H0z" fill="none" />
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M18 11h-5V6m0 5l7-7M6 13h5v5m0-5l-7 7"
      />
    </svg>
  ) : (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

function VideoVolumeControl({
  volume,
  onChange,
  fullscreen,
  onToggleFullscreen,
  showRemove,
  onRemove,
}: {
  volume: number
  onChange: (v: number) => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  showRemove: boolean
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="video-volume" ref={containerRef}>
      {open && (
        <div className="video-volume-popover">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      )}
      {showRemove && (
        <button type="button" onClick={onRemove} title="Remove video">
          <RemoveIcon />
        </button>
      )}
      <button
        type="button"
        onClick={onToggleFullscreen}
        title={fullscreen ? 'Exit full screen' : 'Full screen'}
      >
        <FullscreenIcon active={fullscreen} />
      </button>
      <button type="button" onClick={() => setOpen((v) => !v)} title="Volume">
        <VolumeIcon muted={volume === 0} />
      </button>
    </div>
  )
}

function PrevIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="19 4 9 12 19 20 19 4" />
      <line x1="5" y1="5" x2="5" y2="19" />
    </svg>
  )
}

function NextIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </svg>
  )
}

function ReverseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="18 3 4 12 18 21 18 3" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  )
}

function RecordIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24">
      <path d="M0 0h24v24H0z" fill="none" />
      <g fill="none">
        <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="5" fill="currentColor" />
      </g>
    </svg>
  )
}

function ScreenRecordIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">
      <path d="M0 0h24v24H0z" fill="none" />
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
        <path d="M3 13c3.6-8 14.4-8 18 0" />
        <path d="M12 17a3 3 0 1 1 0-6a3 3 0 0 1 0 6" />
      </g>
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function RepeatIcon({ single }: { single: boolean }) {
  return (
    <span className="icon-stack">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="17 1 21 5 17 9" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 23 3 19 7 15" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
      {single && <span className="icon-badge">1</span>}
    </span>
  )
}

function QueueIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="6" x2="15" y2="6" />
      <line x1="3" y1="12" x2="15" y2="12" />
      <line x1="3" y1="18" x2="10" y2="18" />
      <polygon points="17 14 17 22 23 18" fill="currentColor" stroke="none" />
    </svg>
  )
}

function SkipBack10Icon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
      <text x="13" y="16.5" fontSize="7" fontFamily="Arial, sans-serif" fontWeight="700" stroke="none" fill="currentColor" textAnchor="middle">10</text>
    </svg>
  )
}

function SkipForward10Icon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      <text x="11" y="16.5" fontSize="7" fontFamily="Arial, sans-serif" fontWeight="700" stroke="none" fill="currentColor" textAnchor="middle">10</text>
    </svg>
  )
}

function MiniViewIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="14" rx="2" />
      <rect x="12" y="9.5" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  )
}

function VideoFileIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="2" y1="7" x2="7" y2="7" />
      <line x1="2" y1="17" x2="7" y2="17" />
      <line x1="17" y1="17" x2="22" y2="17" />
      <line x1="17" y1="7" x2="22" y2="7" />
    </svg>
  )
}

type LoopMode = 'off' | 'playlist' | 'song'
type Section = 'songs' | 'recent' | 'sections' | 'playlists' | 'favorites' | 'advanced'
type AppView = 'media' | 'studio' | 'play'
type StudioSlot = 'track' | 'internal' | 'mic'

const HOME_SECTION_STORAGE_KEY = 'volure:homeSection'
const HOME_SECTIONS: Section[] = ['songs', 'recent', 'sections', 'playlists', 'favorites', 'advanced']

function loadHomeSection(): Section {
  try {
    const saved = localStorage.getItem(HOME_SECTION_STORAGE_KEY)
    return saved && HOME_SECTIONS.includes(saved as Section) ? (saved as Section) : 'songs'
  } catch {
    return 'songs'
  }
}

// The last trim range/fades a slot was left at — restored by beginTrimSlot
// when Trim Audio reopens on that slot, so the handles pick up where the
// user left them instead of snapping back to "whole clip, no fade" every
// time. start/end are ratios (0..1) into the slot's own untouched original,
// same convention TrimOverlay/sliceAndFadeBuffer already use.
interface TrimSelection {
  start: number
  end: number
  fadeInOn: boolean
  fadeInRatio: number
  fadeOutOn: boolean
  fadeOutRatio: number
}
const DEFAULT_TRIM_SELECTION: TrimSelection = {
  start: 0,
  end: 1,
  fadeInOn: false,
  fadeInRatio: 0.2,
  fadeOutOn: false,
  fadeOutRatio: 0.2,
}
type SortOption = 'title' | 'artist' | 'album' | 'key' | 'duration' | 'dateAdded' | 'dateModified' | 'recent' | 'favorite' | 'extra' | 'custom'
type SortDir = 'asc' | 'desc'
type GridSortOption = 'default' | 'name' | 'custom'

const IMAGE_VIEWER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const VIDEO_VIEWER_EXTENSIONS = new Set(['.mp4', '.mov'])

type CustomizePreset = {
  name: string
  eqGains: number[]
  playbackSpeed: number
  pitchSemitones: number
  reverseAudioEnabled: boolean
}

const DEFAULT_CUSTOMIZE_PRESET: CustomizePreset = {
  name: 'Default',
  eqGains: EQ_BANDS.map(() => 0),
  playbackSpeed: 1,
  pitchSemitones: 0,
  reverseAudioEnabled: false,
}

type CustomizeSettings = Omit<CustomizePreset, 'name'> & {
  speedSnapEnabled: boolean
  eqLocked: boolean
  boostVolume: number
}

const CUSTOMIZE_SETTINGS_STORAGE_KEY = 'volure:customizeSettings'
const DEFAULT_CUSTOMIZE_SETTINGS: CustomizeSettings = {
  eqGains: EQ_BANDS.map(() => 0),
  playbackSpeed: 1,
  pitchSemitones: 0,
  reverseAudioEnabled: false,
  speedSnapEnabled: true,
  eqLocked: false,
  boostVolume: 1,
}

function loadCustomizeSettings(): CustomizeSettings {
  try {
    const raw = localStorage.getItem(CUSTOMIZE_SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_CUSTOMIZE_SETTINGS
    const parsed = JSON.parse(raw)
    return {
      eqGains: EQ_BANDS.map((_, index) => {
        const value = Number(parsed.eqGains?.[index])
        return Number.isFinite(value) ? Math.max(-30, Math.min(12, value)) : 0
      }),
      playbackSpeed: Number.isFinite(Number(parsed.playbackSpeed))
        ? Math.max(0.5, Math.min(1.5, Number(parsed.playbackSpeed)))
        : 1,
      pitchSemitones: Number.isFinite(Number(parsed.pitchSemitones))
        ? Math.max(PITCH_SEMITONES_MIN, Math.min(PITCH_SEMITONES_MAX, Number(parsed.pitchSemitones)))
        : 0,
      reverseAudioEnabled: parsed.reverseAudioEnabled === true,
      speedSnapEnabled: parsed.speedSnapEnabled !== false,
      eqLocked: parsed.eqLocked === true,
      boostVolume: Number.isFinite(Number(parsed.boostVolume))
        ? Math.max(0, Math.min(2, Number(parsed.boostVolume)))
        : 1,
    }
  } catch {
    return DEFAULT_CUSTOMIZE_SETTINGS
  }
}

const CUSTOMIZE_PRESETS_STORAGE_KEY = 'volure:customizePresets'

function loadCustomizePresets(): CustomizePreset[] {
  try {
    const raw = localStorage.getItem(CUSTOMIZE_PRESETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// EQ-only presets, saved separately from CustomizePreset so applying one
// only touches eqGains — playback speed, pitch, and reverse audio are untouched.
type EqPreset = {
  name: string
  eqGains: number[]
}

// Change EQ presets. Change eq presets. Change Equalizer presets.
const STOCK_EQ_PRESETS: EqPreset[] = [
  { name: 'Default', eqGains: [0, 0, 0, 0, 0, 0, 0] },
  { name: 'Clarity', eqGains: [-2, -1, -3, 0, 4, 6, 5] },
  { name: 'Subdued', eqGains: [0, -1, -3, -6, -12, -20, -30] },
  { name: 'Bass Reduction', eqGains: [-8, -5, -2, 0, 0, 0, 0] },
  { name: 'Bass Boost', eqGains: [8, 5, 2, 0, 0, 0, 0] },
  
]
function isStockEqPresetName(name: string): boolean {
  const lower = name.toLowerCase()
  return STOCK_EQ_PRESETS.some((p) => p.name.toLowerCase() === lower)
}

const EQ_PRESETS_STORAGE_KEY = 'volure:eqPresets'

function loadEqPresets(): EqPreset[] {
  try {
    const raw = localStorage.getItem(EQ_PRESETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const FAVORITE_PRESETS_STORAGE_KEY = 'volure:favoritePresetNames'
const MAX_FAVORITE_PRESETS = 6

function loadFavoritePresetNames(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITE_PRESETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, MAX_FAVORITE_PRESETS) : []
  } catch {
    return []
  }
}

const VOLUME_STORAGE_KEY = 'volure:volume'
const DEFAULT_VOLUME = 0.2

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY)
    if (raw === null) return DEFAULT_VOLUME
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_VOLUME
  } catch {
    return DEFAULT_VOLUME
  }
}

// Mobile keeps its own sort preference so its "newest modified first" default
// isn't pre-empted by a 'recent' value an earlier desktop-style build stored.
const SORT_STORAGE_KEY = import.meta.env.VOLURE_MOBILE ? 'volure:sort:mobile' : 'volure:sort'
const SORT_OPTIONS: SortOption[] = ['title', 'artist', 'album', 'key', 'duration', 'dateAdded', 'dateModified', 'recent', 'favorite', 'custom']

function loadSort(): { sortBy: SortOption; sortDir: SortDir } {
  // Mobile defaults to newest-modified first (matches a phone music player);
  // desktop keeps its "Most Recent" default.
  const fallback: { sortBy: SortOption; sortDir: SortDir } = import.meta.env.VOLURE_MOBILE
    ? { sortBy: 'dateModified', sortDir: 'desc' }
    : { sortBy: 'recent', sortDir: 'asc' }
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return {
      sortBy: SORT_OPTIONS.includes(parsed.sortBy) ? parsed.sortBy : fallback.sortBy,
      sortDir: parsed.sortDir === 'desc' ? 'desc' : 'asc',
    }
  } catch {
    return fallback
  }
}

const SORT_LABELS: Partial<Record<SortOption, string>> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  key: 'Key',
  duration: 'Duration',
  dateAdded: 'Date Added',
  dateModified: 'Date Modified',
  recent: 'Most Recent',
  favorite: 'Recently Favorited',
  custom: 'Custom',
}

const GRID_SORT_LABELS_FOLDERS: Record<GridSortOption, string> = {
  default: 'Date Added',
  name: 'Name',
  custom: 'Custom',
}

const GRID_SORT_LABELS_PLAYLISTS: Record<GridSortOption, string> = {
  default: 'Date Created',
  name: 'Name',
  custom: 'Custom',
}

const SECTIONS_SORT_STORAGE_KEY = 'volure:sectionsSort'
const PLAYLISTS_SORT_STORAGE_KEY = 'volure:playlistsSort'
const GRID_SORT_OPTIONS: GridSortOption[] = ['default', 'name', 'custom']

function loadGridSort(key: string): { sortBy: GridSortOption; sortDir: SortDir } {
  const fallback: { sortBy: GridSortOption; sortDir: SortDir } = { sortBy: 'default', sortDir: 'asc' }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return {
      sortBy: GRID_SORT_OPTIONS.includes(parsed.sortBy) ? parsed.sortBy : fallback.sortBy,
      sortDir: parsed.sortDir === 'desc' ? 'desc' : 'asc',
    }
  } catch {
    return fallback
  }
}

function sortGridItems<T>(
  items: T[],
  sortBy: GridSortOption,
  sortDir: SortDir,
  getName: (item: T) => string,
  getSortOrder: (item: T) => number | null
): T[] {
  if (sortBy === 'default') return items
  const dir = sortDir === 'desc' ? -1 : 1
  const sorted = [...items]
  if (sortBy === 'name') {
    sorted.sort((a, b) => dir * getName(a).localeCompare(getName(b)))
  } else {
    sorted.sort((a, b) => {
      const aOrder = getSortOrder(a)
      const bOrder = getSortOrder(b)
      if (aOrder !== null && bOrder !== null) return dir * (aOrder - bOrder)
      if (aOrder !== null) return -1
      if (bOrder !== null) return 1
      return 0
    })
  }
  return sorted
}


type PlayKeyboardNote = {
  id: string
  isSharp: boolean
  leftPercent: number
  widthPercent: number
}

// C2 through C7 — the standard 88-key range (A0-C8) trimmed down so the
// full-width keyboard has fewer, wider keys. The would-be A1-B1 span at the
// low end is dropped entirely (rather than built and filtered out) so the
// remaining keys' leftPercent/widthPercent land on a clean 0-100% grid that
// lines up with the flex-laid-out white keys and the transpose panel below.
const PLAY_KEYBOARD_LOW_MIDI = 36
const PLAY_KEYBOARD_HIGH_MIDI = 96
const PLAY_KEYBOARD_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteIdToMidi(id: string): number | null {
  const match = id.match(/^([A-G]#?)(-?\d+)$/)
  if (!match) return null
  const nameIndex = PLAY_KEYBOARD_NOTE_NAMES.indexOf(match[1])
  const octave = Number(match[2])
  return (octave + 1) * 12 + nameIndex
}

function midiToNoteId(midi: number): string {
  const name = PLAY_KEYBOARD_NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}`
}

function shiftNoteId(id: string, semitones: number): string {
  const midi = noteIdToMidi(id)
  if (midi === null) return id
  return midiToNoteId(midi + semitones)
}

// Scale lock always filters against natural minor built on C (the un-transposed
// key on the keyboard). Whatever the transpose control maps C to becomes the
// audible root, but the allowed shape stays fixed relative to C.
const NATURAL_MINOR_PITCH_CLASSES = new Set([0, 2, 3, 5, 7, 8, 10])

function isNoteInLockedScale(noteId: string): boolean {
  const midi = noteIdToMidi(noteId)
  if (midi === null) return true
  return NATURAL_MINOR_PITCH_CLASSES.has(((midi % 12) + 12) % 12)
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      {locked ? (
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      ) : (
        <path d="M8 11V7a4 4 0 0 1 7.75-1.5" />
      )}
    </svg>
  )
}

// FL Studio-style "typing keyboard" mapping: two overlapping rows, each
// spanning an octave plus a third, keyed by physical position (KeyboardEvent
// .code) rather than the character produced, so the layout stays put
// regardless of Shift state or OS keyboard layout. Q lines up with the ','
// row an octave below it, matching the standard convention.
const TYPING_KEYBOARD_BASE_MIDI = 60 // Z = C4
const TYPING_KEYBOARD_SEMITONE_OFFSETS: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
  KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
  Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
  KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25,
  KeyO: 26, Digit0: 27, KeyP: 28,
}

// The Play tab uses four one-shot samples: an upper-register sample tuned to
// C6 (MIDI 84), a mid-register sample tuned to C4 (MIDI 60), a G4 sample tuned
// to G4 (MIDI 67), and a lower-register sample tuned to C3 (MIDI 48). Notes
// from C#3 through D#4 use the C4 sample, notes from E4 through G#4 use the G4
// sample, and notes above that use the C6 sample.
const PLAY_SAMPLE_ROOT_MIDI = 84
const PLAY_SAMPLE2_ROOT_MIDI = 48
const PLAY_SAMPLE3_ROOT_MIDI = 60
const PLAY_SAMPLE3_MIN_MIDI = 49
const PLAY_SAMPLE3_MAX_MIDI = 63
const PLAY_SAMPLE4_ROOT_MIDI = 67
const PLAY_SAMPLE4_MIN_MIDI = 64
const PLAY_SAMPLE4_MAX_MIDI = 68
const PLAY_SAMPLE_RELEASE_SECONDS = 2.5

function buildPlayKeyboardNotes(): PlayKeyboardNote[] {
  const NOTE_NAMES = PLAY_KEYBOARD_NOTE_NAMES
  const raw: { id: string; isSharp: boolean }[] = []
  for (let midi = PLAY_KEYBOARD_LOW_MIDI; midi <= PLAY_KEYBOARD_HIGH_MIDI; midi++) {
    const name = NOTE_NAMES[midi % 12]
    const octave = Math.floor(midi / 12) - 1
    raw.push({ id: `${name}${octave}`, isSharp: name.includes('#') })
  }
  const whiteCount = raw.filter((n) => !n.isSharp).length
  const whiteWidth = 100 / whiteCount
  const blackWidth = whiteWidth * 0.62
  let whiteIndex = 0
  const notes: PlayKeyboardNote[] = []
  for (const { id, isSharp } of raw) {
    if (isSharp) {
      notes.push({
        id,
        isSharp: true,
        leftPercent: whiteIndex * whiteWidth - blackWidth / 2,
        widthPercent: blackWidth,
      })
    } else {
      notes.push({
        id,
        isSharp: false,
        leftPercent: whiteIndex * whiteWidth,
        widthPercent: whiteWidth,
      })
      whiteIndex += 1
    }
  }
  return notes
}

const PLAY_KEYBOARD_NOTES = buildPlayKeyboardNotes()
const PLAY_KEYBOARD_WHITE_NOTES = PLAY_KEYBOARD_NOTES.filter((n) => !n.isSharp)
const PLAY_KEYBOARD_BLACK_NOTES = PLAY_KEYBOARD_NOTES.filter((n) => n.isSharp)
const PLAY_KEYBOARD_NOTES_BY_ID = new Map(PLAY_KEYBOARD_NOTES.map((n) => [n.id, n]))
// The dropped A1-B1 span would have been 2 of the original 37 white-key
// slots; the transpose panel reuses that same proportion of the row, with
// the keys area (trails/whites/blacks) offset to fill the remaining width.
const PLAY_KEYBOARD_PANEL_WIDTH_PERCENT = (2 / 37) * 100
const PLAY_KEYBOARD_KEYS_AREA_WIDTH_PERCENT = 100 - PLAY_KEYBOARD_PANEL_WIDTH_PERCENT
const PLAY_KEYBOARD_TRANSPOSE_MIN = -6
const PLAY_KEYBOARD_TRANSPOSE_MAX = 6
const PLAY_KEYBOARD_OCTAVE_MIN = -2
const PLAY_KEYBOARD_OCTAVE_MAX = 2

type PlayKeyboardTrail = {
  id: string
  noteId: string
  leftPercent: number
  widthPercent: number
  releasing: boolean
  frozenHeight?: number
}

type PlayVoice = { parts: { source: AudioBufferSourceNode; gain: GainNode }[] }

type PlayPerformanceEvent = {
  type: 'on' | 'off'
  noteId: string
  midi?: number
  time: number
}

type PlayPerformanceInput = {
  type: 'on' | 'off'
  noteId: string
  midi: number
}

type BackupPerformanceEvent = PlayPerformanceInput & { at: number }

type PlayKeyboardHandle = {
  transposeToKeyRoot: (key: string) => void
  playPerformance: (events: PlayPerformanceEvent[]) => void
  stopPerformance: () => void
}

const PLAY_PERFORMANCE_STORAGE_KEY = 'volure-play-performances'
const LEGACY_PLAY_PERFORMANCE_STORAGE_PREFIX = 'volure-play-performance:'

type SavedPerformance = {
  id: string
  name: string
  createdAt: number
  events: PlayPerformanceEvent[]
}

function normalizePerformanceEvents(value: unknown): PlayPerformanceEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((event) => {
    if (!event || typeof event !== 'object') return []
    const candidate = event as Partial<PlayPerformanceEvent>
    const midi = typeof candidate.midi === 'number' ? candidate.midi : noteIdToMidi(candidate.noteId ?? '')
    if (
      (candidate.type !== 'on' && candidate.type !== 'off') ||
      typeof candidate.noteId !== 'string' ||
      typeof candidate.time !== 'number' ||
      midi === null
    ) {
      return []
    }
    return [{ type: candidate.type, noteId: candidate.noteId, midi, time: candidate.time }]
  })
}

function parseSavedPerformances(stored: string | null): SavedPerformance[] {
  if (!stored) return []
  try {
    const parsed = JSON.parse(stored)
    const rawRecords: SavedPerformance[] = Array.isArray(parsed)
      ? parsed.length > 0 && parsed[0]?.events
        ? parsed
        : parsed.length > 0
          ? [{ id: 'legacy', name: 'Performance', createdAt: Date.now(), events: parsed }]
          : []
      : []
    return rawRecords.map((record) => ({
      ...record,
      events: normalizePerformanceEvents(record.events),
    }))
  } catch {
    return []
  }
}

const PlayKeyboard = forwardRef<
  PlayKeyboardHandle,
  {
    active: boolean
    currentTrackId: number | null
    currentTrackKey?: string | null
    onPerformanceNote?: (event: PlayPerformanceInput) => void
  }
>(function PlayKeyboard({ active, currentTrackId, currentTrackKey, onPerformanceNote }, ref) {
  const [pressed, setPressed] = useState<Record<string, boolean>>({})
  const [trails, setTrails] = useState<PlayKeyboardTrail[]>([])
  const trailElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const [transpose, setTranspose] = useState(0)
  const [octaveShift, setOctaveShift] = useState(0)
  const [scaleLock, setScaleLock] = useState(false)
  const scaleLockRef = useRef(false)
  const [lastPressedDisplayNote, setLastPressedDisplayNote] = useState<string | null>(null)
  const [playVolume, setPlayVolume] = useState(0.3)
  const [previousPlayVolume, setPreviousPlayVolume] = useState(0.3)
  const [midiStatus, setMidiStatus] = useState<'idle' | 'unsupported' | 'connected' | 'no-access'>('idle')
  const [midiDeviceNames, setMidiDeviceNames] = useState<string[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sampleBufferRef = useRef<AudioBuffer | null>(null)
  const sample2BufferRef = useRef<AudioBuffer | null>(null)
  const sample3BufferRef = useRef<AudioBuffer | null>(null)
  const sample4BufferRef = useRef<AudioBuffer | null>(null)
  const voicesRef = useRef<Map<string, PlayVoice>>(new Map())
  const masterGainRef = useRef<GainNode | null>(null)
  const typingKeysHeldRef = useRef<Set<string>>(new Set())
  const dragPressedNoteIdsRef = useRef<Set<string>>(new Set())
  const pointerDragActiveRef = useRef(false)
  const pointerDragPointerIdRef = useRef<number | null>(null)
  const pointerDragCurrentNoteIdRef = useRef<string | null>(null)
  const transposeRef = useRef(0)
  const octaveShiftRef = useRef(0)
  const totalTransposeRef = useRef(0)
  const performanceNoteHandlerRef = useRef(onPerformanceNote)
  const performancePlaybackTimersRef = useRef<number[]>([])
  const performancePlayingRef = useRef(false)
  const totalTranspose = transpose + octaveShift * 12

  useEffect(() => {
    performanceNoteHandlerRef.current = onPerformanceNote
  }, [onPerformanceNote])

  useEffect(() => {
    transposeRef.current = transpose
    totalTransposeRef.current = transpose + octaveShiftRef.current * 12
  }, [transpose])

  useEffect(() => {
    octaveShiftRef.current = octaveShift
    totalTransposeRef.current = transposeRef.current + octaveShift * 12
  }, [octaveShift])

  useEffect(() => {
    scaleLockRef.current = scaleLock
  }, [scaleLock])

  function setTransposeAndRef(v: number) {
    setTranspose(v)
    transposeRef.current = v
    totalTransposeRef.current = v + octaveShiftRef.current * 12
  }

  function setOctaveShiftAndRef(v: number) {
    setOctaveShift(v)
    octaveShiftRef.current = v
    totalTransposeRef.current = transposeRef.current + v * 12
  }

  function ensurePlayAudioContext(): AudioContext {
    if (!audioCtxRef.current) {
      const ctx = new AudioContext()
      const masterGain = ctx.createGain()
      masterGain.gain.value = playVolume
      masterGain.connect(ctx.destination)
      masterGainRef.current = masterGain
      audioCtxRef.current = ctx
    }
    return audioCtxRef.current
  }

  useEffect(() => {
    if (masterGainRef.current) masterGainRef.current.gain.value = playVolume
  }, [playVolume])

  useEffect(() => {
    let cancelled = false
    window.api.getPlaySamplePath().then(async (filePath) => {
      if (!filePath || cancelled) return
      const ctx = ensurePlayAudioContext()
      const res = await fetch(platform.getMediaUrl(filePath))
      const arrayBuffer = await res.arrayBuffer()
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      if (!cancelled) sampleBufferRef.current = buffer
    })
    // Load the lower C3 sample if available
    window.api.getPlaySample2Path?.().then(async (filePath) => {
      if (!filePath || cancelled) return
      const ctx = ensurePlayAudioContext()
      const res = await fetch(platform.getMediaUrl(filePath))
      const arrayBuffer = await res.arrayBuffer()
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      if (!cancelled) sample2BufferRef.current = buffer
    })

    window.api.getPlaySample3Path?.().then(async (filePath) => {
      if (!filePath || cancelled) return
      const ctx = ensurePlayAudioContext()
      const res = await fetch(platform.getMediaUrl(filePath))
      const arrayBuffer = await res.arrayBuffer()
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      if (!cancelled) sample3BufferRef.current = buffer
    })

    window.api.getPlaySample4Path?.().then(async (filePath) => {
      if (!filePath || cancelled) return
      const ctx = ensurePlayAudioContext()
      const res = await fetch(platform.getMediaUrl(filePath))
      const arrayBuffer = await res.arrayBuffer()
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      if (!cancelled) sample4BufferRef.current = buffer
    })

    return () => {
      cancelled = true
    }
  }, [])

  function transposeToKeyRootInternal(key: string) {
    const rootIndex = PLAY_KEYBOARD_NOTE_NAMES.indexOf(key)
    if (rootIndex === -1) return
    // Only the note letter matters here (C -> root), so wrap into the
    // fine-transpose control's -6..+6 range rather than touching octave.
    const wrapped = rootIndex > 6 ? rootIndex - 12 : rootIndex
    setTransposeAndRef(wrapped)
  }

  useImperativeHandle(ref, () => ({
    transposeToKeyRoot: transposeToKeyRootInternal,
    playPerformance,
    stopPerformance,
  }))

  // Keyed on currentTrackId (not scaleLock) so this only fires once per song
  // change, matching scaleLockRef's latest value rather than re-firing when
  // the lock is toggled mid-song.
  useEffect(() => {
    if (scaleLockRef.current && currentTrackKey) {
      transposeToKeyRootInternal(currentTrackKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackId])

  function adjustTranspose(delta: number) {
    setTranspose((prev) => {
      const next = Math.max(
        PLAY_KEYBOARD_TRANSPOSE_MIN,
        Math.min(PLAY_KEYBOARD_TRANSPOSE_MAX, prev + delta),
      )
      transposeRef.current = next
      totalTransposeRef.current = next + octaveShiftRef.current * 12
      return next
    })
  }

  function adjustOctave(delta: number) {
    setOctaveShift((prev) => {
      const next = Math.max(PLAY_KEYBOARD_OCTAVE_MIN, Math.min(PLAY_KEYBOARD_OCTAVE_MAX, prev + delta))
      octaveShiftRef.current = next
      totalTransposeRef.current = transposeRef.current + next * 12
      return next
    })
  }

  function triggerSample(note: PlayKeyboardNote, fixedMidi?: number, voiceId = note.id) {
    const midi = noteIdToMidi(note.id)
    if (midi === null) return
    const effectiveMidi = fixedMidi ?? midi + totalTransposeRef.current
    const ctx = ensurePlayAudioContext()
    if (ctx.state === 'suspended') ctx.resume()

    // Crossfade window in semitones around the boundary (centered on the
    // PLAY_SAMPLE2_ROOT_MIDI). When inside the window both samples are mixed.
    const fadeHalf = 2
    const fadeMin = PLAY_SAMPLE2_ROOT_MIDI - fadeHalf
    const fadeMax = PLAY_SAMPLE2_ROOT_MIDI + fadeHalf
    const inFade = effectiveMidi >= fadeMin && effectiveMidi <= fadeMax

    const parts: { source: AudioBufferSourceNode; gain: GainNode }[] = []

    if (inFade) {
      const t = (effectiveMidi - fadeMin) / (fadeMax - fadeMin)
      let weightUpper = t
      let weightLower = 1 - t
      // Prefer the lower sample at the exact root MIDI to avoid ambiguous
      // mixing when hitting the boundary via octave shifts.
      if (effectiveMidi === PLAY_SAMPLE2_ROOT_MIDI) {
        weightUpper = 0
        weightLower = 1
      }
      const bufUpper = sampleBufferRef.current
      const bufLower = sample2BufferRef.current ?? sampleBufferRef.current
      if (bufUpper) {
        const s = ctx.createBufferSource()
        s.buffer = bufUpper
        s.playbackRate.value = Math.pow(2, (effectiveMidi - PLAY_SAMPLE_ROOT_MIDI) / 12)
        const g = ctx.createGain()
        g.gain.setValueAtTime(weightUpper, ctx.currentTime)
        s.connect(g)
        g.connect(masterGainRef.current ?? ctx.destination)
        s.start()
        parts.push({ source: s, gain: g })
      }
      if (bufLower) {
        const s = ctx.createBufferSource()
        s.buffer = bufLower
        s.playbackRate.value = Math.pow(2, (effectiveMidi - PLAY_SAMPLE2_ROOT_MIDI) / 12)
        const g = ctx.createGain()
        g.gain.setValueAtTime(weightLower, ctx.currentTime)
        s.connect(g)
        g.connect(masterGainRef.current ?? ctx.destination)
        s.start()
        parts.push({ source: s, gain: g })
      }
    } else {
      let buffer: AudioBuffer | null | undefined
      let rootMidi: number

      if (effectiveMidi >= PLAY_SAMPLE3_MIN_MIDI && effectiveMidi <= PLAY_SAMPLE3_MAX_MIDI) {
        buffer = sample3BufferRef.current ?? sampleBufferRef.current
        rootMidi = PLAY_SAMPLE3_ROOT_MIDI
      } else if (effectiveMidi >= PLAY_SAMPLE4_MIN_MIDI && effectiveMidi <= PLAY_SAMPLE4_MAX_MIDI) {
        buffer = sample4BufferRef.current ?? sampleBufferRef.current
        rootMidi = PLAY_SAMPLE4_ROOT_MIDI
      } else {
        const useLower = effectiveMidi <= PLAY_SAMPLE2_ROOT_MIDI
        buffer = useLower ? sample2BufferRef.current ?? sampleBufferRef.current : sampleBufferRef.current
        rootMidi = useLower ? PLAY_SAMPLE2_ROOT_MIDI : PLAY_SAMPLE_ROOT_MIDI
      }

      if (!buffer) return
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = Math.pow(2, (effectiveMidi - rootMidi) / 12)
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(1, ctx.currentTime)
      source.connect(gain)
      gain.connect(masterGainRef.current ?? ctx.destination)
      source.start()
      parts.push({ source, gain })
    }

    const voiceObj: PlayVoice = { parts }
    for (const p of parts) {
      p.source.addEventListener('ended', () => {
        if (voicesRef.current.get(voiceId) === voiceObj) voicesRef.current.delete(voiceId)
      })
    }
    voicesRef.current.set(voiceId, voiceObj)
  }

  function releaseVoice(noteId: string) {
    const ctx = audioCtxRef.current
    const voice = voicesRef.current.get(noteId)
    if (!ctx || !voice) return
    const now = ctx.currentTime
    for (const part of voice.parts) {
      const { gain, source } = part
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(0, now + PLAY_SAMPLE_RELEASE_SECONDS)
      try {
        source.stop(now + PLAY_SAMPLE_RELEASE_SECONDS)
      } catch {}
    }
    voicesRef.current.delete(noteId)
  }

  function addNoteTrail(note: PlayKeyboardNote) {
    const trailId = `${note.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setTrails((prev) => [
      ...prev,
      {
        id: trailId,
        noteId: note.id,
        leftPercent: note.leftPercent,
        widthPercent: note.widthPercent,
        releasing: false,
      },
    ])
  }

  function releaseNoteTrail(noteId: string) {
    setTrails((prev) => {
      let targetId: string | null = null
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].noteId === noteId && !prev[i].releasing) {
          targetId = prev[i].id
          break
        }
      }
      if (!targetId) return prev
      const el = trailElsRef.current.get(targetId)
      const frozenHeight = el ? el.getBoundingClientRect().height : 0
      window.setTimeout(() => {
        setTrails((p) => p.filter((t) => t.id !== targetId))
        trailElsRef.current.delete(targetId!)
      }, 450)
      return prev.map((t) => (t.id === targetId ? { ...t, releasing: true, frozenHeight } : t))
    })
  }

  function pressNote(note: PlayKeyboardNote) {
    const effectiveMidi = (noteIdToMidi(note.id) ?? 60) + totalTransposeRef.current
    setPressed((prev) => (prev[note.id] ? prev : { ...prev, [note.id]: true }))
    if (scaleLockRef.current && !isNoteInLockedScale(note.id)) return
    // Always forward to the handler (even during playback) so overdub recording can capture it.
    const midi = noteIdToMidi(note.id)
    if (midi !== null) {
      performanceNoteHandlerRef.current?.({
        type: 'on',
        noteId: note.id,
        midi: midi + totalTransposeRef.current,
      })
    }
    setLastPressedDisplayNote(midiToNoteId(effectiveMidi))
    triggerSample(note)
    addNoteTrail(note)
  }

  function releaseNote(note: PlayKeyboardNote) {
    setPressed((prev) => {
      if (!prev[note.id]) return prev
      const next = { ...prev }
      delete next[note.id]
      return next
    })
    const midi = noteIdToMidi(note.id)
    if (midi !== null) {
      performanceNoteHandlerRef.current?.({
        type: 'off',
        noteId: note.id,
        midi: midi + totalTransposeRef.current,
      })
    }
    releaseVoice(note.id)
    releaseNoteTrail(note.id)
  }

  function releaseAll() {
    setPressed({})
    setTrails([])
    trailElsRef.current.clear()
    Array.from(voicesRef.current.keys()).forEach(releaseVoice)
    typingKeysHeldRef.current.clear()
    dragPressedNoteIdsRef.current.clear()
    pointerDragActiveRef.current = false
    pointerDragPointerIdRef.current = null
    pointerDragCurrentNoteIdRef.current = null
  }

  function stopPerformance() {
    performancePlayingRef.current = false
    performancePlaybackTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    performancePlaybackTimersRef.current = []
    releaseAll()
  }

  function playPerformance(events: PlayPerformanceEvent[]) {
    if (events.length === 0) return
    stopPerformance()
    performancePlayingRef.current = true
    const duration = Math.max(...events.map((event) => event.time), 0)

    function scheduleLoop() {
      if (!performancePlayingRef.current) return
      const timers = events.map((event) =>
        window.setTimeout(() => {
          if (!performancePlayingRef.current) return
          const note = PLAY_KEYBOARD_NOTES_BY_ID.get(event.noteId)
          if (!note) return
          if (event.type === 'on') {
            const performanceMidi = event.midi ?? noteIdToMidi(event.noteId)
            if (performanceMidi === null) return
            setPressed((prev) => ({ ...prev, [note.id]: true }))
            setLastPressedDisplayNote(midiToNoteId(performanceMidi))
            triggerSample(note, performanceMidi, `performance:${event.noteId}`)
            addNoteTrail(note)
          } else {
            releaseVoice(`performance:${event.noteId}`)
            setPressed((prev) => {
              const next = { ...prev }
              delete next[note.id]
              return next
            })
            releaseNoteTrail(note.id)
          }
        }, event.time),
      )
      performancePlaybackTimersRef.current = timers
      performancePlaybackTimersRef.current.push(window.setTimeout(scheduleLoop, Math.max(duration + 40, 80)))
    }

    scheduleLoop()
  }

  function endPointerDrag() {
    if (!pointerDragActiveRef.current) return
    pointerDragActiveRef.current = false
    const noteIds = Array.from(dragPressedNoteIdsRef.current)
    dragPressedNoteIdsRef.current.clear()
    pointerDragPointerIdRef.current = null
    pointerDragCurrentNoteIdRef.current = null
    for (const id of noteIds) {
      const note = PLAY_KEYBOARD_NOTES_BY_ID.get(id)
      if (note) releaseNote(note)
    }
  }

  function updatePointerDragTarget(noteId: string | null) {
    if (!pointerDragActiveRef.current || !noteId) return
    const previousNoteId = pointerDragCurrentNoteIdRef.current
    if (previousNoteId === noteId) return

    if (previousNoteId) {
      const previousNote = PLAY_KEYBOARD_NOTES_BY_ID.get(previousNoteId)
      if (previousNote) {
        dragPressedNoteIdsRef.current.delete(previousNoteId)
        releaseNote(previousNote)
      }
    }

    const nextNote = PLAY_KEYBOARD_NOTES_BY_ID.get(noteId)
    if (!nextNote) return
    dragPressedNoteIdsRef.current.add(nextNote.id)
    pressNote(nextNote)
    pointerDragCurrentNoteIdRef.current = nextNote.id
  }

  const playVolumeBackground = `linear-gradient(to right, rgba(255, 255, 255, 0.52) ${Math.round(
    playVolume * 100,
  )}%, rgba(255, 255, 255, 0.14) ${Math.round(playVolume * 100)}%)`

  function togglePlayMute() {
    if (playVolume > 0) {
      setPreviousPlayVolume(playVolume)
      setPlayVolume(0)
    } else {
      setPlayVolume(previousPlayVolume > 0 ? previousPlayVolume : 0.3)
    }
  }

  useEffect(() => {
    function handleGlobalPointerMove(event: PointerEvent) {
      if (!pointerDragActiveRef.current || event.pointerId !== pointerDragPointerIdRef.current) return
      const hovered = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      const noteId = hovered?.closest('[data-note-id]')?.getAttribute('data-note-id') ?? null
      updatePointerDragTarget(noteId)
    }

    function handleGlobalPointerUp() {
      endPointerDrag()
    }

    window.addEventListener('pointermove', handleGlobalPointerMove)
    window.addEventListener('pointerup', handleGlobalPointerUp)
    window.addEventListener('pointercancel', handleGlobalPointerUp)
    window.addEventListener('blur', releaseAll)
    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove)
      window.removeEventListener('pointerup', handleGlobalPointerUp)
      window.removeEventListener('pointercancel', handleGlobalPointerUp)
      window.removeEventListener('blur', releaseAll)
    }
  }, [])

  useEffect(() => {
    if (!active) {
      // Leave the performance's notes/trails/audio alone while switching tabs so it
      // still looks (and sounds) like it's playing when the user comes back to Play.
      if (!performancePlayingRef.current) releaseAll()
      return
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (e.code === 'ArrowUp') {
        e.preventDefault()
        adjustOctave(1)
        return
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault()
        adjustOctave(-1)
        return
      }
      const offset = TYPING_KEYBOARD_SEMITONE_OFFSETS[e.code]
      if (offset === undefined) return
      const note = PLAY_KEYBOARD_NOTES_BY_ID.get(midiToNoteId(TYPING_KEYBOARD_BASE_MIDI + offset))
      if (!note) return
      e.preventDefault()
      typingKeysHeldRef.current.add(e.code)
      pressNote(note)
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (!typingKeysHeldRef.current.has(e.code)) return
      typingKeysHeldRef.current.delete(e.code)
      const offset = TYPING_KEYBOARD_SEMITONE_OFFSETS[e.code]
      if (offset === undefined) return
      const note = PLAY_KEYBOARD_NOTES_BY_ID.get(midiToNoteId(TYPING_KEYBOARD_BASE_MIDI + offset))
      if (note) releaseNote(note)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      releaseAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Physical MIDI keyboard input. Note-on/off events are resolved to the same
  // PlayKeyboardNote objects the on-screen keys use and routed through
  // pressNote/releaseNote, so transpose and octave shift apply automatically
  // (both are read fresh off totalTransposeRef inside triggerSample) without
  // any MIDI-specific pitch math here.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      setMidiStatus('unsupported')
      return
    }

    let cancelled = false
    let midiAccess: MIDIAccess | null = null

    function handleMidiMessage(e: MIDIMessageEvent) {
      const data = e.data
      if (!data || data.length < 2) return
      const command = data[0] & 0xf0
      const noteNumber = data[1]
      const velocity = data.length > 2 ? data[2] : 0
      const note = PLAY_KEYBOARD_NOTES_BY_ID.get(midiToNoteId(noteNumber))
      if (!note) return
      if (command === 0x90 && velocity > 0) {
        pressNote(note)
      } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
        releaseNote(note)
      }
    }

    function attachInputs(access: MIDIAccess) {
      setMidiDeviceNames(Array.from(access.inputs.values()).map((input) => input.name || 'MIDI device'))
      access.inputs.forEach((input) => {
        input.onmidimessage = handleMidiMessage
      })
    }

    navigator
      .requestMIDIAccess()
      .then((access) => {
        if (cancelled) return
        midiAccess = access
        setMidiStatus('connected')
        attachInputs(access)
        access.onstatechange = () => attachInputs(access)
      })
      .catch(() => {
        if (!cancelled) setMidiStatus('no-access')
      })

    return () => {
      cancelled = true
      if (midiAccess) {
        midiAccess.onstatechange = null
        midiAccess.inputs.forEach((input) => {
          input.onmidimessage = null
        })
      }
      setMidiDeviceNames([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="play-keyboard">
      {lastPressedDisplayNote && (
        <div className="play-note-display">{lastPressedDisplayNote}</div>
      )}
      <div className="play-volume">
        <input
          className="play-volume-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={playVolume}
          onChange={(e) => setPlayVolume(Number(e.target.value))}
          aria-label="Instrument volume"
          style={{ background: playVolumeBackground }}
        />
        <button
          type="button"
          className="play-volume-icon-btn"
          onClick={togglePlayMute}
          aria-pressed={playVolume === 0}
          aria-label={playVolume === 0 ? 'Unmute piano' : 'Mute piano'}
          title={playVolume === 0 ? 'Unmute piano' : 'Mute piano'}
        >
          <svg
            className="play-volume-icon"
            xmlns="http://www.w3.org/2000/svg"
            width="1em"
            height="1em"
            viewBox="0 0 48 48"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M0 0h48v48H0z" fill="none" />
            <rect
              width="37"
              height="37"
              x="5.5"
              y="5.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              rx="4"
              ry="4"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M17.833 24v18.5M30.167 24v18.5m-15.105-37h5.542V24h-5.542zm12.334 0h5.542V24h-5.542z"
            />
          </svg>
        </button>
      </div>
      {midiStatus === 'connected' && (
        <div
          className="play-midi-status is-connected"
          title={
            midiDeviceNames.length > 0
              ? `MIDI keyboard connected: ${midiDeviceNames.join(', ')}`
              : 'Waiting for a MIDI keyboard'
          }
        >
          <span className="play-midi-status-dot" />
          {midiDeviceNames.length > 0 ? midiDeviceNames[0] : 'MIDI ready'}
        </div>
      )}
      <div
        className="play-keyboard-trails"
        style={{
          marginLeft: `${PLAY_KEYBOARD_PANEL_WIDTH_PERCENT}%`,
          width: `${PLAY_KEYBOARD_KEYS_AREA_WIDTH_PERCENT}%`,
        }}
      >
        {trails.map((t) => (
          <div
            key={t.id}
            ref={(el) => {
              if (el) trailElsRef.current.set(t.id, el)
            }}
            className={`play-keyboard-trail${t.releasing ? ' is-releasing' : ''}`}
            style={{
              left: `${t.leftPercent}%`,
              width: `${t.widthPercent}%`,
              height: t.releasing ? `${t.frozenHeight ?? 0}px` : undefined,
            }}
          />
        ))}
      </div>
      <div className="play-keyboard-keys">
        <div className="play-keyboard-top-row">
          <div className="play-keyboard-octave-switcher" title="Octave">
            <button
              type="button"
              className="play-keyboard-octave-btn"
              onClick={() => adjustOctave(-1)}
              disabled={octaveShift <= PLAY_KEYBOARD_OCTAVE_MIN}
              aria-label={octaveShift <= PLAY_KEYBOARD_OCTAVE_MIN ? 'Octave down disabled' : 'Octave down one'}
            >
              {octaveShift < 0 ? `-${Math.abs(octaveShift)}` : '-'}
            </button>
            <button
              type="button"
              className="play-keyboard-octave-label"
              aria-label={`Octave shift ${octaveShift}`}
              onClick={() => setOctaveShiftAndRef(0)}
              title="Reset octave to default"
            >
              Octave
            </button>
            <button
              type="button"
              className="play-keyboard-octave-btn"
              onClick={() => adjustOctave(1)}
              disabled={octaveShift >= PLAY_KEYBOARD_OCTAVE_MAX}
              aria-label={octaveShift >= PLAY_KEYBOARD_OCTAVE_MAX ? 'Octave up disabled' : 'Octave up one'}
            >
              {octaveShift > 0 ? `+${octaveShift}` : '+'}
            </button>
          </div>
          <button
            type="button"
            className={`play-keyboard-scale-lock-btn${scaleLock ? ' is-active' : ''}`}
            onClick={() => setScaleLock((v) => !v)}
            aria-pressed={scaleLock}
            aria-label={
              scaleLock
                ? 'Scale lock enabled: natural minor, auto-transposes to each new song\'s key. Click to disable.'
                : 'Enable scale lock (natural minor, auto-transposes to each new song\'s key)'
            }
            title={
              scaleLock
                ? 'Scale lock: natural minor (on) — auto-transposes to each new song\'s key'
                : 'Lock keyboard to natural minor scale and auto-transpose to each new song\'s key'
            }
          >
            <LockIcon locked={scaleLock} />
          </button>
          <div
            className="play-keyboard-transpose-display"
            title="Keyboard transposition"
            aria-label={`Keyboard transposed from C to ${PLAY_KEYBOARD_NOTE_NAMES[((transpose % 12) + 12) % 12]}`}
          >
            C <span className="play-keyboard-transpose-arrow">&rarr;</span>{' '}
            {PLAY_KEYBOARD_NOTE_NAMES[((transpose % 12) + 12) % 12]}
          </div>
        </div>
        <div
          className="play-keyboard-panel"
          style={{ width: `${PLAY_KEYBOARD_PANEL_WIDTH_PERCENT}%` }}
          title="Transpose"
        >
          <button
            type="button"
            className="play-keyboard-transpose-btn"
            onClick={() => adjustTranspose(1)}
            disabled={transpose >= PLAY_KEYBOARD_TRANSPOSE_MAX}
            aria-label="Transpose up one semitone"
          >
            +
          </button>
          <button
            type="button"
            className="play-keyboard-transpose-value"
            aria-label={`Transpose ${transpose}`}
            title="Reset semitones to 0"
            onClick={() => setTransposeAndRef(0)}
          >
            {transpose > 0 ? `+${transpose}` : transpose}
          </button>
          <button
            type="button"
            className="play-keyboard-transpose-btn"
            onClick={() => adjustTranspose(-1)}
            disabled={transpose <= PLAY_KEYBOARD_TRANSPOSE_MIN}
            aria-label="Transpose down one semitone"
          >
            −
          </button>
        </div>
        <div
          className="play-keyboard-whites"
          style={{
            marginLeft: `${PLAY_KEYBOARD_PANEL_WIDTH_PERCENT}%`,
            width: `${PLAY_KEYBOARD_KEYS_AREA_WIDTH_PERCENT}%`,
          }}
        >
          {PLAY_KEYBOARD_WHITE_NOTES.map((note) => (
            <button
              key={note.id}
              type="button"
              data-note-id={note.id}
              className={`play-key play-key-white${pressed[note.id] ? ' active' : ''}`}
              onPointerDown={(event) => {
                pointerDragActiveRef.current = true
                pointerDragPointerIdRef.current = event.pointerId
                pointerDragCurrentNoteIdRef.current = note.id
                dragPressedNoteIdsRef.current.clear()
                dragPressedNoteIdsRef.current.add(note.id)
                pressNote(note)
              }}
              onPointerUp={() => endPointerDrag()}
              onPointerLeave={(event) => {
                if (pointerDragActiveRef.current && event.pointerType !== 'mouse') return
                if (pressed[note.id]) releaseNote(note)
              }}
              onPointerCancel={() => endPointerDrag()}
              aria-label={shiftNoteId(note.id, totalTranspose)}
            />
          ))}
        </div>
        <div
          className="play-keyboard-blacks"
          style={{
            left: `${PLAY_KEYBOARD_PANEL_WIDTH_PERCENT}%`,
            width: `${PLAY_KEYBOARD_KEYS_AREA_WIDTH_PERCENT}%`,
          }}
        >
          {PLAY_KEYBOARD_BLACK_NOTES.map((note) => (
            <button
              key={note.id}
              type="button"
              data-note-id={note.id}
              className={`play-key play-key-black${pressed[note.id] ? ' active' : ''}`}
              style={{ left: `${note.leftPercent}%`, width: `${note.widthPercent}%` }}
              onPointerDown={(event) => {
                pointerDragActiveRef.current = true
                pointerDragPointerIdRef.current = event.pointerId
                pointerDragCurrentNoteIdRef.current = note.id
                dragPressedNoteIdsRef.current.clear()
                dragPressedNoteIdsRef.current.add(note.id)
                pressNote(note)
              }}
              onPointerUp={() => endPointerDrag()}
              onPointerLeave={(event) => {
                if (pointerDragActiveRef.current && event.pointerType !== 'mouse') return
                if (pressed[note.id]) releaseNote(note)
              }}
              onPointerCancel={() => endPointerDrag()}
              aria-label={shiftNoteId(note.id, totalTranspose)}
            />
          ))}
        </div>
      </div>
    </div>
  )
})

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [pendingTagEdits, setPendingTagEdits] = useState<
    Record<
      number,
      {
        tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>
        previous: Track
        expiresAt: number
      }
    >
  >({})
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>(() => loadSort().sortBy)
  const [sortDir, setSortDir] = useState<SortDir>(() => loadSort().sortDir)
  const [keyFilter, setKeyFilter] = useState<string | null>(null)
  const playKeyboardRef = useRef<PlayKeyboardHandle>(null)
  const [performanceRecording, setPerformanceRecording] = useState(false)
  const [performanceEvents, setPerformanceEvents] = useState<PlayPerformanceEvent[]>([])
  const [performanceMenu, setPerformanceMenu] = useState<{ x: number; y: number } | null>(null)
  const [performancePlaying, setPerformancePlaying] = useState(false)
  const [performanceSource, setPerformanceSource] = useState<'none' | 'recorded' | 'saved' | 'backup'>('none')
  const [savedPerformances, setSavedPerformances] = useState<SavedPerformance[]>([])
  const [performanceSaveOpen, setPerformanceSaveOpen] = useState(false)
  const [performanceLibraryOpen, setPerformanceLibraryOpen] = useState(false)
  const [performanceName, setPerformanceName] = useState('')
  const [performanceRenameId, setPerformanceRenameId] = useState<string | null>(null)
  const [performanceRenameValue, setPerformanceRenameValue] = useState('')
  const [performanceDeleteId, setPerformanceDeleteId] = useState<string | null>(null)
  const [backupNoticeOpen, setBackupNoticeOpen] = useState(false)
  const performanceRecordStartedAtRef = useRef<number | null>(null)
  const performanceEventsRef = useRef<PlayPerformanceEvent[]>([])
  const performanceHeldNotesRef = useRef<Set<string>>(new Set())
  const performanceHeldMidiRef = useRef<Map<string, number>>(new Map())
  const performanceOverdubBaseRef = useRef<PlayPerformanceEvent[] | null>(null)
  const suppressPerformanceResetRef = useRef(false)
  const backupEventsRef = useRef<BackupPerformanceEvent[]>([])

  function recordBackupEvent(event: PlayPerformanceInput) {
    const now = performanceNow()
    backupEventsRef.current = [
      ...backupEventsRef.current.filter((entry) => now - entry.at <= 10 * 60 * 1000),
      { ...event, at: now },
    ]
  }

  function handlePerformanceNote(event: PlayPerformanceInput) {
    recordBackupEvent(event)
    if (!performanceRecording) return
    if (event.type === 'off' && !performanceHeldNotesRef.current.has(event.noteId)) return
    if (performanceRecordStartedAtRef.current === null) {
      performanceRecordStartedAtRef.current = performanceNow()
    }
    if (event.type === 'on') {
      performanceHeldNotesRef.current.add(event.noteId)
      performanceHeldMidiRef.current.set(event.noteId, event.midi)
    } else {
      performanceHeldNotesRef.current.delete(event.noteId)
      performanceHeldMidiRef.current.delete(event.noteId)
    }
    const nextEvent = {
      ...event,
      time: performanceNow() - performanceRecordStartedAtRef.current,
    }
    performanceEventsRef.current = [...performanceEventsRef.current, nextEvent]
    setPerformanceEvents(performanceEventsRef.current)
  }

  function startPerformanceRecording() {
    playKeyboardRef.current?.stopPerformance()
    setPerformancePlaying(false)
    performanceOverdubBaseRef.current = null
    performanceRecordStartedAtRef.current = null
    performanceHeldNotesRef.current.clear()
    performanceHeldMidiRef.current.clear()
    performanceEventsRef.current = []
    performanceHeldNotesRef.current.clear()
    performanceHeldMidiRef.current.clear()
    setPerformanceEvents([])
    setPerformanceSource('none')
    setPerformanceRecording(true)
  }

  // Records a second take on top of the performance currently playing back, so the
  // user can play along with it. Restarts playback from the beginning so the new
  // take's timestamps line up with the original for merging.
  function startOverdubRecording() {
    performanceOverdubBaseRef.current = performanceEventsRef.current
    performanceHeldNotesRef.current.clear()
    performanceHeldMidiRef.current.clear()
    performanceEventsRef.current = []
    setPerformanceEvents([])
    setPerformanceRecording(true)
    playKeyboardRef.current?.playPerformance(performanceOverdubBaseRef.current)
    setPerformancePlaying(true)
    performanceRecordStartedAtRef.current = performanceNow()
  }

  function stopPerformanceRecording() {
    setPerformanceRecording(false)
    const startedAt = performanceRecordStartedAtRef.current
    const endTime = startedAt === null ? 0 : performanceNow() - startedAt
    if (startedAt !== null && performanceHeldNotesRef.current.size > 0) {
      for (const noteId of performanceHeldNotesRef.current) {
        performanceEventsRef.current.push({
          type: 'off',
          noteId,
          midi: performanceHeldMidiRef.current.get(noteId) ?? noteIdToMidi(noteId) ?? 60,
          time: endTime,
        })
      }
      performanceHeldNotesRef.current.clear()
      performanceHeldMidiRef.current.clear()
    }
    performanceRecordStartedAtRef.current = null

    const overdubBase = performanceOverdubBaseRef.current
    performanceOverdubBaseRef.current = null

    if (overdubBase) {
      playKeyboardRef.current?.stopPerformance()
      // Prevent the performancePlaying reset effect from wiping the merged take before it's saved.
      suppressPerformanceResetRef.current = true
      setPerformancePlaying(false)
      const merged = [...overdubBase, ...performanceEventsRef.current].sort((a, b) => a.time - b.time)
      performanceEventsRef.current = merged
      setPerformanceEvents(merged)
      setPerformanceSource('recorded')
      setPerformanceName('')
      setPerformanceSaveOpen(true)
    } else if (performanceEventsRef.current.length > 0) {
      setPerformanceEvents(performanceEventsRef.current)
      setPerformanceSource('recorded')
    }
  }

  function savePerformance() {
    if (performanceEvents.length === 0 || !performanceName.trim()) return
    const record: SavedPerformance = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: performanceName.trim(),
      createdAt: Date.now(),
      events: performanceEvents,
    }
    const next = [...savedPerformances, record]
    localStorage.setItem(PLAY_PERFORMANCE_STORAGE_KEY, JSON.stringify(next))
    setSavedPerformances(next)
    setPerformanceSaveOpen(false)
    setPerformanceName('')
  }

  function playSavedPerformance(record: SavedPerformance) {
    setPerformanceEvents(record.events)
    performanceEventsRef.current = record.events
    setPerformanceSource('saved')
    playKeyboardRef.current?.playPerformance(record.events)
    setPerformancePlaying(true)
    setPerformanceLibraryOpen(false)
  }

  function renameSavedPerformance(recordId: string) {
    const name = performanceRenameValue.trim()
    if (!name) return
    const next = savedPerformances.map((record) =>
      record.id === recordId ? { ...record, name } : record,
    )
    localStorage.setItem(PLAY_PERFORMANCE_STORAGE_KEY, JSON.stringify(next))
    setSavedPerformances(next)
    setPerformanceRenameId(null)
    setPerformanceRenameValue('')
  }

  function deleteSavedPerformance(recordId: string) {
    const next = savedPerformances.filter((record) => record.id !== recordId)
    localStorage.setItem(PLAY_PERFORMANCE_STORAGE_KEY, JSON.stringify(next))
    setSavedPerformances(next)
    setPerformanceDeleteId(null)
  }

  function backupEventsForMinutes(minutes: number): PlayPerformanceEvent[] | null {
    const now = performanceNow()
    const cutoff = now - minutes * 60 * 1000
    const recent = backupEventsRef.current.filter((event) => event.at >= cutoff)
    if (!recent.some((event) => event.type === 'on')) return null

    const activeAtCutoff = new Map<string, BackupPerformanceEvent>()
    for (const event of backupEventsRef.current) {
      if (event.at > cutoff) break
      if (event.type === 'on') activeAtCutoff.set(event.noteId, event)
      else activeAtCutoff.delete(event.noteId)
    }
    const selected: BackupPerformanceEvent[] = [
      ...Array.from(activeAtCutoff.values()).map((event) => ({ ...event, at: cutoff })),
      ...recent,
    ].sort((a, b) => a.at - b.at)
    const activeAtNow = new Map<string, BackupPerformanceEvent>()
    for (const event of selected) {
      if (event.type === 'on') activeAtNow.set(event.noteId, event)
      else activeAtNow.delete(event.noteId)
    }
    for (const [noteId, event] of activeAtNow) {
      selected.push({ type: 'off', noteId, midi: event.midi, at: now })
    }
    selected.sort((a, b) => a.at - b.at)
    const start = selected[0].at
    return selected.map(({ at, ...event }) => ({ ...event, time: at - start }))
  }

  function playBackupPerformance(minutes: number) {
    const events = backupEventsForMinutes(minutes)
    if (!events) {
      setBackupNoticeOpen(true)
      return
    }
    setPerformanceEvents(events)
    performanceEventsRef.current = events
    setPerformanceSource('backup')
    playKeyboardRef.current?.playPerformance(events)
    setPerformancePlaying(true)
    setPerformanceMenu(null)
  }

  function togglePerformancePlayback() {
    if (performancePlaying) {
      playKeyboardRef.current?.stopPerformance()
      setPerformancePlaying(false)
    } else if (performanceEvents.length > 0) {
      playKeyboardRef.current?.playPerformance(performanceEvents)
      setPerformancePlaying(true)
    }
  }

  function performanceNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
  }
  const [sectionsSortBy, setSectionsSortBy] = useState<GridSortOption>(
    () => loadGridSort(SECTIONS_SORT_STORAGE_KEY).sortBy
  )
  const [sectionsSortDir, setSectionsSortDir] = useState<SortDir>(
    () => loadGridSort(SECTIONS_SORT_STORAGE_KEY).sortDir
  )
  const [playlistsSortBy, setPlaylistsSortBy] = useState<GridSortOption>(
    () => loadGridSort(PLAYLISTS_SORT_STORAGE_KEY).sortBy
  )
  const [playlistsSortDir, setPlaylistsSortDir] = useState<SortDir>(
    () => loadGridSort(PLAYLISTS_SORT_STORAGE_KEY).sortDir
  )

  function handleSortChange(option: SortOption) {
    if (option === sortBy) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(option)
      setSortDir('asc')
    }
  }

  function handleSectionsSortChange(option: GridSortOption) {
    if (option === sectionsSortBy) {
      setSectionsSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSectionsSortBy(option)
      setSectionsSortDir('asc')
    }
  }

  function handlePlaylistsSortChange(option: GridSortOption) {
    if (option === playlistsSortBy) {
      setPlaylistsSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setPlaylistsSortBy(option)
      setPlaylistsSortDir('asc')
    }
  }

  const gridDragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [scanning, setScanning] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [nightMode, setNightMode] = useState(false)
  const [appView, setAppView] = useState<AppView>('media')

  // Switching tabs swaps the header's back button in/out and resizes the
  // title text, which can leave Electron's frameless-window drag region
  // briefly stale (see the matching comment on the main-process handler) —
  // nudge it so the header's buttons don't get eaten as titlebar drags
  // right after a switch.
  useEffect(() => {
    window.api.nudgeDragRegion?.()
  }, [appView])

  const [activeSection, setActiveSection] = useState<Section>(loadHomeSection)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  // User-managed "up next" queue. Takes priority over the natural playback
  // order in goNext() — Prev/auto-continue otherwise fall through to the
  // normal library/folder order untouched by the queue.
  const [queue, setQueue] = useState<Track[]>([])
  const [recentTracks, setRecentTracks] = useState<Track[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [viewingFolder, setViewingFolder] = useState<Folder | null>(null)
  const [folderTracks, setFolderTracks] = useState<Track[]>([])
  const [pendingFolderPath, setPendingFolderPath] = useState<string | null>(null)
  const [trackContextMenu, setTrackContextMenu] = useState<{
    track: Track
    x: number
    y: number
    section: Section
  } | null>(null)
  const [confirmImportKeyTrack, setConfirmImportKeyTrack] = useState<Track | null>(null)
  const [detectingKeyTrack, setDetectingKeyTrack] = useState<Track | null>(null)
  const [infoTrack, setInfoTrack] = useState<Track | null>(null)
  const [infoTrackEditable, setInfoTrackEditable] = useState(false)
  const [artUpdatePrompt, setArtUpdatePrompt] = useState<{ track: Track; artPath: string | null } | null>(null)
  const trackContextMenuRef = useRef<HTMLDivElement>(null)
  // Right-click menu for the Now Playing album art — deliberately separate
  // from trackContextMenu, whose items (library include/exclude, Studio
  // import, etc.) are keyed off a library Section that doesn't apply here.
  const [nowPlayingArtMenu, setNowPlayingArtMenu] = useState<{ x: number; y: number } | null>(null)
  const nowPlayingArtMenuRef = useRef<HTMLDivElement>(null)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [viewingPlaylist, setViewingPlaylist] = useState<Playlist | null>(null)
  const [playlistAddMode, setPlaylistAddMode] = useState(false)
  const [playlistTracks, setPlaylistTracks] = useState<Track[]>([])
  const [playlistPickerFolder, setPlaylistPickerFolder] = useState<Folder | null>(null)
  const [playlistPickerFolderTracks, setPlaylistPickerFolderTracks] = useState<Track[]>([])
  const [advancedTracks, setAdvancedTracks] = useState<Track[]>([])
  const [advancedFolder, setAdvancedFolder] = useState<Folder | null>(null)
  const [advancedFolderTracks, setAdvancedFolderTracks] = useState<Track[]>([])
  const [bassIntervalsByTrack, setBassIntervalsByTrack] = useState<Record<number, BassInterval[]>>({})
  const [bassIntervalFilter, setBassIntervalFilter] = useState<string | null>(null)
  const [advancedSortBy, setAdvancedSortBy] = useState<AdvancedSortOption>('recent')
  const [studioTool, setStudioTool] = useState('Studio Home')
  const [removeSilenceTabClicked, setRemoveSilenceTabClicked] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [imageViewerOpen, setImageViewerOpen] = useState(false)
  const [imageViewerFullscreen, setImageViewerFullscreen] = useState(false)
  const [imageViewerPath, setImageViewerPath] = useState<string | null>(null)
  // Data URL of the crop result, layered over imageViewerPath — the file on
  // disk is never touched until the user explicitly saves/exports it.
  const [imageEditedSrc, setImageEditedSrc] = useState<string | null>(null)
  const [imageCropActive, setImageCropActive] = useState(false)
  const [imageCropBounds, setImageCropBounds] = useState<ImageCropBounds | null>(null)
  const [imageCropRect, setImageCropRect] = useState<ImageCropRect | null>(null)
  // Last measured crop bounds, used to rescale the in-progress crop
  // selection proportionally when zooming out shrinks the image mid-edit
  // (see the crop bounds measurement effect below).
  const imageCropPrevBoundsRef = useRef<ImageCropBounds | null>(null)
  // Declared up here (rather than alongside the other image-viewer HUD
  // state further below) so the crop bounds measurement effect below can
  // list imageZoom as a dependency without a temporal-dead-zone reference
  // error.
  const [imageZoom, setImageZoom] = useState(1)
  const [imagePanX, setImagePanX] = useState(0)
  const [imagePanY, setImagePanY] = useState(0)
  const [imageSaving, setImageSaving] = useState(false)
  const [imageSaveError, setImageSaveError] = useState(false)
  const [imageCopied, setImageCopied] = useState(false)
  // Whole seconds remaining before a delayed screenshot fires, or null when
  // no screenshot timer is pending — drives the on-screen countdown overlay.
  const [screenshotCountdown, setScreenshotCountdown] = useState<number | null>(null)
  const imageViewerContainerRef = useRef<HTMLDivElement>(null)
  const imageViewerImgRef = useRef<HTMLImageElement>(null)
  const imageSaveErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const imageCopiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const screenshotCountdownIntervalRef = useRef<number | null>(null)
  const [videoViewerOpen, setVideoViewerOpen] = useState(false)
  const [videoViewerFullscreen, setVideoViewerFullscreen] = useState(false)
  const [videoViewerPath, setVideoViewerPath] = useState<string | null>(null)
  // True only while videoViewerPath is a screen recording that's never been
  // written anywhere but a scratch temp file — drives the Download button;
  // false for a video opened from disk (already saved) or drag-dropped in.
  const [videoIsUnsavedRecording, setVideoIsUnsavedRecording] = useState(false)
  const [videoDownloading, setVideoDownloading] = useState(false)
  // Keeps the viewer panel mounted for one extra animation frame after it
  // closes, so the hotkey-driven open/close gets a fade+scale transition
  // instead of an instant cut. Mirrors VIEWER_TRANSITION_MS below.
  const [imageViewerRendered, setImageViewerRendered] = useState(false)
  const [imageViewerClosing, setImageViewerClosing] = useState(false)
  const [videoViewerRendered, setVideoViewerRendered] = useState(false)
  const [videoViewerClosing, setVideoViewerClosing] = useState(false)

  useEffect(() => {
    if (imageViewerOpen) {
      setImageViewerRendered(true)
      setImageViewerClosing(false)
      return
    }
    if (!imageViewerRendered) return
    setImageViewerClosing(true)
    const timer = setTimeout(() => {
      setImageViewerRendered(false)
      setImageViewerClosing(false)
    }, VIEWER_TRANSITION_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageViewerOpen])

  // A newly loaded (or removed) image drops any in-progress crop and any
  // edit baked in from a previous image — none of that should carry over.
  useEffect(() => {
    setImageEditedSrc(null)
    setImageCropActive(false)
    setImageCropBounds(null)
    setImageCropRect(null)
    imageCropPrevBoundsRef.current = null
    setImageSaveError(false)
    setImageCopied(false)
    if (imageSaveErrorTimeoutRef.current) clearTimeout(imageSaveErrorTimeoutRef.current)
    if (imageCopiedTimeoutRef.current) clearTimeout(imageCopiedTimeoutRef.current)
  }, [imageViewerPath])

  useEffect(() => {
    return () => {
      if (screenshotCountdownIntervalRef.current) clearInterval(screenshotCountdownIntervalRef.current)
      if (imageCopiedTimeoutRef.current) clearTimeout(imageCopiedTimeoutRef.current)
    }
  }, [])

  // Keeps the floating top-right countdown badge (outside the app window)
  // in sync with the in-viewer one — same state, two displays.
  useEffect(() => {
    window.api.setScreenshotCountdownOverlay(screenshotCountdown)
  }, [screenshotCountdown])

  // Measures the <img>'s own rendered box — getBoundingClientRect() already
  // reflects the live zoom transform (translate/scale), so its box IS the
  // visible image at whatever zoom it's currently at, no object-fit or
  // zoom math needed — so the crop overlay/selection can be positioned in
  // the same coordinate space. Kept in sync across window resizes and,
  // since cropping allows zooming out (see handleWheel's maxZoom), across
  // zoom changes too.
  useEffect(() => {
    if (!imageCropActive) return
    function measure() {
      const img = imageViewerImgRef.current
      const container = imageViewerContainerRef.current
      if (!img || !container) return
      const imgRect = img.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const bounds: ImageCropBounds = {
        left: imgRect.left - containerRect.left,
        top: imgRect.top - containerRect.top,
        width: imgRect.width,
        height: imgRect.height,
      }
      const prevBounds = imageCropPrevBoundsRef.current
      imageCropPrevBoundsRef.current = bounds
      setImageCropBounds(bounds)
      setImageCropRect((prev) => {
        if (!prev) {
          return {
            x: bounds.width * 0.1,
            y: bounds.height * 0.1,
            width: bounds.width * 0.8,
            height: bounds.height * 0.8,
          }
        }
        // The image shrank/grew (zoom changed) since the last measurement —
        // rescale the existing selection by the same factor instead of
        // leaving it sized/positioned for the old, now-stale bounds.
        if (!prevBounds || (prevBounds.width === bounds.width && prevBounds.height === bounds.height)) return prev
        const scaleX = bounds.width / prevBounds.width
        const scaleY = bounds.height / prevBounds.height
        return {
          x: prev.x * scaleX,
          y: prev.y * scaleY,
          width: prev.width * scaleX,
          height: prev.height * scaleY,
        }
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [imageCropActive, imageZoom])

  useEffect(() => {
    if (videoViewerOpen) {
      setVideoViewerRendered(true)
      setVideoViewerClosing(false)
      return
    }
    if (!videoViewerRendered) return
    setVideoViewerClosing(true)
    const timer = setTimeout(() => {
      setVideoViewerRendered(false)
      setVideoViewerClosing(false)
    }, VIEWER_TRANSITION_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoViewerOpen])

  // Which of the panel branches below is actually showing right now — the
  // viewer panels stay mounted (imageViewerRendered/videoViewerRendered)
  // for VIEWER_TRANSITION_MS after close so they can fade out instead of
  // vanishing instantly; this keeps the playback-bar footers and the panel
  // switch in the render below in lockstep during that window.
  const activePanel: 'image' | 'video' | 'fullscreen' | 'default' = imageViewerRendered
    ? 'image'
    : videoViewerRendered
      ? 'video'
      : fullScreen
        ? 'fullscreen'
        : 'default'

  // Guards the transcode fallback (see ensurePlayableVideo) so it's only
  // ever tried once per loaded file — it's applied imperatively straight to
  // the <video> element (mirroring the Studio <audio> fallback below),
  // rather than through React state, since changing .src via a plain
  // attribute re-render doesn't reliably clear an element already sitting
  // in an error state.
  const videoFallbackAppliedRef = useRef(false)
  // The actual playable file fed to <video> — always a faststart-remuxed
  // copy of videoViewerPath (see prepareVideoForPlayback), never the raw
  // source directly. Most exported MP4s put their moov index atom after
  // the media data instead of before it; that's fine over a plain
  // http/file source, but reproducibly fails over Electron's custom
  // protocol.handle (confirmed directly: Chromium's media pipeline has to
  // issue a second, later range request to find moov, and that second
  // request reliably comes back MEDIA_ERR_SRC_NOT_SUPPORTED through
  // protocol.handle even though byte-identical serving works fine over
  // http). Remuxing to faststart first means Chromium only ever needs the
  // first request.
  const [videoPlayableSrc, setVideoPlayableSrc] = useState<string | null>(null)
  const [videoPreparing, setVideoPreparing] = useState(false)
  const [videoIsPlaying, setVideoIsPlaying] = useState(false)
  const [videoCurrentTime, setVideoCurrentTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const [videoVolume, setVideoVolume] = useState(1)
  const [pauseAudioPrompt, setPauseAudioPrompt] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Controls (return/fullscreen buttons, playback bar) fade in on mouse
  // movement over the video and fade back out after 5s of inactivity.
  const [videoControlsVisible, setVideoControlsVisible] = useState(true)
  const videoControlsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [imageControlsVisible, setImageControlsVisible] = useState(true)
  const imageControlsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cursor visibility in the immersive fullscreen view is deliberately
  // separate from the HUD (imageControlsVisible): the HUD only reappears
  // near the top/bottom bands (see handleImageViewerMouseMove), but the
  // cursor itself should snap back visible on any movement at all.
  const [imageCursorVisible, setImageCursorVisible] = useState(true)
  const imageCursorHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirrors imageZoom/imagePanX/imagePanY, kept in sync after every render so
  // the wheel listener (a stable native listener, not re-attached per zoom
  // tick — see the effect below) can read the latest values without going
  // stale between renders during fast scrolling.
  const imageViewLiveRef = useRef({ zoom: 1, panX: 0, panY: 0 })
  const imagePanDragRef = useRef<{
    startX: number
    startY: number
    startPanX: number
    startPanY: number
    moved: boolean
  } | null>(null)
  // Set right after a real (moved) drag-to-pan ends, so the click that the
  // browser may still synthesize on pointerup doesn't also hide the HUD/cursor.
  const imageJustPannedRef = useRef(false)
  const [osFullscreen, setOsFullscreen] = useState(false)
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!libraryNotice) return
    const timer = window.setTimeout(() => setLibraryNotice(null), 4200)
    return () => window.clearTimeout(timer)
  }, [libraryNotice])

  // The native titlebar overlay (minimize/maximize/close) is drawn by the OS,
  // not the DOM, so its contrast/visibility can only be changed through this
  // IPC call: a subtle backing while viewing images normally (so the buttons
  // read against bright content), and fully invisible in the immersive
  // fullscreen view until the HUD itself is revealed.
  useEffect(() => {
    if (activePanel !== 'image' || !imageViewerPath) {
      window.api.setTitleBarOverlay?.(TITLEBAR_OVERLAY_DEFAULT)
      return
    }
    if (imageViewerFullscreen) {
      window.api.setTitleBarOverlay?.(
        imageControlsVisible || imageCropActive ? TITLEBAR_OVERLAY_SUBTLE : TITLEBAR_OVERLAY_INVISIBLE
      )
    } else {
      window.api.setTitleBarOverlay?.(TITLEBAR_OVERLAY_SUBTLE)
    }
  }, [activePanel, imageViewerPath, imageViewerFullscreen, imageControlsVisible, imageCropActive])

  // The fullscreen-exit control mounts/unmounts a new no-drag button over
  // what's otherwise part of the draggable titlebar region (see the
  // matching comment on the appView nudge effect above) — nudge so it
  // doesn't get eaten as a titlebar drag right after it appears.
  useEffect(() => {
    window.api.nudgeDragRegion?.()
  }, [imageViewerFullscreen, videoViewerFullscreen, osFullscreen])

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = videoVolume
  }, [videoVolume, videoViewerPath])

  // A newly opened video starts back on its original file — the fallback is
  // allowed to fire again for this one.
  useEffect(() => {
    videoFallbackAppliedRef.current = false
  }, [videoViewerPath])

  useEffect(() => {
    if (!videoViewerOpen) {
      if (videoControlsHideTimerRef.current) clearTimeout(videoControlsHideTimerRef.current)
      setVideoControlsVisible(true)
      return
    }
    revealVideoControls()
    return () => {
      if (videoControlsHideTimerRef.current) clearTimeout(videoControlsHideTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoViewerOpen])

  useEffect(() => {
    if (!imageViewerOpen) {
      if (imageControlsHideTimerRef.current) clearTimeout(imageControlsHideTimerRef.current)
      if (imageCursorHideTimerRef.current) clearTimeout(imageCursorHideTimerRef.current)
      setImageControlsVisible(true)
      setImageCursorVisible(true)
      setImageZoom(1)
      setImagePanX(0)
      setImagePanY(0)
      return
    }
    revealImageControls()
    revealImageCursor()
    return () => {
      if (imageControlsHideTimerRef.current) clearTimeout(imageControlsHideTimerRef.current)
      if (imageCursorHideTimerRef.current) clearTimeout(imageCursorHideTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageViewerOpen])

  // Each newly loaded image starts back at 1x zoom rather than inheriting
  // whatever the previous image was zoomed/panned to.
  useEffect(() => {
    setImageZoom(1)
    setImagePanX(0)
    setImagePanY(0)
  }, [imageViewerPath])

  // Keeps a ref mirror of zoom/pan so the wheel listener (see below) can
  // read the latest values without staling between renders.
  useEffect(() => {
    imageViewLiveRef.current = { zoom: imageZoom, panX: imagePanX, panY: imagePanY }
  }, [imageZoom, imagePanX, imagePanY])

  // Keeps the panned image from being dragged/zoomed so far that it leaves
  // the container empty on one side — clamps to the point where the image's
  // edge lines up with the container's edge. img.offsetWidth/offsetHeight
  // are the pre-transform layout box (the fit-to-container size at 1x),
  // since CSS transforms don't affect layout metrics.
  function clampImagePan(panX: number, panY: number, zoom: number) {
    const img = imageViewerImgRef.current
    const container = imageViewerContainerRef.current
    if (!img || !container) return { x: panX, y: panY }
    const containerRect = container.getBoundingClientRect()
    const maxX = Math.max(0, (img.offsetWidth * zoom - containerRect.width) / 2)
    const maxY = Math.max(0, (img.offsetHeight * zoom - containerRect.height) / 2)
    return {
      x: Math.min(maxX, Math.max(-maxX, panX)),
      y: Math.min(maxY, Math.max(-maxY, panY)),
    }
  }

  // Scroll to zoom in/out on the image, anchored under the cursor (the
  // point under the cursor stays put as the zoom changes). Wired up as a
  // native listener (rather than React's onWheel) because React attaches
  // wheel handlers as passive by default, so preventDefault() inside a
  // synthetic handler is a silent no-op. Depends on activePanel (not just
  // imageViewerPath) because the container div unmounts/remounts a fresh
  // DOM node every time the panel closes and reopens — without that
  // dependency, reopening the viewer on the same image (path unchanged)
  // would leave the new node without a listener. Reads/writes
  // imageViewLiveRef instead of depending on imageZoom/imagePanX/imagePanY
  // directly so this listener isn't torn down and re-attached on every
  // single scroll tick.
  useEffect(() => {
    if (activePanel !== 'image') return
    const el = imageViewerContainerRef.current
    if (!el || !imageViewerPath) return
    function handleWheel(e: WheelEvent) {
      e.preventDefault()
      const { zoom, panX, panY } = imageViewLiveRef.current
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      // Cropping only ever needs to zoom out to see more of the image
      // shrunk down — zooming past 1x would push part of the image outside
      // the (non-pannable, see handleImagePointerDown) crop container.
      const maxZoom = imageCropActive ? 1 : 6
      const rawNextZoom = Math.min(maxZoom, Math.max(IMAGE_MIN_ZOOM, zoom * factor))
      // Snap back to exactly 1 (the fit-to-container size) whenever a scroll
      // step lands close to it from either side, instead of drifting past it
      // to e.g. 1.0000003 or 0.998 and leaving the grab cursor/pan clamp on
      // at an imperceptible zoom.
      const nextZoom = Math.abs(rawNextZoom - 1) < 0.02 ? 1 : rawNextZoom
      const ratio = nextZoom / zoom
      const containerRect = el!.getBoundingClientRect()
      const cursorX = e.clientX - (containerRect.left + containerRect.width / 2)
      const cursorY = e.clientY - (containerRect.top + containerRect.height / 2)
      const nextPanX = ratio * panX + (1 - ratio) * cursorX
      const nextPanY = ratio * panY + (1 - ratio) * cursorY
      const clamped = clampImagePan(nextPanX, nextPanY, nextZoom)
      imageViewLiveRef.current = { zoom: nextZoom, panX: clamped.x, panY: clamped.y }
      setImageZoom(nextZoom)
      setImagePanX(clamped.x)
      setImagePanY(clamped.y)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [activePanel, imageViewerPath, imageCropActive])

  // <video> never loads videoViewerPath directly (see videoPlayableSrc) —
  // every video is remuxed to faststart first, cached by the main process
  // so repeat plays of the same file are instant.
  useEffect(() => {
    if (!videoViewerPath) {
      setVideoPlayableSrc(null)
      setVideoPreparing(false)
      return
    }
    let cancelled = false
    setVideoPlayableSrc(null)
    setVideoPreparing(true)
    window.api.prepareVideoForPlayback(videoViewerPath).then((playablePath) => {
      if (cancelled) return
      setVideoPlayableSrc(playablePath)
      setVideoPreparing(false)
    })
    return () => {
      cancelled = true
    }
  }, [videoViewerPath])

  // The video is never allowed to autoplay itself (no `autoPlay` prop on the
  // <video> below) — it only starts once loaded AND the pause-audio prompt
  // (if it was shown at all) has been answered, so background music never
  // gets a moment of double playback with the video.
  useEffect(() => {
    if (!videoPlayableSrc || pauseAudioPrompt) return
    videoRef.current?.play().catch((err) => console.error('Failed to start video playback:', err))
  }, [videoPlayableSrc, pauseAudioPrompt])

  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)
  const [currentTrackId, setCurrentTrackId] = useState<number | null>(null)
  useEffect(() => {
    backupEventsRef.current = []
    if (performancePlaying) return
    if (suppressPerformanceResetRef.current) {
      suppressPerformanceResetRef.current = false
      return
    }
    setPerformanceRecording(false)
    performanceRecordStartedAtRef.current = null
    try {
      const records = parseSavedPerformances(localStorage.getItem(PLAY_PERFORMANCE_STORAGE_KEY))
      const legacyKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter((key): key is string => key?.startsWith(LEGACY_PLAY_PERFORMANCE_STORAGE_PREFIX) ?? false)
      const legacyRecords = legacyKeys.flatMap((key) => parseSavedPerformances(localStorage.getItem(key)))
      legacyKeys.forEach((key) => localStorage.removeItem(key))
      const allRecords = [...records, ...legacyRecords]
      if (legacyRecords.length > 0) {
        localStorage.setItem(PLAY_PERFORMANCE_STORAGE_KEY, JSON.stringify(allRecords))
      }
      setSavedPerformances(allRecords)
      performanceEventsRef.current = []
      setPerformanceEvents([])
      setPerformanceSource('none')
    } catch {
      setSavedPerformances([])
      performanceEventsRef.current = []
      setPerformanceEvents([])
      setPerformanceSource('none')
    }
  }, [currentTrackId, performancePlaying])
  useEffect(() => {
    if (!backupNoticeOpen) return
    const timer = window.setTimeout(() => setBackupNoticeOpen(false), 5200)
    return () => window.clearTimeout(timer)
  }, [backupNoticeOpen])
  useEffect(() => {
    if (!performanceMenu) return
    function closePerformanceMenu(event: MouseEvent) {
      const target = event.target as Element | null
      if (!target?.closest('.play-performance-context-menu')) setPerformanceMenu(null)
    }
    window.addEventListener('mousedown', closePerformanceMenu)
    return () => window.removeEventListener('mousedown', closePerformanceMenu)
  }, [performanceMenu])

  // Studio's waveform only shows the now-playing track once the user
  // explicitly imports it (the + button on the album art) — it shouldn't
  // silently swap out from under someone mid-edit just because a different
  // track started playing elsewhere in the app, so a track change always
  // requires a fresh import.
  const [studioTrackImported, setStudioTrackImported] = useState(false)
  useEffect(() => {
    setStudioTrackImported(false)
  }, [currentTrackId])
  // A file dropped directly into Studio — independent of Now Playing, so it
  // survives track changes and never touches the shared <audio> element.
  const [studioDroppedTrack, setStudioDroppedTrack] = useState<Track | null>(null)
  const [playTrigger, setPlayTrigger] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [volume, setVolume] = useState(loadVolume)
  const [previousVolume, setPreviousVolume] = useState(() => {
    const v = loadVolume()
    return v > 0 ? v : DEFAULT_VOLUME
  })
  // Defaults to song-repeat on launch. TODO: replace with the user's last-used setting.
  const [loopMode, setLoopMode] = useState<LoopMode>('song')
  const [shuffle, setShuffle] = useState(false)
  const [shuffleHistory, setShuffleHistory] = useState<number[]>([])
  const [shuffleHistoryPos, setShuffleHistoryPos] = useState(0)

  // Set right before restoring the last-played track into Now Playing on
  // launch, so the currentTrackId-driven load effect can load it paused
  // instead of auto-playing and re-marking it as just-played.
  const isRestoringTrackRef = useRef(false)
  // Stays true from a paused restore until the track's first real play.
  // A track whose <audio> src has been sitting loaded-but-idle since launch
  // (never actually started) fails to produce audible, advancing playback
  // when finally resumed — the underlying stream needs a fresh src/load
  // right before that first play, unlike a normal play-immediately load.
  const needsReloadOnPlayRef = useRef(false)

  const audioRef = useRef<HTMLAudioElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null)
  // Set whenever pitch is shifted away from 0 — a SoundTouch PitchShifter
  // "pseudo-node" (WSOLA time-stretch) takes over from whichever of the
  // three raw-AudioBufferSourceNode engines above (native <audio>, gapless
  // loop, reverse) was driving sound, since only it can move pitch
  // independently of tempo. Mutually exclusive with sourceNodeRef being the
  // active engine — see stopWebAudio, which tears down whichever is set.
  const pitchShifterRef = useRef<PitchShifter | null>(null)
  const trackBufferRef = useRef<ArrayBuffer | null>(null)
  const decodedBufferRef = useRef<AudioBuffer | null>(null)
  const reversedBufferRef = useRef<AudioBuffer | null>(null)
  // Studio's Trim Audio tool, applied live to the actual Now Playing engine
  // when the track being edited is the currently playing one (studioIsAligned)
  // — see beginManualTrimAligned/applyManualTrimAligned below. trimmedBufferRef
  // is the active trimmed+faded buffer (or null when no manual trim is in
  // effect); startReversePlayback/startPitchShiftPlayback/startWebAudioLoop
  // all resolve their forward source through it (falling back to
  // decodedBufferRef) so a trim composes with whichever of reverse/pitch is
  // already active. manualTrimBaseRef is the untouched snapshot
  // applyManualTrimAligned always re-slices from, taken once when Trim Audio
  // opens on this slot — mirrors useFilePlayback's identical pair.
  const trimmedBufferRef = useRef<AudioBuffer | null>(null)
  const manualTrimBaseRef = useRef<AudioBuffer | null>(null)
  // Set by applyManualTrimAligned, cleared by beginManualTrimAligned/
  // confirmManualTrimAligned — whether a trim/fade has actually been applied
  // since Trim Audio last opened on the aligned "track" slot, so a "Done"
  // click with no edits made doesn't stamp the waveform display from a
  // buffer nothing actually changed. Mirrors useFilePlayback's identical
  // manualTrimDirtyRef.
  const alignedManualTrimDirtyRef = useRef(false)
  const reversePlaybackActiveRef = useRef(false)
  const customizeSettings = useRef(loadCustomizeSettings()).current
  // Last committed (not mid-drag) playback rate, read by whichever engine
  // hands off next — native <audio> reload, gapless loop, or reverse buffer.
  const playbackSpeedRef = useRef(customizeSettings.playbackSpeed)
  // Mirrors pitchSemitones for use inside async closures (the buffer-fetch
  // callback below) that read it well after the render that set it — same
  // reasoning as playbackSpeedRef/reverseAudioEnabledRef.
  const pitchSemitonesRef = useRef(customizeSettings.pitchSemitones)
  const webAudioActiveRef = useRef(false)
  const webAudioStartCtxTimeRef = useRef(0)
  const webAudioStartOffsetRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)
  const loopModeRef = useRef<LoopMode>('song')
  const activeSectionRef = useRef<Section>('songs')
  const tracksRequestIdRef = useRef(0)
  const eqFilterNodesRef = useRef<BiquadFilterNode[]>([])
  const eqGainsRef = useRef<number[]>(customizeSettings.eqGains)
  // Volume-boost gain node for Studio's Equalizer tool (the aligned "track"
  // slot case — see boostVolume below) — chained after the EQ filter bank
  // and ahead of the existing master-volume gain node, so it can push above
  // 100% without disturbing the footer's own 0-1 volume slider.
  const boostGainNodeRef = useRef<GainNode | null>(null)
  // Studio dB meter's tap points for the aligned "track" slot — post-EQ/
  // boost, pre-master-volume, so they read true regardless of the footer's
  // own volume slider. Split left/right so the meter can show both channels
  // independently. See studioMeterDb's polling effect.
  const meterAnalyserLRef = useRef<AnalyserNode | null>(null)
  const meterAnalyserRRef = useRef<AnalyserNode | null>(null)
  const mediaSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  // Background key detection: a dedicated (never connected to speakers)
  // decode context, a persistent worker doing the actual analysis off the
  // main thread, and a simple queue so newly-added tracks are processed one
  // at a time instead of competing with playback for CPU.
  const keyDetectionDecodeCtxRef = useRef<AudioContext | null>(null)
  const keyDetectionWorkerRef = useRef<Worker | null>(null)
  const keyDetectionQueueRef = useRef<{ id: number; filePath: string }[]>([])
  const keyDetectionBusyRef = useRef(false)
  const [eqOpen, setEqOpen] = useState(false)
  const [eqGains, setEqGains] = useState<number[]>(customizeSettings.eqGains)
  // Studio Equalizer tool's volume-boost slider for the aligned "track"
  // slot — 0-2 (0%-200%), default 1 (100%). Kept separate from the footer's
  // own 0-1 volume so it can push above 100% without needing to change that
  // slider's range.
  const [boostVolume, setBoostVolumeState] = useState(customizeSettings.boostVolume)
  const boostVolumeRef = useRef(customizeSettings.boostVolume)
  // Studio Equalizer's "lock" toggle — a single UI-wide mode switch (not
  // per-slot, like speedSnapEnabled below) rather than a per-track setting:
  // while on, dragging one band shifts every band by the same amount so
  // their relative shape is preserved, for boosting/cutting overall volume
  // after already shaping the curve. See applyLockedEqBandChange.
  const [eqLocked, setEqLocked] = useState(customizeSettings.eqLocked)
  const [playbackSpeed, setPlaybackSpeed] = useState(customizeSettings.playbackSpeed)
  const [speedSnapEnabled, setSpeedSnapEnabled] = useState(customizeSettings.speedSnapEnabled)
  // Wired to real (tempo-independent) pitch shifting via the pitch-shift
  // effect below, which hands playback over to a SoundTouch PitchShifter
  // whenever this leaves 0.
  const [pitchSemitones, setPitchSemitones] = useState(customizeSettings.pitchSemitones)
  const [reverseAudioEnabled, setReverseAudioEnabled] = useState(customizeSettings.reverseAudioEnabled)
  // Mirrors reverseAudioEnabled for use inside the track-load effect/fetch
  // callback, which reads it well after the render that set it — a plain
  // closure over the state would see a stale value there.
  const reverseAudioEnabledRef = useRef(customizeSettings.reverseAudioEnabled)
  const [exportingStudioAudio, setExportingStudioAudio] = useState(false)
  // Export failures used to only go to the console, so a failed save looked
  // identical to a successful one from the user's perspective. Surface it on
  // the Save button itself instead, briefly.
  const [studioExportError, setStudioExportError] = useState<string | null>(null)
  const studioExportErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // "Add to Song Library?" prompt shown after any Studio save (the primary
  // track, an internal recording, or a mic recording) completes — the
  // saved file's path once it's actually on disk, or null when no prompt
  // is showing. See saveAndOfferLibraryAdd/confirmAddToLibrary below.
  const [pendingLibraryAddPath, setPendingLibraryAddPath] = useState<string | null>(null)
  const [addingToLibrary, setAddingToLibrary] = useState(false)
  // Microphone and internal (system/"what you hear") audio recording in
  // Studio share the same capture/playback/trim state machine — see
  // useAudioRecorder — differing only in how their source MediaStream is
  // obtained below.
  const micRecorder = useAudioRecorder({
    getStream: getMicStream,
    label: 'microphone',
    saveFilePrefix: 'Recording',
  })
  const internalAudioRecorder = useAudioRecorder({
    getStream: getInternalAudioStream,
    label: 'internal audio',
    saveFilePrefix: 'Internal Audio Recording',
  })
  // Studio's "Listen" tab — captures a short window of system audio purely
  // to run it through the key-detection worker (see ensureKeyDetectionWorker/
  // prepareSamplesForKeyDetection below), then throws the audio away. No
  // AudioBuffer from this ever reaches recordingBufferRef/save()/a waveform —
  // it lives only in listenChunksRef/a local buffer variable inside
  // finishListenCapture, both of which fall out of scope (and get GC'd) the
  // moment detection finishes, so nothing is ever written to disk or shown.
  const [listenStatus, setListenStatus] = useState<'idle' | 'listening' | 'analyzing' | 'done' | 'error'>('idle')
  const [listenResult, setListenResult] = useState<KeyDetectionResponse['result']>(null)
  const [listenError, setListenError] = useState<string | null>(null)
  const listenStreamRef = useRef<MediaStream | null>(null)
  const listenCtxRef = useRef<AudioContext | null>(null)
  const listenSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const listenAnalyserRef = useRef<AnalyserNode | null>(null)
  const listenProcessorRef = useRef<AudioWorkletNode | null>(null)
  const listenChunksRef = useRef<Float32Array[][]>([])
  const listenChannelCountRef = useRef(1)
  const listenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listenWaitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listenSoundPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (listenStatus === 'idle' && !listenResult && !listenError) return
    void listenStatus
    void listenResult
    void listenError
    void listenStreamRef.current
    void listenCtxRef.current
    void listenSourceRef.current
    void listenAnalyserRef.current
    void listenProcessorRef.current
    void listenChunksRef.current
    void listenChannelCountRef.current
    void listenTimeoutRef.current
    void listenWaitTimeoutRef.current
    void listenSoundPollRef.current
  }, [listenStatus, listenResult, listenError])
  // Bumped on every start/cancel so a still-in-flight stream-open, flush, or
  // key-detection promise from a superseded run can recognize it's stale and
  // skip touching state instead of clobbering whatever run came after it.
  const listenRunIdRef = useRef(0)
  // Counts down from -1 so Listen's one-off requests can never collide with
  // a real (positive) track id on the same shared key-detection worker.
  const listenDetectionIdRef = useRef(0)
  // Play view's record button — captures the full screen plus system audio to
  // an MP4 and then auto-loads it into the Video Viewer. See useScreenRecorder.
  const screenRecorder = useScreenRecorder((path) => {
    openVideoViewer(path)
    setVideoIsUnsavedRecording(true)
  })
  const [customizePresets, setCustomizePresets] = useState<CustomizePreset[]>(loadCustomizePresets)
  const [favoritePresetNames, setFavoritePresetNames] = useState<string[]>(loadFavoritePresetNames)
  const [eqPresets, setEqPresets] = useState<EqPreset[]>(loadEqPresets)
  const [developerMode, setDeveloperMode] = useState(false)
  const [developerLayout, setDeveloperLayout] = useState<DeveloperLayoutMap | null>(null)
  const [developerElementLayout, setDeveloperElementLayout] = useState<DeveloperElementMap>({})
  const [selectedDeveloperLayoutId, setSelectedDeveloperLayoutId] = useState<DeveloperLayoutId | null>(null)
  const [selectedDeveloperElementId, setSelectedDeveloperElementId] = useState<DeveloperElementId | null>(null)
  const [developerLayoutStatus, setDeveloperLayoutStatus] = useState('')
  const appRootRef = useRef<HTMLDivElement>(null)
  const developerNodeRefs = useRef<Partial<Record<DeveloperLayoutId, HTMLElement | null>>>({})
  const developerInteractionRef = useRef<DeveloperInteraction | null>(null)
  const developerElementInteractionRef = useRef<DeveloperElementInteraction | null>(null)
  const developerLayoutRef = useRef<DeveloperLayoutMap | null>(null)
  const developerElementLayoutRef = useRef<DeveloperElementMap>({})

  useEffect(() => {
    localStorage.setItem(CUSTOMIZE_PRESETS_STORAGE_KEY, JSON.stringify(customizePresets))
  }, [customizePresets])

  useEffect(() => {
    localStorage.setItem(EQ_PRESETS_STORAGE_KEY, JSON.stringify(eqPresets))
  }, [eqPresets])

  useEffect(() => {
    localStorage.setItem(FAVORITE_PRESETS_STORAGE_KEY, JSON.stringify(favoritePresetNames))
  }, [favoritePresetNames])

  useEffect(() => {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(volume))
  }, [volume])

  useEffect(() => {
    localStorage.setItem(HOME_SECTION_STORAGE_KEY, activeSection)
  }, [activeSection])

  useEffect(() => {
    localStorage.setItem(
      CUSTOMIZE_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        eqGains,
        playbackSpeed,
        pitchSemitones,
        reverseAudioEnabled,
        speedSnapEnabled,
        eqLocked,
        boostVolume,
      }),
    )
  }, [eqGains, playbackSpeed, pitchSemitones, reverseAudioEnabled, speedSnapEnabled, eqLocked, boostVolume])

  useEffect(() => {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ sortBy, sortDir }))
  }, [sortBy, sortDir])

  useEffect(() => {
    localStorage.setItem(
      SECTIONS_SORT_STORAGE_KEY,
      JSON.stringify({ sortBy: sectionsSortBy, sortDir: sectionsSortDir })
    )
  }, [sectionsSortBy, sectionsSortDir])

  useEffect(() => {
    localStorage.setItem(
      PLAYLISTS_SORT_STORAGE_KEY,
      JSON.stringify({ sortBy: playlistsSortBy, sortDir: playlistsSortDir })
    )
  }, [playlistsSortBy, playlistsSortDir])

  useEffect(() => {
    developerLayoutRef.current = developerLayout
  }, [developerLayout])

  useEffect(() => {
    developerElementLayoutRef.current = developerElementLayout
  }, [developerElementLayout])

  useEffect(() => {
    if (!IS_DEVELOPER_BUILD) return
    let cancelled = false
    window.api.getDeveloperLayout().then((layout) => {
      if (!cancelled && layout) {
        setDeveloperLayout(layout as DeveloperLayoutMap)
      }
    })
    window.api.getDeveloperElementLayout().then((layout) => {
      if (!cancelled && layout) {
        setDeveloperElementLayout(layout as DeveloperElementMap)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useLayoutEffect(() => {
    if (!developerMode || developerLayoutRef.current) return
    const root = appRootRef.current
    if (!root) return
    const rootRect = root.getBoundingClientRect()
    if (rootRect.width <= 0 || rootRect.height <= 0) return

    const nextLayout = (Object.keys(DEVELOPER_LAYOUT_LABELS) as DeveloperLayoutId[]).reduce(
      (layout, id) => {
        const node = developerNodeRefs.current[id]
        if (!node) return layout
        layout[id] = rectToLayoutBox(node.getBoundingClientRect(), rootRect)
        return layout
      },
      {} as Partial<DeveloperLayoutMap>,
    )

    if (Object.keys(nextLayout).length !== Object.keys(DEVELOPER_LAYOUT_LABELS).length) return
    setDeveloperLayout(nextLayout as DeveloperLayoutMap)
    window.api.saveDeveloperLayout(nextLayout as DeveloperLayoutMap).catch(() => {})
  }, [developerMode, appView, sidebarOpen, fullScreen])

  useEffect(() => {
    function handleMove(event: PointerEvent) {
      const interaction = developerInteractionRef.current
      if (!interaction) return
      const dx = ((event.clientX - interaction.startX) / interaction.rootRect.width) * 100
      const dy = ((event.clientY - interaction.startY) / interaction.rootRect.height) * 100
      const minWidth = 8
      const minHeight = 8

      setDeveloperLayout((current) => {
        const base = current ?? developerLayoutRef.current
        if (!base) return current
        const nextBox = { ...interaction.startBox }

        if (interaction.mode === 'move') {
          nextBox.left = clamp(
            roundLayoutValue(interaction.startBox.left + dx),
            0,
            roundLayoutValue(100 - interaction.startBox.width),
          )
          nextBox.top = clamp(
            roundLayoutValue(interaction.startBox.top + dy),
            0,
            roundLayoutValue(100 - interaction.startBox.height),
          )
        } else {
          nextBox.width = clamp(
            roundLayoutValue(interaction.startBox.width + dx),
            minWidth,
            roundLayoutValue(100 - interaction.startBox.left),
          )
          nextBox.height = clamp(
            roundLayoutValue(interaction.startBox.height + dy),
            minHeight,
            roundLayoutValue(100 - interaction.startBox.top),
          )
        }

        const nextLayout = { ...base, [interaction.id]: nextBox }
        developerLayoutRef.current = nextLayout
        return nextLayout
      })
    }

    function finishInteraction() {
      const interaction = developerInteractionRef.current
      if (!interaction) return
      developerInteractionRef.current = null
      const layout = developerLayoutRef.current
      if (layout) {
        window.api.saveDeveloperLayout(layout).catch(() => {})
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finishInteraction)
    window.addEventListener('pointercancel', finishInteraction)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finishInteraction)
      window.removeEventListener('pointercancel', finishInteraction)
    }
  }, [])

  useEffect(() => {
    function handleMove(event: PointerEvent) {
      const interaction = developerElementInteractionRef.current
      if (!interaction) return
      const dx = ((event.clientX - interaction.startX) / interaction.rootRect.width) * 100
      const dy = ((event.clientY - interaction.startY) / interaction.rootRect.height) * 100
      const minWidth = 2
      const minHeight = 2

      setDeveloperElementLayout((current) => {
        const base = current ?? developerElementLayoutRef.current
        const nextBox = { ...interaction.startBox }

        if (interaction.mode === 'move') {
          nextBox.left = clamp(
            roundLayoutValue(interaction.startBox.left + dx),
            0,
            roundLayoutValue(100 - interaction.startBox.width),
          )
          nextBox.top = clamp(
            roundLayoutValue(interaction.startBox.top + dy),
            0,
            roundLayoutValue(100 - interaction.startBox.height),
          )
        } else {
          nextBox.width = clamp(
            roundLayoutValue(interaction.startBox.width + dx),
            minWidth,
            roundLayoutValue(100 - interaction.startBox.left),
          )
          nextBox.height = clamp(
            roundLayoutValue(interaction.startBox.height + dy),
            minHeight,
            roundLayoutValue(100 - interaction.startBox.top),
          )
        }

        const nextLayout = { ...base, [interaction.id]: nextBox }
        developerElementLayoutRef.current = nextLayout
        return nextLayout
      })
    }

    function finishInteraction() {
      const interaction = developerElementInteractionRef.current
      if (!interaction) return
      developerElementInteractionRef.current = null
      const layout = developerElementLayoutRef.current
      if (layout) {
        window.api.saveDeveloperElementLayout(layout).catch(() => {})
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finishInteraction)
    window.addEventListener('pointercancel', finishInteraction)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finishInteraction)
      window.removeEventListener('pointercancel', finishInteraction)
    }
  }, [])

  useEffect(() => {
    if (!IS_DEVELOPER_BUILD) return
    return window.api.onDeveloperToggle(() => {
      setDeveloperMode((current) => !current)
    })
  }, [])

  useEffect(() => {
    window.api.isWindowFullscreen().then(setOsFullscreen)
    return window.api.onWindowFullscreenChange(setOsFullscreen)
  }, [])

  // Both viewers' full screen controls go beyond the CSS-only immersive mode
  // used elsewhere in the viewer — they drive the real OS-level (F11-style,
  // taskbar-hidden) fullscreen. This keeps that in step with
  // imageViewerFullscreen/videoViewerFullscreen regardless of how either
  // changes (the toggle button, Return, a keyboard shortcut that switches
  // views, etc.), rather than requiring every one of those call sites to
  // remember to also call the window API.
  useEffect(() => {
    if (imageViewerFullscreen) window.api.enterWindowFullscreen()
    else if (osFullscreen) window.api.exitWindowFullscreen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageViewerFullscreen])

  // Keeps the image viewer's immersive CSS state in step if the OS
  // fullscreen is exited some way other than the above — e.g. F11 or the
  // system fullscreen shortcut.
  useEffect(() => {
    if (!osFullscreen && imageViewerFullscreen) setImageViewerFullscreen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [osFullscreen])

  // Same as the image viewer's pair of effects above, but for the video
  // viewer.
  useEffect(() => {
    if (videoViewerFullscreen) window.api.enterWindowFullscreen()
    else if (osFullscreen) window.api.exitWindowFullscreen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoViewerFullscreen])

  useEffect(() => {
    if (!osFullscreen && videoViewerFullscreen) setVideoViewerFullscreen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [osFullscreen])

  function captureDeveloperLayout() {
    const root = appRootRef.current
    if (!root) return null
    const rootRect = root.getBoundingClientRect()
    if (rootRect.width <= 0 || rootRect.height <= 0) return null

    const nextLayout = (Object.keys(DEVELOPER_LAYOUT_LABELS) as DeveloperLayoutId[]).reduce(
      (layout, id) => {
        const node = developerNodeRefs.current[id]
        if (!node) return layout
        layout[id] = rectToLayoutBox(node.getBoundingClientRect(), rootRect)
        return layout
      },
      {} as Partial<DeveloperLayoutMap>,
    )

    if (Object.keys(nextLayout).length !== Object.keys(DEVELOPER_LAYOUT_LABELS).length) return null
    return nextLayout as DeveloperLayoutMap
  }

  function setDeveloperElementBox(id: DeveloperElementId, box: DeveloperLayoutBox) {
    setDeveloperElementLayout((current) => {
      const nextLayout = { ...(current ?? {}), [id]: box }
      developerElementLayoutRef.current = nextLayout
      return nextLayout
    })
  }

  function beginDeveloperInteraction(
    id: DeveloperLayoutId,
    mode: DeveloperInteractionMode,
    event: React.PointerEvent<HTMLElement>,
  ) {
    if (!developerMode) return
    const root = appRootRef.current
    const node = developerNodeRefs.current[id]
    if (!root || !node) return

    const rootRect = root.getBoundingClientRect()
    const layout = developerLayoutRef.current ?? captureDeveloperLayout()
    const box = layout?.[id] ?? rectToLayoutBox(node.getBoundingClientRect(), rootRect)

    developerInteractionRef.current = {
      id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startBox: box,
      rootRect,
    }
    setSelectedDeveloperLayoutId(id)
    event.stopPropagation()
    event.preventDefault()
  }

  function beginDeveloperElementInteraction(
    id: DeveloperElementId,
    mode: DeveloperInteractionMode,
    event: React.PointerEvent<HTMLElement>,
    box: DeveloperLayoutBox,
    rootRect: DOMRect,
  ) {
    if (!developerMode) return

    developerElementInteractionRef.current = {
      id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startBox: box,
      rootRect,
    }
    setSelectedDeveloperElementId(id)
    event.stopPropagation()
    event.preventDefault()
  }

  function renderDeveloperOverlay(id: DeveloperLayoutId) {
    if (!developerMode) return null
    const selected = selectedDeveloperLayoutId === id
    return (
      <div
        className={`developer-layout-overlay${selected ? ' selected' : ''}`}
        onClick={(event) => {
          event.stopPropagation()
          setSelectedDeveloperLayoutId(id)
        }}
        onPointerDown={(event) => beginDeveloperInteraction(id, 'move', event)}
      >
        <span className="developer-layout-label">{DEVELOPER_LAYOUT_LABELS[id]}</span>
        <button
          type="button"
          className="developer-layout-resize-handle"
          aria-label={`Resize ${DEVELOPER_LAYOUT_LABELS[id]}`}
          onPointerDown={(event) => {
            event.stopPropagation()
            beginDeveloperInteraction(id, 'resize', event)
          }}
        />
      </div>
    )
  }

  function developerLayoutStyle(id: DeveloperLayoutId): CSSProperties | undefined {
    if (!developerMode) return undefined
    const layout = developerLayout
    const box = layout?.[id]
    return layoutBoxToStyle(box, selectedDeveloperLayoutId === id)
  }

  async function saveDeveloperLayout() {
    const layout = captureDeveloperLayout()
    const elementLayout = developerElementLayout
    if (!layout && !elementLayout) return
    if (layout) {
      setDeveloperLayout(layout)
      await window.api.saveDeveloperLayout(layout)
    }
    if (elementLayout) {
      setDeveloperElementLayout(elementLayout)
      await window.api.saveDeveloperElementLayout(elementLayout)
    }
    setDeveloperLayoutStatus('Saved layout JSON.')
  }

  async function exportDeveloperLayoutCss() {
    const layout = captureDeveloperLayout()
    const elementLayout = developerElementLayout
    if (!layout && !elementLayout) return
    const files = await Promise.all([
      layout ? window.api.exportDeveloperLayoutCss(layout) : Promise.resolve(null),
      elementLayout ? window.api.exportDeveloperElementLayoutCss(elementLayout) : Promise.resolve(null),
    ])
    const exported = files.filter((filePath): filePath is string => !!filePath)
    if (exported.length > 0) {
      setDeveloperLayoutStatus(`Exported CSS to ${exported.join(', ')}`)
    }
  }

  async function resetDeveloperLayout() {
    await window.api.resetDeveloperLayout()
    await window.api.resetDeveloperElementLayout()
    setDeveloperLayout(null)
    setDeveloperElementLayout({})
    developerElementLayoutRef.current = {}
    setSelectedDeveloperLayoutId(null)
    setSelectedDeveloperElementId(null)
    setDeveloperLayoutStatus('Reset layout files.')
  }

  useEffect(() => {
    reverseAudioEnabledRef.current = reverseAudioEnabled
  }, [reverseAudioEnabled])

  function ensureAudioContext(): AudioContext {
    if (!audioContextRef.current) {
      const ctx = new AudioContext()
      audioContextRef.current = ctx
      // Kicks off the pitch-shift worklet module's fetch+compile now rather
      // than waiting for the user to actually engage pitch shift, so the
      // first engage of a session doesn't hit a silent gap while it loads.
      warmPitchShiftWorklet(ctx)

      const gainNode = ctx.createGain()
      gainNode.gain.value = volume
      gainNodeRef.current = gainNode

      // Chained graphic-EQ filter bank: routed ahead of the gain node so it
      // shapes both the native <audio> element (via the media source below)
      // and the gapless Web Audio loop buffer source.
      const filters = EQ_BANDS.map(({ freq, type }, i) => {
        const filter = ctx.createBiquadFilter()
        filter.type = type
        filter.frequency.value = freq
        filter.Q.value = 1
        filter.gain.value = eqGainsRef.current[i] ?? 0
        return filter
      })
      // Studio Equalizer's volume-boost node — sits between the filter bank
      // and the master-volume gain node above so boosting a Studio track
      // (which shares this exact stream once aligned) never touches the
      // footer's own 0-1 volume value.
      const boostNode = ctx.createGain()
      boostNode.gain.value = boostVolumeRef.current
      boostGainNodeRef.current = boostNode

      // Studio dB meter's tap — a fan-out off the boost node, not an
      // in-line stop, since nothing reads audio back out of it, only its
      // analysis data. Sits after boost but before the master-volume gain
      // node, so the meter reads true regardless of the footer's volume. A
      // channel splitter feeds two per-channel analysers so the meter can
      // show left/right independently rather than a downmixed average.
      const meterSplitter = ctx.createChannelSplitter(2)
      const analyserL = ctx.createAnalyser()
      analyserL.fftSize = 512
      analyserL.smoothingTimeConstant = 0.6
      const analyserR = ctx.createAnalyser()
      analyserR.fftSize = 512
      analyserR.smoothingTimeConstant = 0.6
      meterAnalyserLRef.current = analyserL
      meterAnalyserRRef.current = analyserR

      for (let i = 0; i < filters.length - 1; i++) {
        filters[i].connect(filters[i + 1])
      }
      filters[filters.length - 1]?.connect(boostNode)
      boostNode.connect(meterSplitter)
      meterSplitter.connect(analyserL, 0)
      meterSplitter.connect(analyserR, 1)
      boostNode.connect(gainNode)
      gainNode.connect(ctx.destination)
      eqFilterNodesRef.current = filters

      // Reroutes the native <audio> element's output through the EQ chain.
      // Can only be created once per element, which is why this whole block
      // is guarded to run a single time for the app's lifetime.
      if (audioRef.current) {
        const mediaSource = ctx.createMediaElementSource(audioRef.current)
        mediaSource.connect(filters[0] ?? boostNode)
        mediaSourceNodeRef.current = mediaSource
        // From this point on, gainNode is the sole volume control for the
        // element's output — reset so any volume applied directly to it
        // beforehand doesn't double up with the gain node's.
        audioRef.current.volume = 1
      }
    }
    return audioContextRef.current
  }

  // Native <audio> playback is routed through the AudioContext graph (see
  // ensureAudioContext), so the context must exist and be running or that
  // audio is silently dropped instead of reaching the speakers.
  function resumeAudioContext() {
    const ctx = ensureAudioContext()
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  }

  // Time-stretches playback by simply changing the playback rate — no pitch
  // correction, so pitch rises/falls with speed. Applies to whichever engine
  // is actually driving sound right now (native <audio>, gapless loop buffer,
  // or reversed buffer all share the one AudioBufferSourceNode ref), and
  // caches the rate so the next handoff (track change, loop toggle, reverse
  // toggle) picks it up too.
  function applyPlaybackSpeed(rate: number) {
    setPlaybackSpeed(rate)
    playbackSpeedRef.current = rate
    if (audioRef.current) audioRef.current.playbackRate = rate

    if (pitchShifterRef.current) {
      // The pitch-shift engine tracks its own position directly from
      // samples consumed, so unlike the raw AudioBufferSourceNode engines
      // below there's no rebase math needed — just retune it live.
      pitchShifterRef.current.tempo = rate
      return
    }

    const source = sourceNodeRef.current
    const ctx = audioContextRef.current
    if (source && ctx && webAudioActiveRef.current) {
      // The tick loops track buffer position as offset + elapsed*rate since
      // the last rebase point — rebase now, before changing the rate, or the
      // portion already played at the old rate gets recomputed at the new
      // one and the scrub position jumps.
      const elapsed = (ctx.currentTime - webAudioStartCtxTimeRef.current) * source.playbackRate.value
      webAudioStartOffsetRef.current += elapsed
      webAudioStartCtxTimeRef.current = ctx.currentTime
      source.playbackRate.value = rate
    } else if (source) {
      source.playbackRate.value = rate
    }
  }

  function setEqBandGain(index: number, value: number) {
    eqGainsRef.current = eqGainsRef.current.map((g, i) => (i === index ? value : g))
    setEqGains(eqGainsRef.current)
    const filter = eqFilterNodesRef.current[index]
    if (filter) filter.gain.value = value
  }

  function resetEq() {
    eqGainsRef.current = EQ_BANDS.map(() => 0)
    setEqGains(eqGainsRef.current)
    eqFilterNodesRef.current.forEach((filter) => {
      filter.gain.value = 0
    })
  }

  // Studio Equalizer tool's boost slider, for the aligned "track" slot —
  // see boostGainNodeRef above.
  function setBoostVolume(next: number) {
    boostVolumeRef.current = next
    setBoostVolumeState(next)
    if (boostGainNodeRef.current) boostGainNodeRef.current.gain.value = next
  }

  function saveCustomizePreset(name: string) {
    if (name.toLowerCase() === DEFAULT_CUSTOMIZE_PRESET.name.toLowerCase()) return
    const preset: CustomizePreset = {
      name,
      eqGains: [...eqGainsRef.current],
      playbackSpeed,
      pitchSemitones,
      reverseAudioEnabled,
    }
    setCustomizePresets((prev) => [...prev.filter((p) => p.name !== name), preset])
  }

  function applyCustomizePreset(preset: CustomizePreset) {
    eqGainsRef.current = EQ_BANDS.map((_, i) => preset.eqGains[i] ?? 0)
    setEqGains(eqGainsRef.current)
    eqFilterNodesRef.current.forEach((filter, i) => {
      filter.gain.value = eqGainsRef.current[i] ?? 0
    })
    applyPlaybackSpeed(preset.playbackSpeed)
    setPitchSemitones(preset.pitchSemitones)
    applyReverseAudioState(preset.reverseAudioEnabled)
  }

  function deleteCustomizePreset(name: string) {
    setCustomizePresets((prev) => prev.filter((p) => p.name !== name))
    setFavoritePresetNames((prev) => prev.filter((n) => n !== name))
  }

  function toggleFavoritePreset(name: string) {
    setFavoritePresetNames((prev) => {
      if (prev.includes(name)) return prev.filter((n) => n !== name)
      if (prev.length >= MAX_FAVORITE_PRESETS) return prev
      return [...prev, name]
    })
  }

  const allCustomizePresets = useMemo(
    () => [DEFAULT_CUSTOMIZE_PRESET, ...customizePresets],
    [customizePresets],
  )
  const favoriteCustomizePresets = useMemo(
    () =>
      favoritePresetNames
        .map((name) => allCustomizePresets.find((p) => p.name === name))
        .filter((p): p is CustomizePreset => !!p),
    [favoritePresetNames, allCustomizePresets],
  )

  function saveEqPreset(name: string) {
    if (isStockEqPresetName(name)) return
    const preset: EqPreset = { name, eqGains: [...eqGainsRef.current] }
    setEqPresets((prev) => [...prev.filter((p) => p.name !== name), preset])
  }

  function applyEqPreset(preset: EqPreset) {
    eqGainsRef.current = EQ_BANDS.map((_, i) => preset.eqGains[i] ?? 0)
    setEqGains(eqGainsRef.current)
    eqFilterNodesRef.current.forEach((filter, i) => {
      filter.gain.value = eqGainsRef.current[i] ?? 0
    })
  }

  function deleteEqPreset(name: string) {
    setEqPresets((prev) => prev.filter((p) => p.name !== name))
  }

  const allEqPresets = useMemo(() => [...STOCK_EQ_PRESETS, ...eqPresets], [eqPresets])

  // Stops whichever Web Audio engine (gapless loop, reverse, or pitch-shift)
  // is active, if any, and returns the track-time offset it was at, so
  // playback can hand off to whichever engine comes next seamlessly.
  function stopWebAudio(): number {
    if (pitchShifterRef.current) {
      const shifter = pitchShifterRef.current
      const offset = shifter.timePlayed
      shifter.off()
      shifter.disconnect()
      pitchShifterRef.current = null
      webAudioActiveRef.current = false
      reversePlaybackActiveRef.current = false
      return offset
    }

    const ctx = audioContextRef.current
    const offset = webAudioActiveRef.current
      ? webAudioStartOffsetRef.current + ((ctx?.currentTime ?? 0) - webAudioStartCtxTimeRef.current)
      : (audioRef.current?.currentTime ?? 0)

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop()
      } catch {
        // already stopped
      }
      sourceNodeRef.current.disconnect()
      sourceNodeRef.current = null
    }
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    webAudioActiveRef.current = false
    reversePlaybackActiveRef.current = false
    return offset
  }

  // Builds a new AudioBuffer whose channel data is the reverse of the
  // source buffer's. Native <audio> has no way to play a MediaElement
  // backwards, so reversed playback goes entirely through Web Audio buffer
  // source nodes, same as the gapless single-song loop.
  function reverseAudioBuffer(ctx: AudioContext, buffer: AudioBuffer): AudioBuffer {
    const reversed = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const source = buffer.getChannelData(ch)
      const dest = reversed.getChannelData(ch)
      for (let i = 0; i < source.length; i++) {
        dest[i] = source[source.length - 1 - i]
      }
    }
    return reversed
  }

  // Hands playback over to an AudioBufferSourceNode playing the track's
  // reversed PCM data, mirroring startWebAudioLoop's decode/handoff pattern.
  // offsetSeconds is measured from the start of the reversed buffer — i.e.
  // 0 is the acoustic end of the track. Returns whether the handoff
  // succeeded, so callers can fall back to forward playback if it didn't
  // (unsupported codec, or the track exceeds the gapless decode size cap).
  async function startReversePlayback(offsetSeconds: number): Promise<boolean> {
    if (!trackBufferRef.current) return false
    if (trackBufferRef.current.byteLength > MAX_GAPLESS_DECODE_BYTES) return false

    const ctx = ensureAudioContext()
    if (ctx.state === 'suspended') await ctx.resume()

    if (!decodedBufferRef.current) {
      try {
        decodedBufferRef.current = await ctx.decodeAudioData(trackBufferRef.current.slice(0))
      } catch {
        return false // decode failed (unsupported codec)
      }
    }
    // Falls back to decodedBufferRef when no manual trim is active — see
    // trimmedBufferRef's own comment.
    const forwardBuffer = trimmedBufferRef.current ?? decodedBufferRef.current
    if (!forwardBuffer || !Number.isFinite(forwardBuffer.duration) || forwardBuffer.duration <= 0) {
      return false
    }

    if (!reversedBufferRef.current) {
      reversedBufferRef.current = reverseAudioBuffer(ctx, forwardBuffer)
    }
    const buffer = reversedBufferRef.current

    try {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      // A manual trim always loops its selection (see applyManualTrimAligned),
      // regardless of the app's own loop mode.
      source.loop = loopModeRef.current === 'song' || trimmedBufferRef.current !== null
      source.loopStart = 0
      source.loopEnd = buffer.duration
      source.playbackRate.value = playbackSpeedRef.current
      source.connect(eqFilterNodesRef.current[0] ?? gainNodeRef.current!)
      source.onended = () => {
        if (sourceNodeRef.current !== source) return
        // Only a natural end-of-buffer reaches this for non-looping reverse
        // playback — stopWebAudio() (used for scrubbing/toggling/track
        // changes) already clears these flags synchronously before this
        // async event can fire, so it can't double-fire goNext here.
        if (webAudioActiveRef.current && reversePlaybackActiveRef.current) {
          stopWebAudio()
          setIsPlaying(false)
          goNext()
        }
      }
      source.start(0, offsetSeconds % buffer.duration)

      // Only take over from native <audio> once the Web Audio source is
      // confirmed to have started, so a failed handoff never leaves silence.
      audioRef.current?.pause()

      sourceNodeRef.current = source
      webAudioStartCtxTimeRef.current = ctx.currentTime
      webAudioStartOffsetRef.current = offsetSeconds
      webAudioActiveRef.current = true
      reversePlaybackActiveRef.current = true
      setIsPlaying(true)

      const tick = () => {
        if (!webAudioActiveRef.current || !reversePlaybackActiveRef.current || !audioContextRef.current) return
        const elapsed =
          (audioContextRef.current.currentTime - webAudioStartCtxTimeRef.current) * source.playbackRate.value
        setCurrentTime((webAudioStartOffsetRef.current + elapsed) % buffer.duration)
        rafIdRef.current = requestAnimationFrame(tick)
      }
      tick()
      return true
    } catch {
      return false
    }
  }

  // Hands playback over to a SoundTouch PitchShifter "pseudo-node" — a
  // WSOLA time-stretcher that can move pitch independently of tempo, unlike
  // the raw AudioBufferSourceNode engines above (loop/reverse), which only
  // offer combined varispeed via playbackRate. Mirrors their decode/handoff
  // pattern; reversed feeds it the same reversed PCM the raw reverse engine
  // uses, so reverse and pitch shift can combine. offsetSeconds is in
  // whichever buffer's own terms (reversed measures from the acoustic end,
  // same convention startReversePlayback/seekTo already use). Returns
  // whether the handoff succeeded, so callers can fall back otherwise.
  async function startPitchShiftPlayback(offsetSeconds: number, reversed: boolean): Promise<boolean> {
    if (!trackBufferRef.current) return false
    if (trackBufferRef.current.byteLength > MAX_GAPLESS_DECODE_BYTES) return false

    const ctx = ensureAudioContext()
    if (ctx.state === 'suspended') await ctx.resume()

    if (!decodedBufferRef.current) {
      try {
        decodedBufferRef.current = await ctx.decodeAudioData(trackBufferRef.current.slice(0))
      } catch {
        return false // decode failed (unsupported codec)
      }
    }
    const forwardBuffer = trimmedBufferRef.current ?? decodedBufferRef.current
    if (!forwardBuffer || !Number.isFinite(forwardBuffer.duration) || forwardBuffer.duration <= 0) {
      return false
    }

    let buffer = forwardBuffer
    if (reversed) {
      if (!reversedBufferRef.current) {
        reversedBufferRef.current = reverseAudioBuffer(ctx, forwardBuffer)
      }
      buffer = reversedBufferRef.current
    }

    try {
      const shifter = new PitchShifter(ctx, buffer, PITCH_SHIFT_BUFFER_SIZE, () => {
        // Only a natural end-of-buffer reaches this repeatedly once the
        // source runs dry — stopWebAudio() (used for scrubbing/toggling/
        // track changes) tears the shifter down synchronously before a
        // stale callback can double-fire goNext, and looping resets the
        // source position instead of ending, so this only actually acts
        // once per real end.
        if (pitchShifterRef.current !== shifter) return
        // A manual trim always loops its selection (see
        // applyManualTrimAligned), regardless of the app's own loop mode.
        if (loopModeRef.current === 'song' || trimmedBufferRef.current) {
          shifter.percentagePlayed = 0
          return
        }
        stopWebAudio()
        setIsPlaying(false)
        goNext()
      })
      shifter.tempo = playbackSpeedRef.current
      shifter.pitchSemitones = pitchSemitonesRef.current
      shifter.percentagePlayed = buffer.duration > 0 ? offsetSeconds / buffer.duration : 0
      shifter.on('play', (detail) => setCurrentTime(detail.timePlayed))
      shifter.connect(eqFilterNodesRef.current[0] ?? gainNodeRef.current!)

      // Only take over from native <audio> once the shifter is wired up, so
      // a failed handoff never leaves silence.
      audioRef.current?.pause()

      pitchShifterRef.current = shifter
      webAudioActiveRef.current = true
      reversePlaybackActiveRef.current = false
      setIsPlaying(true)
      return true
    } catch {
      return false
    }
  }

  // Single entry point for turning reversed playback on/off, used by both
  // the Reverse Audio button and applying a Customize preset, so the two
  // can't drift into a "toggle says on but audio plays forward" state.
  function applyReverseAudioState(next: boolean) {
    const changed = next !== reverseAudioEnabled
    setReverseAudioEnabled(next)
    if (!changed || !currentTrack) return

    stopWebAudio()
    setCurrentTime(0)

    const fallbackForward = () => {
      const audio = audioRef.current
      if (audio) {
        audio.currentTime = 0
        resumeAudioContext()
        audio.play().catch((err) => console.error('Failed to resume playback:', err))
        setIsPlaying(true)
      }
    }

    if (pitchSemitonesRef.current !== 0) {
      // Pitch is already active — keep it active, just fed the buffer that
      // matches the new reverse state, instead of dropping down to the raw
      // reverse/loop engines.
      startPitchShiftPlayback(0, next).then((ok) => {
        if (ok) return
        if (next) {
          setReverseAudioEnabled(false)
          fallbackForward()
        } else if (loopModeRef.current === 'song' && trackBufferRef.current) {
          startWebAudioLoop(0)
        } else {
          fallbackForward()
        }
      })
      return
    }

    if (next) {
      // Restart from the beginning of the song — the end of the track,
      // once reversed.
      audioRef.current?.pause()
      startReversePlayback(0).then((ok) => {
        if (!ok && trackBufferRef.current) {
          // Track can't be reversed (too large to decode, or an
          // unsupported codec) — fall back to forward playback instead of
          // leaving it stuck paused with the toggle showing "on".
          setReverseAudioEnabled(false)
          fallbackForward()
        }
      })
    } else if (loopModeRef.current === 'song' && trackBufferRef.current) {
      startWebAudioLoop(0)
    } else {
      fallbackForward()
    }
  }

  // Hands playback of the current track over to a looping AudioBufferSourceNode,
  // which loops on already-decoded PCM with no decoder reset, unlike <audio loop>.
  // Native <audio loop> is left running throughout, so any failure here just
  // means we silently keep using it instead of the gapless loop.
  async function startWebAudioLoop(offsetSeconds: number) {
    if (!trackBufferRef.current) return
    if (trackBufferRef.current.byteLength > MAX_GAPLESS_DECODE_BYTES) return

    const ctx = ensureAudioContext()
    if (ctx.state === 'suspended') await ctx.resume()

    if (!decodedBufferRef.current) {
      try {
        decodedBufferRef.current = await ctx.decodeAudioData(trackBufferRef.current.slice(0))
      } catch {
        return // decode failed (unsupported codec); fall back to native <audio loop>
      }
    }
    const buffer = trimmedBufferRef.current ?? decodedBufferRef.current
    if (
      // A manual trim always plays through this looping engine (see
      // applyManualTrimAligned), regardless of the app's own loop mode.
      (loopModeRef.current !== 'song' && !trimmedBufferRef.current) ||
      !buffer ||
      !Number.isFinite(buffer.duration) ||
      buffer.duration <= 0
    ) {
      return
    }

    try {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.loopStart = 0
      source.loopEnd = buffer.duration
      source.playbackRate.value = playbackSpeedRef.current
      source.connect(eqFilterNodesRef.current[0] ?? gainNodeRef.current!)
      source.start(0, offsetSeconds % buffer.duration)

      // Only take over from native <audio> once the Web Audio source is
      // confirmed to have started, so a failed handoff never leaves silence.
      audioRef.current?.pause()

      sourceNodeRef.current = source
      webAudioStartCtxTimeRef.current = ctx.currentTime
      webAudioStartOffsetRef.current = offsetSeconds
      webAudioActiveRef.current = true
      setIsPlaying(true)

      const tick = () => {
        if (!webAudioActiveRef.current || !audioContextRef.current) return
        const elapsed =
          (audioContextRef.current.currentTime - webAudioStartCtxTimeRef.current) * source.playbackRate.value
        setCurrentTime((webAudioStartOffsetRef.current + elapsed) % buffer.duration)
        rafIdRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      // Web Audio handoff failed; native <audio loop> is still playing uninterrupted.
    }
  }

  // Snapshots the currently decoded (untouched) buffer as the fixed source
  // applyManualTrimAligned re-slices from — mirrors useFilePlayback's own
  // beginManualTrim, but for Studio's aligned "track" slot (the currently
  // playing track), which has no buffer of its own until one is decoded
  // here. decodedBufferRef is never overwritten by trim/reverse/pitch (they
  // all write elsewhere — trimmedBufferRef/reversedBufferRef), so it's
  // always the real original, meaning this always starts a fresh trim
  // session from the full track even if a previous one already cut it down.
  // Also resets the waveform display back to null (so it falls back to the
  // real file's own full-length peaks/duration while editing — see
  // StudioWaveform's peaksOverride/durationOverride) and clears the dirty
  // flag confirmManualTrimAligned checks. Same MAX_GAPLESS_DECODE_BYTES gate
  // as reverse/pitch/loop above: a track too large to decode leaves
  // manualTrimBaseRef unset, so applyManualTrimAligned silently no-ops
  // rather than trimming nothing audible.
  async function beginManualTrimAligned() {
    alignedManualTrimDirtyRef.current = false
    setAlignedTrimmedPeaks(null)
    setAlignedTrimmedDuration(null)
    if (!trackBufferRef.current || trackBufferRef.current.byteLength > MAX_GAPLESS_DECODE_BYTES) return
    const ctx = ensureAudioContext()
    if (!decodedBufferRef.current) {
      try {
        decodedBufferRef.current = await ctx.decodeAudioData(trackBufferRef.current.slice(0))
      } catch {
        return // decode failed (unsupported codec)
      }
    }
    manualTrimBaseRef.current = decodedBufferRef.current
  }

  // Cuts manualTrimBaseRef down to [startRatio, endRatio] and bakes in any
  // active fades, then immediately restarts whichever engine is driving Now
  // Playing so the edit is audible live, instead of the edit only ever
  // reaching a disconnected Studio preview copy (the bug this fixes).
  // Reuses startReversePlayback/startPitchShiftPlayback/startWebAudioLoop —
  // all three resolve their forward source through trimmedBufferRef (falling
  // back to decodedBufferRef, see its own comment), so a trim composes with
  // whichever of reverse/pitch is already active, and all three now always
  // loop while a manual trim is active regardless of the app's own loop
  // mode. Always (re)starts playback at the top of the new selection rather
  // than preserving a paused state — none of those three engines support
  // starting paused, and an immediate audible loop of the edited selection is
  // exactly what opening Trim Audio on the currently playing track is for.
  // Safe to call repeatedly (once per handle drag release, or immediately on
  // a Fade In/Out toggle click) since it always re-slices manualTrimBaseRef
  // rather than its own last result. Deliberately leaves
  // alignedTrimmedPeaks/alignedTrimmedDuration alone — those only drive the
  // Studio waveform's own size/duration display, which should stay fixed on
  // the original clip until confirmManualTrimAligned runs on "Done" (the
  // footer transport below reads trimmedBufferRef directly instead, so it
  // stays live in sync with what's actually audible even before "Done").
  function applyManualTrimAligned(startRatio: number, endRatio: number, fadeIn: FadeSetting, fadeOut: FadeSetting) {
    const base = manualTrimBaseRef.current
    if (!base) return
    const trimmed = sliceAndFadeBuffer(base, startRatio, endRatio, fadeIn, fadeOut)
    trimmedBufferRef.current = trimmed
    // Invalidated — a reverse toggle (or the reverse branch below) rebuilds
    // it from the newly trimmed forward buffer instead of reusing a stale
    // pre-trim one.
    reversedBufferRef.current = null
    alignedManualTrimDirtyRef.current = true

    stopWebAudio()
    audioRef.current?.pause()
    setCurrentTime(0)

    if (pitchSemitonesRef.current !== 0) {
      startPitchShiftPlayback(0, reverseAudioEnabledRef.current)
    } else if (reverseAudioEnabledRef.current) {
      startReversePlayback(0)
    } else {
      startWebAudioLoop(0)
    }
  }

  // Bakes the in-progress trim/fade edit (if any were actually made since
  // beginManualTrimAligned) into the Studio waveform's own display — called
  // once when the user clicks "Done". Reads whatever applyManualTrimAligned
  // last hot-swapped into trimmedBufferRef rather than re-slicing, so the
  // display always matches exactly what's audible.
  function confirmManualTrimAligned() {
    if (!alignedManualTrimDirtyRef.current) return
    alignedManualTrimDirtyRef.current = false
    const trimmed = trimmedBufferRef.current
    if (!trimmed) return
    setAlignedTrimmedPeaks(computePeaksFromBuffer(trimmed))
    setAlignedTrimmedDuration(trimmed.duration)
  }

  // The aligned case (studioIsAligned) renders the currently loaded track
  // through the same processing the user hears in Studio — EQ, playback
  // speed, pitch shift, and reverse — on an OfflineAudioContext so it
  // doesn't touch (or get interrupted by) whatever's currently playing.
  //
  // A file dropped straight into Studio, on the other hand, never runs
  // through that engine at all — see useFilePlayback above, it's plain
  // <audio> playback with no EQ/speed/reverse applied — so exporting it is a
  // straight format conversion of the original file's own bytes, not a
  // re-render.
  // Renders one AudioBuffer through a fresh EQ filter bank + boost gain (and,
  // if engaged, pitch shift) on an OfflineAudioContext — the offline-render
  // half shared by both export branches below (the aligned track's own
  // decoded buffer, or a dropped-in file's prepareExportSource) so their
  // baked-in processing stays identical to what's actually heard live.
  async function renderEqBoostOffline(
    sourceBuffer: AudioBuffer,
    rate: number,
    eqGains: number[],
    boost: number,
    pitchSemitones = 0
  ): Promise<AudioBuffer> {
    // Pitch shift and playback rate move independently — rate/duration
    // alone still determines the output length either way.
    const outLength = Math.max(1, Math.ceil((sourceBuffer.duration / rate) * sourceBuffer.sampleRate))
    // renderPitchShiftOffline's spectral engine has its own processing
    // latency, so rendering to exactly outLength risks clipping the last
    // moment of audio — pad generously, then trim the padding back off
    // below once rendering finishes.
    const latencyPadding = pitchSemitones !== 0 ? Math.ceil(sourceBuffer.sampleRate * 0.5) : 0
    const offlineCtx = new OfflineAudioContext(
      sourceBuffer.numberOfChannels,
      outLength + latencyPadding,
      sourceBuffer.sampleRate
    )

    const filters = EQ_BANDS.map(({ freq, type }, i) => {
      const filter = offlineCtx.createBiquadFilter()
      filter.type = type
      filter.frequency.value = freq
      filter.Q.value = 1
      filter.gain.value = eqGains[i] ?? 0
      return filter
    })
    for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1])
    const boostNode = offlineCtx.createGain()
    boostNode.gain.value = boost
    filters[filters.length - 1]?.connect(boostNode)
    boostNode.connect(offlineCtx.destination)

    if (pitchSemitones !== 0) {
      // Same SignalsmithStretch engine Now Playing's own Pitch Shift
      // control uses live (see PitchShifterWorklet) — a plain
      // AudioBufferSourceNode's playbackRate (the rate-only path below)
      // can't move pitch independently of speed.
      await renderPitchShiftOffline(offlineCtx, sourceBuffer, rate, pitchSemitones, filters[0] ?? boostNode)
    } else {
      const source = offlineCtx.createBufferSource()
      source.buffer = sourceBuffer
      source.playbackRate.value = rate
      source.connect(filters[0] ?? boostNode)
      source.start()
    }

    const rendered = await offlineCtx.startRendering()
    if (rendered.length <= outLength) return rendered
    // Trim the latency-compensation padding back off so the exported
    // duration matches what Now Playing/the waveform actually show.
    const trimmed = new AudioBuffer({
      numberOfChannels: rendered.numberOfChannels,
      length: outLength,
      sampleRate: rendered.sampleRate,
    })
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      trimmed.copyToChannel(rendered.getChannelData(ch).subarray(0, outLength), ch)
    }
    return trimmed
  }

  // Renders whatever's actually Now Playing — EQ/boost, playback speed,
  // reverse, and any manual trim (see trimmedBufferRef) — to a file. Reads
  // directly off currentTrack and the main engine's own refs rather than
  // studioDisplayTrack/studioIsAligned, so it works regardless of whether
  // the track has also been explicitly imported into Studio's own waveform
  // view — the corner "Save" button (rendered whenever a track is Now
  // Playing at all, see the view-corner-actions block below) shouldn't
  // silently no-op just because the user hasn't clicked "+" in Studio.
  // exportStudioAudio's own aligned branch delegates here too, since
  // studioDisplayTrack IS currentTrack in that case anyway.
  async function exportCurrentTrackAudio(format: AudioExportFormat = 'wav'): Promise<string | null> {
    if (!currentTrack || exportingStudioAudio) return null
    const track = currentTrack
    if (studioExportErrorTimeoutRef.current) clearTimeout(studioExportErrorTimeoutRef.current)
    setStudioExportError(null)
    setExportingStudioAudio(true)
    try {
      if (!trackBufferRef.current) throw new Error('No audio loaded to export')
      const ctx = ensureAudioContext()
      if (!decodedBufferRef.current) {
        try {
          decodedBufferRef.current = await ctx.decodeAudioData(trackBufferRef.current.slice(0))
        } catch {
          throw new Error('Failed to decode track for export')
        }
      }
      const forwardBuffer = trimmedBufferRef.current ?? decodedBufferRef.current
      if (!forwardBuffer) throw new Error('No decoded audio to export')

      let sourceBuffer = forwardBuffer
      if (reverseAudioEnabled) {
        if (!reversedBufferRef.current) {
          reversedBufferRef.current = reverseAudioBuffer(ctx, forwardBuffer)
        }
        sourceBuffer = reversedBufferRef.current
      }

      const rendered = await renderEqBoostOffline(
        sourceBuffer,
        playbackSpeedRef.current || 1,
        eqGainsRef.current,
        boostVolumeRef.current,
        pitchSemitonesRef.current
      )
      const sourceBytes = audioBufferToWav(rendered)
      const baseName = sanitizeFileName(
        track.artist ? `${track.artist} - ${track.title}` : track.title ?? ''
      )
      const savedPath = await window.api.saveAudioFile(
        `${baseName || 'track'}.${format}`,
        sourceBytes,
        format,
        'wav'
      )
      return savedPath // null if the user canceled the save dialog — not a failure
    } catch (err) {
      console.error('Failed to export current track audio:', err)
      setStudioExportError(format)
      studioExportErrorTimeoutRef.current = setTimeout(() => setStudioExportError(null), 4000)
      return null
    } finally {
      setExportingStudioAudio(false)
    }
  }

  async function exportStudioAudio(format: AudioExportFormat = 'wav'): Promise<string | null> {
    if (!studioDisplayTrack || exportingStudioAudio) return null
    if (studioIsAligned) return exportCurrentTrackAudio(format)
    const track = studioDisplayTrack
    if (studioExportErrorTimeoutRef.current) clearTimeout(studioExportErrorTimeoutRef.current)
    setStudioExportError(null)
    setExportingStudioAudio(true)
    try {
      let sourceBytes: ArrayBuffer
      let sourceExt: string

      // A dropped-in file with nothing actually changed exports the
      // original bytes untouched (preserves its original quality/format
      // rather than a lossy decode-and-WAV-render round trip) — the same
      // offline EQ/boost render as exportCurrentTrackAudio only kicks in
      // once there's something to bake in.
      const hasProcessing =
        studioIndependentPlayback.reversed ||
        studioIndependentPlayback.silenceRemoved ||
        // Checked instead of trimmedDuration so a trim/fade still in
        // progress (handles dragged but "Done" not yet clicked) is baked
        // into the save too — trimmedDuration only reflects a confirmed
        // edit, since it also drives the waveform's own display.
        studioIndependentPlayback.manualTrimApplied ||
        studioIndependentPlayback.eqGains.some((g) => g !== 0) ||
        studioIndependentPlayback.boostVolume !== 1 ||
        studioIndependentPlayback.playbackRate !== 1 ||
        studioIndependentPlayback.pitchSemitones !== 0

      if (hasProcessing) {
        const sourceBuffer = await studioIndependentPlayback.prepareExportSource()
        if (!sourceBuffer) throw new Error('No audio loaded to export')
        const rendered = await renderEqBoostOffline(
          sourceBuffer,
          studioIndependentPlayback.playbackRate || 1,
          studioIndependentPlayback.eqGains,
          studioIndependentPlayback.boostVolume,
          studioIndependentPlayback.pitchSemitones
        )
        sourceBytes = audioBufferToWav(rendered)
        sourceExt = 'wav'
      } else {
        const res = await fetch(platform.getMediaUrl(track.filePath))
        if (!res.ok) throw new Error(`Failed to read file (${res.status})`)
        sourceBytes = await res.arrayBuffer()
        const extMatch = /\.([a-z0-9]+)$/i.exec(track.filePath)
        sourceExt = extMatch ? extMatch[1].toLowerCase() : 'wav'
      }

      const baseName = sanitizeFileName(
        track.artist ? `${track.artist} - ${track.title}` : track.title ?? ''
      )
      const savedPath = await window.api.saveAudioFile(
        `${baseName || 'track'}.${format}`,
        sourceBytes,
        format,
        sourceExt
      )
      return savedPath // null if the user canceled the save dialog — not a failure
    } catch (err) {
      console.error('Failed to export studio audio:', err)
      setStudioExportError(format)
      studioExportErrorTimeoutRef.current = setTimeout(() => setStudioExportError(null), 4000)
      return null
    } finally {
      setExportingStudioAudio(false)
    }
  }

  // Wraps any of Studio's three save actions (the primary track, an
  // internal recording, a mic recording) so a successful save — the file
  // actually landed on disk, not canceled/failed — offers to add it to the
  // song library. format is threaded through rather than defaulted so this
  // stays a drop-in wrapper for StudioSaveMenu's own onSave signature.
  async function saveAndOfferLibraryAdd(
    saveFn: (format?: AudioExportFormat) => Promise<string | null>,
    format: AudioExportFormat
  ) {
    const savedPath = await saveFn(format)
    if (savedPath && studioIsAligned && studioRestoreSnapshotRef.current) {
      restoreStudioRestoreState()
    }
    if (savedPath) setPendingLibraryAddPath(savedPath)
  }

  function dismissAddToLibrary() {
    setPendingLibraryAddPath(null)
  }

  // Registers the just-saved file as a track (same upsert playDroppedFile
  // already uses for a Studio drop) and, since a location outside a scanned
  // library folder otherwise defaults to excluded, explicitly flips it into
  // the library — mirrors toggleTrackInclude's own setTrackInLibrary call.
  async function confirmAddToLibrary() {
    const path = pendingLibraryAddPath
    if (!path) return
    setAddingToLibrary(true)
    try {
      const result = await window.api.playDroppedFile(path)
      if (!result?.track) return
      if (!result.track.inLibrary) {
        await platform.setTrackInLibrary(result.track.id, true)
      }
      if (result.inserted) {
        enqueueKeyDetection([{ id: result.track.id, filePath: result.track.filePath }])
      }
      platform.getTracks().then(setTracks)
    } catch (err) {
      console.error('Failed to add saved file to the library:', err)
    } finally {
      setAddingToLibrary(false)
      setPendingLibraryAddPath(null)
    }
  }

  useEffect(() => {
    const requestId = ++tracksRequestIdRef.current
    // On Android the library is the device's own music (MediaStore), refreshed
    // on every launch; there's no "add a folder" step. syncLibrary prompts for
    // the audio permission on first run and returns the same Track[] as getTracks.
    const initialTracks = import.meta.env.VOLURE_MOBILE
      ? platform.syncLibrary()
      : platform.getTracks()
    initialTracks.then((result) => {
      if (tracksRequestIdRef.current === requestId) setTracks(result)
    })
    platform.getFolders().then(setFolders)
    platform.listPlaylists().then(setPlaylists)
    // Restore the last-played track into Now Playing, paused, so launching
    // the app picks up where the user left off instead of starting empty.
    platform.getRecentlyPlayed().then((result) => {
      setRecentTracks(result)
      const lastPlayed = result[0]
      if (lastPlayed) {
        isRestoringTrackRef.current = true
        setCurrentTrackId(lastPlayed.id)
      }
    })
  }, [])

  useEffect(() => {
    const handle = setTimeout(() => {
      const requestId = ++tracksRequestIdRef.current
      const request =
        query.trim() === '' ? platform.getTracks() : platform.searchTracks(query)
      request.then((result) => {
        if (tracksRequestIdRef.current === requestId) setTracks(result)
      })
    }, 150)
    return () => clearTimeout(handle)
  }, [query])

  useEffect(() => {
    activeSectionRef.current = activeSection
    if (activeSection === 'recent') {
      platform.getRecentlyPlayed().then(setRecentTracks)
      setSelectedIds(new Set())
    }
    if (activeSection !== 'sections') {
      setViewingFolder(null)
    }
    if (activeSection !== 'playlists') {
      setViewingPlaylist(null)
    }
    if (activeSection !== 'advanced') {
      setAdvancedFolder(null)
      setBassIntervalFilter(null)
    }
    if (activeSection === 'advanced') {
      window.api.getAdvancedTracks().then(setAdvancedTracks)
    }
  }, [activeSection])

  useEffect(() => {
    if (advancedFolder) {
      platform.getTracksInFolder(advancedFolder.path).then(setAdvancedFolderTracks)
    } else {
      setAdvancedFolderTracks([])
    }
  }, [advancedFolder])

  // Bass intervals are stored in their own table, so whichever track list is
  // currently visible in the Advanced tab needs a follow-up fetch to attach
  // them.
  const advancedTrackIdsKey = useMemo(
    () =>
      Array.from(new Set([...advancedTracks.map((t) => t.id), ...advancedFolderTracks.map((t) => t.id)]))
        .sort((a, b) => a - b)
        .join(','),
    [advancedTracks, advancedFolderTracks]
  )

  useEffect(() => {
    if (!advancedTrackIdsKey) {
      setBassIntervalsByTrack({})
      return
    }
    window.api.getBassIntervals(advancedTrackIdsKey.split(',').map(Number)).then(setBassIntervalsByTrack)
  }, [advancedTrackIdsKey])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [viewingFolder, viewingPlaylist])

  useEffect(() => {
    if (!trackContextMenu) return
    function handleClickOutside(e: MouseEvent) {
      if (!trackContextMenuRef.current?.contains(e.target as Node)) setTrackContextMenu(null)
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setTrackContextMenu(null)
    }
    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [trackContextMenu])

  useEffect(() => {
    if (!nowPlayingArtMenu) return
    function handleClickOutside(e: MouseEvent) {
      if (!nowPlayingArtMenuRef.current?.contains(e.target as Node)) setNowPlayingArtMenu(null)
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setNowPlayingArtMenu(null)
    }
    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [nowPlayingArtMenu])

  useEffect(() => {
    if (!viewingPlaylist) {
      setPlaylistTracks([])
      return
    }
    platform.getPlaylistTracks(viewingPlaylist.id).then(setPlaylistTracks)
  }, [viewingPlaylist])

  useEffect(() => {
    setPlaylistPickerFolder(null)
    setPlaylistAddMode(false)
  }, [viewingPlaylist])

  useEffect(() => {
    if (!playlistPickerFolder) {
      setPlaylistPickerFolderTracks([])
      return
    }
    // Picking songs for a playlist has to reach isolated folders too, so it
    // fetches directly instead of going through the (isolated-excluded) `tracks`.
    let cancelled = false
    platform.getTracksInFolder(playlistPickerFolder.path).then((result) => {
      if (!cancelled) setPlaylistPickerFolderTracks(result)
    })
    return () => {
      cancelled = true
    }
  }, [playlistPickerFolder])

  useEffect(() => {
    if (!viewingFolder) {
      setFolderTracks([])
      return
    }
    // Isolated folders are excluded from `tracks` (Songs tab / search), so
    // browsing one has to fetch its contents directly rather than filtering
    // the already-loaded library list.
    let cancelled = false
    platform.getTracksInFolder(viewingFolder.path).then((result) => {
      if (!cancelled) setFolderTracks(result)
    })
    return () => {
      cancelled = true
    }
  }, [viewingFolder])

  const libraryAvailableKeys = useMemo(
    () => new Set(tracks.map((t) => t.key).filter((k): k is string => !!k)),
    [tracks]
  )
  const visibleTracks = useMemo(
    () => (keyFilter ? tracks.filter((t) => t.key === keyFilter) : tracks),
    [tracks, keyFilter]
  )
  const favoriteTracks = useMemo(
    () => [...tracks].filter((t) => t.favorite).sort((a, b) => (b.favoriteAt ?? 0) - (a.favoriteAt ?? 0)),
    [tracks],
  )
  // Keyed on the id sequence rather than `visibleTracks` itself: under the
  // "Most Recent" sort, playing a track updates its `lastPlayedAt` and bumps
  // it to the top of the visible table, but re-deriving the Next/Prev order
  // from that live churn on every track change made stepping through with
  // the transport controls jump around unpredictably. Freezing this order
  // until the track set, filter, or sort mode actually changes keeps
  // Next/Prev stable — the same as it already is for every other sort.
  const visibleTrackIdsKey = useMemo(() => visibleTracks.map((t) => t.id).join(','), [visibleTracks])
  const playbackOrder = useMemo(
    () => sortTracks(visibleTracks, sortBy, sortDir),
    [visibleTrackIdsKey, sortBy, sortDir]
  )

  const sortedFolders = useMemo(
    () =>
      sortGridItems(
        folders,
        sectionsSortBy,
        sectionsSortDir,
        (f) => f.name?.trim() || folderBaseName(f.path),
        (f) => f.sortOrder
      ),
    [folders, sectionsSortBy, sectionsSortDir]
  )
  const sortedPlaylists = useMemo(
    () => sortGridItems(playlists, playlistsSortBy, playlistsSortDir, (p) => p.name, (p) => p.sortOrder),
    [playlists, playlistsSortBy, playlistsSortDir]
  )

  const folderAvailableKeys = useMemo(
    () => new Set(folderTracks.map((t) => t.key).filter((k): k is string => !!k)),
    [folderTracks]
  )
  const visibleFolderTracks = useMemo(
    () => (keyFilter ? folderTracks.filter((t) => t.key === keyFilter) : folderTracks),
    [folderTracks, keyFilter]
  )

  function trackHasBassInterval(track: Track, sequence: string): boolean {
    return (bassIntervalsByTrack[track.id] ?? []).some((entry) => bassSequenceIncludes(entry.sequence, sequence))
  }

  const visibleAdvancedTracks = useMemo(
    () =>
      bassIntervalFilter
        ? advancedTracks.filter((t) => trackHasBassInterval(t, bassIntervalFilter))
        : advancedTracks,
    [advancedTracks, bassIntervalFilter, bassIntervalsByTrack]
  )
  const visibleAdvancedFolderTracks = useMemo(
    () =>
      bassIntervalFilter
        ? advancedFolderTracks.filter((t) => trackHasBassInterval(t, bassIntervalFilter))
        : advancedFolderTracks,
    [advancedFolderTracks, bassIntervalFilter, bassIntervalsByTrack]
  )

  // The playlist view is a picker over a source list (the whole library, or
  // one specific folder's tracks — including isolated ones) rather than just
  // the playlist's current contents, so isolated tracks can be added to it.
  const playlistPickerTracks = playlistPickerFolder ? playlistPickerFolderTracks : tracks
  const playlistPickerAvailableKeys = useMemo(
    () => new Set(playlistPickerTracks.map((t) => t.key).filter((k): k is string => !!k)),
    [playlistPickerTracks]
  )
  const visiblePlaylistPickerTracks = useMemo(
    () => (keyFilter ? playlistPickerTracks.filter((t) => t.key === keyFilter) : playlistPickerTracks),
    [playlistPickerTracks, keyFilter]
  )
  const playlistTrackIds = useMemo(() => new Set(playlistTracks.map((t) => t.id)), [playlistTracks])
  // "Custom" order for an open playlist's track list means the playlist's
  // own position, not the track's global sortOrder — playlistTracks already
  // arrives from the backend ordered by position, so its array index is that
  // order.
  const playlistOrderMap = useMemo(
    () => new Map(playlistTracks.map((t, i) => [t.id, i])),
    [playlistTracks]
  )
  const getPlaylistTrackOrder = useMemo(
    () => (t: Track) => playlistOrderMap.get(t.id) ?? Number.MAX_SAFE_INTEGER,
    [playlistOrderMap]
  )

  function addSelectionToPlaylist(playlistId: number, ids?: number[]) {
    const trackIds = ids ?? Array.from(selectedIds)
    if (trackIds.length === 0) return
    platform.addTracksToPlaylist(playlistId, trackIds).then(({ playlists: updated, tracks: updatedTracks }) => {
      setPlaylists(updated)
      if (viewingPlaylist?.id === playlistId) {
        setPlaylistTracks(updatedTracks)
        setViewingPlaylist(updated.find((p) => p.id === playlistId) ?? null)
      }
    })
    setSelectedIds(new Set())
  }

  function createPlaylistAndAddSelection(name: string) {
    const trackIds = Array.from(selectedIds)
    platform.createPlaylist(name).then((created) => {
      setPlaylists((prev) => [created, ...prev])
      if (trackIds.length > 0) addSelectionToPlaylist(created.id, trackIds)
    })
  }

  function removeSelectionFromPlaylist() {
    if (!viewingPlaylist || selectedIds.size === 0) return
    const trackIds = Array.from(selectedIds)
    window.api
      .removeTracksFromPlaylist(viewingPlaylist.id, trackIds)
      .then(({ playlists: updated, tracks: updatedTracks }) => {
        setPlaylists(updated)
        setPlaylistTracks(updatedTracks)
        setViewingPlaylist(updated.find((p) => p.id === viewingPlaylist.id) ?? null)
      })
    setSelectedIds(new Set())
  }

  function toggleTrackSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function togglePlaylistMembership(track: Track) {
    if (!viewingPlaylist) return
    const playlistId = viewingPlaylist.id
    const isMember = playlistTrackIds.has(track.id)
    const request = isMember
      ? platform.removeTracksFromPlaylist(playlistId, [track.id])
      : platform.addTracksToPlaylist(playlistId, [track.id])
    request.then(({ playlists: updated, tracks: updatedTracks }) => {
      setPlaylists(updated)
      setPlaylistTracks(updatedTracks)
      setViewingPlaylist(updated.find((p) => p.id === playlistId) ?? null)
    })
  }

  function handleRowContextMenu(track: Track, e: React.MouseEvent) {
    setTrackContextMenu({ track, x: e.clientX, y: e.clientY, section: activeSection })
  }

  async function detectKeyFromFile(id: number, filePath: string) {
    try {
      const res = await fetch(platform.getMediaUrl(filePath))
      const arrayBuffer = await res.arrayBuffer()
      if (!keyDetectionDecodeCtxRef.current) {
        keyDetectionDecodeCtxRef.current = new AudioContext()
      }
      const audioBuffer = await keyDetectionDecodeCtxRef.current.decodeAudioData(arrayBuffer)
      const { samples, sampleRate } = prepareSamplesForKeyDetection(audioBuffer)
      const worker = ensureKeyDetectionWorker()
      const result = await new Promise<KeyDetectionResponse['result']>((resolve) => {
        function handleMessage(e: MessageEvent<KeyDetectionResponse>) {
          if (e.data.id !== id) return
          worker.removeEventListener('message', handleMessage)
          resolve(e.data.result)
        }
        worker.addEventListener('message', handleMessage)
        const request: KeyDetectionRequest = { id, sampleRate, samples }
        worker.postMessage(request, [samples.buffer])
      })
      return result
    } catch (err) {
      console.error(`Detect key failed for ${filePath}:`, err)
      return null
    }
  }

  async function detectKeyForTrack(track: Track) {
    setTrackContextMenu(null)
    setDetectingKeyTrack(track)
    try {
      const result = await detectKeyFromFile(track.id, track.filePath)
      if (!result) return
      setConfirmImportKeyTrack({ ...track, key: result.key, keySignature: result.keySignature })
    } finally {
      setDetectingKeyTrack(null)
    }
  }

  function confirmImportKey() {
    if (!confirmImportKeyTrack) return
    window.api
      .setDetectedKey(
        confirmImportKeyTrack.id,
        confirmImportKeyTrack.key ?? '',
        confirmImportKeyTrack.keySignature ?? '',
        true,
      )
      .then((updated) => {
        if (!updated) return
        applyDetectedKey(updated)
        setConfirmImportKeyTrack(null)
      })
  }

  function cancelImportKey() {
    setConfirmImportKeyTrack(null)
  }

  function applyLocalTrackTagEdits(ids: number[], tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>) {
    const applyTo = <T extends Track[]>(list: T): T =>
      list.map((track) => (ids.includes(track.id) ? { ...track, ...tags } : track)) as T

    setTracks((prev) => applyTo(prev))
    setFolderTracks((prev) => applyTo(prev))
    setPlaylistTracks((prev) => applyTo(prev))
    setPlaylistPickerFolderTracks((prev) => applyTo(prev))
    setRecentTracks((prev) => applyTo(prev))
  }

  function revertLocalTrackTagEdits(ids: number[]) {
    const revertTo = <T extends Track[]>(list: T): T =>
      list.map((track) => {
        const pending = pendingTagEdits[track.id]
        if (!pending || !ids.includes(track.id)) return track
        return { ...track, ...pending.previous }
      }) as T

    setTracks((prev) => revertTo(prev))
    setFolderTracks((prev) => revertTo(prev))
    setPlaylistTracks((prev) => revertTo(prev))
    setPlaylistPickerFolderTracks((prev) => revertTo(prev))
    setRecentTracks((prev) => revertTo(prev))
  }

  function saveTagForSelection(track: Track, tags: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'key'>>) {
    const ids = selectedIds.has(track.id) && selectedIds.size > 1 ? Array.from(selectedIds) : [track.id]
    const supported = new Set(['.mp3', '.flac'])
    const unsupported = ids
      .map((id) => tracks.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is Track => !!candidate)
      .filter((candidate) => {
        const ext = candidate.filePath.slice(candidate.filePath.lastIndexOf('.') + 1).toLowerCase()
        return !supported.has(`.${ext}`)
      })

    if (unsupported.length > 0) {
      const ext = unsupported[0].filePath.slice(unsupported[0].filePath.lastIndexOf('.') + 1).toUpperCase()
      setLibraryNotice(`${ext} files cannot be rewritten. All edits exist only within the Volure app.`)
    }

    const nextPending = Object.fromEntries(
      ids.map((id) => {
        const existingPending = pendingTagEdits[id]
        const existingTrack = tracks.find((candidate) => candidate.id === id) ?? null
        return [
          id,
          {
            // Merge onto any not-yet-applied edit instead of replacing it, so
            // editing Title then Artist before pressing Update keeps both
            // instead of the second field clobbering the first.
            tags: { ...existingPending?.tags, ...tags },
            // Keep the snapshot from before the *first* pending edit — once
            // an edit is pending, `tracks` already reflects it locally, so
            // re-reading from `tracks` here would capture the in-progress
            // edit as "previous" and lose the true original on revert.
            previous: existingPending?.previous ?? existingTrack ?? { ...track, ...tags },
            expiresAt: Date.now() + 10_000,
          },
        ]
      }),
    )

    setPendingTagEdits((prev) => ({ ...prev, ...nextPending }))
    applyLocalTrackTagEdits(ids, tags)
  }

  function applyPendingTagUpdate(track: Track) {
    const pending = pendingTagEdits[track.id]
    if (!pending) return

    const ids = selectedIds.has(track.id) && selectedIds.size > 1 ? Array.from(selectedIds) : [track.id]
    const supported = new Set(['.mp3', '.flac'])
    const unsupported = ids
      .map((id) => tracks.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is Track => !!candidate)
      .filter((candidate) => {
        const ext = candidate.filePath.slice(candidate.filePath.lastIndexOf('.') + 1).toLowerCase()
        return !supported.has(`.${ext}`)
      })

    if (unsupported.length > 0) {
      const ext = unsupported[0].filePath.slice(unsupported[0].filePath.lastIndexOf('.') + 1).toUpperCase()
      setLibraryNotice(`${ext} files cannot be rewritten. All edits exist only within the Volure app.`)
    }

    // Clear the pending edit (and its Update button) immediately on click
    // rather than waiting on the write to finish.
    setPendingTagEdits((prev) => {
      const next = { ...prev }
      for (const id of ids) delete next[id]
      return next
    })

    platform.updateTagsBulk(ids, pending.tags).then(({ tracks: updated, failedIds }) => {
      setTracks(updated)
      setFolderTracks((prev) => prev.map((t) => updated.find((u) => u.id === t.id) ?? t))
      setPlaylistTracks((prev) => prev.map((t) => updated.find((u) => u.id === t.id) ?? t))
      setPlaylistPickerFolderTracks((prev) => prev.map((t) => updated.find((u) => u.id === t.id) ?? t))
      setRecentTracks((prev) => prev.map((t) => updated.find((u) => u.id === t.id) ?? t))
      if (failedIds.length > 0) {
        setLibraryNotice('Could not save the new tags to the file on disk — it may be open elsewhere. The change is kept in Volure only.')
      }
    })
  }

  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = Date.now()
      setPendingTagEdits((prev) => {
        const next = { ...prev }
        for (const [id, value] of Object.entries(prev)) {
          if (value.expiresAt <= now) {
            revertLocalTrackTagEdits([Number(id)])
            delete next[Number(id)]
          }
        }
        return next
      })
    }, 1000)
    return () => window.clearInterval(tick)
  }, [pendingTagEdits])

  function toggleTrackInclude(track: Track) {
    const nextInLibrary = track.inLibrary ? false : true
    platform.setTrackInLibrary(track.id, nextInLibrary).then((updated) => {
      if (!updated) return
      setFolderTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      setRecentTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      platform.getTracks().then(setTracks)
      if (activeSection === 'recent') {
        platform.getRecentlyPlayed().then(setRecentTracks)
      }
    })
  }

  function toggleAdvancedInclude(track: Track) {
    const nextIncluded = track.inAdvancedLibrary ? false : true
    window.api.setTrackInAdvancedLibrary(track.id, nextIncluded).then((updated) => {
      if (!updated) return
      setAdvancedFolderTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      window.api.getAdvancedTracks().then(setAdvancedTracks)
    })
  }

  function saveAdvancedTag(track: Track, tags: Partial<Pick<Track, 'key' | 'mood'>>) {
    window.api.updateAdvancedTags(track.id, tags).then((updated) => {
      if (!updated) return
      setAdvancedTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      setAdvancedFolderTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      // Key is shown on every other tab too, so keep them in sync — Mood has
      // no other reader, but merging it in here as well is harmless.
      if ('key' in tags) {
        setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
        setFolderTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
        setPlaylistTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
        setRecentTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      }
    })
  }

  function addBassIntervalToTrack(track: Track, sequence: string) {
    window.api.addBassInterval(track.id, sequence).then((entry) => {
      setBassIntervalsByTrack((prev) => ({
        ...prev,
        [track.id]: [...(prev[track.id] ?? []), entry],
      }))
    })
  }

  function removeBassIntervalFromTrack(track: Track, intervalId: number) {
    window.api.removeBassInterval(intervalId).then(() => {
      setBassIntervalsByTrack((prev) => ({
        ...prev,
        [track.id]: (prev[track.id] ?? []).filter((entry) => entry.id !== intervalId),
      }))
    })
  }

  // Drag-to-reorder persistence. `tracks.sortOrder` is a single global field
  // shared by the Songs tab and an open folder's track list (both read/write
  // it via the same handler); an open playlist instead reorders its own
  // `playlist_tracks.position`, scoped to that one playlist.
  function handleTracksReorder(orderedIds: number[]) {
    const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
    const apply = (list: Track[]) =>
      list.map((t) => (orderMap.has(t.id) ? { ...t, sortOrder: orderMap.get(t.id)! } : t))
    setTracks(apply)
    setFolderTracks(apply)
    platform.setTracksOrder(orderedIds)
  }

  function handlePlaylistTracksReorder(orderedIds: number[]) {
    if (!viewingPlaylist) return
    const byId = new Map(playlistTracks.map((t) => [t.id, t]))
    const reordered = orderedIds.map((id) => byId.get(id)).filter((t): t is Track => !!t)
    setPlaylistTracks(reordered)
    platform.reorderPlaylistTracks(viewingPlaylist.id, orderedIds)
  }

  function handleFoldersReorder(orderedPaths: string[]) {
    const orderMap = new Map(orderedPaths.map((p, i) => [p, i]))
    setFolders((prev) =>
      prev.map((f) => (orderMap.has(f.path) ? { ...f, sortOrder: orderMap.get(f.path)! } : f))
    )
    if (sectionsSortBy !== 'custom') {
      setSectionsSortBy('custom')
      setSectionsSortDir('asc')
    }
    platform.reorderFolders(orderedPaths)
  }

  function handlePlaylistsReorder(orderedIds: number[]) {
    const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
    setPlaylists((prev) =>
      prev.map((p) => (orderMap.has(p.id) ? { ...p, sortOrder: orderMap.get(p.id)! } : p))
    )
    if (playlistsSortBy !== 'custom') {
      setPlaylistsSortBy('custom')
      setPlaylistsSortDir('asc')
    }
    platform.reorderPlaylists(orderedIds)
  }

  function handleFoldersDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = sortedFolders.findIndex((f) => f.path === active.id)
    const newIndex = sortedFolders.findIndex((f) => f.path === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    handleFoldersReorder(arrayMove(sortedFolders, oldIndex, newIndex).map((f) => f.path))
  }

  function handlePlaylistsDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = sortedPlaylists.findIndex((p) => p.id === active.id)
    const newIndex = sortedPlaylists.findIndex((p) => p.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    handlePlaylistsReorder(arrayMove(sortedPlaylists, oldIndex, newIndex).map((p) => p.id))
  }

  const currentTrack = useMemo(
    () =>
      tracks.find((t) => t.id === currentTrackId) ??
      folderTracks.find((t) => t.id === currentTrackId) ??
      recentTracks.find((t) => t.id === currentTrackId) ??
      null,
    [tracks, folderTracks, recentTracks, currentTrackId]
  )
  const lastPlaybackToggleRef = useRef<(() => void) | null>(null)
  const nowPlayingTrackRef = useRef<Track | null>(null)
  const nowPlayingIsPlayingRef = useRef(false)
  const nowPlayingToggleRef = useRef<() => void>(() => {})
  const nowPlayingNextRef = useRef<() => void>(() => {})
  const nowPlayingPrevRef = useRef<() => void>(() => {})
  nowPlayingTrackRef.current = currentTrack
  nowPlayingIsPlayingRef.current = isPlaying
  const effectiveTrackKey = useMemo(
    () => shiftKeyBySemitones(currentTrack?.key ?? null, pitchSemitones + speedToSemitoneShift(playbackSpeed)),
    [currentTrack?.key, pitchSemitones, playbackSpeed],
  )
  // The Show Info modal's edits go through the same tag pipeline as the
  // library table (saveTagForSelection/applyLocalTrackTagEdits), which only
  // ever updates tracks/folderTracks/recentTracks — not the infoTrack
  // snapshot itself — so the modal re-reads from those lists to stay live
  // while it's open instead of showing stale values after a field edit.
  const infoTrackLive = useMemo(
    () =>
      infoTrack &&
      (tracks.find((t) => t.id === infoTrack.id) ??
        folderTracks.find((t) => t.id === infoTrack.id) ??
        recentTracks.find((t) => t.id === infoTrack.id) ??
        infoTrack),
    [infoTrack, tracks, folderTracks, recentTracks],
  )
  const embeddedCurrentArt = useTrackArt(currentTrack?.filePath ?? null)
  const currentArtSrc = currentTrack?.customArtPath
    ? platform.getMediaUrl(currentTrack.customArtPath)
    : (embeddedCurrentArt ?? DEFAULT_ART)

  // A dropped-in file takes priority over an imported Now Playing track (only
  // one waveform slot). Importing the current song (the + button) is a live
  // view into the actual Now Playing <audio> element — play/pause, seek, and
  // volume in Studio and the footer transport are the same single stream, so
  // they stay in lockstep either direction. A file dropped directly into
  // Studio, on the other hand, is never the Now Playing track — it plays
  // through its own fully independent engine so it can't affect (or be
  // affected by) whatever's actually playing.
  const studioDisplayTrack = studioDroppedTrack ?? (studioTrackImported ? currentTrack : null)
  // Studio only shares the Now Playing engine while its "track" slot holds
  // the live imported view — a dropped-in file is never aligned, even if it
  // happens to be the very same track by id (e.g. removeStudioSlotSilence
  // forks an aligned track into an independent dropped one via
  // setStudioDroppedTrack so Remove Silence has a buffer of its own to cut —
  // comparing IDs alone let that forked-but-same-track slot keep reporting
  // itself as aligned afterward, silently routing later edits/export through
  // the main Now Playing engine instead of the independent one actually
  // backing what's on screen).
  const studioIsAligned = !studioDroppedTrack && studioTrackImported && !!currentTrack
  const studioRestoreSnapshotRef = useRef<{
    eqGains: number[]
    boostVolume: number
    playbackSpeed: number
    pitchSemitones: number
    reverseAudioEnabled: boolean
  } | null>(null)

  function snapshotStudioRestoreState() {
    studioRestoreSnapshotRef.current = {
      eqGains: [...eqGainsRef.current],
      boostVolume: boostVolumeRef.current,
      playbackSpeed: playbackSpeedRef.current,
      pitchSemitones: pitchSemitonesRef.current,
      reverseAudioEnabled: reverseAudioEnabledRef.current,
    }
  }

  function restoreStudioRestoreState() {
    const snapshot = studioRestoreSnapshotRef.current
    if (!snapshot) return

    eqGainsRef.current = [...snapshot.eqGains]
    setEqGains(eqGainsRef.current)
    eqFilterNodesRef.current.forEach((filter, index) => {
      filter.gain.value = snapshot.eqGains[index] ?? 0
    })

    setBoostVolume(snapshot.boostVolume)
    boostVolumeRef.current = snapshot.boostVolume
    if (boostGainNodeRef.current) boostGainNodeRef.current.gain.value = snapshot.boostVolume

    applyPlaybackSpeed(snapshot.playbackSpeed)
    setPitchSemitones(snapshot.pitchSemitones)
    pitchSemitonesRef.current = snapshot.pitchSemitones

    const shouldRestoreReverse = snapshot.reverseAudioEnabled
    if (currentTrack) {
      if (shouldRestoreReverse || snapshot.pitchSemitones !== 0) {
        applyReverseAudioState(shouldRestoreReverse)
      } else {
        const audio = audioRef.current
        if (audio) {
          audio.currentTime = 0
          resumeAudioContext()
        }
      }
    }

    studioRestoreSnapshotRef.current = null
  }

  useEffect(() => {
    if (appView !== 'studio' && studioRestoreSnapshotRef.current && currentTrack) {
      restoreStudioRestoreState()
      return
    }

    if (studioIsAligned && appView === 'studio') {
      if (!studioRestoreSnapshotRef.current) {
        snapshotStudioRestoreState()
      }
    }
  }, [appView, studioIsAligned, currentTrackId])

  const studioDroppedFileSrc = studioDroppedTrack ? platform.getMediaUrl(studioDroppedTrack.filePath) : null
  const studioIndependentPlayback = useFilePlayback(studioDroppedFileSrc, volume)
  const studioPlayback = studioIsAligned
    ? {
        currentTime,
        seek: seekTo,
        playing: isPlaying,
        togglePlay,
        volume,
        setVolume,
        playbackRate: playbackSpeed,
        setPlaybackRate: applyPlaybackSpeed,
        pitchSemitones,
        setPitchSemitones,
        eqGains,
        setEqBandGain,
        resetEq,
        boostVolume,
        setBoostVolume,
        meterAnalyserL: meterAnalyserLRef.current,
        meterAnalyserR: meterAnalyserRRef.current,
      }
    : studioIndependentPlayback

  // Studio's dB meter — polls every engine that can actually be sounding in
  // Studio once per frame and combines them, so it reads true regardless of
  // this slot's own volume or the footer's master volume, and matches what
  // an export would actually contain:
  //  - the "track" slot, but ONLY the aligned Now Playing stream (once
  //    imported) or a dropped-in file — never the Now Playing engine while
  //    it's unrelated to Studio, so playback elsewhere in the app never
  //    leaks into this meter (studioPlayback already resolves to whichever
  //    applies, or an analyser-less object when neither does).
  //  - the internal-audio and mic take-playback engines, whenever a take is
  //    actually loaded and playing (their analysers read silent otherwise).
  // All three can sound at once (e.g. reviewing a take against the aligned
  // track), so the tick loop below sums their levels rather than picking one.
  // Ref mirrors let the loop start once (on entering Studio) rather than
  // restart every render.
  const studioPlaybackRef = useRef(studioPlayback)
  studioPlaybackRef.current = studioPlayback
  const internalAudioRecorderMeterRef = useRef(internalAudioRecorder)
  internalAudioRecorderMeterRef.current = internalAudioRecorder
  const micRecorderMeterRef = useRef(micRecorder)
  micRecorderMeterRef.current = micRecorder
  const [studioMeterDb, setStudioMeterDb] = useState<StereoDb>({ l: STUDIO_METER_FLOOR_DB, r: STUDIO_METER_FLOOR_DB })
  // Peak-hold readout — each channel's marker snaps up instantly to a new
  // high, sits still for STUDIO_METER_PEAK_HOLD_MS, then eases back down at
  // STUDIO_METER_PEAK_DECAY_DB_PER_TICK/tick, the same behavior pro mixing-
  // console meters use so a brief transient stays readable after it passes.
  const [studioMeterPeak, setStudioMeterPeak] = useState<StereoDb>({
    l: STUDIO_METER_FLOOR_DB,
    r: STUDIO_METER_FLOOR_DB,
  })
  const studioMeterPeakRef = useRef<StereoDb>({ l: STUDIO_METER_FLOOR_DB, r: STUDIO_METER_FLOOR_DB })
  const studioMeterPeakHoldMsRef = useRef<StereoDb>({ l: 0, r: 0 })
  const studioMeterIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Per-analyser scratch buffers, keyed by node identity rather than by
  // fixed slot — up to three sources (track/internal/mic) can each need one
  // per channel, and which slots are actually live varies over time.
  const studioMeterBuffersRef = useRef<Map<AnalyserNode, Uint8Array<ArrayBuffer>>>(new Map())
  useEffect(() => {
    if (appView !== 'studio') {
      setStudioMeterDb({ l: STUDIO_METER_FLOOR_DB, r: STUDIO_METER_FLOOR_DB })
      studioMeterPeakRef.current = { l: STUDIO_METER_FLOOR_DB, r: STUDIO_METER_FLOOR_DB }
      studioMeterPeakHoldMsRef.current = { l: 0, r: 0 }
      setStudioMeterPeak({ l: STUDIO_METER_FLOOR_DB, r: STUDIO_METER_FLOOR_DB })
      return
    }
    // A plain interval rather than requestAnimationFrame — a level meter
    // doesn't need to be paint-synced, and this stays simpler to reason
    // about across visibility/occlusion states. ~30Hz is plenty smooth.
    const TICK_MS = 33
    function readChannelRms(analyser: AnalyserNode | null): number {
      if (!analyser) return 0
      let data = studioMeterBuffersRef.current.get(analyser)
      if (!data || data.length !== analyser.fftSize) {
        data = new Uint8Array(new ArrayBuffer(analyser.fftSize))
        studioMeterBuffersRef.current.set(analyser, data)
      }
      analyser.getByteTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i] - 128) / 128
        sumSquares += normalized * normalized
      }
      return Math.sqrt(sumSquares / data.length)
    }
    // Combines every currently-live source's RMS on this channel as an
    // (uncorrelated-signal) power sum rather than just taking the loudest —
    // two takes playing at once should read louder than either alone, the
    // same way they'd actually sound.
    function combinedChannelDb(analysers: (AnalyserNode | null)[]): number {
      let sumSquares = 0
      for (const analyser of analysers) {
        const rms = readChannelRms(analyser)
        sumSquares += rms * rms
      }
      const combinedRms = Math.sqrt(sumSquares)
      const db = combinedRms > 0 ? 20 * Math.log10(combinedRms) : STUDIO_METER_FLOOR_DB
      return Math.max(STUDIO_METER_FLOOR_DB, Math.min(0, db))
    }
    function updatePeak(channel: 'l' | 'r', db: number) {
      const peaks = studioMeterPeakRef.current
      const holds = studioMeterPeakHoldMsRef.current
      if (db >= peaks[channel]) {
        peaks[channel] = db
        holds[channel] = 0
      } else {
        holds[channel] += TICK_MS
        if (holds[channel] > STUDIO_METER_PEAK_HOLD_MS) {
          peaks[channel] = Math.max(STUDIO_METER_FLOOR_DB, peaks[channel] - STUDIO_METER_PEAK_DECAY_DB_PER_TICK)
        }
      }
    }
    function tick() {
      const track = studioPlaybackRef.current
      const internal = internalAudioRecorderMeterRef.current
      const mic = micRecorderMeterRef.current
      const dbL = combinedChannelDb([track.meterAnalyserL, internal.meterAnalyserL, mic.meterAnalyserL])
      const dbR = combinedChannelDb([track.meterAnalyserR, internal.meterAnalyserR, mic.meterAnalyserR])
      setStudioMeterDb({ l: dbL, r: dbR })
      updatePeak('l', dbL)
      updatePeak('r', dbR)
      setStudioMeterPeak({ ...studioMeterPeakRef.current })
    }
    studioMeterIntervalRef.current = setInterval(tick, TICK_MS)
    return () => {
      if (studioMeterIntervalRef.current !== null) clearInterval(studioMeterIntervalRef.current)
    }
  }, [appView])

  // Which waveform slots are actually loaded — every loaded slot (including
  // the track slot, whether an aligned import or a dropped-in file) is
  // eligible for all three slot-targeted tools (Time Stretch, Reverse Audio,
  // Remove Silence), so this no longer varies by which one is active.
  function loadedSlotsForTool(): StudioSlot[] {
    const slots: StudioSlot[] = []
    if (studioDisplayTrack) slots.push('track')
    if (internalAudioRecorder.recordingPeaks) slots.push('internal')
    if (micRecorder.recordingPeaks) slots.push('mic')
    return slots
  }

  // Reverses a single Studio waveform slot. An aligned track reuses the Now
  // Playing / Equalizer "Reverse Audio" toggle directly (same underlying
  // stream, see the comment on studioIsAligned above), so reversing from
  // here and from the Equalizer stay in lockstep. A dropped-in file has no
  // such shared state — it reverses through its own independent playback
  // engine instead.
  function reverseStudioSlot(slot: StudioSlot) {
    if (slot === 'track') {
      if (studioIsAligned) applyReverseAudioState(!reverseAudioEnabled)
      else studioIndependentPlayback.toggleReverse()
    } else if (slot === 'internal') {
      internalAudioRecorder.toggleReverse()
    } else if (slot === 'mic') {
      micRecorder.toggleReverse()
    }
  }

  // An aligned track has no buffer of its own to trim (it's a live view into
  // the actual Now Playing element, see studioIsAligned above) — removing
  // its silence first breaks alignment the same way a reverse toggle does
  // for that slot, converting it into an independent dropped-in track backed
  // by the same file. That swap only takes effect on the next render (once
  // studioDroppedFileSrc points at the file), so the trim itself is deferred
  // until the pending-track-silence-removal effect below sees it land.
  const pendingTrackSilenceRemovalRef = useRef(false)

  // Removes leading/trailing silence from a single Studio waveform slot.
  function removeStudioSlotSilence(slot: StudioSlot) {
    if (slot === 'internal') internalAudioRecorder.removeSilence()
    else if (slot === 'mic') micRecorder.removeSilence()
    else if (slot === 'track') {
      if (studioIsAligned && studioDisplayTrack) {
        pendingTrackSilenceRemovalRef.current = true
        setStudioTrackImported(false)
        setStudioDroppedTrack(studioDisplayTrack)
      } else {
        studioIndependentPlayback.removeSilence()
      }
    }
    setRemoveSilenceTabClicked(true)
  }

  // Picks up removeStudioSlotSilence's deferred trim once an aligned track's
  // conversion to an independent dropped-in track actually lands.
  useEffect(() => {
    if (pendingTrackSilenceRemovalRef.current && studioDroppedFileSrc) {
      pendingTrackSilenceRemovalRef.current = false
      studioIndependentPlayback.removeSilence()
    }
  }, [studioDroppedFileSrc])

  // Opens Trim Audio on a single Studio waveform slot — restores the trim
  // range/fades to wherever that slot was last left (see trimSelections)
  // and snapshots that slot's engine so applyManualTrim has a fixed buffer
  // to re-slice from as the user drags handles. An aligned track (the
  // currently playing one) trims in place via the real Now Playing engine
  // (see beginManualTrimAligned) rather than being converted into a
  // disconnected independent copy, so the edit stays audible on whatever's
  // actually playing — mirrors how reverseStudioSlot already keeps an
  // aligned track live instead of forking it.
  function beginTrimSlot(slot: StudioSlot) {
    const saved = trimSelections[slot]
    setTrimStart(saved.start)
    setTrimEnd(saved.end)
    setFadeInOn(saved.fadeInOn)
    setFadeOutOn(saved.fadeOutOn)
    setFadeInRatio(saved.fadeInRatio)
    setFadeOutRatio(saved.fadeOutRatio)
    setSelectedToolSlot(slot)
    if (slot === 'internal') internalAudioRecorder.beginManualTrim()
    else if (slot === 'mic') micRecorder.beginManualTrim()
    else if (slot === 'track') {
      if (studioIsAligned) beginManualTrimAligned()
      else studioIndependentPlayback.beginManualTrim()
    }
  }

  // Applies whichever slot-targeted tool is currently active to one picked
  // slot, then — for the tools that just make an instant change rather than
  // opening a menu (Reverse Audio, Remove Silence) — returns to Studio Home
  // so the user lands back on the plain waveform view. Time Stretch and Trim
  // Audio instead narrow the view down to the picked slot and leave their
  // own menu open, so they only update the selected slot itself.
  function applyStudioTool(tool: string, slot: StudioSlot) {
    if (tool === 'Time Stretch') {
      setSelectedToolSlot(slot)
      return
    }
    if (tool === 'Trim Audio') {
      beginTrimSlot(slot)
      return
    }
    if (tool === 'Equalizer') {
      setSelectedToolSlot(slot)
      return
    }
    if (tool === 'Reverse Audio') reverseStudioSlot(slot)
    else if (tool === 'Remove Silence') removeStudioSlotSilence(slot)
    setStudioTool('Studio Home')
    setSelectedToolSlot(null)
  }

  // Drives the "Remove Silence" tab's checkmark. Tracks the tab click
  // directly (rather than only the recorders' own silenceRemoved flags) so
  // the check appears the moment the tab is used, even before/without a take
  // loaded — mirrors how confirmTrim's own silenceRemoved flag already marks
  // the prompt-triggered path.
  const studioSilenceRemoved =
    internalAudioRecorder.silenceRemoved ||
    micRecorder.silenceRemoved ||
    studioIndependentPlayback.silenceRemoved ||
    removeSilenceTabClicked

  // A new take invalidates the previous click's checkmark — reset it the
  // moment either recorder starts recording again.
  useEffect(() => {
    if (internalAudioRecorder.recording || micRecorder.recording) setRemoveSilenceTabClicked(false)
  }, [internalAudioRecorder.recording, micRecorder.recording])

  // Returns the side panel to Studio Home the moment an internal-audio
  // recording actually finishes — recording can be stopped either from this
  // tab's own button or the record button in the top-right corner (both
  // call the same internalAudioRecorder.toggleRecording), so this watches
  // the recording flag itself rather than either click handler. Only acts
  // while "Record Internal Audio" is still the selected tab, so it can't
  // yank the user back if they've already navigated elsewhere while a
  // recording (started from the top-right button) was still running.
  const wasRecordingInternalRef = useRef(false)
  useEffect(() => {
    if (wasRecordingInternalRef.current && !internalAudioRecorder.recording && studioTool === 'Record Internal Audio') {
      setStudioTool('Studio Home')
    }
    wasRecordingInternalRef.current = internalAudioRecorder.recording
  }, [internalAudioRecorder.recording, studioTool])

  // Unlike internal-audio recording (which the user explicitly starts/stops
  // and which keeps running if they navigate away), Listen mode's capture is
  // implicit — it just starts the moment the tab is selected — so leaving
  // the tab before it finishes should cancel it rather than leave a system-
  // audio capture running invisibly in the background.
  useEffect(() => {
    if (studioTool !== 'Listen' && listenStatus !== 'idle') cancelListenMode()
  }, [studioTool, listenStatus])

  // Whether reverseStudioSlot's most recent toggle left any currently loaded
  // slot actually reversed — same per-slot sources reverseStudioSlot itself
  // reads from, checked directly rather than mirrored into a separate flag
  // so it can never drift from the underlying playback state.
  const studioAudioReversed =
    (studioDisplayTrack ? (studioIsAligned ? reverseAudioEnabled : studioIndependentPlayback.reversed) : false) ||
    internalAudioRecorder.reversed ||
    micRecorder.reversed

  // Which waveform slot Time Stretch / Trim Audio / Reverse Audio / Remove
  // Silence has narrowed the Studio view down to — null means the tab (if
  // one of those four is active) is still showing every loaded slot with
  // its own select checkmark, waiting for the user to pick one. Reverse
  // Audio and Remove Silence clear this again the instant they apply (see
  // applyStudioTool) since they have no menu to linger on; Time Stretch and
  // Trim Audio leave it set until their own "Done" button is clicked.
  const timeStretchMode = studioTool === 'Time Stretch'
  const trimMode = studioTool === 'Trim Audio'
  const eqMode = studioTool === 'Equalizer'
  const slotToolActive =
    timeStretchMode || trimMode || eqMode || studioTool === 'Reverse Audio' || studioTool === 'Remove Silence'
  const [selectedToolSlot, setSelectedToolSlot] = useState<StudioSlot | null>(null)
  const [timeStretchDone, setTimeStretchDone] = useState(false)
  // Trim Audio's editing state — ratios (0..1) into whichever slot is
  // narrowed to, seeded from that slot's trimSelections entry each time the
  // tool opens on it (see beginTrimSlot) so reopening picks up where the
  // user left off rather than snapping back to "whole clip, no fade".
  // fadeInRatio/fadeOutRatio are fractions of the current selection's own
  // width (see TrimOverlay/sliceAndFadeBuffer), not the full clip's.
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(1)
  const [fadeInOn, setFadeInOn] = useState(false)
  const [fadeOutOn, setFadeOutOn] = useState(false)
  const [fadeInRatio, setFadeInRatio] = useState(0.2)
  const [fadeOutRatio, setFadeOutRatio] = useState(0.2)
  // Each slot's last-committed trim range/fades, restored into the editing
  // state above by beginTrimSlot whenever Trim Audio reopens on that slot —
  // see commitTrim (called from renderTrimOverlay/the Fade In/Out toggles)
  // for where this gets updated, and the trim-selection-reset effects below
  // for where a genuinely new track/take clears a slot's entry back to
  // DEFAULT_TRIM_SELECTION.
  const [trimSelections, setTrimSelections] = useState<Record<StudioSlot, TrimSelection>>({
    track: DEFAULT_TRIM_SELECTION,
    internal: DEFAULT_TRIM_SELECTION,
    mic: DEFAULT_TRIM_SELECTION,
  })
  // A trim selection only makes sense for the exact audio it was measured
  // against — reset back to default the moment a slot's underlying audio
  // changes out from under it, so a stale range from a previous track/take
  // never gets silently reapplied to a new one.
  useEffect(() => {
    setTrimSelections((prev) => ({ ...prev, track: DEFAULT_TRIM_SELECTION }))
  }, [studioDisplayTrack?.id])
  const prevInternalRecordingRef = useRef(false)
  useEffect(() => {
    if (internalAudioRecorder.recording && !prevInternalRecordingRef.current) {
      setTrimSelections((prev) => ({ ...prev, internal: DEFAULT_TRIM_SELECTION }))
    }
    prevInternalRecordingRef.current = internalAudioRecorder.recording
  }, [internalAudioRecorder.recording])
  const prevMicRecordingRef = useRef(false)
  useEffect(() => {
    if (micRecorder.recording && !prevMicRecordingRef.current) {
      setTrimSelections((prev) => ({ ...prev, mic: DEFAULT_TRIM_SELECTION }))
    }
    prevMicRecordingRef.current = micRecorder.recording
  }, [micRecorder.recording])
  // Persists a commit (handle drag release, or a Fade In/Out toggle click)
  // into that slot's trimSelections entry, then applies it exactly like a
  // direct trimTarget.applyManualTrim call would — shared by
  // renderTrimOverlay and the Fade In/Out toggle buttons below so neither
  // has to remember to do both.
  function commitTrim(slot: StudioSlot, start: number, end: number, fadeIn: FadeSetting, fadeOut: FadeSetting) {
    setTrimSelections((prev) => ({
      ...prev,
      [slot]: {
        start,
        end,
        fadeInOn: fadeIn.on,
        fadeInRatio: fadeIn.ratio,
        fadeOutOn: fadeOut.on,
        fadeOutRatio: fadeOut.ratio,
      },
    }))
    trimTarget?.applyManualTrim(start, end, fadeIn, fadeOut)
  }

  // While Trim Audio is open on a slot and a commit has moved playback onto
  // the trimmed selection, that slot's waveform still shows the full
  // original clip (peaksOverride/durationOverride stay null until "Done" —
  // see beginManualTrim/confirmManualTrim), but the engine's own
  // currentTime/seek target are measured relative to just the trimmed
  // selection, not the full clip actually on screen. These two convert
  // between the two coordinate spaces so the cursor visibly loops within the
  // shaded selection (instead of collapsing near the far left, out of step
  // with the audible loop) and clicking/dragging anywhere on the waveform
  // seeks to the right spot in the trimmed audio (instead of a seemingly
  // unrelated one). Both degrade to a no-op once nothing's been dragged yet
  // (trimStart/trimEnd are still 0/1) or once "Done" switches the display
  // over to the trimmed view, whose own currentTime/seeks already match its
  // own duration directly.
  function trimPreviewDisplayTime(rawCurrentTime: number, fullDuration: number): number {
    return trimStart * fullDuration + rawCurrentTime
  }

  function trimPreviewSeek(fullClipTime: number, fullDuration: number, seek: (time: number) => void) {
    const trimStartTime = trimStart * fullDuration
    const trimEndTime = trimEnd * fullDuration
    seek(Math.min(Math.max(fullClipTime, trimStartTime), trimEndTime) - trimStartTime)
  }

  // Drives the "Trim Audio" tab's checkmark once its "Done" button has been
  // clicked — mirrors timeStretchDone, a plain one-way flag with no reset.
  const [studioTrimDone, setStudioTrimDone] = useState(false)
  // Waveform-override state for a live trim applied to the aligned "track"
  // slot (see applyManualTrimAligned) — the studioIndependentPlayback
  // counterparts (trimmedPeaks/trimmedDuration) only ever reflect a dropped-in
  // file, never the actual Now Playing engine, so this needs its own state.
  const [alignedTrimmedPeaks, setAlignedTrimmedPeaks] = useState<number[] | null>(null)
  const [alignedTrimmedDuration, setAlignedTrimmedDuration] = useState<number | null>(null)

  // "Converter" tab state — a developer-only YouTube-to-audio downloader,
  // kept out of the shipped app for legal reasons (see the studio-tabs list
  // and the converter:downloadYoutubeAudio ipcMain handler). Not a slot
  // tool: it doesn't touch any loaded waveform, so it's excluded from
  // slotToolActive below and renders its own standalone panel instead.
  const converterMode = studioTool === 'Converter'
  // "Listen" tab — likewise not a slot tool (see converterMode above): it
  // has its own standalone panel and never touches a loaded waveform.
  const listenMode = studioTool === 'Listen'
  const [converterUrl, setConverterUrl] = useState('')
  const [converterDownloading, setConverterDownloading] = useState(false)
  const [converterError, setConverterError] = useState<string | null>(null)
  const [converterSavedPath, setConverterSavedPath] = useState<string | null>(null)

  // Mirrors saveAndOfferLibraryAdd's own success path (see above) — a
  // successful download offers the same "Add to Song Library?" prompt a
  // Studio save does, via the shared pendingLibraryAddPath modal.
  async function downloadConverterAudio(format: AudioExportFormat) {
    const url = converterUrl.trim()
    if (!url || converterDownloading) return
    setConverterDownloading(true)
    setConverterError(null)
    setConverterSavedPath(null)
    try {
      const savedPath = await window.api.downloadYoutubeAudio(url, format)
      if (savedPath) {
        setConverterSavedPath(savedPath)
        setPendingLibraryAddPath(savedPath)
      }
    } catch (error) {
      setConverterError(error instanceof Error ? error.message : 'Download failed')
    } finally {
      setConverterDownloading(false)
    }
  }

  // The slots the currently active tool can actually be applied to right
  // now — drives both the per-waveform select checkmark and the "only one
  // slot loaded" bypass in the side-panel tab's click handler.
  const activeToolSlots = loadedSlotsForTool()

  // A slot the user had selected can vanish out from under them — the "x"
  // on that same waveform is still reachable while narrowed, and discarding
  // a take or clearing the track both remain valid actions mid-selection.
  // Fall back out of the narrowed view rather than leaving it pointed at
  // nothing.
  useEffect(() => {
    if (selectedToolSlot === 'track' && !studioDisplayTrack) setSelectedToolSlot(null)
    if (selectedToolSlot === 'internal' && !internalAudioRecorder.recordingPeaks) setSelectedToolSlot(null)
    if (selectedToolSlot === 'mic' && !micRecorder.recordingPeaks) setSelectedToolSlot(null)
  }, [selectedToolSlot, studioDisplayTrack, internalAudioRecorder.recordingPeaks, micRecorder.recordingPeaks])

  // Whether a given waveform slot should render right now: every slot when
  // the active tool isn't narrowed down to one, otherwise only the selected
  // one. Equalizer still keeps its waveform visible so the user can preview
  // and scrubbing/play/pause the audio they're adjusting while the control
  // panel sits beneath it.
  function toolSlotVisible(slot: StudioSlot): boolean {
    return !slotToolActive || selectedToolSlot === null || selectedToolSlot === slot
  }

  // Whether a given waveform slot should show its select checkmark right
  // now: only while the active tool is narrowable, nothing's been picked
  // yet, that slot is actually eligible for the tool, and there's more than
  // one eligible slot to choose between (a single loaded slot bypasses the
  // checkmark entirely — see the tab click handler).
  function toolSlotSelectable(slot: StudioSlot): boolean {
    return slotToolActive && selectedToolSlot === null && activeToolSlots.length > 1 && activeToolSlots.includes(slot)
  }

  // The engine actually driving sound for whichever slot Time Stretch is
  // narrowed down to — each slot type plays through a different engine
  // (studioPlayback for the track/dropped-file, or each recorder's own
  // AudioBufferSourceNode-based playback), so the speed slider has to be
  // pointed at the right one rather than always the main Now Playing engine.
  const timeStretchTarget =
    selectedToolSlot === 'track'
      ? studioPlayback
      : selectedToolSlot === 'internal'
        ? internalAudioRecorder
        : selectedToolSlot === 'mic'
          ? micRecorder
          : null

  // The engine Studio's Equalizer tool is narrowed down to — like
  // timeStretchTarget, the aligned "track" slot uses studioPlayback (the
  // shared Now Playing engine) rather than always studioIndependentPlayback,
  // so an aligned track's EQ/boost stay in lockstep with the Customize menu.
  const eqTarget =
    selectedToolSlot === 'track'
      ? studioPlayback
      : selectedToolSlot === 'internal'
        ? internalAudioRecorder
        : selectedToolSlot === 'mic'
          ? micRecorder
          : null

  // The engine Trim Audio is narrowed down to. An aligned track slices via
  // applyManualTrimAligned (the real Now Playing engine, kept live rather
  // than forked into an independent copy — see beginTrimSlot), everything
  // else via its own independent engine's applyManualTrim.
  const trimTarget =
    selectedToolSlot === 'track'
      ? studioIsAligned
        ? { applyManualTrim: applyManualTrimAligned, confirmManualTrim: confirmManualTrimAligned }
        : studioIndependentPlayback
      : selectedToolSlot === 'internal'
        ? internalAudioRecorder
        : selectedToolSlot === 'mic'
          ? micRecorder
          : null

  // Builds the TrimOverlay for one waveform slot, wiring its drag callbacks
  // to update the live handle position (setTrimStart/etc, every pointer
  // move) and — only once a drag/toggle actually commits — re-slice the
  // buffer via trimTarget.applyManualTrim. Returns undefined for any slot
  // that isn't the one Trim Audio is currently narrowed to, so the other two
  // waveform components (which always render this prop) get no overlay.
  function renderTrimOverlay(slot: StudioSlot) {
    if (!trimMode || selectedToolSlot !== slot || !trimTarget) return undefined
    return (
      <TrimOverlay
        trimStart={trimStart}
        trimEnd={trimEnd}
        onTrimStartChange={(value, commit) => {
          setTrimStart(value)
          if (commit) {
            commitTrim(slot, value, trimEnd, { on: fadeInOn, ratio: fadeInRatio }, { on: fadeOutOn, ratio: fadeOutRatio })
          }
        }}
        onTrimEndChange={(value, commit) => {
          setTrimEnd(value)
          if (commit) {
            commitTrim(slot, trimStart, value, { on: fadeInOn, ratio: fadeInRatio }, { on: fadeOutOn, ratio: fadeOutRatio })
          }
        }}
        fadeInOn={fadeInOn}
        fadeInRatio={fadeInRatio}
        onFadeInRatioChange={(value, commit) => {
          setFadeInRatio(value)
          if (commit) {
            commitTrim(slot, trimStart, trimEnd, { on: fadeInOn, ratio: value }, { on: fadeOutOn, ratio: fadeOutRatio })
          }
        }}
        fadeOutOn={fadeOutOn}
        fadeOutRatio={fadeOutRatio}
        onFadeOutRatioChange={(value, commit) => {
          setFadeOutRatio(value)
          if (commit) {
            commitTrim(slot, trimStart, trimEnd, { on: fadeInOn, ratio: fadeInRatio }, { on: fadeOutOn, ratio: value })
          }
        }}
      />
    )
  }

  // The waveform can swap in asynchronously after the tab has already
  // switched to Studio (loadFileIntoStudio's IPC round-trip resolving a
  // moment after setAppView('studio') — e.g. from the "Open Song in
  // Studio" context menu action), which lands after the appView-triggered
  // nudge above already fired. Chromium's drag-region hit-test can then
  // still be stale for the newly-mounted play button (see the matching
  // comment on that effect and on the main-process handler) — nudge again
  // once the waveform's actual track identity changes.
  useEffect(() => {
    window.api.nudgeDragRegion?.()
  }, [studioDisplayTrack?.id])

  function clearStudio() {
    setStudioDroppedTrack(null)
    setStudioTrackImported(false)
  }

  function updateCurrentTrackArt(artPath: string | null) {
    if (!currentTrack) return

    const track = currentTrack
    // Apply the art to the app immediately, without touching the file's
    // embedded tags — the metadata prompt below only decides whether to
    // additionally write it to the file. Skipping that prompt must leave
    // this already-applied, metadata-free art in place, not undo it.
    platform.updateTrackArt(track.id, artPath, false).then(({ track: updated }) => {
      if (!updated) return
      applyTrackUpdateEverywhere(updated)
      setArtUpdatePrompt({ track: updated, artPath })
    })
  }

  function commitTrackArtUpdate(saveToMetadata: boolean) {
    if (!artUpdatePrompt) return
    const { track, artPath } = artUpdatePrompt
    setArtUpdatePrompt(null)

    // Skip: the art was already applied (app-only) when the prompt opened —
    // nothing left to do, and importantly no metadata write to make.
    if (!saveToMetadata) return

    platform.updateTrackArt(track.id, artPath, true).then(({ track: updated, metadataWriteFailed }) => {
      if (!updated) return
      applyTrackUpdateEverywhere(updated)
      // Mirrors applyPendingTagUpdate's own failedIds notice — the app-side
      // art (customArtPath) already applied fine either way, so without
      // this the file-level write failing was invisible.
      if (metadataWriteFailed) {
        setLibraryNotice('Could not save the album art to the file on disk — it may be open elsewhere. The change is kept in Volure only.')
      }
    })
  }

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return
    let cancelled = false

    stopWebAudio()
    trackBufferRef.current = null
    decodedBufferRef.current = null
    reversedBufferRef.current = null
    // A new track has no trim of its own — a manual trim applied to the
    // previous now-playing track must never bleed into whatever plays next.
    trimmedBufferRef.current = null
    manualTrimBaseRef.current = null
    alignedManualTrimDirtyRef.current = false
    setAlignedTrimmedPeaks(null)
    setAlignedTrimmedDuration(null)

    // On launch, the last-played track is restored into Now Playing paused
    // (see the getRecentlyPlayed restore above) — it's already the most
    // recently played track, so re-marking it and auto-starting playback
    // would be wrong.
    const isRestoring = isRestoringTrackRef.current
    isRestoringTrackRef.current = false
    needsReloadOnPlayRef.current = isRestoring

    if (!isRestoring) {
      const playedAt = Date.now()
      // Keep currentTrack resolvable via recentTracks even if folderTracks is cleared on navigation
      setRecentTracks((prev) => [
        { ...currentTrack, lastPlayedAt: playedAt },
        ...prev.filter((t) => t.id !== currentTrack.id),
      ])
      setTracks((prev) =>
        prev.map((t) => (t.id === currentTrack.id ? { ...t, lastPlayedAt: playedAt } : t))
      )
      setFolderTracks((prev) =>
        prev.map((t) => (t.id === currentTrack.id ? { ...t, lastPlayedAt: playedAt } : t))
      )
      setPlaylistTracks((prev) =>
        prev.map((t) => (t.id === currentTrack.id ? { ...t, lastPlayedAt: playedAt } : t))
      )
      setPlaylistPickerFolderTracks((prev) =>
        prev.map((t) => (t.id === currentTrack.id ? { ...t, lastPlayedAt: playedAt } : t))
      )
      platform.markPlayed(currentTrack.id).then(() => {
        if (activeSectionRef.current === 'recent') {
          platform.getRecentlyPlayed().then(setRecentTracks)
        }
      })
    }

    const mediaUrl = platform.getMediaUrl(currentTrack.filePath)
    if (!isRestoring) {
      // Stream straight from the media:// protocol instead of buffering the
      // whole file first — playback can start as soon as enough has arrived,
      // which matters most for large/one-off files that aren't part of a
      // scanned library folder.
      audio.src = mediaUrl
      audio.playbackRate = playbackSpeedRef.current
      resumeAudioContext()
      if (reverseAudioEnabledRef.current) {
        // Reversed playback needs the full track decoded first (see the
        // buffer fetch below) — starting forward playback here would be an
        // audible blip in the wrong direction before that handoff happens.
        setIsPlaying(true)
      } else {
        audio.play().catch((err) => {
          if (!cancelled) console.error(`Failed to play ${currentTrack.filePath}:`, err)
        })
        setIsPlaying(true)
      }
    }
    // else: leave audio.src untouched. Assigning it now, on a track that's
    // just sitting paused, lets Chromium abort the idle fetch shortly after
    // (normal behavior for a paused resource) — and that leaves the
    // element's media pipeline in a state no later reload can recover:
    // audio.currentTime and even the AudioContext's own clock keep
    // advancing normally on the next play() call, but the Web Audio tap
    // captures silence. togglePlay assigns src itself, for the first time,
    // at the moment the user actually presses play — matching this exact
    // sequence (fresh src, then play, immediately) the only way it's been
    // observed to reliably produce audible output.

    // Separately fetch the full buffer in the background, only so gapless
    // single-song looping (which needs a decoded AudioBuffer) can hand off
    // once it's ready. This never blocks playback start.
    fetch(mediaUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to read file (${res.status})`)
        const size = Number(res.headers.get('Content-Length') ?? 0)
        if (size > MAX_GAPLESS_DECODE_BYTES) {
          res.body?.cancel()
          return null
        }
        return res.arrayBuffer()
      })
      .then((buf) => {
        if (cancelled) return
        if (buf) {
          trackBufferRef.current = buf
          if (!isRestoring) {
            if (pitchSemitonesRef.current !== 0) {
              startPitchShiftPlayback(reverseAudioEnabledRef.current ? 0 : audio.currentTime, reverseAudioEnabledRef.current)
            } else if (reverseAudioEnabledRef.current) startReversePlayback(0)
            else if (loopModeRef.current === 'song') startWebAudioLoop(audio.currentTime)
          }
        } else if (!isRestoring && (reverseAudioEnabledRef.current || pitchSemitonesRef.current !== 0)) {
          // Track is too large to decode for reversal/pitch shift — fall
          // back to forward playback instead of leaving it silent.
          audio.play().catch((err) => console.error(`Failed to play ${currentTrack.filePath}:`, err))
        }
      })
      .catch((err) => {
        if (!cancelled) console.error(`Failed to buffer ${currentTrack.filePath} for gapless loop:`, err)
      })

    return () => {
      cancelled = true
    }
    // Deliberately keyed on the id rather than the currentTrack object: marking
    // a track as played updates its `lastPlayedAt` in `tracks`, which gives the
    // matched track a new object identity on every play and would otherwise
    // re-trigger this effect (reloading + restarting audio) in a loop.
  }, [currentTrackId, playTrigger])

  useEffect(() => {
    // Once the AudioContext graph exists, the <audio> element's own output is
    // captured entirely by its MediaElementAudioSourceNode and routed through
    // gainNode, so gainNode is the sole volume control — setting audio.volume
    // too would double-attenuate. Only fall back to audio.volume before the
    // graph exists (the brief window before the first play starts it up).
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volume
    } else if (audioRef.current) {
      audioRef.current.volume = volume
    }
  }, [volume])

  useEffect(() => {
    loopModeRef.current = loopMode
    // Native <audio loop> stays as a fallback in case Web Audio decoding fails.
    if (audioRef.current) audioRef.current.loop = loopMode === 'song'

    if (pitchShifterRef.current) {
      // The pitch-shift engine re-reads loopModeRef itself the next time
      // its buffer would naturally end (see startPitchShiftPlayback's onEnd
      // callback), so a live loop-mode change needs no immediate handoff.
      return
    }

    if (reversePlaybackActiveRef.current && sourceNodeRef.current) {
      // Reversed playback is already running on its own buffer source —
      // just flip its loop flag live instead of tearing it down and handing
      // off to the (forward) gapless loop engine.
      sourceNodeRef.current.loop = loopMode === 'song'
      return
    }

    if (loopMode === 'song') {
      startWebAudioLoop(audioRef.current?.currentTime ?? 0)
    } else {
      const offset = stopWebAudio()
      const audio = audioRef.current
      if (audio) {
        audio.currentTime = offset
        if (isPlaying) {
          resumeAudioContext()
          audio.play()
        }
      }
    }
  }, [loopMode])

  // Hands playback off to (or back from) the pitch-shift engine whenever
  // pitch moves away from / back to 0, and retunes it live otherwise.
  useEffect(() => {
    pitchSemitonesRef.current = pitchSemitones
    const shifter = pitchShifterRef.current

    if (shifter) {
      shifter.pitchSemitones = pitchSemitones
      if (pitchSemitones !== 0) return // still needed — nothing else to do

      // Pitch just returned to 0 — hand back to whichever plain engine
      // (native <audio>, gapless loop, or reverse buffer) the rest of the
      // current state actually calls for.
      const offset = stopWebAudio()
      if (reverseAudioEnabledRef.current) {
        startReversePlayback(offset)
      } else if (loopModeRef.current === 'song') {
        startWebAudioLoop(offset)
      } else {
        const audio = audioRef.current
        if (audio) {
          audio.currentTime = offset
          if (isPlaying) {
            resumeAudioContext()
            audio.play().catch((err) => console.error('Failed to resume playback:', err))
          }
        }
      }
      return
    }

    if (pitchSemitones === 0 || !currentTrack || !trackBufferRef.current) return
    // Pitch just became active — hand off to the pitch-shift engine from
    // whatever's currently playing, preserving position.
    const wasReversed = reversePlaybackActiveRef.current
    const offset = stopWebAudio()
    startPitchShiftPlayback(offset, wasReversed)
  }, [pitchSemitones])

  useEffect(() => {
    return () => {
      stopWebAudio()
      audioContextRef.current?.close()
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.code === 'Escape') {
        if (imageViewerFullscreen) {
          setImageViewerFullscreen(false)
          return
        }
        if (fullScreen) setFullScreen(false)
        return
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyN') {
        e.preventDefault()
        if (imageViewerOpen) {
          setImageViewerOpen(false)
          setImageViewerFullscreen(false)
        }
        if (videoViewerOpen) {
          setVideoViewerOpen(false)
          setVideoViewerFullscreen(false)
        }
        // Ctrl+N should always land on Now Playing, not stay in Customize.
        if (eqOpen) setEqOpen(false)
        if (currentTrack) setFullScreen(true)
        return
      }
      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.code === 'KeyP' || e.code === 'KeyS' || e.code === 'KeyH')
      ) {
        e.preventDefault()
        if (fullScreen) setFullScreen(false)
        if (imageViewerOpen) {
          setImageViewerOpen(false)
          setImageViewerFullscreen(false)
        }
        if (videoViewerOpen) {
          setVideoViewerOpen(false)
          setVideoViewerFullscreen(false)
        }
        if (e.code === 'KeyP') setAppView('play')
        else if (e.code === 'KeyS') setAppView('studio')
        else setAppView('media')
        return
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyI') {
        e.preventDefault()
        if (fullScreen) setFullScreen(false)
        setImageViewerOpen(true)
        return
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyC') {
        // Keep native copy behavior while typing; only hijack plain Ctrl+C
        // elsewhere to open the Customize (equalizer) view.
        const target = e.target as HTMLElement | null
        if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) {
          return
        }
        if (!currentTrack) return
        e.preventDefault()
        if (imageViewerOpen) {
          setImageViewerOpen(false)
          setImageViewerFullscreen(false)
        }
        if (videoViewerOpen) {
          setVideoViewerOpen(false)
          setVideoViewerFullscreen(false)
        }
        if (!fullScreen) setFullScreen(true)
        setEqOpen(true)
        return
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV') {
        // Ctrl+V still pastes normally while focus is in a text field —
        // only hijack it for the video viewer elsewhere in the app.
        const target = e.target as HTMLElement | null
        if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) {
          return
        }
        e.preventDefault()
        if (fullScreen) setFullScreen(false)
        setVideoViewerOpen(true)
        return
      }
      if (e.code !== 'Space') return
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) {
        return
      }
      e.preventDefault()
      if (videoViewerOpen && videoViewerPath) {
        toggleVideoPlay()
      } else if (currentTrack) {
        togglePlay()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    currentTrack,
    isPlaying,
    fullScreen,
    eqOpen,
    imageViewerOpen,
    imageViewerFullscreen,
    videoViewerOpen,
    videoViewerPath,
  ])

  useEffect(() => {
    return platform.onMediaPlayPause(() => {
      if (nowPlayingTrackRef.current) nowPlayingToggleRef.current()
    })
  }, [])

  useEffect(() => {
    return platform.onMediaNextTrack(() => {
      if (nowPlayingTrackRef.current) nowPlayingNextRef.current()
    })
  }, [])

  useEffect(() => {
    return platform.onMediaPrevTrack(() => {
      if (nowPlayingTrackRef.current) nowPlayingPrevRef.current()
    })
  }, [])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (nowPlayingTrackRef.current && !nowPlayingIsPlayingRef.current) nowPlayingToggleRef.current()
      })
      navigator.mediaSession.setActionHandler('pause', () => {
        if (nowPlayingTrackRef.current && nowPlayingIsPlayingRef.current) nowPlayingToggleRef.current()
      })
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        if (nowPlayingTrackRef.current) nowPlayingPrevRef.current()
      })
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (nowPlayingTrackRef.current) nowPlayingNextRef.current()
      })
    } catch {
      // Media Session actions are not supported by every Electron platform.
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler('play', null)
        navigator.mediaSession.setActionHandler('pause', null)
        navigator.mediaSession.setActionHandler('previoustrack', null)
        navigator.mediaSession.setActionHandler('nexttrack', null)
      } catch {
        // Ignore unsupported Media Session cleanup.
      }
    }
  }, [])

  // Windows' native transport control (SMTC, shown in the volume flyout and
  // taskbar even while Volure isn't focused) reads its title/artist/artwork
  // and play/pause glyph from navigator.mediaSession — keep both in sync
  // with whatever is actually loaded and playing.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!currentTrack) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
      return
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || 'Unknown title',
        artist: currentTrack.artist || '',
        album: currentTrack.album || '',
        artwork: currentArtSrc ? [{ src: currentArtSrc, sizes: '512x512' }] : [],
      })
    } catch {
      // Ignore unsupported artwork formats (e.g. malformed embedded art).
    }
  }, [currentTrack, currentArtSrc])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  }, [isPlaying, currentTrack])

  function applyTrackUpdateEverywhere(updated: Track) {
    setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    setFolderTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    setPlaylistTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    setPlaylistPickerFolderTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    setRecentTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
  }

  const applyDetectedKey = applyTrackUpdateEverywhere

  function toggleTrackFavorite(track: Track) {
    const nextFavorite = track.favorite ? false : true
    platform.setTrackFavorite(track.id, nextFavorite).then((updated) => {
      if (!updated) return
      applyTrackUpdateEverywhere(updated)
    })
  }

  function addToQueue(track: Track) {
    setQueue((prev) => [...prev, track])
  }

  function removeFromQueue(index: number) {
    setQueue((prev) => prev.filter((_, i) => i !== index))
  }

  function clearQueue() {
    setQueue([])
  }

  // Jumping to a queued track consumes it and everything skipped ahead of
  // it, matching how Prev/Next already discard played queue entries.
  function playFromQueue(index: number) {
    const track = queue[index]
    if (!track) return
    setQueue((prev) => prev.slice(index + 1))
    playTrack(track.id)
  }

  function ensureKeyDetectionWorker(): Worker {
    if (!keyDetectionWorkerRef.current) {
      keyDetectionWorkerRef.current = new Worker(
        new URL('./keyDetectionWorker.ts', import.meta.url),
        { type: 'module' }
      )
    }
    return keyDetectionWorkerRef.current
  }

  // Downmixes to mono at the track's native sample rate (no decimation —
  // picking every Nth sample without an anti-alias filter was folding high
  // frequencies back down into the analysis band as noise) and caps analysis
  // to a ~90s window from the middle of the track, so one very long file
  // can't stall the background queue behind it.
  function prepareSamplesForKeyDetection(buffer: AudioBuffer): { samples: Float32Array; sampleRate: number } {
    const { numberOfChannels, length, sampleRate } = buffer
    const mono = new Float32Array(length)
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < length; i++) mono[i] += data[i] / numberOfChannels
    }

    const maxSamples = Math.floor(sampleRate * 90)
    if (mono.length <= maxSamples) {
      return { samples: mono, sampleRate }
    }
    const start = Math.floor((mono.length - maxSamples) / 2)
    return { samples: mono.slice(start, start + maxSamples), sampleRate }
  }

  async function processNextKeyDetectionJob() {
    if (keyDetectionBusyRef.current) return
    const job = keyDetectionQueueRef.current.shift()
    if (!job) return
    keyDetectionBusyRef.current = true
    try {
      const res = await fetch(platform.getMediaUrl(job.filePath))
      const arrayBuffer = await res.arrayBuffer()
      if (!keyDetectionDecodeCtxRef.current) {
        keyDetectionDecodeCtxRef.current = new AudioContext()
      }
      const audioBuffer = await keyDetectionDecodeCtxRef.current.decodeAudioData(arrayBuffer)
      const { samples, sampleRate } = prepareSamplesForKeyDetection(audioBuffer)

      const worker = ensureKeyDetectionWorker()
      const result = await new Promise<KeyDetectionResponse['result']>((resolve) => {
        function handleMessage(e: MessageEvent<KeyDetectionResponse>) {
          if (e.data.id !== job!.id) return
          worker.removeEventListener('message', handleMessage)
          resolve(e.data.result)
        }
        worker.addEventListener('message', handleMessage)
        const request: KeyDetectionRequest = { id: job!.id, sampleRate, samples }
        worker.postMessage(request, [samples.buffer])
      })

      if (result) {
        const updated = await platform.setDetectedKey(job.id, result.key, result.keySignature)
        if (updated) applyDetectedKey(updated)
      }
    } catch (err) {
      console.error(`Key detection failed for ${job.filePath}:`, err)
    } finally {
      keyDetectionBusyRef.current = false
      processNextKeyDetectionJob()
    }
  }

  function enqueueKeyDetection(jobs: { id: number; filePath: string }[]) {
    if (jobs.length === 0) return
    keyDetectionQueueRef.current.push(...jobs)
    processNextKeyDetectionJob()
  }

  const LISTEN_DURATION_MS = 15000
  const LISTEN_WAIT_TIMEOUT_MS = 30000
  const LISTEN_SOUND_RMS_THRESHOLD = 0.015

  // Tears down whatever capture graph is currently live for Listen mode
  // (if any) — shared by startListenMode (which always clears out a prior
  // run before starting a fresh one) and cancelListenMode. Synchronous
  // aside from closing the AudioContext, so callers don't need to await it
  // before immediately starting a new capture.
  function teardownListenCapture() {
    if (listenTimeoutRef.current) {
      clearTimeout(listenTimeoutRef.current)
      listenTimeoutRef.current = null
    }
    if (listenWaitTimeoutRef.current) {
      clearTimeout(listenWaitTimeoutRef.current)
      listenWaitTimeoutRef.current = null
    }
    if (listenSoundPollRef.current) {
      clearInterval(listenSoundPollRef.current)
      listenSoundPollRef.current = null
    }
    listenProcessorRef.current?.disconnect()
    listenSourceRef.current?.disconnect()
    listenStreamRef.current?.getTracks().forEach((track) => track.stop())
    listenCtxRef.current?.close().catch(() => {})
    listenStreamRef.current = null
    listenCtxRef.current = null
    listenSourceRef.current = null
    listenAnalyserRef.current = null
    listenProcessorRef.current = null
    listenChunksRef.current = []
  }

  // Starts a fresh 15s system-audio capture for Studio's Listen tab. Reuses
  // getInternalAudioStream (the same silent, no-picker loopback capture
  // "Record Internal Audio" already uses) rather than the microphone, since
  // the point is the key of whatever the user is *listening to* — music
  // playing through their speakers — not whatever the mic happens to pick
  // up. Capture goes through the same mic-recorder-processor AudioWorklet as
  // useAudioRecorder, but the resulting buffer is only ever handed to the
  // key-detection worker in finishListenCapture below, never to save() or a
  // waveform.
  async function startListenMode() {
    teardownListenCapture()
    const runId = ++listenRunIdRef.current
    setListenStatus('listening')
    setListenResult(null)
    setListenError(null)
    try {
      const stream = await getInternalAudioStream()
      if (runId !== listenRunIdRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const ctx = new AudioContext()
      await ctx.audioWorklet.addModule(new URL('./micRecorderWorklet.js', import.meta.url))
      if (runId !== listenRunIdRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        await ctx.close()
        return
      }
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      const channelCount = Math.max(1, source.channelCount)
      const processor = new AudioWorkletNode(ctx, 'mic-recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount,
        outputChannelCount: [channelCount],
      })
      const chunks: Float32Array[][] = Array.from({ length: channelCount }, () => [])
      processor.port.onmessage = (event: MessageEvent<Float32Array[] | null>) => {
        if (!event.data) return
        for (let ch = 0; ch < channelCount; ch++) chunks[ch].push(event.data[ch])
      }

      // Same silent-routing trick as useAudioRecorder: the worklet only
      // runs while connected through to the destination, but Listen mode
      // must never audibly double up whatever's already playing.
      const silence = ctx.createGain()
      silence.gain.value = 0
      source.connect(processor)
      source.connect(analyser)
      processor.connect(silence)
      silence.connect(ctx.destination)

      listenStreamRef.current = stream
      listenCtxRef.current = ctx
      listenSourceRef.current = source
      listenAnalyserRef.current = analyser
      listenProcessorRef.current = processor
      listenChunksRef.current = chunks
      listenChannelCountRef.current = channelCount

      const samples = new Float32Array(analyser.fftSize)
      listenSoundPollRef.current = setInterval(() => {
        if (runId !== listenRunIdRef.current || !listenAnalyserRef.current) return
        analyser.getFloatTimeDomainData(samples)
        let sumSquares = 0
        for (const sample of samples) sumSquares += sample * sample
        const rms = Math.sqrt(sumSquares / samples.length)
        if (rms < LISTEN_SOUND_RMS_THRESHOLD) return

        if (listenSoundPollRef.current) {
          clearInterval(listenSoundPollRef.current)
          listenSoundPollRef.current = null
        }
        if (listenWaitTimeoutRef.current) {
          clearTimeout(listenWaitTimeoutRef.current)
          listenWaitTimeoutRef.current = null
        }
        processor.port.postMessage('start')
        listenTimeoutRef.current = setTimeout(() => finishListenCapture(runId), LISTEN_DURATION_MS)
      }, 50)
      listenWaitTimeoutRef.current = setTimeout(() => finishListenCapture(runId), LISTEN_WAIT_TIMEOUT_MS)
    } catch (err) {
      console.error('Failed to start Listen mode capture:', err)
      if (runId === listenRunIdRef.current) {
        setListenStatus('error')
        setListenError('Could not access system audio. Make sure something is playing and try again.')
      }
    }
  }

  async function finishListenCapture(runId: number) {
    if (runId !== listenRunIdRef.current) return
    const ctx = listenCtxRef.current
    const processor = listenProcessorRef.current
    const source = listenSourceRef.current
    const stream = listenStreamRef.current
    const chunks = listenChunksRef.current
    const channelCount = listenChannelCountRef.current
    listenTimeoutRef.current = null
    if (listenWaitTimeoutRef.current) {
      clearTimeout(listenWaitTimeoutRef.current)
      listenWaitTimeoutRef.current = null
    }
    if (listenSoundPollRef.current) {
      clearInterval(listenSoundPollRef.current)
      listenSoundPollRef.current = null
    }

    // Flush the worklet's last (possibly partial) chunk before tearing the
    // graph down — see useAudioRecorder.stopRecording for the identical
    // reasoning.
    if (processor) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200)
        processor.port.onmessage = (event: MessageEvent<Float32Array[] | null>) => {
          clearTimeout(timeout)
          if (event.data) {
            for (let ch = 0; ch < channelCount; ch++) chunks[ch].push(event.data[ch])
          }
          resolve()
        }
        processor.port.postMessage('flush')
      })
    }

    processor?.disconnect()
    source?.disconnect()
    stream?.getTracks().forEach((track) => track.stop())
    listenStreamRef.current = null
    listenCtxRef.current = null
    listenSourceRef.current = null
    listenAnalyserRef.current = null
    listenProcessorRef.current = null
    listenChunksRef.current = []

    if (runId !== listenRunIdRef.current) {
      if (ctx) await ctx.close().catch(() => {})
      return
    }

    const totalLength = chunks[0]?.reduce((sum, chunk) => sum + chunk.length, 0) ?? 0
    if (!ctx || totalLength === 0) {
      if (ctx) await ctx.close().catch(() => {})
      setListenStatus('error')
      setListenError('No audio detected. Play some music and try again.')
      return
    }

    const buffer = ctx.createBuffer(channelCount, totalLength, ctx.sampleRate)
    for (let ch = 0; ch < channelCount; ch++) {
      const channelData = buffer.getChannelData(ch)
      let offset = 0
      for (const chunk of chunks[ch]) {
        channelData.set(chunk, offset)
        offset += chunk.length
      }
    }
    await ctx.close()

    setListenStatus('analyzing')
    try {
      const { samples, sampleRate } = prepareSamplesForKeyDetection(buffer)
      const worker = ensureKeyDetectionWorker()
      const id = --listenDetectionIdRef.current
      const result = await new Promise<KeyDetectionResponse['result']>((resolve) => {
        function handleMessage(e: MessageEvent<KeyDetectionResponse>) {
          if (e.data.id !== id) return
          worker.removeEventListener('message', handleMessage)
          resolve(e.data.result)
        }
        worker.addEventListener('message', handleMessage)
        const request: KeyDetectionRequest = { id, sampleRate, samples }
        worker.postMessage(request, [samples.buffer])
      })
      if (runId !== listenRunIdRef.current) return
      if (result) {
        setListenResult(result)
        setListenStatus('done')
      } else {
        setListenStatus('error')
        setListenError('Could not detect a clear key. Try again once the music is a bit louder.')
      }
    } catch (err) {
      console.error('Listen mode key detection failed:', err)
      if (runId === listenRunIdRef.current) {
        setListenStatus('error')
        setListenError('Key detection failed. Try again.')
      }
    }
  }

  function cancelListenMode() {
    listenRunIdRef.current++
    teardownListenCapture()
    setListenStatus('idle')
    setListenResult(null)
    setListenError(null)
  }

  async function handleAddFolder() {
    const folder = await platform.selectFolder()
    if (!folder) return
    setPendingFolderPath(folder)
  }

  async function handleAddAudioFile() {
    const filePath = await window.api.selectAudioFile()
    if (!filePath) return
    setScanning(true)
    try {
      const result = await window.api.playDroppedFile(filePath)
      if (!result?.track) return
      if (!result.track.inLibrary) {
        await platform.setTrackInLibrary(result.track.id, true)
      }
      if (result.inserted) {
        enqueueKeyDetection([{ id: result.track.id, filePath: result.track.filePath }])
      }
      await Promise.all([
        platform.getTracks().then(setTracks),
        platform.getRecentlyPlayed().then(setRecentTracks),
      ])
    } catch (err) {
      console.error(`Failed to add file ${filePath} to the library:`, err)
    } finally {
      setScanning(false)
    }
  }

  async function confirmAddFolder(includeInLibrary: boolean) {
    const folder = pendingFolderPath
    setPendingFolderPath(null)
    if (!folder) return
    setScanning(true)
    try {
      const result = await platform.scanLibrary(folder, !includeInLibrary)
      setTracks(result.tracks)
      await platform.getFolders().then(setFolders)
      enqueueKeyDetection(result.newTracks)
    } catch (err) {
      console.error(`Failed to scan folder ${folder}:`, err)
    } finally {
      setScanning(false)
    }
  }

  function playTrack(id: number) {
    setCurrentTrackId(id)
    if (shuffle) {
      setShuffleHistory([id])
      setShuffleHistoryPos(0)
    }
  }

  function openNowPlaying(id: number) {
    playTrack(id)
    setFullScreen(true)
  }

  function togglePlay() {
    if (webAudioActiveRef.current) {
      const ctx = audioContextRef.current
      if (!ctx) return
      if (isPlaying) {
        ctx.suspend()
        setIsPlaying(false)
      } else {
        ctx.resume()
        setIsPlaying(true)
      }
      return
    }

    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      if (needsReloadOnPlayRef.current && currentTrack) {
        // First real play of a track restored into Now Playing paused on
        // launch. Manually assigning src and calling play() here — even
        // with an otherwise-identical sequence to a normal track load —
        // has been observed to produce a live-clocked but totally silent
        // AudioContext graph (confirmed by tapping the actual sample data,
        // not just currentTime). Re-driving the currentTrackId effect
        // instead reuses the exact sequence that reliably works for every
        // other track load in the app, rather than a hand-rolled imitation
        // of it.
        needsReloadOnPlayRef.current = false
        const idToResume = currentTrack.id
        setCurrentTrackId(null)
        setTimeout(() => setCurrentTrackId(idToResume), 0)
        return
      }
      // A track resumed after the AudioContext graph already exists but is
      // suspended needs the context genuinely running before play() will
      // produce audible, advancing playback — calling play() before
      // resume() settles leaves the element's output captured by a silent,
      // unstarted graph.
      const ctx = ensureAudioContext()
      const startPlayback = () =>
        audio.play().catch((err) => console.error('Failed to resume playback:', err))
      if (ctx.state === 'suspended') {
        ctx.resume().then(startPlayback, startPlayback)
      } else {
        startPlayback()
      }
      setIsPlaying(true)
    }
  }

  nowPlayingToggleRef.current = togglePlay

  function goNext() {
    if (!currentTrack) return

    // Queued-up tracks take priority over the natural playback order.
    if (queue.length > 0) {
      const [next, ...rest] = queue
      setQueue(rest)
      setCurrentTrackId(next.id)
      if (shuffle) {
        setShuffleHistory((prev) => [...prev, next.id])
        setShuffleHistoryPos((prev) => prev + 1)
      }
      return
    }

    // Use the folder's track list when the current track lives only there
    const inLibrary = playbackOrder.some((t) => t.id === currentTrack.id)
    const activeOrder = inLibrary
      ? playbackOrder
      : sortTracks(visibleFolderTracks, sortBy, sortDir)

    if (activeOrder.length === 0) return

    if (shuffle) {
      if (shuffleHistoryPos < shuffleHistory.length - 1) {
        const pos = shuffleHistoryPos + 1
        setShuffleHistoryPos(pos)
        setCurrentTrackId(shuffleHistory[pos])
        return
      }
      const candidates = activeOrder.filter((t) => t.id !== currentTrack.id)
      const pool = candidates.length > 0 ? candidates : activeOrder
      const next = pool[Math.floor(Math.random() * pool.length)]
      const history = [...shuffleHistory, next.id]
      setShuffleHistory(history)
      setShuffleHistoryPos(history.length - 1)
      setCurrentTrackId(next.id)
      return
    }

    const index = activeOrder.findIndex((t) => t.id === currentTrack.id)
    let nextIndex = index + 1
    if (nextIndex >= activeOrder.length) {
      if (loopMode === 'off') return
      nextIndex = 0
    }
    setCurrentTrackId(activeOrder[nextIndex].id)
  }

  function goPrev() {
    if (!currentTrack) return

    const inLibrary = playbackOrder.some((t) => t.id === currentTrack.id)
    const activeOrder = inLibrary
      ? playbackOrder
      : sortTracks(visibleFolderTracks, sortBy, sortDir)

    if (activeOrder.length === 0) return

    if (shuffle) {
      if (shuffleHistoryPos > 0) {
        const pos = shuffleHistoryPos - 1
        setShuffleHistoryPos(pos)
        setCurrentTrackId(shuffleHistory[pos])
      }
      return
    }

    const index = activeOrder.findIndex((t) => t.id === currentTrack.id)
    let prevIndex = index - 1
    if (prevIndex < 0) {
      if (loopMode === 'off') return
      prevIndex = activeOrder.length - 1
    }
    setCurrentTrackId(activeOrder[prevIndex].id)
  }

  nowPlayingNextRef.current = goNext
  nowPlayingPrevRef.current = goPrev

  function handleEnded() {
    // Song-repeat is handled by the Web Audio loop engine (or native audio.loop as
    // a fallback), so <audio> only reaches 'ended' for non-repeat playback.
    goNext()
  }

  function cycleLoopMode() {
    setLoopMode((mode) => (mode === 'off' ? 'playlist' : mode === 'playlist' ? 'song' : 'off'))
  }

  function seekTo(value: number) {
    if (pitchShifterRef.current) {
      const shifter = pitchShifterRef.current
      shifter.percentagePlayed = shifter.duration > 0 ? value / shifter.duration : 0
    } else if (reversePlaybackActiveRef.current) {
      stopWebAudio()
      startReversePlayback(value)
    } else if (webAudioActiveRef.current) {
      stopWebAudio()
      startWebAudioLoop(value)
    } else if (audioRef.current) {
      audioRef.current.currentTime = value
    }
    setCurrentTime(value)
  }

  function toggleShuffle() {
    setShuffle((current) => {
      const next = !current
      if (next && currentTrack) {
        setShuffleHistory([currentTrack.id])
        setShuffleHistoryPos(0)
      }
      return next
    })
  }

  function toggleMute() {
    if (volume > 0) {
      setPreviousVolume(volume)
      setVolume(0)
    } else {
      setVolume(previousVolume > 0 ? previousVolume : 0.2)
    }
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault()
    dragCounterRef.current++
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
  }

  // Loads a file into Studio only — used by both a Studio-view drop and the
  // "Studio Is Currently Empty" picker button. Must never touch Now
  // Playing/playback, so currentTrackId, playTrigger, fullScreen, and
  // shuffle are all deliberately left untouched here.
  function loadFileIntoStudio(filePath: string) {
    window.api.playDroppedFile(filePath).then((result) => {
      if (!result?.track) return
      const { track, inserted } = result
      setRecentTracks((prev) => [track, ...prev.filter((t) => t.id !== track.id)])
      if (track.inLibrary) {
        setTracks((prev) => (prev.some((t) => t.id === track.id) ? prev : [...prev, track]))
      }
      setStudioTrackImported(false)
      setStudioDroppedTrack(track)
      if (inserted) enqueueKeyDetection([{ id: track.id, filePath: track.filePath }])
    })
  }

  function importFileIntoStudio() {
    window.api.selectAudioFile().then((filePath) => {
      if (filePath) loadFileIntoStudio(filePath)
    })
  }

  // Loads a video into the Video Viewer, from any screen, without touching
  // Now Playing/audio state — playing a video is not allowed to silently
  // stop whatever song is currently playing, so if audio is mid-playback
  // the user is asked first (see the "Pause Current Audio Playback?" modal).
  function openVideoViewer(filePath: string) {
    if (fullScreen) setFullScreen(false)
    if (imageViewerOpen) {
      setImageViewerOpen(false)
      setImageViewerFullscreen(false)
    }
    setVideoViewerPath(filePath)
    setVideoViewerFullscreen(true)
    setVideoViewerOpen(true)
    if (isPlaying) setPauseAudioPrompt(true)
  }

  // A finished screen recording only ever lands in a scratch temp file (see
  // useScreenRecorder/library:stageScreenRecording) — nothing is written
  // anywhere the user would consider "saved" until they explicitly download
  // it here, which just copies that temp file to their chosen destination.
  async function downloadCurrentRecording() {
    if (!videoViewerPath || videoDownloading) return
    setVideoDownloading(true)
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const savedPath = await window.api.downloadScreenRecording(
        videoViewerPath,
        `Screen Recording ${timestamp}.mp4`
      )
      if (savedPath) setLibraryNotice('Recording saved')
    } catch (err) {
      console.error('Failed to download screen recording:', err)
    } finally {
      setVideoDownloading(false)
    }
  }

  function toggleVideoPlay() {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch((err) => console.error('Failed to play video:', err))
    else video.pause()
  }

  // Called directly from the pause-audio-prompt modal's Yes/No buttons (in
  // addition to the videoPlayableSrc/pauseAudioPrompt effect above) so
  // playback starts the instant the prompt is answered, rather than waiting
  // on the next effect pass. A no-op if the video hasn't finished loading
  // yet — the effect covers that case once it does.
  function resumeVideoAfterPrompt() {
    videoRef.current?.play().catch((err) => console.error('Failed to start video playback:', err))
  }

  function skipVideo(seconds: number) {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), video.duration || Infinity)
  }

  function revealVideoControls() {
    setVideoControlsVisible(true)
    if (videoControlsHideTimerRef.current) clearTimeout(videoControlsHideTimerRef.current)
    videoControlsHideTimerRef.current = setTimeout(() => setVideoControlsVisible(false), 5000)
  }

  function revealImageControls() {
    setImageControlsVisible(true)
    if (imageControlsHideTimerRef.current) clearTimeout(imageControlsHideTimerRef.current)
    imageControlsHideTimerRef.current = setTimeout(() => setImageControlsVisible(false), 5000)
  }

  function revealImageCursor() {
    setImageCursorVisible(true)
    if (imageCursorHideTimerRef.current) clearTimeout(imageCursorHideTimerRef.current)
    imageCursorHideTimerRef.current = setTimeout(() => setImageCursorVisible(false), 5000)
  }

  // Lets a click on the image itself dismiss the HUD immediately instead of
  // waiting out the 5s timer.
  function hideImageControlsNow() {
    if (imageControlsHideTimerRef.current) clearTimeout(imageControlsHideTimerRef.current)
    setImageControlsVisible(false)
  }

  // Lets a click on the image itself hide the cursor immediately instead of
  // waiting out the 5s idle timer.
  function hideImageCursorNow() {
    if (imageCursorHideTimerRef.current) clearTimeout(imageCursorHideTimerRef.current)
    setImageCursorVisible(false)
  }

  // In the immersive fullscreen view, the HUD (and the native titlebar
  // overlay buttons, see the titleBarOverlay effect below) should only
  // reappear when the cursor is actually over the top bar or bottom
  // playback-bar bands — not on any movement over the image itself. The
  // cursor itself isn't held to that restriction: any movement snaps it
  // back visible immediately, in or out of fullscreen.
  function handleImageViewerMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    revealImageCursor()
    if (!imageViewerFullscreen) {
      revealImageControls()
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const nearTop = e.clientY - rect.top <= IMAGE_HUD_TOP_ZONE_PX
    const nearBottom = rect.bottom - e.clientY <= IMAGE_HUD_BOTTOM_ZONE_PX
    if (nearTop || nearBottom) revealImageControls()
  }

  // A click anywhere on the viewer outside the top/bottom bar bands hides
  // both the HUD and the cursor right away, without waiting on the idle
  // timers.
  function handleImageViewerClick(e: React.MouseEvent<HTMLDivElement>) {
    if (imageJustPannedRef.current) {
      imageJustPannedRef.current = false
      return
    }
    if (imageCropActive) return
    const rect = e.currentTarget.getBoundingClientRect()
    const nearTop = e.clientY - rect.top <= IMAGE_HUD_TOP_ZONE_PX
    const nearBottom = rect.bottom - e.clientY <= IMAGE_HUD_BOTTOM_ZONE_PX
    if (nearTop || nearBottom) return
    hideImageControlsNow()
    hideImageCursorNow()
  }

  // Click-and-drag to pan around a zoomed-in image. Only active once zoomed
  // past 1x — at 1x the image already fits the container, so there's
  // nowhere to pan.
  function handleImagePointerDown(e: React.PointerEvent<HTMLImageElement>) {
    if (imageCropActive || imageZoom <= 1) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    imagePanDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: imagePanX,
      startPanY: imagePanY,
      moved: false,
    }
  }

  function handleImagePointerMove(e: React.PointerEvent<HTMLImageElement>) {
    const drag = imagePanDragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true
    const clamped = clampImagePan(drag.startPanX + dx, drag.startPanY + dy, imageZoom)
    setImagePanX(clamped.x)
    setImagePanY(clamped.y)
  }

  function handleImagePointerUp(e: React.PointerEvent<HTMLImageElement>) {
    const drag = imagePanDragRef.current
    if (!drag) return
    if (drag.moved) imageJustPannedRef.current = true
    imagePanDragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  function toggleImageViewerFullscreen() {
    const next = !imageViewerFullscreen
    setImageViewerFullscreen(next)
    // Entering the immersive view should hide the cursor immediately rather
    // than waiting for the idle timer or the next mouse movement.
    if (next) hideImageCursorNow()
  }

  function startImageCrop() {
    setImageCropBounds(null)
    setImageCropRect(null)
    imageCropPrevBoundsRef.current = null
    setImageCropActive(true)
    // Cropping always starts from the image at its fit-to-container size —
    // scrolling to zoom out from there is still allowed once crop mode is on.
    setImageZoom(1)
  }

  function cancelImageCrop() {
    setImageCropActive(false)
    setImageCropBounds(null)
    setImageCropRect(null)
    imageCropPrevBoundsRef.current = null
  }

  // Loads whatever's currently on screen as a decoded <img> for canvas use —
  // the crop result (a data: URL) is always canvas-safe, and the original
  // file is re-fetched as a blob: URL rather than reused from the live
  // media:// <img> so neither ever risks tainting the canvas.
  async function loadCurrentImagePixels(): Promise<HTMLImageElement> {
    const src = imageEditedSrc ?? (imageViewerPath ? await toBlobUrl(imageViewerPath) : null)
    if (!src) throw new Error('No image loaded')
    return await loadImageElement(src)

    async function toBlobUrl(filePath: string) {
      const res = await fetch(platform.getMediaUrl(filePath))
      if (!res.ok) throw new Error(`Failed to read image (${res.status})`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      try {
        // Resolved before the finally below runs, so the decode has already
        // captured the bytes it needs by the time the URL is revoked.
        return objectUrl
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
      }
    }
  }

  async function applyImageCrop() {
    if (!imageCropRect || !imageCropBounds) return
    try {
      const img = await loadCurrentImagePixels()
      const scaleX = img.naturalWidth / imageCropBounds.width
      const scaleY = img.naturalHeight / imageCropBounds.height
      const sx = imageCropRect.x * scaleX
      const sy = imageCropRect.y * scaleY
      const sw = imageCropRect.width * scaleX
      const sh = imageCropRect.height * scaleY
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(sw))
      canvas.height = Math.max(1, Math.round(sh))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
      setImageEditedSrc(canvas.toDataURL('image/png'))
      setImageCropActive(false)
      setImageCropBounds(null)
      setImageCropRect(null)
      imageCropPrevBoundsRef.current = null
    } catch (err) {
      console.error('Failed to crop image:', err)
    }
  }

  async function saveViewerImage(format: 'png' | 'jpg') {
    setImageSaving(true)
    setImageSaveError(false)
    try {
      const img = await loadCurrentImagePixels()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas unavailable')
      ctx.drawImage(img, 0, 0)
      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.92))
      if (!blob) throw new Error('Failed to encode image')
      const buffer = await blob.arrayBuffer()
      const baseName = imageViewerPath ? baseFileNameWithoutExt(imageViewerPath) : 'image'
      await window.api.saveImageFile(`${baseName}.${format}`, buffer, format)
    } catch (err) {
      console.error('Failed to save image:', err)
      setImageSaveError(true)
      imageSaveErrorTimeoutRef.current = setTimeout(() => setImageSaveError(false), 4000)
    } finally {
      setImageSaving(false)
    }
  }

  async function copyViewerImage() {
    if (!imageViewerPath) return
    try {
      await window.api.copyImageToClipboard(imageViewerPath, imageEditedSrc ?? undefined)
      setImageCopied(true)
      if (imageCopiedTimeoutRef.current) clearTimeout(imageCopiedTimeoutRef.current)
      imageCopiedTimeoutRef.current = setTimeout(() => {
        setImageCopied(false)
        imageCopiedTimeoutRef.current = null
      }, 2000)
    } catch (err) {
      console.error('Failed to copy image:', err)
    }
  }

  async function captureViewerScreenshot(seconds: number) {
    if (screenshotCountdown !== null) return
    try {
      if (seconds > 0) {
        const targetTime = Date.now() + seconds * 1000
        setScreenshotCountdown(seconds)
        await new Promise<void>((resolve) => {
          screenshotCountdownIntervalRef.current = window.setInterval(() => {
            const remaining = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000))
            setScreenshotCountdown(remaining)
            if (remaining <= 0) {
              if (screenshotCountdownIntervalRef.current) {
                clearInterval(screenshotCountdownIntervalRef.current)
                screenshotCountdownIntervalRef.current = null
              }
              resolve()
            }
          }, 200)
        })
        setScreenshotCountdown(null)
        // Give the countdown overlay a frame to actually disappear before the
        // capture happens, so it doesn't end up baked into the screenshot.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      }
      // Fire the shutter sound the instant the shot is taken, like a real
      // camera — not after captureScreenshot's desktopCapturer round-trip
      // (which can take a few seconds) finishes writing the file to disk.
      const screenshotSound = new Audio('/sound-effects/screenshot1.wav')
      screenshotSound.volume = 1
      screenshotSound.play().catch(() => {})
      const filePath = await window.api.captureScreenshot(0)
      if (!filePath) return
      setImageViewerPath(filePath)
      setImageEditedSrc(null)
    } catch (err) {
      console.error('Failed to capture screenshot:', err)
    } finally {
      setScreenshotCountdown(null)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)

    const file = e.dataTransfer.files[0]
    if (!file) return
    const filePath = window.api.getPathForFile(file)
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()

    // Images open the Image Viewer instead of the audio flow below,
    // regardless of which view they're dropped on, and never touch
    // playback/Now Playing state.
    if (IMAGE_VIEWER_EXTENSIONS.has(ext)) {
      if (fullScreen) setFullScreen(false)
      setImageViewerPath(filePath)
      setImageViewerFullscreen(false)
      setImageViewerOpen(true)
      return
    }

    // Videos open the Video Viewer instead of the audio flow below,
    // regardless of which view they're dropped on.
    if (VIDEO_VIEWER_EXTENSIONS.has(ext)) {
      openVideoViewer(filePath)
      setVideoIsUnsavedRecording(false)
      return
    }

    // On the Studio view, a drop loads the file into Studio only.
    if (appView === 'studio' && !fullScreen) {
      loadFileIntoStudio(filePath)
      return
    }

    window.api.playDroppedFile(filePath).then((result) => {
      if (!result?.track) return
      const { track, inserted } = result
      setRecentTracks((prev) => [track, ...prev.filter((t) => t.id !== track.id)])
      if (track.inLibrary) {
        setTracks((prev) => (prev.some((t) => t.id === track.id) ? prev : [...prev, track]))
      }
      setPlayTrigger((n) => n + 1)
      setCurrentTrackId(track.id)
      setFullScreen(true)
      if (shuffle) {
        setShuffleHistory([track.id])
        setShuffleHistoryPos(0)
      }
      if (inserted) enqueueKeyDetection([{ id: track.id, filePath: track.filePath }])
    })
  }

  // Cropping needs the Apply/Cancel controls reachable no matter how long the
  // user pauses to line up the selection, so crop mode pins the HUD visible
  // regardless of the inactivity timer.
  const imageHudVisible = imageControlsVisible || imageCropActive

  return (
    <div
      ref={appRootRef}
      className={`app${import.meta.env.VOLURE_MOBILE ? ' mobile' : ''}${isDragging ? ' drag-active' : ''}${nightMode ? ' night-mode' : ''}${appView === 'studio' && !fullScreen ? ' studio-mode' : ''}${
        developerMode ? ' developer-mode' : ''
      }`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {libraryNotice && (
        <div className="app-notice" role="status" aria-live="polite">
          {libraryNotice}
        </div>
      )}
      <div className="background" />
      <div className="background-night" />
      {(imageViewerFullscreen || videoViewerFullscreen || osFullscreen) && (
        <button
          type="button"
          className="fullscreen-exit-control"
          onClick={() => {
            if (imageViewerFullscreen) {
              setImageViewerOpen(false)
              setImageViewerFullscreen(false)
            }
            if (videoViewerFullscreen) {
              setVideoViewerOpen(false)
              setVideoViewerFullscreen(false)
            }
            if (osFullscreen) {
              window.api.exitWindowFullscreen()
            }
          }}
          title="Exit full screen"
        >
          <CloseIcon />
        </button>
      )}
      <div className="overlay">
        {activePanel === 'image' ? (
          <div
            ref={imageViewerContainerRef}
            className={`image-viewer${imageViewerFullscreen ? ' image-viewer-fullscreen' : ''}${!imageViewerPath ? ' image-viewer-empty' : ''}${!imageCursorVisible ? ' image-viewer-cursor-hidden' : ''}${imageViewerClosing ? ' image-viewer-closing' : ''}`}
            onMouseMove={handleImageViewerMouseMove}
            onClick={handleImageViewerClick}
          >
            <div className="image-viewer-drag-strip" />
            <div className={`image-viewer-controls${imageHudVisible ? ' image-viewer-controls-visible' : ''}`}>
              {imageViewerPath && (
                <div className="image-viewer-topbar">
                  <span className="image-viewer-topbar-title">
                    {imageViewerPath.split(/[\\/]/).pop()}
                  </span>
                </div>
              )}
              <div className="image-viewer-controls-left">
                <button
                  type="button"
                  className="image-viewer-return"
                  onClick={() => {
                    if (imageCropActive) cancelImageCrop()
                    setImageViewerOpen(false)
                    setImageViewerFullscreen(false)
                  }}
                  title="Return"
                >
                  <BackIcon />
                </button>
                {imageViewerPath && (
                  <button
                    type="button"
                    className={`image-viewer-edit${imageCropActive ? ' active' : ''}`}
                    onClick={() => (imageCropActive ? cancelImageCrop() : startImageCrop())}
                    title={imageCropActive ? 'Cancel edit' : 'Edit image'}
                  >
                    <EditIcon />
                    <span>Edit</span>
                  </button>
                )}
                {imageCropActive && (
                  <button
                    type="button"
                    className="image-viewer-crop-apply"
                    onClick={applyImageCrop}
                    title="Apply crop"
                  >
                    <CheckIcon />
                  </button>
                )}
                {imageViewerPath && !imageCropActive && (
                  <>
                    <ImageSaveMenu onSave={saveViewerImage} saving={imageSaving} failed={imageSaveError} />
                    <button
                      type="button"
                      className="image-viewer-copy"
                      onClick={copyViewerImage}
                      title={imageCopied ? 'Image copied' : 'Copy image'}
                    >
                      {imageCopied ? <CheckIcon /> : <CopyIcon />}
                    </button>
                    <button
                      type="button"
                      className="image-viewer-remove"
                      onClick={() => setImageViewerPath(null)}
                      title="Remove image"
                    >
                      <RemoveIcon />
                    </button>
                  </>
                )}
              </div>
            </div>
            {imageViewerPath ? (
              <img
                ref={imageViewerImgRef}
                src={imageEditedSrc ?? platform.getMediaUrl(imageViewerPath)}
                className={`image-viewer-img${imageZoom > 1 ? ' image-viewer-img-zoomed' : ''}`}
                alt=""
                draggable={false}
                style={
                  imageZoom !== 1 || imagePanX !== 0 || imagePanY !== 0
                    ? { transform: `translate(${imagePanX}px, ${imagePanY}px) scale(${imageZoom})` }
                    : undefined
                }
                onPointerDown={handleImagePointerDown}
                onPointerMove={handleImagePointerMove}
                onPointerUp={handleImagePointerUp}
              />
            ) : (
              <div className="image-viewer-empty-state">
                <p>Add an Image</p>
                <div className="image-viewer-empty-actions">
                  <button
                    type="button"
                    className="image-viewer-add-button"
                    onClick={() => {
                      window.api.selectViewerImage().then((filePath) => {
                        if (filePath) setImageViewerPath(filePath)
                      })
                    }}
                    title="Add an image from your computer"
                  >
                    <PlusIcon />
                  </button>
                  <ImageScreenshotMenu onCapture={captureViewerScreenshot} countdown={screenshotCountdown} />
                </div>
              </div>
            )}
            {imageCropActive && imageCropBounds && imageCropRect && (
              <ImageCropOverlay bounds={imageCropBounds} rect={imageCropRect} onChange={setImageCropRect} />
            )}
            {screenshotCountdown !== null && (
              <div className="image-viewer-screenshot-overlay">
                <span key={screenshotCountdown} className="image-viewer-screenshot-overlay-number">
                  {screenshotCountdown}
                </span>
              </div>
            )}
          </div>
        ) : activePanel === 'video' ? (
          <div
            className={`video-viewer${videoViewerFullscreen ? ' video-viewer-fullscreen' : ''}${!videoViewerPath ? ' video-viewer-empty' : ''}${videoViewerFullscreen && !videoControlsVisible ? ' video-viewer-cursor-hidden' : ''}${videoViewerClosing ? ' video-viewer-closing' : ''}`}
            onMouseMove={revealVideoControls}
          >
            <div className={`video-viewer-controls${videoControlsVisible ? ' video-viewer-controls-visible' : ''}`}>
              <div className="video-viewer-controls-left">
                <button
                  type="button"
                  className="video-viewer-return"
                  onClick={() => {
                    setVideoViewerOpen(false)
                    setVideoViewerFullscreen(false)
                  }}
                  title="Return"
                >
                  <BackIcon />
                </button>
              </div>
              {videoViewerPath && videoIsUnsavedRecording && (
                <div className="video-viewer-controls-right">
                  <button
                    type="button"
                    className="video-viewer-download"
                    onClick={downloadCurrentRecording}
                    disabled={videoDownloading}
                    title="Download recording"
                  >
                    <SaveIcon />
                  </button>
                </div>
              )}
            </div>
            {videoViewerPath && videoPlayableSrc ? (
              <video
                ref={videoRef}
                src={platform.getMediaUrl(videoPlayableSrc)}
                className="video-viewer-video"
                loop
                onClick={toggleVideoPlay}
                onTimeUpdate={(e) => setVideoCurrentTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
                onPlay={() => setVideoIsPlaying(true)}
                onPause={() => setVideoIsPlaying(false)}
                onEnded={() => setVideoIsPlaying(false)}
                onError={(e) => {
                  const video = e.currentTarget
                  console.error(
                    `<video> playback error for ${videoViewerPath}: code ${video.error?.code} - ${video.error?.message}`
                  )
                  // Chromium has no HEVC decoder and rejects some H.264
                  // profiles outright — both surface here as a generic
                  // error with no useful recovery except transcoding a
                  // browser-safe copy (see ensurePlayableVideo) and
                  // swapping to it. Only tried once per loaded file.
                  if (!videoViewerPath || videoFallbackAppliedRef.current) return
                  videoFallbackAppliedRef.current = true
                  window.api.ensurePlayableVideo?.(videoViewerPath).then((playablePath) => {
                    if (!playablePath || videoRef.current !== video) return
                    video.src = platform.getMediaUrl(playablePath)
                    video.load()
                    video.play().catch((err) => console.error('Failed to play transcoded video fallback:', err))
                  })
                }}
              />
            ) : videoPreparing ? (
              <div className="video-viewer-empty-state">
                <p>Preparing video…</p>
              </div>
            ) : (
              <div className="video-viewer-empty-state">
                <p>Add a Video</p>
                <div className="video-viewer-empty-actions">
                  <button
                    type="button"
                    className="video-viewer-add-button"
                    onClick={() => {
                      window.api.selectViewerVideo().then((filePath) => {
                        if (filePath) {
                          openVideoViewer(filePath)
                          setVideoIsUnsavedRecording(false)
                        }
                      })
                    }}
                    title="Add a video from your computer"
                  >
                    <PlusIcon />
                  </button>
                  <VideoScreenRecordMenu
                    onRecord={(seconds) => screenRecorder.beginRecordingWithDelay(seconds)}
                    onStop={screenRecorder.toggleRecording}
                    recording={screenRecorder.recording}
                    pendingSeconds={screenRecorder.countdown}
                  />
                </div>
              </div>
            )}
          </div>
        ) : activePanel === 'fullscreen' ? (
          eqOpen ? (
            <div className="equalizer-view">
              <div className="equalizer-view-drag-strip" />
              <DeveloperEditableNode
                id="eqBackButton"
                tag="button"
                className="fullscreen-back"
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'eqBackButton'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                onClick={() => setEqOpen(false)}
                title="Back"
                type="button"
              >
                <BackIcon />
              </DeveloperEditableNode>
              <div className="equalizer-presets">
                {effectiveTrackKey && (
                  <button
                    type="button"
                    className="equalizer-header-key-badge current-key-badge-clickable"
                    onClick={() => playKeyboardRef.current?.transposeToKeyRoot(effectiveTrackKey)}
                    title={`Transpose keyboard to ${effectiveTrackKey}`}
                    aria-label={`Current key ${effectiveTrackKey}`}
                  >
                    {effectiveTrackKey}
                  </button>
                )}
                <PresetsMenu
                  presets={allCustomizePresets}
                  defaultPresetName={DEFAULT_CUSTOMIZE_PRESET.name}
                  favoritePresetNames={favoritePresetNames}
                  onApply={applyCustomizePreset}
                  onSave={saveCustomizePreset}
                  onDelete={deleteCustomizePreset}
                  onToggleFavorite={toggleFavoritePreset}
                />
              </div>
              <div className="equalizer-title-row">
                <h2 className="equalizer-title">Equalizer</h2>
                <EqPresetsMenu
                  presets={allEqPresets}
                  onApply={applyEqPreset}
                  onSave={saveEqPreset}
                  onDelete={deleteEqPreset}
                />
              </div>
              <EqualizerBands gains={eqGains} onChange={setEqBandGain} onReset={resetEq} />
              <PlaybackSpeedControl
                playbackSpeed={playbackSpeed}
                setPlaybackSpeed={setPlaybackSpeed}
                applyPlaybackSpeed={applyPlaybackSpeed}
                speedSnapEnabled={speedSnapEnabled}
                onToggleSnap={() => setSpeedSnapEnabled((v) => !v)}
                variant="customize"
              />
              <PitchShiftControl pitchSemitones={pitchSemitones} setPitchSemitones={setPitchSemitones} />
              <button
                className={`reverse-audio-toggle${reverseAudioEnabled ? ' active' : ''}`}
                onClick={() => applyReverseAudioState(!reverseAudioEnabled)}
                aria-pressed={reverseAudioEnabled}
              >
                <ReverseIcon />
                Reverse Audio
              </button>
            </div>
          ) : (
          <div className="now-playing-full">
            <div className="now-playing-full-drag-strip" />
            <div className="now-playing-full-left">
              <DeveloperEditableNode
                id="nowPlayingBackButton"
                tag="button"
                className="fullscreen-back"
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'nowPlayingBackButton'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                onClick={() => setFullScreen(false)}
                title="Exit full screen"
                type="button"
              >
                <BackIcon />
              </DeveloperEditableNode>
              <div className="now-playing-full-quick-actions">
                <div className="now-playing-full-favorites">
                  {favoriteCustomizePresets.map((preset) => (
                    <button
                      key={preset.name}
                      className="now-playing-full-favorite-btn"
                      onClick={() => applyCustomizePreset(preset)}
                      title={preset.name}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
                <div className="night-mode-toggle-wrap now-playing-full-night-toggle">
                  <button
                    type="button"
                    className={`night-mode-toggle${nightMode ? ' active' : ''}`}
                    onClick={() => setNightMode((v) => !v)}
                    title={nightMode ? 'Night mode: on' : 'Night mode: off'}
                    role="switch"
                    aria-checked={nightMode}
                  >
                    <span className="night-mode-toggle-track" />
                    <span className="night-mode-toggle-thumb" />
                  </button>
                </div>
              </div>
            </div>
            {effectiveTrackKey && (
              <DeveloperEditableNode
                id="fullscreenKeyBadge"
                tag="div"
                className="current-key-badge current-key-badge-corner"
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'fullscreenKeyBadge'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                title={effectiveTrackKey}
              >
                {effectiveTrackKey}
              </DeveloperEditableNode>
            )}
            <DeveloperEditableNode
              id="fullscreenEqualizerButton"
              tag="button"
              className="now-playing-full-equalizer"
              devMode={developerMode}
              selected={selectedDeveloperElementId === 'fullscreenEqualizerButton'}
              layout={developerElementLayout}
              rootRef={appRootRef}
              onMeasure={setDeveloperElementBox}
              onSelect={setSelectedDeveloperElementId}
              onBeginInteraction={beginDeveloperElementInteraction}
              onClick={() => setEqOpen(true)}
              title="Customize"
              type="button"
            >
              <EqualizerIcon />
            </DeveloperEditableNode>
            <div
              className="now-playing-full-art-wrap"
              onContextMenu={(e) => {
                e.preventDefault()
                if (!currentTrack) return
                setNowPlayingArtMenu({ x: e.clientX, y: e.clientY })
              }}
            >
              <img
                src={currentArtSrc}
                className="now-playing-full-art"
                alt=""
                draggable={false}
              />
              <ArtChangeMenu
                hasCustomArt={!!currentTrack?.customArtPath}
                onSelectPreset={(filePath) => updateCurrentTrackArt(filePath)}
                onUploadCustom={() => {
                  platform.selectImage().then((filePath) => {
                    if (filePath) updateCurrentTrackArt(filePath)
                  })
                }}
                onRemove={() => updateCurrentTrackArt(null)}
                onOpenInStudio={() => {
                  if (!currentTrack) return
                  setStudioDroppedTrack(null)
                  setStudioTrackImported(true)
                  setAppView('studio')
                  setFullScreen(false)
                }}
              />
              {currentTrack && (
                <button
                  type="button"
                  className={`favorite-btn${currentTrack.favorite ? ' is-favorite' : ''}`}
                  aria-label={currentTrack.favorite ? 'Unfavorite' : 'Favorite'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleTrackFavorite(currentTrack)
                  }}
                >
                  <StarIcon filled={!!currentTrack.favorite} />
                </button>
              )}
            </div>
            <div className="now-playing-full-title">{currentTrack?.title}</div>
            <div className="now-playing-full-artist">{currentTrack?.artist}</div>
          </div>
          )
        ) : (
          <>
            <header
              ref={(node) => {
                developerNodeRefs.current.toolbar = node
              }}
              style={developerLayoutStyle('toolbar')}
              className="toolbar"
            >
              {renderDeveloperOverlay('toolbar')}
              <div className="toolbar-left">
                {appView === 'media' ? (
                  <DeveloperEditableNode
                    id="sidebarToggleButton"
                    tag="button"
                    className={`sidebar-toggle ${sidebarOpen ? 'open' : ''}`}
                    devMode={developerMode}
                    selected={selectedDeveloperElementId === 'sidebarToggleButton'}
                    layout={developerElementLayout}
                    rootRef={appRootRef}
                    onMeasure={setDeveloperElementBox}
                    onSelect={setSelectedDeveloperElementId}
                    onBeginInteraction={beginDeveloperElementInteraction}
                    onClick={() => setSidebarOpen((open) => !open)}
                    title={sidebarOpen ? 'Close panel' : 'Open panel'}
                    type="button"
                  >
                    <ChevronIcon />
                  </DeveloperEditableNode>
                ) : (
                  <DeveloperEditableNode
                    id="headerBackButton"
                    tag="button"
                    className="sidebar-toggle header-back"
                    devMode={developerMode}
                    selected={selectedDeveloperElementId === 'headerBackButton'}
                    layout={developerElementLayout}
                    rootRef={appRootRef}
                    onMeasure={setDeveloperElementBox}
                    onSelect={setSelectedDeveloperElementId}
                    onBeginInteraction={beginDeveloperElementInteraction}
                    onClick={() => setAppView('media')}
                    title="Back to Volure Home"
                    type="button"
                  >
                    <BackIcon />
                  </DeveloperEditableNode>
                )}
                <h1>Volure{appView === 'studio' ? ' Studio' : appView === 'play' ? ' Play' : ''}</h1>
                <div className="night-mode-toggle-wrap">
                  <DeveloperEditableNode
                    id="nightModeToggle"
                    tag="button"
                    className={`night-mode-toggle${nightMode ? ' active' : ''}`}
                    devMode={developerMode}
                    selected={selectedDeveloperElementId === 'nightModeToggle'}
                    layout={developerElementLayout}
                    rootRef={appRootRef}
                    onMeasure={setDeveloperElementBox}
                    onSelect={setSelectedDeveloperElementId}
                    onBeginInteraction={beginDeveloperElementInteraction}
                    onClick={() => setNightMode((v) => !v)}
                    title={nightMode ? 'Night mode: on' : 'Night mode: off'}
                    role="switch"
                    ariaChecked={nightMode}
                    type="button"
                  >
                    <span className="night-mode-toggle-track" />
                    <span className="night-mode-toggle-thumb" />
                  </DeveloperEditableNode>
                  <svg
                    className={`night-mode-toggle-moon${nightMode ? ' active' : ''}`}
                    xmlns="http://www.w3.org/2000/svg"
                    width="1em"
                    height="1em"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="M0 0h24v24H0z" fill="none" />
                    <g fill="currentColor">
                      <path d="M20 14h-7.5v1.5H20zm-2.5-3h-7v1.5h7z" />
                      <path d="M22 17H11v1.5h6.455a8.43 8.43 0 0 1-5.455 2c-4.685 0-8.5-3.815-8.5-8.5c0-3.565 2.25-6.725 5.5-7.955a10 10 0 0 0-.25 2.205c0 1.12.18 2.21.54 3.25h1.615a8.4 8.4 0 0 1-.085-6.29l.49-1.28l-1.345.275C5.35 3.16 2 7.28 2 12c0 5.515 4.485 10 10 10a9.94 9.94 0 0 0 7.585-3.5H22zm0-6h-3v1.5h3z" />
                    </g>
                  </svg>
                </div>
              </div>
              {appView === 'media' && (
                <div className="toolbar-actions">
                  <input
                    className="search"
                    placeholder="Search title, artist, album..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {!import.meta.env.VOLURE_MOBILE && (
                    <>
                      <button
                        type="button"
                        className="toolbar-add-file-btn"
                        onClick={handleAddAudioFile}
                        disabled={scanning}
                        title="Add audio file to library"
                        aria-label="Add audio file to library"
                      >
                        <PlusIcon />
                      </button>
                      <button className="btn-primary" onClick={handleAddFolder} disabled={scanning}>
                        {scanning ? 'Scanning...' : 'Add Folder'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </header>

            <div className="body-row">
              <aside
                ref={(node) => {
                  developerNodeRefs.current.sidebar = node
                }}
                style={developerLayoutStyle('sidebar')}
                className={`sidebar ${sidebarOpen || appView !== 'media' ? 'open' : ''}${
                  appView === 'play' ? ' sidebar-overlay sidebar-play' : appView === 'studio' ? ' sidebar-overlay' : ''
                }`}
              >
                {renderDeveloperOverlay('sidebar')}
                {appView === 'media' && (
                  <nav>
                    <button
                      className={activeSection === 'songs' ? 'active' : ''}
                      onClick={() => setActiveSection('songs')}
                    >
                      Songs
                    </button>
                    <button
                      className={activeSection === 'recent' ? 'active' : ''}
                      onClick={() => setActiveSection('recent')}
                    >
                      Recently Played
                    </button>
                    <button
                      className={activeSection === 'sections' ? 'active' : ''}
                      onClick={() => {
                        setActiveSection('sections')
                        setViewingFolder(null)
                      }}
                    >
                      Sections
                    </button>
                    <button
                      className={activeSection === 'playlists' ? 'active' : ''}
                      onClick={() => {
                        setActiveSection('playlists')
                        setViewingPlaylist(null)
                      }}
                    >
                      Playlists
                    </button>
                    <button
                      className={activeSection === 'favorites' ? 'active' : ''}
                      onClick={() => setActiveSection('favorites')}
                    >
                      Favorites
                    </button>
                    <button
                      className={activeSection === 'advanced' ? 'active' : ''}
                      onClick={() => setActiveSection('advanced')}
                    >
                      Advanced
                    </button>
                  </nav>
                )}
                {appView === 'studio' && (
                  <div className="studio-tabs">
                    {[
                      'Studio Home',
                      'Equalizer',
                      'Time Stretch',
                      'Trim Audio',
                      'Remove Silence',
                      'Record Internal Audio',
                      'Reverse Audio',
                      // Developer-only: paste a YouTube link, download its
                      // audio (mp3/wav/flac). Not part of the official
                      // launch — see the converter:downloadYoutubeAudio
                      // ipcMain handler.
                      'Converter',
                      // Detects the key of whatever's currently playing
                      // through the system — see startListenMode below.
                      'Listen',
                    ].map((label) => (
                      <button
                        key={label}
                        type="button"
                        className={`studio-tab${studioTool === label ? ' active' : ''}`}
                        onClick={() => {
                          if (label === 'Record Internal Audio') {
                            // Same entry point as the record button in the
                            // top-right corner (recordButton) — its own
                            // active/icon state already derives from
                            // internalAudioRecorder.recording, so toggling
                            // it here is all that's needed to visually
                            // activate it and start/stop the capture.
                            internalAudioRecorder.toggleRecording()
                            setStudioTool(label)
                            setSelectedToolSlot(null)
                          } else if (label === 'Listen') {
                            setStudioTool(label)
                            setSelectedToolSlot(null)
                            startListenMode()
                          } else if (
                            label === 'Time Stretch' ||
                            label === 'Trim Audio' ||
                            label === 'Reverse Audio' ||
                            label === 'Remove Silence' ||
                            label === 'Equalizer'
                          ) {
                            const slots = loadedSlotsForTool()
                            setStudioTool(label)
                            if (slots.length > 0) {
                              const preferredSlot = label === 'Equalizer' ? slots[0] : slots.length === 1 ? slots[0] : null
                              if (preferredSlot) {
                                applyStudioTool(label, preferredSlot)
                              } else {
                                setSelectedToolSlot(null)
                              }
                            } else {
                              setSelectedToolSlot(null)
                            }
                          } else {
                            setStudioTool(label)
                            setSelectedToolSlot(null)
                          }
                        }}
                      >
                        {label}
                        {label === 'Time Stretch' && <TimedCheck active={timeStretchDone} />}
                        {label === 'Trim Audio' && <TimedCheck active={studioTrimDone} />}
                        {label === 'Remove Silence' && <TimedCheck active={studioSilenceRemoved} />}
                        {label === 'Reverse Audio' && <TimedCheck active={studioAudioReversed} />}
                        {label === 'Converter' && <TimedCheck active={converterSavedPath !== null} />}
                        {label === 'Listen' && <TimedCheck active={listenStatus === 'done'} />}
                      </button>
                    ))}
                  </div>
                )}
                <nav className="app-view-nav">
                  <button
                    className={appView === 'media' ? 'active' : ''}
                    onClick={() => setAppView('media')}
                  >
                    Volure Home
                    {appView === 'media' && <CheckIcon />}
                  </button>
                  <button
                    className={appView === 'studio' ? 'active' : ''}
                    onClick={() => setAppView('studio')}
                  >
                    Volure Studio
                    {appView === 'studio' && <CheckIcon />}
                  </button>
                  {!import.meta.env.VOLURE_MOBILE && (
                    <button
                      className={appView === 'play' ? 'active' : ''}
                      onClick={() => setAppView('play')}
                    >
                      Volure Play
                      {appView === 'play' && <CheckIcon />}
                    </button>
                  )}
                </nav>
              </aside>

              <main
                ref={(node) => {
                  developerNodeRefs.current.studio = node
                }}
                style={developerLayoutStyle('studio')}
                className={`studio-view view-fade${appView === 'studio' ? ' active' : ''}`}
              >
                {renderDeveloperOverlay('studio')}
                {currentTrack && (
                  <div className="view-corner-actions">
                      {effectiveTrackKey && (
                        <DeveloperEditableNode
                          id="studioKeyBadge"
                          tag="div"
                          className="current-key-badge current-key-badge-corner"
                          devMode={developerMode}
                          selected={selectedDeveloperElementId === 'studioKeyBadge'}
                          layout={developerElementLayout}
                          rootRef={appRootRef}
                          onMeasure={setDeveloperElementBox}
                          onSelect={setSelectedDeveloperElementId}
                          onBeginInteraction={beginDeveloperElementInteraction}
                          title={effectiveTrackKey}
                        >
                          {effectiveTrackKey}
                        </DeveloperEditableNode>
                      )}
                      <DeveloperEditableNode
                        id="recordButton"
                        tag="button"
                        className={`current-record-button${internalAudioRecorder.recording ? ' active' : ''}${internalAudioRecorder.starting ? ' starting' : ''}`}
                        devMode={developerMode}
                        selected={selectedDeveloperElementId === 'recordButton'}
                        layout={developerElementLayout}
                        rootRef={appRootRef}
                        onMeasure={setDeveloperElementBox}
                        onSelect={setSelectedDeveloperElementId}
                        onBeginInteraction={beginDeveloperElementInteraction}
                        onClick={internalAudioRecorder.toggleRecording}
                        ariaPressed={internalAudioRecorder.recording}
                        title={
                          internalAudioRecorder.starting
                            ? 'Starting…'
                            : internalAudioRecorder.recording
                              ? 'Stop recording internal audio'
                              : 'Record internal audio'
                        }
                        type="button"
                      >
                        <RecordIcon />
                      </DeveloperEditableNode>
                      <button
                        type="button"
                        className={`current-record-button mic-record-button${micRecorder.recording ? ' active' : ''}${micRecorder.starting ? ' starting' : ''}`}
                        onClick={micRecorder.toggleRecording}
                        aria-pressed={micRecorder.recording}
                        title={micRecorder.starting ? 'Starting…' : micRecorder.recording ? 'Stop recording microphone' : 'Record microphone'}
                      >
                        <MicIcon />
                      </button>
                      <StudioSaveMenu
                        onSave={(format) => saveAndOfferLibraryAdd(exportCurrentTrackAudio, format)}
                        saving={exportingStudioAudio}
                        failed={studioExportError !== null}
                      />
                  </div>
                )}
                <div className="studio-content">
                <div className="studio-art-wrap">
                  <img
                    src={currentArtSrc}
                    className="studio-art"
                    alt=""
                    draggable={false}
                  />
                  {currentTrack && (
                    <button
                      type="button"
                      className="studio-art-import-button"
                      onClick={() => {
                        setStudioDroppedTrack(null)
                        setStudioTrackImported(true)
                      }}
                      title={`Import "${currentTrack.title ?? 'current song'}" into Studio`}
                    >
                      <PlusIcon />
                    </button>
                  )}
                </div>
                <div
                  className={`studio-waveforms${eqMode ? ' studio-waveforms-eq' : ''}${listenMode ? ' studio-waveforms-listen' : ''}`}
                >
                  {converterMode && (
                    <div className="studio-converter-panel">
                      <p className="studio-converter-note">
                        Developer tool — paste a YouTube link and download the audio as mp3, wav, or flac.
                      </p>
                      <div className="studio-converter-row">
                        <input
                          type="text"
                          className="studio-converter-input"
                          placeholder="https://www.youtube.com/watch?v=…"
                          value={converterUrl}
                          onChange={(e) => {
                            setConverterUrl(e.target.value)
                            setConverterError(null)
                            setConverterSavedPath(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') downloadConverterAudio('mp3')
                          }}
                          disabled={converterDownloading}
                        />
                        <StudioSaveMenu
                          onSave={downloadConverterAudio}
                          saving={converterDownloading}
                          failed={converterError !== null}
                          disabled={!converterUrl.trim()}
                          idleLabel="Download"
                          savingLabel="Downloading…"
                          failedLabel="Download failed"
                          idleTitle="Download this video's audio to your computer"
                          failedTitle="Download failed — click to try again"
                        />
                      </div>
                      {converterError && <p className="studio-converter-error">{converterError}</p>}
                      {converterSavedPath && (
                        <p className="studio-converter-success">Saved to {converterSavedPath}</p>
                      )}
                    </div>
                  )}
                  {listenMode && (
                    <div className="studio-listen-panel">
                      {(listenStatus === 'listening' || listenStatus === 'analyzing') && (
                        <ListeningWave
                          label={
                            listenStatus === 'analyzing'
                              ? 'Figuring out the key…'
                              : "Listening for the key of what's playing…"
                          }
                        />
                      )}
                      {listenStatus === 'done' && listenResult && (
                        <>
                          <p className="studio-listen-result">{listenResult.keySignature}</p>
                          <button type="button" className="btn-primary studio-listen-again" onClick={startListenMode}>
                            Listen again
                          </button>
                        </>
                      )}
                      {listenStatus === 'error' && (
                        <>
                          <p className="studio-listen-error">{listenError}</p>
                          <button type="button" className="btn-primary studio-listen-again" onClick={startListenMode}>
                            Try again
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {!converterMode && !listenMode && studioDisplayTrack ? (
                    toolSlotVisible('track') && (
                      <StudioWaveform
                        track={studioDisplayTrack}
                        currentTime={
                          trimMode && selectedToolSlot === 'track'
                            ? trimPreviewDisplayTime(studioPlayback.currentTime, studioDisplayTrack?.duration ?? 0)
                            : studioPlayback.currentTime
                        }
                        onSeek={
                          trimMode && selectedToolSlot === 'track'
                            ? (time) => trimPreviewSeek(time, studioDisplayTrack?.duration ?? 0, studioPlayback.seek)
                            : studioPlayback.seek
                        }
                        playing={studioPlayback.playing}
                        onTogglePlay={studioPlayback.togglePlay}
                        onActivateToggle={() => {
                          lastPlaybackToggleRef.current = studioPlayback.togglePlay
                        }}
                        volume={studioPlayback.volume}
                        onVolumeChange={studioPlayback.setVolume}
                        onRemove={clearStudio}
                        showRemove={studioTool === 'Studio Home'}
                        showSave={studioTool === 'Studio Home'}
                        onSave={eqMode ? undefined : (format) => saveAndOfferLibraryAdd(exportStudioAudio, format)}
                        saving={exportingStudioAudio}
                        saveFailed={studioExportError !== null}
                        selectable={toolSlotSelectable('track')}
                        selectLabel={studioTool}
                        onSelect={() => applyStudioTool(studioTool, 'track')}
                        peaksOverride={studioIsAligned ? alignedTrimmedPeaks : studioIndependentPlayback.trimmedPeaks}
                        durationOverride={studioIsAligned ? alignedTrimmedDuration : studioIndependentPlayback.trimmedDuration}
                        overlay={renderTrimOverlay('track')}
                      />
                    )
                  ) : (
                    !converterMode &&
                    !listenMode &&
                    !internalAudioRecorder.recording &&
                    !internalAudioRecorder.recordingPeaks &&
                    !micRecorder.recording &&
                    !micRecorder.recordingPeaks && <StudioEmptyState onImport={importFileIntoStudio} />
                  )}
                  {!converterMode && !listenMode && internalAudioRecorder.recording ? (
                    toolSlotVisible('internal') && <RecordingLiveWave />
                  ) : (
                    !converterMode &&
                    !listenMode &&
                    internalAudioRecorder.recordingPeaks &&
                    toolSlotVisible('internal') && (
                      <RecordingWaveform
                        peaks={internalAudioRecorder.recordingPeaks}
                        duration={internalAudioRecorder.duration}
                        currentTime={
                          trimMode && selectedToolSlot === 'internal'
                            ? trimPreviewDisplayTime(internalAudioRecorder.playbackTime, internalAudioRecorder.duration)
                            : internalAudioRecorder.playbackTime
                        }
                        playing={internalAudioRecorder.playing}
                        volume={internalAudioRecorder.volume}
                        onSeek={
                          trimMode && selectedToolSlot === 'internal'
                            ? (time) => trimPreviewSeek(time, internalAudioRecorder.duration, internalAudioRecorder.seek)
                            : internalAudioRecorder.seek
                        }
                        onTogglePlay={internalAudioRecorder.togglePlayback}
                        onActivateToggle={() => {
                          lastPlaybackToggleRef.current = internalAudioRecorder.togglePlayback
                        }}
                        onVolumeChange={internalAudioRecorder.setVolume}
                        showSave={studioTool === 'Studio Home'}
                        onSave={(format) => saveAndOfferLibraryAdd(internalAudioRecorder.save, format)}
                        saving={internalAudioRecorder.saving}
                        saveFailed={internalAudioRecorder.saveFailed}
                        onRemove={internalAudioRecorder.discard}
                        selectable={toolSlotSelectable('internal')}
                        selectLabel={studioTool}
                        onSelect={() => applyStudioTool(studioTool, 'internal')}
                        overlay={renderTrimOverlay('internal')}
                      />
                    )
                  )}
                  {!converterMode && !listenMode && micRecorder.recording ? (
                    toolSlotVisible('mic') && <RecordingLiveWave />
                  ) : (
                    !converterMode &&
                    !listenMode &&
                    micRecorder.recordingPeaks &&
                    toolSlotVisible('mic') && (
                      <RecordingWaveform
                        peaks={micRecorder.recordingPeaks}
                        duration={micRecorder.duration}
                        currentTime={
                          trimMode && selectedToolSlot === 'mic'
                            ? trimPreviewDisplayTime(micRecorder.playbackTime, micRecorder.duration)
                            : micRecorder.playbackTime
                        }
                        playing={micRecorder.playing}
                        volume={micRecorder.volume}
                        onSeek={
                          trimMode && selectedToolSlot === 'mic'
                            ? (time) => trimPreviewSeek(time, micRecorder.duration, micRecorder.seek)
                            : micRecorder.seek
                        }
                        onTogglePlay={micRecorder.togglePlayback}
                        onActivateToggle={() => {
                          lastPlaybackToggleRef.current = micRecorder.togglePlayback
                        }}
                        onVolumeChange={micRecorder.setVolume}
                        showSave={studioTool === 'Studio Home'}
                        onSave={(format) => saveAndOfferLibraryAdd(micRecorder.save, format)}
                        saving={micRecorder.saving}
                        saveFailed={micRecorder.saveFailed}
                        onRemove={micRecorder.discard}
                        selectable={toolSlotSelectable('mic')}
                        selectLabel={studioTool}
                        onSelect={() => applyStudioTool(studioTool, 'mic')}
                        overlay={renderTrimOverlay('mic')}
                      />
                    )
                  )}
                  {timeStretchMode && timeStretchTarget && (
                    <div className="time-stretch-controls">
                      <PlaybackSpeedControl
                        playbackSpeed={timeStretchTarget.playbackRate}
                        setPlaybackSpeed={timeStretchTarget.setPlaybackRate}
                        applyPlaybackSpeed={timeStretchTarget.setPlaybackRate}
                        speedSnapEnabled={speedSnapEnabled}
                        onToggleSnap={() => setSpeedSnapEnabled((v) => !v)}
                        variant="studio"
                      />
                      <PitchShiftControl
                        pitchSemitones={timeStretchTarget.pitchSemitones}
                        setPitchSemitones={timeStretchTarget.setPitchSemitones}
                      />
                    </div>
                  )}
                  {eqMode && eqTarget && (
                    <div className="studio-equalizer-controls">
                      <div className="studio-eq-row">
                        <div className="studio-eq-bands-col">
                          <EqualizerBands
                            gains={eqTarget.eqGains}
                            onChange={(index, value) => {
                              if (eqLocked) {
                                applyLockedEqBandChange(eqTarget.eqGains, index, value, eqTarget.setEqBandGain)
                              } else {
                                eqTarget.setEqBandGain(index, value)
                              }
                            }}
                            onReset={eqTarget.resetEq}
                          />
                        </div>
                        <button
                          type="button"
                          className={`studio-eq-lock${eqLocked ? ' active' : ''}`}
                          onClick={() => setEqLocked((v) => !v)}
                          aria-pressed={eqLocked}
                          title={
                            eqLocked
                              ? 'Bands locked together: on — drag one band to shift them all'
                              : 'Bands locked together: off'
                          }
                        >
                          <LockIcon locked={eqLocked} />
                        </button>
                      </div>
                      <div className="studio-eq-boost-control">
                        <span className="studio-eq-boost-label">Volume</span>
                        <input
                          type="range"
                          className="studio-eq-boost"
                          min={0}
                          max={2}
                          step={0.01}
                          value={eqTarget.boostVolume}
                          onChange={(e) => eqTarget.setBoostVolume(Number(e.target.value))}
                          title="Volume boost"
                        />
                        <span className="studio-eq-boost-value">{Math.round(eqTarget.boostVolume * 100)}%</span>
                      </div>
                    </div>
                  )}
                  {trimMode && trimTarget && selectedToolSlot && (
                    <div className="trim-controls">
                      <button
                        type="button"
                        className={`trim-fade-toggle${fadeInOn ? ' active' : ''}`}
                        onClick={() => {
                          const next = !fadeInOn
                          setFadeInOn(next)
                          commitTrim(
                            selectedToolSlot,
                            trimStart,
                            trimEnd,
                            { on: next, ratio: fadeInRatio },
                            { on: fadeOutOn, ratio: fadeOutRatio }
                          )
                        }}
                      >
                        Fade In
                      </button>
                      <button
                        type="button"
                        className={`trim-fade-toggle${fadeOutOn ? ' active' : ''}`}
                        onClick={() => {
                          const next = !fadeOutOn
                          setFadeOutOn(next)
                          commitTrim(
                            selectedToolSlot,
                            trimStart,
                            trimEnd,
                            { on: fadeInOn, ratio: fadeInRatio },
                            { on: next, ratio: fadeOutRatio }
                          )
                        }}
                      >
                        Fade Out
                      </button>
                    </div>
                  )}
                </div>
                {(timeStretchMode || trimMode || eqMode) && selectedToolSlot !== null && (
                  <button
                    type="button"
                    className="time-stretch-done"
                    onClick={() => {
                      setSelectedToolSlot(null)
                      if (timeStretchMode) setTimeStretchDone(true)
                      if (trimMode) {
                        setStudioTrimDone(true)
                        trimTarget?.confirmManualTrim()
                      }
                      setStudioTool('Studio Home')
                    }}
                  >
                    Done
                  </button>
                )}
                </div>
                <div
                  className="studio-db-meter"
                  title={`L ${studioMeterDb.l <= STUDIO_METER_FLOOR_DB ? '-∞' : studioMeterDb.l.toFixed(1)} dB · R ${studioMeterDb.r <= STUDIO_METER_FLOOR_DB ? '-∞' : studioMeterDb.r.toFixed(1)} dB`}
                >
                  <div className="studio-db-meter-body">
                    <div className="studio-db-meter-scale">
                      {STUDIO_METER_SCALE_MARKS.map((mark) => (
                        <span
                          key={mark}
                          className="studio-db-meter-scale-mark"
                          style={{ bottom: `${studioMeterPercent(mark)}%` }}
                        >
                          {mark === 0 ? '0' : mark}
                        </span>
                      ))}
                    </div>
                    {(['l', 'r'] as const).map((channel) => {
                      const db = studioMeterDb[channel]
                      const peak = studioMeterPeak[channel]
                      const clipping = db >= -0.5
                      return (
                        <div className="studio-db-meter-channel" key={channel}>
                          <div className={`studio-db-meter-track${clipping ? ' clipping' : ''}`}>
                            <div
                              className="studio-db-meter-fill"
                              style={{ height: `${studioMeterPercent(db)}%` }}
                            />
                            <div
                              className="studio-db-meter-peak"
                              style={{ bottom: `${studioMeterPercent(peak)}%` }}
                            />
                          </div>
                          <span className="studio-db-meter-chan-label">{channel.toUpperCase()}</span>
                        </div>
                      )
                    })}
                  </div>
                  
                </div>
              </main>
              {!import.meta.env.VOLURE_MOBILE && (
              <main
                ref={(node) => {
                  developerNodeRefs.current.play = node
                }}
                style={developerLayoutStyle('play')}
                className={`play-view view-fade${appView === 'play' ? ' active' : ''}`}
              >
                {renderDeveloperOverlay('play')}
                {currentTrack && (
                  <div className="view-corner-actions">
                    {performancePlaying && performanceSource === 'recorded' && (
                      <button
                        type="button"
                        className="current-record-button performance-save-button"
                        onClick={() => {
                          setPerformanceName('')
                          setPerformanceSaveOpen(true)
                        }}
                        title="Save performance"
                        aria-label="Save performance"
                      >
                        <SaveIcon />
                      </button>
                    )}
                    {effectiveTrackKey && (
                      <DeveloperEditableNode
                        id="playKeyBadge"
                        tag="button"
                        className="current-key-badge current-key-badge-corner current-key-badge-clickable"
                        devMode={developerMode}
                        selected={selectedDeveloperElementId === 'playKeyBadge'}
                        layout={developerElementLayout}
                        rootRef={appRootRef}
                        onMeasure={setDeveloperElementBox}
                        onSelect={setSelectedDeveloperElementId}
                        onBeginInteraction={beginDeveloperElementInteraction}
                        onClick={() => playKeyboardRef.current?.transposeToKeyRoot(effectiveTrackKey)}
                        title={`Transpose keyboard to ${effectiveTrackKey}`}
                        type="button"
                      >
                        {effectiveTrackKey}
                      </DeveloperEditableNode>
                    )}
                    <DeveloperEditableNode
                      id="playRecordButton"
                      tag="button"
                      className={`current-record-button${screenRecorder.recording || performanceRecording ? ' active' : ''}`}
                      devMode={developerMode}
                      selected={selectedDeveloperElementId === 'playRecordButton'}
                      layout={developerElementLayout}
                      rootRef={appRootRef}
                      onMeasure={setDeveloperElementBox}
                      onSelect={setSelectedDeveloperElementId}
                      onBeginInteraction={beginDeveloperElementInteraction}
                      onClick={() => {
                        if (performanceRecording) stopPerformanceRecording()
                        else if (performancePlaying) startOverdubRecording()
                        else startPerformanceRecording()
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setPerformanceMenu({ x: event.clientX, y: event.clientY })
                      }}
                      ariaPressed={performanceRecording}
                      title={
                        performanceRecording
                          ? 'Stop performance recording'
                          : performancePlaying
                            ? 'Record along with playback'
                            : 'Record performance'
                      }
                      type="button"
                    >
                      <RecordIcon />
                    </DeveloperEditableNode>
                    {performanceEvents.length > 0 && performanceSource !== 'none' && (
                      <button
                        type="button"
                        className={`current-record-button performance-play-button${performancePlaying ? ' active' : ''}`}
                        onClick={togglePerformancePlayback}
                        aria-pressed={performancePlaying}
                        title={performancePlaying ? 'Pause performance' : 'Play performance'}
                      >
                        {performancePlaying ? <PauseIcon /> : <PlayIcon />}
                      </button>
                    )}
                  </div>
                )}
                <PlayKeyboard
                  ref={playKeyboardRef}
                  active={appView === 'play'}
                  currentTrackId={currentTrackId}
                  currentTrackKey={currentTrack?.key}
                  onPerformanceNote={handlePerformanceNote}
                />
              </main>
              )}
              <main
                ref={(node) => {
                  developerNodeRefs.current.library = node
                }}
                style={developerLayoutStyle('library')}
                className={`library view-fade${appView === 'media' ? ' active' : ''}`}
              >
                {renderDeveloperOverlay('library')}
            {selectedIds.size > 0 && (
              <SelectionToolbar
                count={selectedIds.size}
                playlists={playlists}
                onAddToPlaylist={addSelectionToPlaylist}
                onCreatePlaylistAndAdd={createPlaylistAndAddSelection}
                onRemoveFromPlaylist={viewingPlaylist ? removeSelectionFromPlaylist : undefined}
                onClear={() => setSelectedIds(new Set())}
              />
            )}
            {activeSection === 'songs' ? (
              <TrackTable
                tracks={visibleTracks}
                sortBy={sortBy}
                sortDir={sortDir}
                onSortChange={handleSortChange}
                currentTrackId={currentTrackId}
                selectedIds={selectedIds}
                onToggleSelected={toggleTrackSelected}
                onPlay={playTrack}
                onOpenNowPlaying={openNowPlaying}
                onSaveTag={saveTagForSelection}
                pendingTagEdits={pendingTagEdits}
                onApplyPendingTagUpdate={applyPendingTagUpdate}
                keyFilter={keyFilter}
                onKeyFilterChange={setKeyFilter}
                availableKeys={libraryAvailableKeys}
                emptyMessage="Your library is empty. Add a folder to get started."
                onRowContextMenu={handleRowContextMenu}
                onReorder={handleTracksReorder}
              />
            ) : activeSection === 'recent' ? (
              recentTracks.length === 0 ? (
                <div className="empty-state">
                  <p>Nothing played yet.</p>
                </div>
              ) : (
                <div className="recent-grid">
                  {recentTracks.map((track) => (
                    <RecentTile
                      key={track.id}
                      track={track}
                      onPlay={() => playTrack(track.id)}
                      onRemove={() => {
                        setRecentTracks((prev) => prev.filter((t) => t.id !== track.id))
                        platform.removeFromRecentlyPlayed(track.id)
                      }}
                      onOpenInStudio={() => {
                        loadFileIntoStudio(track.filePath)
                        setAppView('studio')
                      }}
                      onContextMenu={handleRowContextMenu}
                    />
                  ))}
                </div>
              )
            ) : activeSection === 'playlists' ? (
              viewingPlaylist ? (
                playlistAddMode ? (
                <>
                  <div className="folder-view-header">
                    <button
                      className="fullscreen-back"
                      onClick={() => setPlaylistAddMode(false)}
                      title="Back to Playlist"
                    >
                      <BackIcon />
                    </button>
                    <h2 className="folder-view-title">Add Songs</h2>
                  </div>
                  <div className="playlist-source-bar">
                    <button
                      type="button"
                      className={`playlist-source-chip${playlistPickerFolder === null ? ' active' : ''}`}
                      onClick={() => setPlaylistPickerFolder(null)}
                    >
                      All Songs
                    </button>
                    {folders.map((folder) => (
                      <button
                        type="button"
                        key={folder.path}
                        className={`playlist-source-chip${
                          playlistPickerFolder?.path === folder.path ? ' active' : ''
                        }`}
                        onClick={() => setPlaylistPickerFolder(folder)}
                      >
                        {folder.name?.trim() || folderBaseName(folder.path)}
                        {folder.isolated ? <span className="isolated-badge">Isolated</span> : null}
                      </button>
                    ))}
                  </div>
                  <TrackTable
                    tracks={visiblePlaylistPickerTracks}
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSortChange={handleSortChange}
                    currentTrackId={currentTrackId}
                    selectedIds={selectedIds}
                    onToggleSelected={toggleTrackSelected}
                    onPlay={playTrack}
                    onOpenNowPlaying={openNowPlaying}
                    onSaveTag={saveTagForSelection}
                    pendingTagEdits={pendingTagEdits}
                    onApplyPendingTagUpdate={applyPendingTagUpdate}
                    keyFilter={keyFilter}
                    onKeyFilterChange={setKeyFilter}
                    availableKeys={playlistPickerAvailableKeys}
                    emptyMessage="No songs found."
                    extraColumn={{
                      label: 'In Playlist',
                      isChecked: (t) => playlistTrackIds.has(t.id),
                      onToggle: togglePlaylistMembership,
                    }}
                    onRowContextMenu={handleRowContextMenu}
                  />
                </>
                ) : (
                <>
                  <div className="folder-view-header">
                    <button
                      className="fullscreen-back"
                      onClick={() => setViewingPlaylist(null)}
                      title="Back to Playlists"
                    >
                      <BackIcon />
                    </button>
                    <h2 className="folder-view-title">{viewingPlaylist.name}</h2>
                    <button
                      type="button"
                      className="playlist-source-chip"
                      onClick={() => setPlaylistAddMode(true)}
                    >
                      + Add Songs
                    </button>
                  </div>
                  <TrackTable
                    tracks={playlistTracks}
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSortChange={handleSortChange}
                    currentTrackId={currentTrackId}
                    selectedIds={selectedIds}
                    onToggleSelected={toggleTrackSelected}
                    onPlay={playTrack}
                    onOpenNowPlaying={openNowPlaying}
                    onSaveTag={saveTagForSelection}
                    pendingTagEdits={pendingTagEdits}
                    onApplyPendingTagUpdate={applyPendingTagUpdate}
                    keyFilter={keyFilter}
                    onKeyFilterChange={setKeyFilter}
                    availableKeys={new Set(playlistTracks.map((t) => t.key).filter((k): k is string => !!k))}
                    emptyMessage={'No songs in this playlist. Click "+ Add Songs" to get started.'}
                    onReorder={handlePlaylistTracksReorder}
                    getCustomOrder={getPlaylistTrackOrder}
                    onRowContextMenu={handleRowContextMenu}
                  />
                </>)
              ) : (
                <>
                  <div className="grid-toolbar">
                    <SortMenu
                      value={playlistsSortBy}
                      onChange={handlePlaylistsSortChange}
                      labels={GRID_SORT_LABELS_PLAYLISTS}
                    />
                  </div>
                  <div className="folder-grid">
                    <NewPlaylistTile
                      onCreate={() =>
                        platform.createPlaylist('New Playlist').then((created) => {
                          setPlaylists((prev) => [created, ...prev])
                          setViewingPlaylist(created)
                        })
                      }
                    />
                    <DndContext
                      sensors={gridDragSensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handlePlaylistsDragEnd}
                    >
                      <SortableContext
                        items={sortedPlaylists.map((p) => p.id)}
                        strategy={rectSortingStrategy}
                      >
                        {sortedPlaylists.map((playlist) => (
                          <SortableGridItem key={playlist.id} id={playlist.id}>
                            {(dragHandle) => (
                              <PlaylistTile
                                playlist={playlist}
                                dragHandle={dragHandle}
                                onOpen={() => setViewingPlaylist(playlist)}
                                onRename={(name) =>
                                  platform.renamePlaylist(playlist.id, name).then(setPlaylists)
                                }
                                onDelete={() =>
                                  platform.deletePlaylist(playlist.id).then(setPlaylists)
                                }
                              />
                            )}
                          </SortableGridItem>
                        ))}
                      </SortableContext>
                    </DndContext>
                  </div>
                </>
              )
            ) : activeSection === 'favorites' ? (
              <TrackTable
                tracks={favoriteTracks}
                sortBy={activeSection === 'favorites' ? 'favorite' : sortBy}
                sortDir={sortDir}
                onSortChange={handleSortChange}
                currentTrackId={currentTrackId}
                selectedIds={selectedIds}
                onToggleSelected={toggleTrackSelected}
                onPlay={playTrack}
                onOpenNowPlaying={openNowPlaying}
                onSaveTag={saveTagForSelection}
                pendingTagEdits={pendingTagEdits}
                onApplyPendingTagUpdate={applyPendingTagUpdate}
                keyFilter={keyFilter}
                onKeyFilterChange={setKeyFilter}
                availableKeys={new Set(favoriteTracks.map((t) => t.key).filter((k): k is string => !!k))}
                emptyMessage="No favorites yet. Star a song to add it here."
                onRowContextMenu={handleRowContextMenu}
              />
            ) : activeSection === 'advanced' ? (
              <>
                <div className="playlist-source-bar">
                  <button
                    type="button"
                    className={`playlist-source-chip${advancedFolder === null ? ' active' : ''}`}
                    onClick={() => setAdvancedFolder(null)}
                  >
                    Advanced Songs
                  </button>
                  {folders.map((folder) => (
                    <button
                      type="button"
                      key={folder.path}
                      className={`playlist-source-chip${
                        advancedFolder?.path === folder.path ? ' active' : ''
                      }`}
                      onClick={() => setAdvancedFolder(folder)}
                    >
                      {folder.name?.trim() || folderBaseName(folder.path)}
                      {folder.isolated ? <span className="isolated-badge">Isolated</span> : null}
                    </button>
                  ))}
                </div>
                <AdvancedTrackTable
                  tracks={advancedFolder ? visibleAdvancedFolderTracks : visibleAdvancedTracks}
                  bassIntervalsByTrack={bassIntervalsByTrack}
                  currentTrackId={currentTrackId}
                  selectedIds={selectedIds}
                  onToggleSelected={toggleTrackSelected}
                  onPlay={playTrack}
                  onOpenNowPlaying={openNowPlaying}
                  onSaveTag={saveAdvancedTag}
                  onAddBassInterval={addBassIntervalToTrack}
                  bassIntervalFilter={bassIntervalFilter}
                  onBassIntervalFilterChange={setBassIntervalFilter}
                  sortBy={advancedSortBy}
                  onSortChange={setAdvancedSortBy}
                  emptyMessage={
                    advancedFolder
                      ? 'No songs in this folder.'
                      : 'Your library is empty. Add a folder to get started.'
                  }
                  extraColumn={
                    advancedFolder
                      ? {
                          label: 'Include',
                          isChecked: (t) => t.inAdvancedLibrary === 1,
                          onToggle: toggleAdvancedInclude,
                        }
                      : undefined
                  }
                  onRowContextMenu={handleRowContextMenu}
                />
              </>
            ) : viewingFolder ? (
              <>
                <div className="folder-view-header">
                  <button
                    className="fullscreen-back"
                    onClick={() => setViewingFolder(null)}
                    title="Back to Sections"
                  >
                    <BackIcon />
                  </button>
                  <h2 className="folder-view-title">
                    {viewingFolder.name?.trim() || folderBaseName(viewingFolder.path)}
                  </h2>
                  {viewingFolder.isolated ? <span className="isolated-badge">Isolated</span> : null}
                </div>
                <TrackTable
                  tracks={visibleFolderTracks}
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSortChange={handleSortChange}
                  currentTrackId={currentTrackId}
                  selectedIds={selectedIds}
                  onToggleSelected={toggleTrackSelected}
                  onPlay={playTrack}
                  onOpenNowPlaying={openNowPlaying}
                  onSaveTag={saveTagForSelection}
                  pendingTagEdits={pendingTagEdits}
                  onApplyPendingTagUpdate={applyPendingTagUpdate}
                  keyFilter={keyFilter}
                  onKeyFilterChange={setKeyFilter}
                  availableKeys={folderAvailableKeys}
                  emptyMessage="No songs in this folder."
                  extraColumn={
                    viewingFolder.isolated
                      ? {
                          label: 'Include',
                          isChecked: (t) => t.inLibrary === 1,
                          onToggle: toggleTrackInclude,
                        }
                      : undefined
                  }
                  onRowContextMenu={handleRowContextMenu}
                  onReorder={handleTracksReorder}
                />
              </>
            ) : folders.length === 0 ? (
              <div className="empty-state">
                <p>No folders added yet.</p>
              </div>
            ) : (
              <>
                <div className="grid-toolbar">
                  <SortMenu
                    value={sectionsSortBy}
                    onChange={handleSectionsSortChange}
                    labels={GRID_SORT_LABELS_FOLDERS}
                  />
                </div>
                <div className="folder-grid">
                  <DndContext
                    sensors={gridDragSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleFoldersDragEnd}
                  >
                    <SortableContext
                      items={sortedFolders.map((f) => f.path)}
                      strategy={rectSortingStrategy}
                    >
                      {sortedFolders.map((folder) => (
                        <SortableGridItem key={folder.path} id={folder.path}>
                          {(dragHandle) => (
                            <FolderTile
                              folder={folder}
                              dragHandle={dragHandle}
                              onOpen={() => setViewingFolder(folder)}
                              onRename={(name) =>
                                platform.renameFolder(folder.path, name).then(setFolders)
                              }
                              onRemove={() =>
                                platform.removeFolder(folder.path).then(({ folders, tracks }) => {
                                  setFolders(folders)
                                  setTracks(tracks)
                                })
                              }
                              onSelectArt={(filePath) =>
                                platform.updateFolderArt(folder.path, filePath).then(setFolders)
                              }
                              onUploadArt={() => {
                                platform.selectImage().then((filePath) => {
                                  if (filePath) {
                                    platform.updateFolderArt(folder.path, filePath).then(setFolders)
                                  }
                                })
                              }}
                              onRemoveArt={() =>
                                platform.updateFolderArt(folder.path, null).then(setFolders)
                              }
                            />
                          )}
                        </SortableGridItem>
                      ))}
                    </SortableContext>
                  </DndContext>
                </div>
              </>
            )}
              </main>
            </div>
          </>
        )}

        {developerMode && (
          <div className="developer-layout-panel">
            <div className="developer-layout-panel-title">Developer Mode</div>
            <div className="developer-layout-panel-body">
              Click a panel to select it. Drag to move. Use the handle to resize.
            </div>
            <div className="developer-layout-panel-actions">
              <button type="button" className="modal-btn modal-btn-secondary" onClick={() => setDeveloperMode(false)}>
                Exit
              </button>
              <button type="button" className="modal-btn modal-btn-secondary" onClick={() => void saveDeveloperLayout()}>
                Save Layout
              </button>
              <button type="button" className="modal-btn modal-btn-secondary" onClick={() => void exportDeveloperLayoutCss()}>
                Apply Layout Changes
              </button>
              <button type="button" className="modal-btn modal-btn-primary" onClick={() => void resetDeveloperLayout()}>
                Reset Layout
              </button>
            </div>
            <div className="developer-layout-panel-footer">
              {selectedDeveloperLayoutId ? `Selected: ${DEVELOPER_LAYOUT_LABELS[selectedDeveloperLayoutId]}` : 'No panel selected'}
            </div>
            {developerLayoutStatus && <div className="developer-layout-panel-status">{developerLayoutStatus}</div>}
          </div>
        )}

        {activePanel !== 'video' && (
        <footer
          ref={(node) => {
            developerNodeRefs.current.playback = node
          }}
          style={developerLayoutStyle('playback')}
          className={`playback-bar${activePanel === 'image' ? ' image-playback-bar' : ''}${activePanel === 'image' && (!imageControlsVisible || imageCropActive) ? ' image-playback-bar-hidden' : ''}`}
          onMouseMove={activePanel === 'image' && !imageCropActive ? revealImageControls : undefined}
        >
          {renderDeveloperOverlay('playback')}
          <div className="now-playing">
            <DeveloperEditableNode
              id="nowPlayingArt"
              tag="div"
              className={`now-playing-art-wrapper`}
              devMode={developerMode}
              selected={selectedDeveloperElementId === 'nowPlayingArt'}
              layout={developerElementLayout}
              rootRef={appRootRef}
              onMeasure={setDeveloperElementBox}
              onSelect={setSelectedDeveloperElementId}
              onBeginInteraction={beginDeveloperElementInteraction}
              onClick={() => {
                if (!currentTrack) return
                if (activePanel === 'image') {
                  if (imageCropActive) cancelImageCrop()
                  setImageViewerOpen(false)
                  setImageViewerFullscreen(false)
                }
                setFullScreen(true)
                if (!isPlaying) togglePlay()
              }}
            >
              <img
                src={currentArtSrc}
                className={`now-playing-art${currentTrack ? ' clickable' : ''}`}
                alt=""
                draggable={false}
              />
            </DeveloperEditableNode>
            <div className="now-playing-meta">
              <div className="now-playing-title">{currentTrack?.title ?? 'Welcome To Volure'}</div>
              <div className="now-playing-artist">{currentTrack?.artist ?? ''}</div>
            </div>
          </div>

          <div className="transport">
            <div className="transport-buttons">
              <DeveloperEditableNode
                id="shuffleButton"
                tag="button"
                className={shuffle ? 'toggle-active' : ''}
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'shuffleButton'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                onClick={toggleShuffle}
                title="Shuffle"
                ariaPressed={shuffle}
                type="button"
              >
                <ShuffleIcon />
              </DeveloperEditableNode>
              <DeveloperEditableNode
                id="prevButton"
                tag="button"
                className=""
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'prevButton'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                onClick={goPrev}
                disabled={!currentTrack}
                title="Previous"
                type="button"
              >
                <PrevIcon />
              </DeveloperEditableNode>
              <DeveloperEditableNode
                id="playPauseButton"
                tag="button"
                className="play-pause"
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'playPauseButton'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                onClick={() => {
                  lastPlaybackToggleRef.current = togglePlay
                  togglePlay()
                }}
                disabled={!currentTrack}
                title={isPlaying ? 'Pause' : 'Play'}
                type="button"
              >
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </DeveloperEditableNode>
              <DeveloperEditableNode
                id="nextButton"
                tag="button"
                className=""
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'nextButton'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                onClick={goNext}
                disabled={!currentTrack}
                title="Next"
                type="button"
              >
                <NextIcon />
              </DeveloperEditableNode>
              <DeveloperEditableNode
                id="loopButton"
                tag="button"
                className={loopMode !== 'off' ? 'toggle-active' : ''}
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'loopButton'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                onClick={cycleLoopMode}
                title={
                  loopMode === 'off'
                    ? 'Loop: off'
                    : loopMode === 'playlist'
                      ? 'Loop: playlist'
                      : 'Loop: song'
                }
                ariaPressed={loopMode !== 'off'}
                type="button"
              >
                <RepeatIcon single={loopMode === 'song'} />
              </DeveloperEditableNode>
            </div>
            <div className="scrub">
              <span>{formatTime(currentTime)}</span>
              <input
                type="range"
                min={0}
                max={trimmedBufferRef.current?.duration ?? currentTrack?.duration ?? 0}
                value={currentTime}
                onChange={(e) => seekTo(Number(e.target.value))}
              />
              <span>{formatTime(trimmedBufferRef.current?.duration ?? currentTrack?.duration)}</span>
            </div>
          </div>

          <div className="playback-bar-right">
            <div className="volume">
              <DeveloperEditableNode
                id="volumeButton"
                tag="button"
                className=""
                devMode={developerMode}
                selected={selectedDeveloperElementId === 'volumeButton'}
                layout={developerElementLayout}
                rootRef={appRootRef}
                onMeasure={setDeveloperElementBox}
                onSelect={setSelectedDeveloperElementId}
                onBeginInteraction={beginDeveloperElementInteraction}
                onClick={toggleMute}
                title={volume === 0 ? 'Unmute' : 'Mute'}
                type="button"
              >
                <VolumeIcon muted={volume === 0} />
              </DeveloperEditableNode>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
            </div>
            {activePanel === 'image' ? (
              imageViewerPath && (
                <button
                  type="button"
                  className="queue-menu-btn"
                  onClick={toggleImageViewerFullscreen}
                  title={imageViewerFullscreen ? 'Exit full screen' : 'Full screen'}
                >
                  <FullscreenIcon active={imageViewerFullscreen} />
                </button>
              )
            ) : (
              <QueueMenu
                queue={queue}
                onPlay={playFromQueue}
                onRemove={removeFromQueue}
                onClear={clearQueue}
              />
            )}
          </div>
        </footer>
        )}

        {activePanel === 'video' && (
        <footer
          className={`playback-bar video-playback-bar${videoViewerFullscreen ? ' video-playback-bar-overlay' : ''}${videoViewerFullscreen && !videoControlsVisible ? ' video-playback-bar-hidden' : ''}`}
          onMouseMove={revealVideoControls}
        >
          <div className="now-playing">
            <div className="now-playing-art video-now-playing-art">
              <VideoFileIcon />
            </div>
            <div className="now-playing-meta">
              <div className="now-playing-title">
                {videoViewerPath ? videoViewerPath.split(/[\\/]/).pop() : 'No Video Loaded'}
              </div>
              <div className="now-playing-artist"></div>
            </div>
          </div>

          <div className="transport">
            <div className="transport-buttons">
              <button type="button" disabled={!videoPlayableSrc} title="Mini view">
                <MiniViewIcon />
              </button>
              <button
                type="button"
                onClick={() => skipVideo(-10)}
                disabled={!videoPlayableSrc}
                title="Back 10 seconds"
              >
                <SkipBack10Icon />
              </button>
              <button
                type="button"
                className="play-pause"
                onClick={toggleVideoPlay}
                disabled={!videoPlayableSrc}
                title={videoIsPlaying ? 'Pause' : 'Play'}
              >
                {videoIsPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button
                type="button"
                onClick={() => skipVideo(10)}
                disabled={!videoPlayableSrc}
                title="Forward 10 seconds"
              >
                <SkipForward10Icon />
              </button>
              <button type="button" disabled={!videoPlayableSrc} title="Edit">
                <EditIcon />
              </button>
            </div>
            <div className="scrub">
              <span>{formatTime(videoCurrentTime)}</span>
              <input
                type="range"
                min={0}
                max={videoDuration || 0}
                value={videoCurrentTime}
                onChange={(e) => {
                  const t = Number(e.target.value)
                  if (videoRef.current) videoRef.current.currentTime = t
                  setVideoCurrentTime(t)
                }}
              />
              <span>{formatTime(videoDuration)}</span>
            </div>
          </div>

          <VideoVolumeControl
            volume={videoVolume}
            onChange={setVideoVolume}
            fullscreen={videoViewerFullscreen}
            onToggleFullscreen={() => setVideoViewerFullscreen((v) => !v)}
            showRemove={!!videoViewerPath}
            onRemove={() => {
              setVideoViewerPath(null)
              setVideoIsUnsavedRecording(false)
            }}
          />
        </footer>
        )}
      </div>

      <audio
        ref={audioRef}
        // Without this, createMediaElementSource (see ensureAudioContext)
        // still passes audio through to the speakers fine, but Chromium
        // silently zeroes out anything read back from it via an
        // AnalyserNode — which is exactly what the Studio dB meter does.
        // The media:// protocol is already registered corsEnabled, so this
        // is enough to un-taint it.
        crossOrigin="anonymous"
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onEnded={handleEnded}
        onError={(e) => {
          const error = e.currentTarget.error
          console.error(
            `<audio> playback error for ${currentTrack?.filePath}: code ${error?.code} - ${error?.message}`
          )
        }}
      />

      {performanceMenu && (
        <div
          className="track-context-menu play-performance-context-menu"
          style={{
            top: Math.min(performanceMenu.y, Math.max(8, window.innerHeight - 150)),
            left: Math.min(performanceMenu.x, Math.max(8, window.innerWidth - 220)),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="track-context-menu-item"
            onClick={() => {
              startPerformanceRecording()
              setPerformanceMenu(null)
            }}
          >
            Record Performance
          </button>
          <button
            type="button"
            className="track-context-menu-item"
            onClick={() => {
              screenRecorder.toggleRecording()
              setPerformanceMenu(null)
            }}
          >
            {screenRecorder.recording ? 'Stop Screen Recording' : 'Record Screen'}
          </button>
          {performanceEvents.length > 0 && (performanceSource === 'recorded' || performanceSource === 'saved') && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={() => {
                setPerformanceName('')
                setPerformanceSaveOpen(true)
                setPerformanceMenu(null)
              }}
            >
              Save Performance
            </button>
          )}
          <button
            type="button"
            className="track-context-menu-item"
            onClick={() => {
              setPerformanceLibraryOpen(true)
              setPerformanceMenu(null)
            }}
          >
            Performances
          </button>
          {[2, 5, 10].map((minutes) => (
            <button
              key={minutes}
              type="button"
              className="track-context-menu-item"
              onClick={() => playBackupPerformance(minutes)}
            >
              Play Last {minutes} Minutes
            </button>
          ))}
        </div>
      )}

      {performanceSaveOpen && (
        <div className="performance-modal-backdrop" onMouseDown={() => setPerformanceSaveOpen(false)}>
          <div
            className="performance-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="performance-save-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="performance-save-title">Save Performance</h2>
            <input
              autoFocus
              value={performanceName}
              onChange={(event) => setPerformanceName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') savePerformance()
                if (event.key === 'Escape') setPerformanceSaveOpen(false)
              }}
              placeholder="Performance name"
              aria-label="Performance name"
            />
            <div className="performance-modal-actions">
              <button type="button" onClick={() => setPerformanceSaveOpen(false)}>Cancel</button>
              <button type="button" disabled={!performanceName.trim()} onClick={savePerformance}>Save</button>
            </div>
          </div>
        </div>
      )}

      {performanceLibraryOpen && (
        <div className="performance-modal-backdrop" onMouseDown={() => setPerformanceLibraryOpen(false)}>
          <div
            className="performance-modal performance-library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="performance-library-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="performance-library-title">Performances</h2>
            {savedPerformances.length === 0 ? (
              <p className="performance-empty">No saved performances yet.</p>
            ) : (
              <div className="performance-list">
                {savedPerformances.map((record) => (
                  <div className="performance-list-row" key={record.id}>
                    {performanceRenameId === record.id ? (
                      <div className="performance-rename-row">
                        <input
                          autoFocus
                          value={performanceRenameValue}
                          onChange={(event) => setPerformanceRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') renameSavedPerformance(record.id)
                            if (event.key === 'Escape') setPerformanceRenameId(null)
                          }}
                          aria-label="Performance name"
                        />
                        <button type="button" onClick={() => renameSavedPerformance(record.id)}>Save</button>
                        <button type="button" onClick={() => setPerformanceRenameId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="performance-list-item"
                          onClick={() => playSavedPerformance(record)}
                        >
                          <span>
                            <strong>{record.name}</strong>
                            <small>{new Date(record.createdAt).toLocaleString()}</small>
                          </span>
                          <PlayIcon />
                        </button>
                        <button
                          type="button"
                          className="performance-rename-button"
                          onClick={() => {
                            setPerformanceRenameId(record.id)
                            setPerformanceRenameValue(record.name)
                          }}
                          title={`Rename ${record.name}`}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="performance-delete-button"
                          onClick={() => setPerformanceDeleteId(record.id)}
                          title={`Delete ${record.name}`}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="performance-modal-actions">
              <button type="button" onClick={() => setPerformanceLibraryOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {performanceDeleteId && (
        <div
          className="performance-modal-backdrop"
          onMouseDown={() => setPerformanceDeleteId(null)}
        >
          <div
            className="performance-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="performance-delete-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="performance-delete-title">Delete Performance</h2>
            <p>
              Are you sure you want to delete "
              {savedPerformances.find((record) => record.id === performanceDeleteId)?.name}"? This
              cannot be undone.
            </p>
            <div className="performance-modal-actions">
              <button type="button" onClick={() => setPerformanceDeleteId(null)}>Cancel</button>
              <button type="button" onClick={() => deleteSavedPerformance(performanceDeleteId)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {backupNoticeOpen && (
        <div className="backup-performance-notice" role="status">
          Nothing Played In The Last 10 Minutes. Remember backup recording only begins if and when the user starts playing the keyboard.
        </div>
      )}

      {trackContextMenu && (
        <div
          className="track-context-menu"
          ref={trackContextMenuRef}
          style={{ top: trackContextMenu.y, left: trackContextMenu.x }}
        >
          {trackContextMenu.section === 'recent' && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={() => {
                loadFileIntoStudio(trackContextMenu.track.filePath)
                setAppView('studio')
                setTrackContextMenu(null)
              }}
            >
              Open Song in Studio
            </button>
          )}
          <button
            type="button"
            className="track-context-menu-item"
            disabled={detectingKeyTrack?.id === trackContextMenu.track.id}
            onClick={() => detectKeyForTrack(trackContextMenu.track)}
          >
            {detectingKeyTrack?.id === trackContextMenu.track.id ? 'Detecting…' : 'Detect Key'}
          </button>
          {!trackContextMenu.track.favorite && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={() => {
                toggleTrackFavorite(trackContextMenu.track)
                setTrackContextMenu(null)
              }}
            >
              Favorite
            </button>
          )}
          <button
            type="button"
            className="track-context-menu-item"
            onClick={() => {
              addToQueue(trackContextMenu.track)
              setTrackContextMenu(null)
            }}
          >
            Add to Queue
          </button>
          {trackContextMenu.section === 'recent' && !trackContextMenu.track.inLibrary && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={() => {
                toggleTrackInclude(trackContextMenu.track)
                setTrackContextMenu(null)
              }}
            >
              Add to Song Library
            </button>
          )}
          {trackContextMenu.section !== 'recent' && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={() => {
                loadFileIntoStudio(trackContextMenu.track.filePath)
                setAppView('studio')
                setTrackContextMenu(null)
              }}
            >
              Open Song in Studio
            </button>
          )}
          {trackContextMenu.section === 'songs' && (
            <button
              type="button"
              className="track-context-menu-item"
              onClick={() => {
                toggleTrackInclude(trackContextMenu.track)
                setTrackContextMenu(null)
              }}
            >
              Remove From Songs Library
            </button>
          )}
          <button
            type="button"
            className="track-context-menu-item"
            onClick={() => {
              const track = trackContextMenu.track
              setInfoTrack(track)
              setInfoTrackEditable(trackContextMenu.section === 'advanced')
              setTrackContextMenu(null)
              window.api.getBassIntervals([track.id]).then((map) => {
                setBassIntervalsByTrack((prev) => ({ ...prev, ...map }))
              })
            }}
          >
            Show Info
          </button>
        </div>
      )}

      {nowPlayingArtMenu && currentTrack && (
        <div
          className="track-context-menu"
          ref={nowPlayingArtMenuRef}
          style={{ top: nowPlayingArtMenu.y, left: nowPlayingArtMenu.x }}
        >
          <button
            type="button"
            className="track-context-menu-item"
            onClick={() => {
              const track = currentTrack
              setInfoTrack(track)
              setInfoTrackEditable(false)
              setNowPlayingArtMenu(null)
              window.api.getBassIntervals([track.id]).then((map) => {
                setBassIntervalsByTrack((prev) => ({ ...prev, ...map }))
              })
            }}
          >
            Show Info
          </button>
        </div>
      )}

      {infoTrack && infoTrackLive && (
        <div className="modal-overlay" onMouseDown={() => setInfoTrack(null)}>
          <div className="modal-card modal-card-info" onMouseDown={(e) => e.stopPropagation()}>
            <div className="track-info-fields">
              <EditableInfoField
                label="Title"
                value={infoTrackLive.title ?? ''}
                onSave={(title) => saveTagForSelection(infoTrackLive, { title })}
              />
              <EditableInfoField
                label="Artist"
                value={infoTrackLive.artist ?? ''}
                onSave={(artist) => saveTagForSelection(infoTrackLive, { artist })}
              />
              <EditableInfoField
                label="Album"
                value={infoTrackLive.album ?? ''}
                onSave={(album) => saveTagForSelection(infoTrackLive, { album })}
              />
              <EditableInfoKeyField
                label="Key (and Scale)"
                value={infoTrackLive.key}
                displayValue={infoTrackLive.keySignature ?? infoTrackLive.key}
                onSave={(key) => saveTagForSelection(infoTrackLive, { key })}
              />
              <div className="track-info-field">
                <span className="track-info-label">Bass</span>
                <div className="track-info-bass">
                  {(bassIntervalsByTrack[infoTrackLive.id] ?? []).length === 0 ? (
                    <span className="track-info-value">Unknown</span>
                  ) : (
                    <div className="track-info-bass-chips">
                      {(bassIntervalsByTrack[infoTrackLive.id] ?? []).map((entry) => (
                        <span key={entry.id} className="bass-interval-chip">
                          <span className="bass-interval-sequence">{entry.sequence}</span>
                          {infoTrackEditable && (
                            <button
                              type="button"
                              className="bass-interval-remove"
                              title="Remove this bass sequence"
                              onClick={() => removeBassIntervalFromTrack(infoTrackLive, entry.id)}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {infoTrackEditable && (
                    <BassIntervalAddRow onAdd={(sequence) => addBassIntervalToTrack(infoTrackLive, sequence)} />
                  )}
                </div>
              </div>
              <div className="track-info-field">
                <span className="track-info-label">Mood</span>
                <span className="track-info-value">{infoTrackLive.mood || 'Unknown'}</span>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn modal-btn-secondary"
                onClick={() => window.api.showItemInFolder(infoTrackLive.filePath)}
              >
                Show File Location
              </button>
              {pendingTagEdits[infoTrackLive.id] && (
                <button
                  className="modal-btn modal-btn-primary"
                  onClick={() => applyPendingTagUpdate(infoTrackLive)}
                >
                  Update
                </button>
              )}
              <button className="modal-btn modal-btn-secondary" onClick={() => setInfoTrack(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {artUpdatePrompt && (
        <div className="modal-overlay" onMouseDown={() => setArtUpdatePrompt(null)}>
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Update Metadata?</h3>
            <p className="modal-message">
              Save the album art to the file's metadata tags?
            </p>
            <div className="modal-actions">
              <button 
                className="modal-btn modal-btn-secondary" 
                onClick={() => commitTrackArtUpdate(false)}
              >
                Skip
              </button>
              <button 
                className="modal-btn modal-btn-primary" 
                onClick={() => commitTrackArtUpdate(true)}
              >
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {internalAudioRecorder.trimPromptOpen && (
        <div className="modal-overlay" onMouseDown={internalAudioRecorder.dismissTrim}>
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Trim Silence?</h3>
            <p className="modal-message">
              Remove silence from the beginning and end of this recording?
            </p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-secondary" onClick={internalAudioRecorder.dismissTrim}>
                No
              </button>
              <button className="modal-btn modal-btn-primary" onClick={internalAudioRecorder.confirmTrim}>
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {micRecorder.trimPromptOpen && (
        <div className="modal-overlay" onMouseDown={micRecorder.dismissTrim}>
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Trim Silence?</h3>
            <p className="modal-message">
              Remove silence (or near-silence) from the beginning and end of this recording?
            </p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-secondary" onClick={micRecorder.dismissTrim}>
                No
              </button>
              <button className="modal-btn modal-btn-primary" onClick={micRecorder.confirmTrim}>
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingLibraryAddPath && (
        <div className="modal-overlay" onMouseDown={dismissAddToLibrary}>
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Add to Song Library?</h3>
            <p className="modal-message">
              The file has been saved to your computer. Add it to your song library too?
            </p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-secondary" onClick={dismissAddToLibrary}>
                No
              </button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={confirmAddToLibrary}
                disabled={addingToLibrary}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmImportKeyTrack && (
        <div className="modal-overlay" onMouseDown={() => cancelImportKey()}>
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Import Key?</h3>
            <p className="modal-message">
              The detected key for {confirmImportKeyTrack.title ?? 'this song'} is{' '}
              {confirmImportKeyTrack.keySignature ?? confirmImportKeyTrack.key}. Import it?
            </p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-secondary" onClick={cancelImportKey}>
                No
              </button>
              <button className="modal-btn modal-btn-primary" onClick={confirmImportKey}>
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingFolderPath && (
        <div className="modal-overlay" onMouseDown={() => setPendingFolderPath(null)}>
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Include in song library?</h3>
            <p className="modal-message">
              Songs can be added to your Songs tab, or kept isolated so they only show up when
              you browse this folder in Sections.
            </p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-secondary" onClick={() => confirmAddFolder(false)}>
                No
              </button>
              <button className="modal-btn modal-btn-primary" onClick={() => confirmAddFolder(true)}>
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
      {pauseAudioPrompt && (
        <div
          className="modal-overlay"
          onMouseDown={() => {
            setPauseAudioPrompt(false)
            resumeVideoAfterPrompt()
          }}
        >
          <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Pause Current Audio Playback?</h3>
            <div className="modal-actions">
              <button
                className="modal-btn modal-btn-secondary"
                onClick={() => {
                  setPauseAudioPrompt(false)
                  resumeVideoAfterPrompt()
                }}
              >
                No
              </button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={() => {
                  if (isPlaying) togglePlay()
                  setPauseAudioPrompt(false)
                  resumeVideoAfterPrompt()
                }}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
