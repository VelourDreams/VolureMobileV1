import { useEffect, useRef, useState } from 'react'
import { PitchShifterWorklet as PitchShifter, warmPitchShiftWorklet } from './pitchShiftWorkletNode'
import { trimSilence, sliceAndFadeBuffer, type FadeSetting } from './audioTrim'
import { computePeaksFromBuffer } from './useWaveformPeaks'
import { PITCH_SHIFT_BUFFER_SIZE } from './pitchShift'
import { EQ_BANDS } from './eq'

export interface FilePlaybackHandle {
  playing: boolean
  currentTime: number
  volume: number
  togglePlay: () => void
  seek: (time: number) => void
  setVolume: (volume: number) => void
  reversed: boolean
  reversing: boolean
  toggleReverse: () => void
  playbackRate: number
  setPlaybackRate: (rate: number) => void
  silenceRemoved: boolean
  removingSilence: boolean
  removeSilence: () => void
  // Set once silence has been trimmed — the waveform display and duration
  // then need to reflect the trimmed buffer rather than the original file,
  // since there's no way to "cut" the underlying file on disk.
  trimmedPeaks: number[] | null
  trimmedDuration: number | null
  // Manual Trim Audio — unlike removeSilence, the cut points and fades are
  // user-picked and re-applied repeatedly as the trim handles move, so this
  // is split into three steps: a one-off snapshot of the *untouched* source
  // (beginManualTrim), a re-sliceable live-preview apply that hot-swaps
  // playback but leaves trimmedPeaks/trimmedDuration alone (applyManualTrim
  // — called once per handle drag or fade toggle), and an explicit commit
  // (confirmManualTrim, called once when the user clicks "Done") that's the
  // only thing that updates trimmedPeaks/trimmedDuration. This keeps the
  // waveform's own size/duration display fixed on the original clip while
  // the user is still dragging handles — only the overlay should move —
  // and keeps beginManualTrim's snapshot re-derived from the original file
  // every time (never a previous trim's result), so reopening Trim Audio
  // after an earlier trim starts from the full clip again, letting the user
  // drag back out to recover audio a previous trim cut away.
  beginManualTrim: () => void
  applyManualTrim: (startRatio: number, endRatio: number, fadeIn: FadeSetting, fadeOut: FadeSetting) => void
  confirmManualTrim: () => void
  // True from the moment applyManualTrim first runs (regardless of whether
  // "Done" has been clicked yet) until a new src loads — lets
  // exportStudioAudio's hasProcessing check bake an in-progress trim/fade
  // into a Save even if the user saves before confirming it.
  manualTrimApplied: boolean
  // Tempo-independent pitch shift, in semitones — see the pitch-shift effect
  // below for how this hands playback to (or back from) a SoundTouch
  // PitchShifter.
  pitchSemitones: number
  setPitchSemitones: (value: number) => void
  // Studio's Equalizer tool — a 7-band graphic EQ plus a 0-2 (0%-200%)
  // volume boost. Always in the signal path (see ensureWebAudioCtx)
  // regardless of which engine is actually driving sound, so both apply
  // from the very first play, and — like reverse/trim — exportStudioAudio
  // bakes them into the saved file too (see prepareExportSource) once
  // anything's actually been changed from flat/100%.
  eqGains: number[]
  setEqBandGain: (index: number, value: number) => void
  resetEq: () => void
  boostVolume: number
  setBoostVolume: (value: number) => void
  // The Studio dB meter's tap points — post-EQ/boost, pre-volume, so they
  // read true regardless of this slot's own volume slider. Null until a src
  // has been loaded (see ensureWebAudioCtx). Split left/right so the meter
  // can show both channels independently.
  meterAnalyserL: AnalyserNode | null
  meterAnalyserR: AnalyserNode | null
  // The buffer exportStudioAudio should render its offline EQ/boost/rate
  // pass from — see prepareExportSource.
  prepareExportSource: () => Promise<AudioBuffer | null>
}

// Builds a new AudioBuffer whose channel data is the reverse of the
// source buffer's — same approach used for mic/internal-audio takes in
// useAudioRecorder.
function reverseBuffer(buffer: AudioBuffer): AudioBuffer {
  const channelCount = buffer.numberOfChannels
  const length = buffer.length
  const reversed = new AudioBuffer({
    numberOfChannels: channelCount,
    length,
    sampleRate: buffer.sampleRate,
  })
  for (let ch = 0; ch < channelCount; ch++) {
    const source = buffer.getChannelData(ch)
    const dest = new Float32Array(length)
    for (let i = 0; i < length; i++) dest[i] = source[length - 1 - i]
    reversed.copyToChannel(dest, ch)
  }
  return reversed
}

// `src` is always a media://<encoded filePath> URL built by getMediaUrl —
// recovering filePath from it (rather than threading a second prop through
// every caller) is what lets the error-triggered fallback below ask the
// main process to transcode the original file.
function filePathFromMediaUrl(src: string): string | null {
  if (!src.startsWith('media://')) return null
  try {
    return decodeURIComponent(src.slice('media://'.length).split('?')[0])
  } catch {
    return null
  }
}

// Plain <audio>-element playback for whatever's loaded into Studio (an
// imported Now Playing track or a file dropped directly onto Studio) —
// deliberately its own element rather than the app's single shared <audio>
// (which drives Now Playing), so Studio can never start, stop, seek, or
// change the volume of whatever the user actually has playing.
export function useFilePlayback(src: string | null, initialVolume: number): FilePlaybackHandle {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [volume, setVolumeState] = useState(initialVolume)
  // Read at src-change time rather than depended on directly, so Studio's
  // volume only snaps to the master slider once per newly loaded file —
  // it's then free to drift independently without master changes chasing it.
  const initialVolumeRef = useRef(initialVolume)
  initialVolumeRef.current = initialVolume
  // Whether the current `src` has already been swapped for a transcoded
  // fallback (see handleUnsupportedSource) — keeps a file that's still
  // unplayable after transcoding from retrying forever, and tells
  // togglePlay's self-heal not to stomp the fallback back to the original.
  const fallbackAppliedRef = useRef(false)
  // Whether the user has asked to play — if the fallback transcode is still
  // in flight when they click, playback resumes automatically once it lands.
  const playIntentRef = useRef(false)

  // Time-stretch rate — applies directly to the native <audio> element when
  // playing forward, or to the reversed-playback buffer source below when
  // playing backward. Read via the ref (rather than the state) wherever a
  // new source/element needs the current rate, so a rate set while paused is
  // still picked up the next time playback starts.
  const [playbackRate, setPlaybackRateState] = useState(1)
  const playbackRateRef = useRef(1)

  // Reversed playback — and, once silence has been trimmed, forward
  // playback too — are a second, entirely separate engine from the native
  // <audio> above: there's no way to play a MediaElement backwards, and no
  // way to "cut" a chunk out of its source file, so both go through Web
  // Audio buffer-source nodes instead (same approach Now Playing's Reverse
  // Audio feature uses), on its own AudioContext so it can't collide with
  // either the <audio> element above or the app's main playback graph. Only
  // one of the two ever drives sound at a time (activeDirectionRef says
  // which); trimming while reversed re-derives reversedBufferRef from the
  // freshly trimmed forwardBufferRef, and reversing after a trim reverses
  // the trimmed clip rather than the original.
  const [reversed, setReversed] = useState(false)
  const [reversing, setReversing] = useState(false)
  const [silenceRemoved, setSilenceRemoved] = useState(false)
  const [removingSilence, setRemovingSilence] = useState(false)
  const [trimmedPeaks, setTrimmedPeaks] = useState<number[] | null>(null)
  // Explicit rather than derived from forwardBufferRef — forwardBufferRef
  // itself is hot-swapped on every handle drag / fade toggle (for live
  // audible preview), but this should only change once, when
  // confirmManualTrim runs on "Done" — see confirmManualTrim's own comment.
  const [trimmedDurationState, setTrimmedDurationState] = useState<number | null>(null)
  // Unlike trimmedDurationState, set the moment applyManualTrim first runs
  // and never cleared by beginManualTrim/confirmManualTrim (only by a src
  // change) — exportStudioAudio's hasProcessing check reads this instead of
  // trimmedDuration so Save still bakes in an in-progress trim/fade even if
  // the user clicks Save before clicking "Done".
  const [manualTrimApplied, setManualTrimApplied] = useState(false)
  // Set by applyManualTrim, cleared by beginManualTrim/confirmManualTrim —
  // whether a trim/fade has actually been applied since Trim Audio last
  // opened on this slot, so confirmManualTrim (and a Done click with no
  // edits made) doesn't stamp trimmedPeaks/trimmedDurationState from a
  // buffer nothing actually changed.
  const manualTrimDirtyRef = useRef(false)
  // The buffer applyManualTrim always re-slices from, snapshotted once by
  // beginManualTrim when Trim Audio opens on this slot — re-deriving from
  // this on every call (rather than the previous result) means repeated
  // handle drags / fade toggles never compound cuts into each other. Always
  // the untouched original (see ensureOriginalBuffer), even if a previous
  // Trim Audio session already cut this slot down, so reopening the tool
  // can always drag back out to recover audio a previous trim cut away.
  const manualTrimBaseRef = useRef<AudioBuffer | null>(null)
  // The untouched decode of the source file — unlike forwardBufferRef below
  // (which trim/silence-removal overwrite with their result), this never
  // changes once set. See ensureOriginalBuffer.
  const originalBufferRef = useRef<AudioBuffer | null>(null)
  // Tempo-independent pitch shift — a third reason (alongside reversed and
  // silenceRemoved) the Web Audio engine takes over from native <audio>, via
  // the pitch-shift effect below. Mirrors pitchSemitonesRef for use inside
  // async closures (decode callbacks) the same way playbackRateRef does.
  const [pitchSemitones, setPitchSemitones] = useState(0)
  const pitchSemitonesRef = useRef(0)
  // Set instead of webAudioSourceRef whenever pitch is active — a SoundTouch
  // PitchShifter "pseudo-node" (WSOLA time-stretch) in place of a plain
  // AudioBufferSourceNode, since only it can move pitch independently of
  // playbackRate. Still plays whatever activeBufferRef/activeDirectionRef
  // point at, so reversed/trimmed audio combine with pitch shift for free.
  const pitchShifterRef = useRef<PitchShifter | null>(null)
  // Studio Equalizer state — the filter bank/boost/meter live in the same
  // Web Audio graph the native <audio> element is unconditionally routed
  // through (see ensureWebAudioCtx), so they apply regardless of whether
  // this slot is on native forward playback or the reversed/trimmed/
  // pitch-shifted buffer engine below.
  const [eqGains, setEqGainsState] = useState<number[]>(EQ_BANDS.map(() => 0))
  const eqGainsRef = useRef<number[]>(EQ_BANDS.map(() => 0))
  const eqFilterNodesRef = useRef<BiquadFilterNode[]>([])
  const [boostVolume, setBoostVolumeState] = useState(1)
  const boostVolumeRef = useRef(1)
  const webAudioBoostRef = useRef<GainNode | null>(null)
  // The filter chain's entry point (first filter, or the boost node if
  // EQ_BANDS were ever empty) — where the active source/shifter (and the
  // native element's own media source) connects instead of straight to
  // webAudioGainRef.
  const webAudioEqEntryRef = useRef<AudioNode | null>(null)
  // Tap points for the Studio dB meter — see meterAnalyserL/meterAnalyserR
  // on the return value below.
  const meterAnalyserLRef = useRef<AnalyserNode | null>(null)
  const meterAnalyserRRef = useRef<AnalyserNode | null>(null)
  // Redirects the native <audio> element's own output through the graph
  // above — see ensureWebAudioCtx. Only ever created once per element.
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const forwardBufferRef = useRef<AudioBuffer | null>(null)
  const reversedBufferRef = useRef<AudioBuffer | null>(null)
  const activeBufferRef = useRef<AudioBuffer | null>(null)
  const activeDirectionRef = useRef<'forward' | 'reversed'>('forward')
  const webAudioCtxRef = useRef<AudioContext | null>(null)
  const webAudioGainRef = useRef<GainNode | null>(null)
  const webAudioSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const webAudioStartCtxTimeRef = useRef(0)
  // Offset into the *active* buffer in its own playback order — for reversed
  // playback that's distance from the acoustic end of the track, and
  // currentTime is reported back as (duration - offset) so the on-screen
  // cursor still tracks left-to-right across the always forward-ordered
  // waveform peaks while audio plays backwards under it. For trimmed forward
  // playback, offset and currentTime are the same thing.
  const webAudioStartOffsetRef = useRef(0)
  const webAudioRafRef = useRef<number | null>(null)

  // Builds the persistent Web Audio graph — the graphic EQ filter bank,
  // volume-boost node, the Studio dB meter's analyser tap, and the master
  // gain node — and, the first time this runs, permanently reroutes the
  // native <audio> element's own output through it too via
  // createMediaElementSource. That means EQ/boost/the meter apply
  // regardless of whether native forward playback or the reversed/trimmed/
  // pitch-shifted buffer engine below is actually driving sound (only one
  // ever produces signal at a time — the other is paused — so there's no
  // risk of doubling up). Mirrors the app's main Now Playing engine
  // (ensureAudioContext in App.tsx), which has used this same pattern from
  // the start. Guarded to run once — createMediaElementSource throws if
  // called twice on the same element — and called eagerly as soon as a src
  // loads (see the src-sync effect below) rather than waiting for the user
  // to press play or open the Equalizer, so the meter reads true from the
  // first frame.
  function ensureWebAudioCtx(): AudioContext {
    if (!webAudioCtxRef.current) {
      const ctx = new AudioContext()
      // Kicks off the pitch-shift worklet module's fetch+compile now rather
      // than waiting for the user to actually engage pitch shift, so the
      // first engage of a session doesn't hit a silent gap while it loads.
      warmPitchShiftWorklet(ctx)
      // Built with whatever gains/boost were already set (e.g. dialed in
      // before this slot ever started playing) rather than always starting
      // flat.
      const filters = EQ_BANDS.map(({ freq, type }, i) => {
        const filter = ctx.createBiquadFilter()
        filter.type = type
        filter.frequency.value = freq
        filter.Q.value = 1
        filter.gain.value = eqGainsRef.current[i] ?? 0
        return filter
      })
      for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1])
      const boost = ctx.createGain()
      boost.gain.value = boostVolumeRef.current
      // A channel splitter feeds two per-channel analysers so the meter can
      // show left/right independently rather than a downmixed average.
      const meterSplitter = ctx.createChannelSplitter(2)
      const analyserL = ctx.createAnalyser()
      analyserL.fftSize = 512
      analyserL.smoothingTimeConstant = 0.6
      const analyserR = ctx.createAnalyser()
      analyserR.fftSize = 512
      analyserR.smoothingTimeConstant = 0.6
      const gain = ctx.createGain()
      gain.gain.value = initialVolumeRef.current
      filters[filters.length - 1]?.connect(boost)
      // The meter tap is a fan-out, not an in-line stop — it doesn't need
      // its own onward connection since nothing reads audio back out of it,
      // only its analysis data.
      boost.connect(meterSplitter)
      meterSplitter.connect(analyserL, 0)
      meterSplitter.connect(analyserR, 1)
      boost.connect(gain)
      gain.connect(ctx.destination)
      webAudioCtxRef.current = ctx
      webAudioGainRef.current = gain
      webAudioBoostRef.current = boost
      eqFilterNodesRef.current = filters
      webAudioEqEntryRef.current = filters[0] ?? boost
      meterAnalyserLRef.current = analyserL
      meterAnalyserRRef.current = analyserR

      const audio = audioRef.current
      if (audio) {
        const mediaSource = ctx.createMediaElementSource(audio)
        mediaSource.connect(filters[0] ?? boost)
        mediaSourceRef.current = mediaSource
        // From this point on, gain.gain.value is the sole volume control
        // for the element's output — reset so the element's own volume
        // doesn't double up with it (same fix as the main engine's).
        audio.volume = 1
      }
    }
    return webAudioCtxRef.current
  }

  // Studio Equalizer tool functions — see the Studio Equalizer tool state
  // block above.
  function setEqBandGain(index: number, value: number) {
    eqGainsRef.current = eqGainsRef.current.map((g, i) => (i === index ? value : g))
    setEqGainsState(eqGainsRef.current)
    const filter = eqFilterNodesRef.current[index]
    if (filter) filter.gain.value = value
  }

  function resetEq() {
    eqGainsRef.current = EQ_BANDS.map(() => 0)
    setEqGainsState(eqGainsRef.current)
    eqFilterNodesRef.current.forEach((filter) => {
      filter.gain.value = 0
    })
  }

  function setBoostVolume(next: number) {
    boostVolumeRef.current = next
    setBoostVolumeState(next)
    if (webAudioBoostRef.current) webAudioBoostRef.current.gain.value = next
  }

  // Stops whatever Web Audio source is playing (reversed or trimmed-forward,
  // either a raw AudioBufferSourceNode or a pitch-shifted PitchShifter) and
  // returns the offset (into the active buffer, in its own playback order)
  // it had reached, so callers can resume from there or convert it back to
  // a forward-time position.
  function stopWebAudioPlayback(): number {
    if (pitchShifterRef.current) {
      const shifter = pitchShifterRef.current
      const offset = shifter.timePlayed
      shifter.off()
      shifter.disconnect()
      pitchShifterRef.current = null
      return offset
    }

    const ctx = webAudioCtxRef.current
    let offset = webAudioStartOffsetRef.current
    if (webAudioSourceRef.current && ctx) {
      offset =
        webAudioStartOffsetRef.current +
        (ctx.currentTime - webAudioStartCtxTimeRef.current) * playbackRateRef.current
    }
    if (webAudioRafRef.current !== null) {
      cancelAnimationFrame(webAudioRafRef.current)
      webAudioRafRef.current = null
    }
    if (webAudioSourceRef.current) {
      const source = webAudioSourceRef.current
      webAudioSourceRef.current = null
      source.onended = null
      try {
        source.stop()
      } catch {
        // already stopped
      }
      source.disconnect()
    }
    return offset
  }

  function startWebAudioPlayback(offsetSeconds: number, autoplay: boolean) {
    const buffer = activeBufferRef.current
    if (!buffer) return
    const reversedDirection = activeDirectionRef.current === 'reversed'
    const ctx = ensureWebAudioCtx()
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const clampedOffset = Math.min(Math.max(0, offsetSeconds), buffer.duration)

    if (pitchSemitonesRef.current !== 0) {
      startPitchShiftedPlayback(ctx, buffer, clampedOffset, reversedDirection, autoplay)
      return
    }

    webAudioStartOffsetRef.current = clampedOffset
    webAudioStartCtxTimeRef.current = ctx.currentTime
    setCurrentTime(reversedDirection ? Math.max(0, buffer.duration - clampedOffset) : clampedOffset)

    if (!autoplay) {
      setPlaying(false)
      return
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = playbackRateRef.current
    source.connect(webAudioEqEntryRef.current ?? webAudioGainRef.current ?? ctx.destination)
    source.onended = () => {
      // Only a natural end-of-buffer reaches this — stopWebAudioPlayback()
      // (used for pause/seek/un-reverse) already clears the ref
      // synchronously before this async event can fire. Loops back to the
      // start rather than stopping, so audio left playing runs indefinitely
      // until the user pauses it.
      if (webAudioSourceRef.current !== source) return
      webAudioSourceRef.current = null
      if (webAudioRafRef.current !== null) {
        cancelAnimationFrame(webAudioRafRef.current)
        webAudioRafRef.current = null
      }
      startWebAudioPlayback(0, true)
    }
    source.start(0, clampedOffset)
    webAudioSourceRef.current = source
    setPlaying(true)

    const tick = () => {
      if (webAudioSourceRef.current !== source) return
      const elapsed = (ctx.currentTime - webAudioStartCtxTimeRef.current) * playbackRateRef.current
      const pos = Math.min(buffer.duration, webAudioStartOffsetRef.current + elapsed)
      setCurrentTime(reversedDirection ? Math.max(0, buffer.duration - pos) : pos)
      webAudioRafRef.current = requestAnimationFrame(tick)
    }
    tick()
  }

  // The pitch-active counterpart to the plain AudioBufferSourceNode playback
  // above — a SoundTouch PitchShifter WSOLA-shifts the same buffer/direction
  // startWebAudioPlayback already resolved, so reversed/trimmed audio and
  // pitch shift combine automatically. Position tracking comes from the
  // shifter's own 'play' events (dispatched once per audio-process callback)
  // rather than a ctx-clock tick loop, since the shifter tracks samples
  // actually consumed directly.
  function startPitchShiftedPlayback(
    ctx: AudioContext,
    buffer: AudioBuffer,
    clampedOffset: number,
    reversedDirection: boolean,
    autoplay: boolean
  ) {
    setCurrentTime(reversedDirection ? Math.max(0, buffer.duration - clampedOffset) : clampedOffset)
    webAudioStartOffsetRef.current = clampedOffset

    if (!autoplay) {
      setPlaying(false)
      return
    }

    const shifter = new PitchShifter(ctx, buffer, PITCH_SHIFT_BUFFER_SIZE, () => {
      // Only a natural end-of-buffer reaches this repeatedly once the
      // source runs dry — stopWebAudioPlayback() (used for pause/seek/
      // un-reverse) tears the shifter down synchronously before a stale
      // callback can double-fire this. Loops back to the start rather than
      // stopping, matching the raw-engine path above.
      if (pitchShifterRef.current !== shifter) return
      shifter.percentagePlayed = 0
    })
    shifter.tempo = playbackRateRef.current
    shifter.pitchSemitones = pitchSemitonesRef.current
    shifter.percentagePlayed = buffer.duration > 0 ? clampedOffset / buffer.duration : 0
    shifter.on('play', (detail) => {
      setCurrentTime(reversedDirection ? Math.max(0, buffer.duration - detail.timePlayed) : detail.timePlayed)
    })
    shifter.connect(webAudioEqEntryRef.current ?? webAudioGainRef.current ?? ctx.destination)

    pitchShifterRef.current = shifter
    setPlaying(true)
  }

  // Lazily decodes and caches the true, never-overwritten original — unlike
  // forwardBufferRef (which trim/silence-removal replace with their result),
  // this always stays the untouched file, so beginManualTrim can re-derive a
  // trim from the real original no matter how many edits already happened.
  async function ensureOriginalBuffer(): Promise<AudioBuffer | null> {
    if (originalBufferRef.current) return originalBufferRef.current
    if (!src) return null
    const res = await fetch(src)
    const arrayBuffer = await res.arrayBuffer()
    const ctx = ensureWebAudioCtx()
    originalBufferRef.current = await ctx.decodeAudioData(arrayBuffer)
    return originalBufferRef.current
  }

  // Lazily decodes and caches the *current effective* forward buffer —
  // shared by toggleReverse, removeSilence, and the pitch-shift effect
  // below, the three places that need a decoded AudioBuffer to hand
  // playback to the Web Audio engine and want whatever's already been
  // trimmed/silence-removed (if anything) rather than the original. Backed
  // by ensureOriginalBuffer so the first decode is never repeated.
  async function ensureForwardBuffer(): Promise<AudioBuffer | null> {
    if (forwardBufferRef.current) return forwardBufferRef.current
    forwardBufferRef.current = await ensureOriginalBuffer()
    return forwardBufferRef.current
  }

  // The buffer Studio's export should render from — decoded/reversed/
  // trimmed exactly as this slot currently plays, but (unlike playback)
  // without EQ/boost/rate baked in yet: exportStudioAudio applies those
  // itself via an OfflineAudioContext, mirroring the aligned "track" case's
  // own export path, so gains/boost/rate read at render time (not whatever
  // they were when this was called) end up in the file.
  async function prepareExportSource(): Promise<AudioBuffer | null> {
    const forward = await ensureForwardBuffer()
    if (!forward) return null
    if (reversed) {
      if (!reversedBufferRef.current) reversedBufferRef.current = reverseBuffer(forward)
      return reversedBufferRef.current
    }
    return forward
  }

  // Turns reversed playback on/off.
  async function toggleReverse() {
    const audio = audioRef.current
    if (!audio || !src || reversing) return
    const onWebAudio = activeBufferRef.current !== null

    if (reversed) {
      const wasPlaying = playing
      const offset = stopWebAudioPlayback()
      const buffer = reversedBufferRef.current
      const forwardTime = buffer ? Math.max(0, Math.min(buffer.duration, buffer.duration - offset)) : 0
      setReversed(false)
      if (silenceRemoved || pitchSemitonesRef.current !== 0) {
        // Still driven by the trimmed/pitch-shifted buffer, not the native
        // element — hand playback back to the forward Web Audio engine
        // rather than the (untouched) <audio> element, which has nothing to
        // resume from.
        activeBufferRef.current = forwardBufferRef.current
        activeDirectionRef.current = 'forward'
        startWebAudioPlayback(forwardTime, wasPlaying)
        return
      }
      audio.currentTime = forwardTime
      setCurrentTime(forwardTime)
      if (wasPlaying) {
        audio
          .play()
          .then(() => setPlaying(true))
          .catch((err) => console.error('Failed to resume forward playback:', err))
      } else {
        setPlaying(false)
      }
      return
    }

    setReversing(true)
    try {
      const forward = await ensureForwardBuffer()
      if (!forward) throw new Error('No source to reverse')
      // Rebuilt whenever it's missing — cleared by removeSilence() so a trim
      // applied while forward is never reversed from stale (pre-trim) data.
      if (!reversedBufferRef.current) {
        reversedBufferRef.current = reverseBuffer(forward)
      }
    } catch (err) {
      console.error('Failed to prepare reversed audio:', err)
      setReversing(false)
      return
    }
    setReversing(false)

    const buffer = reversedBufferRef.current
    if (!buffer) return
    const wasPlaying = playing
    // Silence-removed/pitch-shifted playback is already driven by
    // forwardBufferRef through the Web Audio engine, so its precise
    // position comes from stopping that engine rather than reading the
    // (irrelevant, stale) native element.
    const currentForwardTime = onWebAudio ? stopWebAudioPlayback() : audio.currentTime
    if (!onWebAudio) audio.pause()
    const offset = Math.max(0, Math.min(buffer.duration, buffer.duration - currentForwardTime))
    activeBufferRef.current = buffer
    activeDirectionRef.current = 'reversed'
    setReversed(true)
    startWebAudioPlayback(offset, wasPlaying)
  }

  // Removes leading/trailing silence from the file — lazily decodes (or
  // reuses an already-decoded buffer, e.g. from a prior reverse toggle)
  // then, like toggleReverse, hands playback over to the Web Audio engine
  // since there's no way to "cut" a chunk out of the native element's
  // source file. Shares its working buffer with toggleReverse
  // (forwardBufferRef): reversing after a trim reverses the trimmed clip,
  // matching how useAudioRecorder's take trimming works.
  async function removeSilence() {
    const audio = audioRef.current
    if (!audio || !src || removingSilence || silenceRemoved) return
    setRemovingSilence(true)
    try {
      const forward = await ensureForwardBuffer()
      if (!forward) throw new Error('No source to trim')
      forwardBufferRef.current = trimSilence(forward)
      // Invalidated — a reverse toggle after this rebuilds it from the
      // now-trimmed forward buffer instead of reusing the stale full-length
      // one.
      reversedBufferRef.current = null
    } catch (err) {
      console.error('Failed to remove silence:', err)
      setRemovingSilence(false)
      return
    }
    setRemovingSilence(false)
    setSilenceRemoved(true)
    setTrimmedPeaks(computePeaksFromBuffer(forwardBufferRef.current))
    setTrimmedDurationState(forwardBufferRef.current.duration)

    const buffer = forwardBufferRef.current
    const wasPlaying = playing
    if (reversed) {
      stopWebAudioPlayback()
      reversedBufferRef.current = reverseBuffer(buffer)
      activeBufferRef.current = reversedBufferRef.current
      activeDirectionRef.current = 'reversed'
      startWebAudioPlayback(0, wasPlaying)
      return
    }
    audio.pause()
    activeBufferRef.current = buffer
    activeDirectionRef.current = 'forward'
    startWebAudioPlayback(0, wasPlaying)
  }

  // Snapshots the untouched original as the fixed source applyManualTrim
  // re-slices from — called once when Trim Audio opens on this slot. Always
  // the real original (see ensureOriginalBuffer), never a previous trim's
  // result, so reopening Trim Audio after an earlier trim starts from the
  // full clip again. Also resets the waveform override back to null (so the
  // waveform falls back to the real file's own full-length peaks/duration
  // while editing) and clears the dirty flag confirmManualTrim checks.
  function beginManualTrim() {
    manualTrimDirtyRef.current = false
    setTrimmedPeaks(null)
    setTrimmedDurationState(null)
    ensureOriginalBuffer().then((original) => {
      manualTrimBaseRef.current = original
    })
  }

  // Cuts manualTrimBaseRef down to [startRatio, endRatio] and bakes in any
  // active fades, then hands the result to the Web Audio engine exactly like
  // removeSilence does — there's no way to "cut" a chunk out of the native
  // element's source file either. Safe to call repeatedly (once per handle
  // drag release, or immediately on a Fade In/Out toggle click) since it
  // always starts from the untouched snapshot rather than its own last
  // result. Deliberately leaves trimmedPeaks/trimmedDurationState alone —
  // this only drives the *live audible preview* of the in-progress edit; the
  // waveform's own size/duration display only updates once confirmManualTrim
  // runs, on "Done", so it doesn't jump around mid-drag.
  function applyManualTrim(startRatio: number, endRatio: number, fadeIn: FadeSetting, fadeOut: FadeSetting) {
    const audio = audioRef.current
    const base = manualTrimBaseRef.current
    if (!audio || !base) return
    const trimmed = sliceAndFadeBuffer(base, startRatio, endRatio, fadeIn, fadeOut)
    forwardBufferRef.current = trimmed
    reversedBufferRef.current = null
    manualTrimDirtyRef.current = true
    setManualTrimApplied(true)

    const wasPlaying = playing
    if (reversed) {
      stopWebAudioPlayback()
      reversedBufferRef.current = reverseBuffer(trimmed)
      activeBufferRef.current = reversedBufferRef.current
      activeDirectionRef.current = 'reversed'
      startWebAudioPlayback(0, wasPlaying)
      return
    }
    stopWebAudioPlayback()
    audio.pause()
    activeBufferRef.current = trimmed
    activeDirectionRef.current = 'forward'
    startWebAudioPlayback(0, wasPlaying)
  }

  // Bakes the in-progress trim/fade edit (if any were actually made since
  // beginManualTrim) into the waveform's own display — called once when the
  // user clicks "Done". Reads whatever applyManualTrim last hot-swapped into
  // forwardBufferRef rather than re-slicing, so the display always matches
  // exactly what's audible.
  function confirmManualTrim() {
    if (!manualTrimDirtyRef.current) return
    manualTrimDirtyRef.current = false
    const buffer = forwardBufferRef.current
    if (!buffer) return
    setTrimmedPeaks(computePeaksFromBuffer(buffer))
    setTrimmedDurationState(buffer.duration)
  }

  useEffect(() => {
    const audio = new Audio()
    // Without this, createMediaElementSource (see ensureWebAudioCtx) still
    // passes audio through to the speakers fine, but Chromium silently
    // zeroes out anything read back from it via an AnalyserNode — which is
    // exactly what the Studio dB meter does. The media:// protocol is
    // already registered corsEnabled, so this is enough to un-taint it.
    audio.crossOrigin = 'anonymous'
    audio.volume = initialVolumeRef.current
    // Attached to the document (hidden) rather than left detached — a
    // detached <audio> streaming through the custom media:// protocol has
    // been unreliable here (play() silently never audibly starting), while
    // the app's one DOM-attached <audio> (Now Playing) has always worked.
    audio.style.display = 'none'
    document.body.appendChild(audio)
    audioRef.current = audio
    const onTime = () => setCurrentTime(audio.currentTime)
    // Loops back to the start rather than stopping, so a file left playing
    // runs indefinitely until the user pauses it. Only ever fires while the
    // native element is actually driving sound (forward, untrimmed) — the
    // reversed/trimmed Web Audio engine has its own loop in its onended.
    const onEnded = () => {
      audio.currentTime = 0
      setCurrentTime(0)
      audio.play().catch((err) => console.error('Failed to loop studio file playback:', err))
    }
    // Chromium's <audio> element only decodes a narrow slice of WAV variants
    // (8/16-bit PCM) — a 24-bit PCM WAV exported by e.g. FL Studio reports
    // MEDIA_ERR_SRC_NOT_SUPPORTED here instead of playing. Ask the main
    // process to transcode a browser-safe copy once, then swap to it and
    // (if the user already clicked play) resume automatically.
    const onError = () => {
      console.error('Studio file playback error:', audio.error)
      if (
        audio.error?.code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
        fallbackAppliedRef.current ||
        !audio.src
      ) {
        return
      }
      fallbackAppliedRef.current = true
      const filePath = filePathFromMediaUrl(audio.src)
      if (!filePath) return
      window.api.ensurePlayableAudio?.(filePath).then((playablePath) => {
        if (!playablePath || audioRef.current !== audio) return
        audio.src = window.api.getMediaUrl(playablePath)
        audio.load()
        if (playIntentRef.current) {
          audio
            .play()
            .then(() => setPlaying(true))
            .catch((err) => console.error('Failed to play transcoded fallback:', err))
        }
      })
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    return () => {
      audio.pause()
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.remove()
      audioRef.current = null
      if (webAudioRafRef.current !== null) cancelAnimationFrame(webAudioRafRef.current)
      webAudioSourceRef.current?.disconnect()
      webAudioCtxRef.current?.close().catch(() => {})
    }
  }, [])

  // A new (or cleared) src always starts paused from the top, at the current
  // master volume — resuming a stale offset on someone else's file would be
  // more surprising than useful.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    stopWebAudioPlayback()
    forwardBufferRef.current = null
    originalBufferRef.current = null
    reversedBufferRef.current = null
    manualTrimBaseRef.current = null
    manualTrimDirtyRef.current = false
    activeBufferRef.current = null
    activeDirectionRef.current = 'forward'
    setReversed(false)
    setReversing(false)
    setSilenceRemoved(false)
    setRemovingSilence(false)
    setTrimmedPeaks(null)
    setTrimmedDurationState(null)
    setManualTrimApplied(false)
    setPlaying(false)
    setCurrentTime(0)
    playIntentRef.current = false
    fallbackAppliedRef.current = false
    const nextVolume = initialVolumeRef.current
    audio.volume = nextVolume
    if (webAudioGainRef.current) webAudioGainRef.current.gain.value = nextVolume
    setVolumeState(nextVolume)
    playbackRateRef.current = 1
    audio.playbackRate = 1
    setPlaybackRateState(1)
    pitchSemitonesRef.current = 0
    setPitchSemitones(0)
    // A new file starts with a flat EQ/boost too — reset both the state and
    // (since webAudioCtxRef, unlike the buffers above, persists across src
    // changes within the same slot) any already-live filter/boost nodes.
    eqGainsRef.current = EQ_BANDS.map(() => 0)
    setEqGainsState(eqGainsRef.current)
    eqFilterNodesRef.current.forEach((filter) => {
      filter.gain.value = 0
    })
    boostVolumeRef.current = 1
    setBoostVolumeState(1)
    if (webAudioBoostRef.current) webAudioBoostRef.current.gain.value = 1
    if (src) {
      audio.src = src
      audio.load()
      // Built eagerly (rather than waiting for the user to press play or
      // open the Equalizer) so EQ/boost and the Studio dB meter are live
      // from the very first frame — see ensureWebAudioCtx.
      ensureWebAudioCtx()
    } else {
      audio.removeAttribute('src')
    }
  }, [src])

  function togglePlay() {
    const audio = audioRef.current
    if (!audio || !src) return
    // activeBufferRef is set whenever the Web Audio buffer engine (rather
    // than the native <audio> element) is the one actually driving sound —
    // reversed, silence-removed, pitch-shifted, AND manually trimmed all
    // route through it. Checking that directly (rather than re-deriving the
    // same condition from three separate flags) is what used to leave a
    // plain manual trim unrecognized here, so pressing play/pause on a
    // trimmed-only slot silently did nothing to the actually-playing buffer
    // source.
    if (activeBufferRef.current) {
      if (playing) {
        const offset = stopWebAudioPlayback()
        webAudioStartOffsetRef.current = offset
        setPlaying(false)
      } else {
        startWebAudioPlayback(webAudioStartOffsetRef.current, true)
      }
      return
    }
    if (playing) {
      playIntentRef.current = false
      audio.pause()
      setPlaying(false)
    } else {
      // Self-heals if the src-sync effect above hasn't (yet) applied to this
      // element — e.g. a dev Fast Refresh landed between the src changing
      // and this click — rather than failing with "no supported sources".
      // Skipped once a transcoded fallback is in place, or this would just
      // stomp it back to the original (unplayable) source.
      if (audio.src !== src && !fallbackAppliedRef.current) {
        audio.src = src
        audio.load()
      }
      // The element's output is routed through webAudioCtxRef (see
      // ensureWebAudioCtx) even on this plain forward path now, so a
      // context that's still suspended (autoplay policy) would otherwise
      // play the element with no audible/metered output.
      const ctx = webAudioCtxRef.current
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
      playIntentRef.current = true
      audio
        .play()
        .then(() => setPlaying(true))
        .catch((err) => console.error('Failed to play studio file:', err))
    }
  }

  function seek(time: number) {
    if (activeBufferRef.current) {
      const buffer = activeBufferRef.current
      if (!buffer) return
      const reversedDirection = activeDirectionRef.current === 'reversed'
      const wasPlaying = playing
      if (wasPlaying) stopWebAudioPlayback()
      const clampedTime = Math.min(Math.max(0, time), buffer.duration)
      const offset = reversedDirection ? buffer.duration - clampedTime : clampedTime
      webAudioStartOffsetRef.current = offset
      setCurrentTime(clampedTime)
      if (wasPlaying) startWebAudioPlayback(offset, true)
      return
    }
    const audio = audioRef.current
    if (!audio || !src) return
    audio.currentTime = time
    setCurrentTime(time)
  }

  function setVolume(next: number) {
    const audio = audioRef.current
    if (audio) audio.volume = next
    if (webAudioGainRef.current) webAudioGainRef.current.gain.value = next
    setVolumeState(next)
  }

  // Time-stretches playback by changing the rate. Applies immediately to
  // whichever engine is actually driving sound right now (native <audio>
  // forward, the reversed/trimmed buffer source, or the pitch-shift engine),
  // and caches the rate so the next one (a reverse toggle, or resuming from
  // pause) picks it up too. Only the raw AudioBufferSourceNode path (native
  // <audio> and the plain buffer source) lacks pitch correction, so speed
  // changes pitch there — the pitch-shift engine's tempo is independent by
  // design (that's its entire purpose), so this never touches its pitch.
  function setPlaybackRate(rate: number) {
    playbackRateRef.current = rate
    const audio = audioRef.current
    if (audio) audio.playbackRate = rate

    if (pitchShifterRef.current) {
      pitchShifterRef.current.tempo = rate
      return
    }

    const ctx = webAudioCtxRef.current
    const source = webAudioSourceRef.current
    if (source && ctx) {
      // Rebase now, before changing the rate, or the portion already played
      // at the old rate gets recomputed at the new one and the scrub
      // position jumps — same fix as the main engine's applyPlaybackSpeed.
      const elapsed = (ctx.currentTime - webAudioStartCtxTimeRef.current) * source.playbackRate.value
      webAudioStartOffsetRef.current += elapsed
      webAudioStartCtxTimeRef.current = ctx.currentTime
      source.playbackRate.value = rate
    }
    setPlaybackRateState(rate)
  }

  // Hands playback off to (or back from) the pitch-shift engine whenever
  // pitch moves away from / back to 0, and retunes it live otherwise.
  // Reversed/trimmed audio needs no special-casing here: activeBufferRef
  // already points at whichever buffer those need, and startWebAudioPlayback
  // re-derives raw-vs-pitch-shifted fresh from pitchSemitonesRef every call.
  useEffect(() => {
    pitchSemitonesRef.current = pitchSemitones
    const shifter = pitchShifterRef.current
    if (shifter) shifter.pitchSemitones = pitchSemitones

    if (activeBufferRef.current) {
      if (!reversed && !silenceRemoved && pitchSemitones === 0) {
        // Nothing needs the buffer engine anymore — hand playback control
        // back to the native <audio> element (its output still runs through
        // the same EQ/boost/meter graph either way, see ensureWebAudioCtx).
        const offset = stopWebAudioPlayback()
        activeBufferRef.current = null
        const audio = audioRef.current
        if (audio) {
          audio.currentTime = offset
          if (playing) audio.play().catch((err) => console.error('Failed to resume playback:', err))
        }
        return
      }
      if (shifter) return // already pitch-shifted and still needed — just retuned above
      if (pitchSemitones === 0) return // still needs Web Audio (reversed/trimmed) but not pitch — nothing to change
      // Reversed/trimmed audio was on the raw engine — restart on the
      // pitch-shift engine instead, same buffer/direction/position.
      const wasPlaying = playing
      const offset = stopWebAudioPlayback()
      startWebAudioPlayback(offset, wasPlaying)
      return
    }

    if (pitchSemitones === 0 || !src) return
    // Pitch just became the only reason the Web Audio engine is needed —
    // decode lazily (same first-use pattern as toggleReverse/removeSilence)
    // and hand off from native <audio>.
    const wasPlaying = playing
    const offset = audioRef.current?.currentTime ?? 0
    ensureForwardBuffer()
      .then((buffer) => {
        // Bails if something else (a reverse/trim toggle, or pitch already
        // reset back to 0) claimed the engine while this decode was in
        // flight — a subsequent pitch change re-fires this effect and picks
        // it up correctly then.
        if (!buffer || pitchSemitonesRef.current === 0 || activeBufferRef.current) return
        audioRef.current?.pause()
        activeBufferRef.current = buffer
        activeDirectionRef.current = 'forward'
        startWebAudioPlayback(offset, wasPlaying)
      })
      .catch((err) => console.error('Failed to prepare pitch-shifted audio:', err))
  }, [pitchSemitones])

  return {
    playing,
    currentTime,
    volume,
    togglePlay,
    seek,
    setVolume,
    reversed,
    reversing,
    toggleReverse,
    playbackRate,
    setPlaybackRate,
    silenceRemoved,
    removingSilence,
    removeSilence,
    trimmedPeaks,
    trimmedDuration: trimmedDurationState,
    beginManualTrim,
    applyManualTrim,
    confirmManualTrim,
    manualTrimApplied,
    pitchSemitones,
    setPitchSemitones,
    eqGains,
    setEqBandGain,
    resetEq,
    boostVolume,
    setBoostVolume,
    meterAnalyserL: meterAnalyserLRef.current,
    meterAnalyserR: meterAnalyserRRef.current,
    prepareExportSource,
  }
}
