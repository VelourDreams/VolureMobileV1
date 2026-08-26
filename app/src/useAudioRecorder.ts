import { useEffect, useRef, useState } from 'react'
import { PitchShifterWorklet as PitchShifter, warmPitchShiftWorklet } from './pitchShiftWorkletNode'
import { computePeaksFromBuffer } from './useWaveformPeaks'
import { audioBufferToWav } from './audioBufferToWav'
import { trimSilence, sliceAndFadeBuffer, type FadeSetting } from './audioTrim'
import { PITCH_SHIFT_BUFFER_SIZE } from './pitchShift'
import { EQ_BANDS } from './eq'
import type { AudioExportFormat } from '../electron/audio'

export interface AudioRecorderOptions {
  // Resolves the MediaStream to capture from — getUserMedia for the
  // microphone, getDisplayMedia (audio-only) for internal/system audio.
  getStream: () => Promise<MediaStream>
  // Used in console error messages, e.g. "microphone" / "internal audio".
  label: string
  // Used as the default Save-dialog filename prefix.
  saveFilePrefix: string
}

export interface AudioRecorderHandle {
  recording: boolean
  // True while getStream() is in flight and the capture graph is still
  // being set up — see startingRef in the implementation for why the UI
  // should treat this as busy (disable the record button) rather than idle.
  starting: boolean
  recordingPeaks: number[] | null
  playing: boolean
  playbackTime: number
  duration: number
  trimPromptOpen: boolean
  silenceRemoved: boolean
  volume: number
  saving: boolean
  saveFailed: boolean
  reversed: boolean
  playbackRate: number
  toggleRecording: () => void
  togglePlayback: () => void
  seek: (time: number) => void
  // Resolves to the saved file's path, or null if the user canceled the
  // save dialog or the save failed — lets callers offer to add it to the
  // song library only once it's actually landed on disk.
  save: (format?: AudioExportFormat) => Promise<string | null>
  discard: () => void
  setVolume: (volume: number) => void
  confirmTrim: () => void
  dismissTrim: () => void
  removeSilence: () => void
  // Manual Trim Audio — see useFilePlayback's identically-shaped trio, which
  // this mirrors: beginManualTrim snapshots the *untouched* recorded take
  // once, applyManualTrim re-slices from that snapshot every time (never its
  // own last result, and never a previous trim's result) so repeated handle
  // drags / fade toggles don't compound and reopening Trim Audio can always
  // drag back out to recover audio a previous trim cut away. applyManualTrim
  // only hot-swaps the take for live preview — recordingPeaks/duration only
  // update once confirmManualTrim runs, on "Done", so the waveform doesn't
  // resize mid-drag.
  beginManualTrim: () => void
  applyManualTrim: (startRatio: number, endRatio: number, fadeIn: FadeSetting, fadeOut: FadeSetting) => void
  confirmManualTrim: () => void
  toggleReverse: () => void
  setPlaybackRate: (rate: number) => void
  // Tempo-independent pitch shift, in semitones — see the pitch-shift effect
  // below for how this hands playback to (or back from) a SoundTouch
  // PitchShifter.
  pitchSemitones: number
  setPitchSemitones: (value: number) => void
  // Studio's Equalizer tool — a 7-band graphic EQ plus a 0-2 (0%-200%)
  // volume boost, both live-only (never baked into the saved take, matching
  // playbackRate/pitchSemitones' own precedent) — see useFilePlayback's
  // identically-shaped pair for the sibling "track" slot.
  eqGains: number[]
  setEqBandGain: (index: number, value: number) => void
  resetEq: () => void
  boostVolume: number
  setBoostVolume: (value: number) => void
  // The Studio dB meter's tap points for this take's playback — post-EQ/
  // boost, pre-volume, so they read true regardless of this take's own
  // volume slider, and read silent (rather than null) whenever nothing is
  // actually playing through them. Null until playback has started at least
  // once (see ensurePlaybackContext). Split left/right so the meter can
  // show both channels independently.
  meterAnalyserL: AnalyserNode | null
  meterAnalyserR: AnalyserNode | null
}

// Builds a new AudioBuffer whose channel data is the reverse of the
// source buffer's — same approach as trimSilence above, just walking
// each channel back-to-front instead of trimming from both ends.
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

// Captures raw PCM via an AudioWorkletNode (micRecorderWorklet.js) rather
// than MediaRecorder so the result can be saved through the same WAV
// pipeline as Studio export. An AudioWorkletNode runs its processing on the
// dedicated real-time audio thread instead of the main thread (unlike a
// ScriptProcessorNode), so main-thread work — like the live waveform
// animation shown during recording — can't delay it and cause the browser
// to drop audio frames, which would otherwise be audible as clicks/pops.
//
// Shared by both the microphone and internal-audio recorders in Studio —
// identical capture/playback/trim state machine, differing only in how the
// source MediaStream is obtained.
export function useAudioRecorder({ getStream, label, saveFilePrefix }: AudioRecorderOptions): AudioRecorderHandle {
  const [recording, setRecording] = useState(false)
  // True from the moment the record button is pressed until getStream()
  // resolves and the capture graph is live. getStream() can take several
  // seconds — internal audio in particular goes through Electron's
  // desktopCapturer, which enumerates every open window before resolving —
  // and with nothing else marking that time as busy, a user who doesn't see
  // an immediate reaction tends to press the button again. Without this
  // guard that second press lands while `recording` is still false, so
  // toggleRecording reads it as another start rather than a stop; whichever
  // of the two overlapping startRecording() calls finishes last wins the
  // shared refs below, silently orphaning the other's stream and producing
  // a take that both starts later and ends earlier than the user intended.
  const startingRef = useRef(false)
  const [starting, setStarting] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const chunksRef = useRef<Float32Array[][]>([])
  const channelCountRef = useRef(1)
  const [recordingPeaks, setRecordingPeaks] = useState<number[] | null>(null)
  const [trimPromptOpen, setTrimPromptOpen] = useState(false)
  const [silenceRemoved, setSilenceRemoved] = useState(false)

  // Playback of the recorded take, entirely separate from both the capture
  // graph above and the library-track playback engine — its own
  // AudioContext, reused across plays/pauses/seeks of the same recording.
  const recordingBufferRef = useRef<AudioBuffer | null>(null)
  // The take exactly as captured, set once by stopRecording and never
  // overwritten by any later edit (trim/silence-removal/reverse all mutate
  // recordingBufferRef instead) — see useFilePlayback's originalBufferRef
  // for the identical reasoning. beginManualTrim always re-derives from
  // this, never from recordingBufferRef's current (possibly already
  // trimmed) contents, so reopening Trim Audio after an earlier trim starts
  // from the full take again.
  const originalRecordingBufferRef = useRef<AudioBuffer | null>(null)
  // The take applyManualTrim always re-slices from, snapshotted once by
  // beginManualTrim when Trim Audio opens on this slot — see
  // useFilePlayback's manualTrimBaseRef for the full reasoning.
  const manualTrimBaseRef = useRef<AudioBuffer | null>(null)
  // Set by applyManualTrim, cleared by beginManualTrim/confirmManualTrim —
  // see useFilePlayback's identical manualTrimDirtyRef.
  const manualTrimDirtyRef = useRef(false)
  // Explicit rather than derived from recordingBufferRef.current?.duration —
  // recordingBufferRef itself is hot-swapped on every handle drag / fade
  // toggle (for live audible preview), but this should only change once,
  // when confirmManualTrim runs on "Done" (or immediately for the
  // one-shot removeSilence/toggleReverse actions, which have no separate
  // commit step) — see useFilePlayback's identical trimmedDurationState.
  const [recordingDuration, setRecordingDuration] = useState(0)
  const playbackCtxRef = useRef<AudioContext | null>(null)
  const playbackGainRef = useRef<GainNode | null>(null)
  const playbackSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const playbackStartCtxTimeRef = useRef(0)
  const playbackStartOffsetRef = useRef(0)
  const playbackRafRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playbackTime, setPlaybackTime] = useState(0)
  const [volume, setVolumeState] = useState(1)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const saveFailedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [reversed, setReversed] = useState(false)
  // Time-stretch rate for take playback — read via the ref (rather than the
  // state) wherever a new AudioBufferSourceNode is created, so a rate set
  // while paused is still picked up the next time playback starts.
  const [playbackRate, setPlaybackRateState] = useState(1)
  const playbackRateRef = useRef(1)
  // Tempo-independent pitch shift — see the pitch-shift effect below.
  // Mirrors playbackRateRef's reasoning: read via the ref wherever a new
  // engine is created, so a value set while paused is still picked up next.
  const [pitchSemitones, setPitchSemitones] = useState(0)
  const pitchSemitonesRef = useRef(0)
  // Set instead of playbackSourceRef whenever pitch is active — a SoundTouch
  // PitchShifter "pseudo-node" (WSOLA time-stretch) in place of a plain
  // AudioBufferSourceNode, since only it can move pitch independently of
  // playbackRate.
  const pitchShifterRef = useRef<PitchShifter | null>(null)
  // Studio Equalizer state — take playback is always through this hook's own
  // AudioBufferSourceNode-based engine (never a native <audio> element), so
  // unlike useFilePlayback's sibling pair the filter bank/boost node are
  // simply always in the signal path once ensurePlaybackContext has run,
  // with no separate "activate" handoff needed.
  const [eqGains, setEqGainsState] = useState<number[]>(EQ_BANDS.map(() => 0))
  const eqGainsRef = useRef<number[]>(EQ_BANDS.map(() => 0))
  const eqFilterNodesRef = useRef<BiquadFilterNode[]>([])
  const [boostVolume, setBoostVolumeState] = useState(1)
  const boostVolumeRef = useRef(1)
  const playbackBoostRef = useRef<GainNode | null>(null)
  // The filter chain's entry point (first filter, or the boost node if
  // EQ_BANDS were ever empty) — where a fresh source/shifter connects
  // instead of straight to playbackGainRef.
  const playbackEqEntryRef = useRef<AudioNode | null>(null)
  // Tap points for the Studio dB meter — see meterAnalyserL/meterAnalyserR
  // on the return value below.
  const meterAnalyserLRef = useRef<AnalyserNode | null>(null)
  const meterAnalyserRRef = useRef<AnalyserNode | null>(null)

  function stopPlayback() {
    if (pitchShifterRef.current) {
      pitchShifterRef.current.off()
      pitchShifterRef.current.disconnect()
      pitchShifterRef.current = null
    }
    if (playbackRafRef.current !== null) {
      cancelAnimationFrame(playbackRafRef.current)
      playbackRafRef.current = null
    }
    if (playbackSourceRef.current) {
      const source = playbackSourceRef.current
      playbackSourceRef.current = null
      source.onended = null
      try {
        source.stop()
      } catch {
        // already stopped
      }
      source.disconnect()
    }
    setPlaying(false)
  }

  async function startRecording() {
    if (recording || startingRef.current) return
    startingRef.current = true
    setStarting(true)
    try {
      // Starting a new take invalidates whatever waveform/recording is
      // currently shown, so tear that down now rather than leaving a stale
      // one up (and possibly still playing) while the new take records.
      stopPlayback()
      recordingBufferRef.current = null
      originalRecordingBufferRef.current = null
      manualTrimBaseRef.current = null
      manualTrimDirtyRef.current = false
      setRecordingPeaks(null)
      setRecordingDuration(0)
      setPlaybackTime(0)
      setTrimPromptOpen(false)
      setSilenceRemoved(false)
      setReversed(false)
      playbackRateRef.current = 1
      setPlaybackRateState(1)
      pitchSemitonesRef.current = 0
      setPitchSemitones(0)
      // A new take starts with a flat EQ/boost too — reset both the state
      // and (since playbackCtxRef, unlike recordingBufferRef above, is
      // reused across takes) any already-live filter/boost nodes.
      eqGainsRef.current = EQ_BANDS.map(() => 0)
      setEqGainsState(eqGainsRef.current)
      eqFilterNodesRef.current.forEach((filter) => {
        filter.gain.value = 0
      })
      boostVolumeRef.current = 1
      setBoostVolumeState(1)
      if (playbackBoostRef.current) playbackBoostRef.current.gain.value = 1
      const stream = await getStream()
      const ctx = new AudioContext()
      await ctx.audioWorklet.addModule(new URL('./micRecorderWorklet.js', import.meta.url))
      const source = ctx.createMediaStreamSource(stream)
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
        for (let ch = 0; ch < channelCount; ch++) {
          chunks[ch].push(event.data[ch])
        }
      }

      // An AudioWorkletNode only runs process() while it's part of a live
      // graph reaching the destination — route through a silent gain so the
      // captured audio doesn't also play back out loud through the speakers.
      const silence = ctx.createGain()
      silence.gain.value = 0
      source.connect(processor)
      processor.connect(silence)
      silence.connect(ctx.destination)
      processor.port.postMessage('start')

      streamRef.current = stream
      audioCtxRef.current = ctx
      sourceRef.current = source
      processorRef.current = processor
      chunksRef.current = chunks
      channelCountRef.current = channelCount
      setRecording(true)
    } catch (err) {
      console.error(`Failed to start ${label} recording:`, err)
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }

  async function stopRecording() {
    const ctx = audioCtxRef.current
    const processor = processorRef.current
    const source = sourceRef.current
    const stream = streamRef.current
    const chunks = chunksRef.current
    const channelCount = channelCountRef.current

    // The worklet buffers audio into fixed-size chunks before posting them,
    // so up to one chunk's worth of tail audio can still be sitting in the
    // worklet when recording stops. Ask it to flush that remainder before
    // tearing the graph down, so the take isn't missing its last moment.
    if (processor) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200)
        processor.port.onmessage = (event: MessageEvent<Float32Array[] | null>) => {
          clearTimeout(timeout)
          if (event.data) {
            for (let ch = 0; ch < channelCount; ch++) {
              chunks[ch].push(event.data[ch])
            }
          }
          resolve()
        }
        processor.port.postMessage('flush')
      })
    }

    processor?.disconnect()
    source?.disconnect()
    stream?.getTracks().forEach((track) => track.stop())

    streamRef.current = null
    audioCtxRef.current = null
    sourceRef.current = null
    processorRef.current = null
    chunksRef.current = []
    setRecording(false)

    if (!ctx) return
    const totalLength = chunks[0]?.reduce((sum, chunk) => sum + chunk.length, 0) ?? 0
    if (totalLength === 0) {
      await ctx.close()
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

    recordingBufferRef.current = buffer
    originalRecordingBufferRef.current = buffer
    setRecordingPeaks(computePeaksFromBuffer(buffer))
    setRecordingDuration(buffer.duration)
    setTrimPromptOpen(true)
  }

  function toggleRecording() {
    if (recording) stopRecording()
    else startRecording()
  }

  // Shared by the post-recording prompt (confirmTrim) and the "Remove
  // Silence" side-panel tab (removeSilence) — same trim, two entry points.
  function applySilenceTrim() {
    const buffer = recordingBufferRef.current
    if (buffer) {
      const trimmed = trimSilence(buffer)
      recordingBufferRef.current = trimmed
      setRecordingPeaks(computePeaksFromBuffer(trimmed))
      setRecordingDuration(trimmed.duration)
      setPlaybackTime(0)
      setSilenceRemoved(true)
    }
  }

  function confirmTrim() {
    applySilenceTrim()
    setTrimPromptOpen(false)
  }

  function dismissTrim() {
    setTrimPromptOpen(false)
  }

  function removeSilence() {
    applySilenceTrim()
  }

  // Snapshots the untouched original take as the fixed source
  // applyManualTrim re-slices from — called once when Trim Audio opens on
  // this slot. Always the take exactly as recorded (see
  // originalRecordingBufferRef), never a previous trim's result, so
  // reopening Trim Audio after an earlier trim starts from the full take
  // again. Also resets the waveform display back to that full take (so the
  // user can see, and drag back out into, whatever a previous trim cut
  // away) and clears the dirty flag confirmManualTrim checks.
  function beginManualTrim() {
    manualTrimDirtyRef.current = false
    const original = originalRecordingBufferRef.current
    manualTrimBaseRef.current = original
    if (original) {
      setRecordingPeaks(computePeaksFromBuffer(original))
      setRecordingDuration(original.duration)
    }
  }

  // Cuts manualTrimBaseRef down to [startRatio, endRatio] and bakes in any
  // active fades, then swaps it in as the take exactly like applySilenceTrim
  // does. Safe to call repeatedly (once per handle drag release, or
  // immediately on a Fade In/Out toggle click) since it always starts from
  // the untouched snapshot rather than its own last result. Deliberately
  // leaves recordingPeaks/recordingDuration alone — see confirmManualTrim,
  // which is what actually bakes this into the waveform's own display.
  function applyManualTrim(startRatio: number, endRatio: number, fadeIn: FadeSetting, fadeOut: FadeSetting) {
    const base = manualTrimBaseRef.current
    if (!base) return
    const trimmed = sliceAndFadeBuffer(base, startRatio, endRatio, fadeIn, fadeOut)
    stopPlayback()
    recordingBufferRef.current = trimmed
    manualTrimDirtyRef.current = true
    setPlaybackTime(0)
  }

  // Bakes the in-progress trim/fade edit (if any were actually made since
  // beginManualTrim) into the waveform's own display — called once when the
  // user clicks "Done". Reads whatever applyManualTrim last swapped into
  // recordingBufferRef rather than re-slicing, so the display always matches
  // exactly what's audible.
  function confirmManualTrim() {
    if (!manualTrimDirtyRef.current) return
    manualTrimDirtyRef.current = false
    const buffer = recordingBufferRef.current
    if (!buffer) return
    setRecordingPeaks(computePeaksFromBuffer(buffer))
    setRecordingDuration(buffer.duration)
  }

  // Reverses the take in place — the waveform, playback, and save() all
  // read from recordingBufferRef, so reversing it here is enough to flip
  // all three at once. Reversing twice restores the original audio, which
  // is what lets this double as a plain on/off toggle for the button.
  function toggleReverse() {
    const buffer = recordingBufferRef.current
    if (!buffer) return
    stopPlayback()
    const next = reverseBuffer(buffer)
    recordingBufferRef.current = next
    setRecordingPeaks(computePeaksFromBuffer(next))
    setPlaybackTime(0)
    setReversed((prev) => !prev)
  }

  // Playback of the recorded take. A plain AudioBufferSourceNode play/pause
  // — pausing just means recreating the source at the current offset next
  // time, since source nodes are one-shot — on its own context so it can't
  // be disrupted by (or interfere with) library-track playback.
  function ensurePlaybackContext(): AudioContext {
    if (!playbackCtxRef.current) {
      const ctx = new AudioContext()
      // Kicks off the pitch-shift worklet module's fetch+compile now rather
      // than waiting for the user to actually engage pitch shift, so the
      // first engage of a session doesn't hit a silent gap while it loads.
      warmPitchShiftWorklet(ctx)
      // Graphic EQ filter bank + volume-boost node, ahead of the gain node
      // below — see EqualizerBands/the Studio Equalizer tool in App.tsx.
      // Built with whatever gains/boost were already dialed in before this
      // take ever started playing, rather than always starting flat.
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
      // A channel splitter feeds two per-channel analysers so the Studio
      // meter can show left/right independently rather than a downmixed
      // average — see meterAnalyserL/meterAnalyserR on the return value.
      const meterSplitter = ctx.createChannelSplitter(2)
      const analyserL = ctx.createAnalyser()
      analyserL.fftSize = 512
      analyserL.smoothingTimeConstant = 0.6
      const analyserR = ctx.createAnalyser()
      analyserR.fftSize = 512
      analyserR.smoothingTimeConstant = 0.6
      const gain = ctx.createGain()
      gain.gain.value = volume
      filters[filters.length - 1]?.connect(boost)
      // The meter tap is a fan-out, not an in-line stop — it doesn't need
      // its own onward connection since nothing reads audio back out of it,
      // only its analysis data.
      boost.connect(meterSplitter)
      meterSplitter.connect(analyserL, 0)
      meterSplitter.connect(analyserR, 1)
      boost.connect(gain)
      gain.connect(ctx.destination)
      playbackCtxRef.current = ctx
      playbackGainRef.current = gain
      playbackBoostRef.current = boost
      eqFilterNodesRef.current = filters
      playbackEqEntryRef.current = filters[0] ?? boost
      meterAnalyserLRef.current = analyserL
      meterAnalyserRRef.current = analyserR
    }
    return playbackCtxRef.current
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
    if (playbackBoostRef.current) playbackBoostRef.current.gain.value = next
  }

  function playRecording(offsetSeconds: number) {
    const buffer = recordingBufferRef.current
    if (!buffer) return
    stopPlayback()

    const ctx = ensurePlaybackContext()
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const startOffset = offsetSeconds >= buffer.duration ? 0 : offsetSeconds

    if (pitchSemitonesRef.current !== 0) {
      playPitchShifted(ctx, buffer, startOffset)
      return
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = playbackRateRef.current
    source.connect(playbackEqEntryRef.current ?? playbackGainRef.current ?? ctx.destination)
    source.onended = () => {
      // Only a natural end-of-buffer reaches this — stopPlayback() (used for
      // pause/seek/new-recording) already clears the ref and the handler
      // synchronously before this async event can fire. Loops back to the
      // start rather than stopping, so a take left playing runs indefinitely
      // until the user pauses it.
      if (playbackSourceRef.current !== source) return
      playbackSourceRef.current = null
      if (playbackRafRef.current !== null) {
        cancelAnimationFrame(playbackRafRef.current)
        playbackRafRef.current = null
      }
      playRecording(0)
    }
    source.start(0, startOffset)

    playbackSourceRef.current = source
    playbackStartCtxTimeRef.current = ctx.currentTime
    playbackStartOffsetRef.current = startOffset
    setPlaying(true)

    const tick = () => {
      if (playbackSourceRef.current !== source) return
      const elapsed = (ctx.currentTime - playbackStartCtxTimeRef.current) * playbackRateRef.current
      setPlaybackTime(Math.min(buffer.duration, startOffset + elapsed))
      playbackRafRef.current = requestAnimationFrame(tick)
    }
    tick()
  }

  // The pitch-active counterpart to the plain AudioBufferSourceNode playback
  // above — a SoundTouch PitchShifter WSOLA-shifts the take independently of
  // its playback rate. Position tracking comes from the shifter's own 'play'
  // events (dispatched once per audio-process callback) rather than a
  // ctx-clock tick loop, since the shifter tracks samples actually consumed
  // directly.
  function playPitchShifted(ctx: AudioContext, buffer: AudioBuffer, startOffset: number) {
    const shifter = new PitchShifter(ctx, buffer, PITCH_SHIFT_BUFFER_SIZE, () => {
      // Only a natural end-of-buffer reaches this repeatedly once the source
      // runs dry — stopPlayback() (used for pause/seek/new-recording) tears
      // the shifter down synchronously before a stale callback can
      // double-fire this. Loops back to the start rather than stopping,
      // matching the raw-engine path above.
      if (pitchShifterRef.current !== shifter) return
      shifter.percentagePlayed = 0
    })
    shifter.tempo = playbackRateRef.current
    shifter.pitchSemitones = pitchSemitonesRef.current
    shifter.percentagePlayed = buffer.duration > 0 ? startOffset / buffer.duration : 0
    shifter.on('play', (detail) => setPlaybackTime(detail.timePlayed))
    shifter.connect(playbackEqEntryRef.current ?? playbackGainRef.current ?? ctx.destination)

    pitchShifterRef.current = shifter
    setPlaying(true)
  }

  function togglePlayback() {
    if (playing) {
      if (pitchShifterRef.current) {
        setPlaybackTime(pitchShifterRef.current.timePlayed)
      } else {
        const buffer = recordingBufferRef.current
        const ctx = playbackCtxRef.current
        if (buffer && ctx) {
          const elapsed = (ctx.currentTime - playbackStartCtxTimeRef.current) * playbackRateRef.current
          setPlaybackTime(Math.min(buffer.duration, playbackStartOffsetRef.current + elapsed))
        }
      }
      stopPlayback()
    } else {
      playRecording(playbackTime)
    }
  }

  function seek(time: number) {
    const wasPlaying = playing
    stopPlayback()
    setPlaybackTime(time)
    if (wasPlaying) playRecording(time)
  }

  // Save is explicit (a button on the recording waveform) rather than
  // automatic on stop, so finishing a take doesn't unexpectedly throw a
  // native Save dialog in the user's face — they preview first, save if
  // they want to keep it.
  async function save(format: AudioExportFormat = 'wav'): Promise<string | null> {
    const buffer = recordingBufferRef.current
    if (!buffer || saving) return null
    if (saveFailedTimeoutRef.current) clearTimeout(saveFailedTimeoutRef.current)
    setSaveFailed(false)
    setSaving(true)
    try {
      const wav = audioBufferToWav(buffer)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const savedPath = await window.api.saveAudioFile(
        `${saveFilePrefix} ${timestamp}.${format}`,
        wav,
        format,
        'wav'
      )
      return savedPath // null if the user canceled the save dialog — not a failure
    } catch (err) {
      console.error(`Failed to save ${label} recording:`, err)
      setSaveFailed(true)
      saveFailedTimeoutRef.current = setTimeout(() => setSaveFailed(false), 4000)
      return null
    } finally {
      setSaving(false)
    }
  }

  // Discards the current take (the waveform's own remove button) without
  // saving it — distinct from save(), which keeps the take around afterward.
  function discard() {
    stopPlayback()
    recordingBufferRef.current = null
    originalRecordingBufferRef.current = null
    manualTrimBaseRef.current = null
    manualTrimDirtyRef.current = false
    setRecordingPeaks(null)
    setRecordingDuration(0)
    setPlaybackTime(0)
    setTrimPromptOpen(false)
    setSilenceRemoved(false)
    setReversed(false)
    playbackRateRef.current = 1
    setPlaybackRateState(1)
    pitchSemitonesRef.current = 0
    setPitchSemitones(0)
    eqGainsRef.current = EQ_BANDS.map(() => 0)
    setEqGainsState(eqGainsRef.current)
    eqFilterNodesRef.current.forEach((filter) => {
      filter.gain.value = 0
    })
    boostVolumeRef.current = 1
    setBoostVolumeState(1)
    if (playbackBoostRef.current) playbackBoostRef.current.gain.value = 1
  }

  function setVolume(next: number) {
    if (playbackGainRef.current) playbackGainRef.current.gain.value = next
    setVolumeState(next)
  }

  // Time-stretches take playback by changing the rate. Applies immediately
  // to whatever's currently playing, and caches the rate so the next
  // playRecording() picks it up too. Only the raw AudioBufferSourceNode path
  // lacks pitch correction, so speed changes pitch there — the pitch-shift
  // engine's tempo is independent by design, so this never touches its
  // pitch.
  function setPlaybackRate(rate: number) {
    if (pitchShifterRef.current) {
      pitchShifterRef.current.tempo = rate
      playbackRateRef.current = rate
      setPlaybackRateState(rate)
      return
    }

    const ctx = playbackCtxRef.current
    const source = playbackSourceRef.current
    if (source && ctx) {
      // Rebase now, before changing the rate, or the portion already played
      // at the old rate gets recomputed at the new one and the scrub
      // position jumps — same fix as the main engine's applyPlaybackSpeed.
      const elapsed = (ctx.currentTime - playbackStartCtxTimeRef.current) * playbackRateRef.current
      playbackStartOffsetRef.current += elapsed
      playbackStartCtxTimeRef.current = ctx.currentTime
      source.playbackRate.value = rate
    }
    playbackRateRef.current = rate
    setPlaybackRateState(rate)
  }

  // Hands playback off to (or back from) the pitch-shift engine whenever
  // pitch moves away from / back to 0 while a take is playing, and retunes
  // it live otherwise. While paused, nothing needs restarting — the next
  // playRecording() call reads pitchSemitonesRef fresh.
  useEffect(() => {
    pitchSemitonesRef.current = pitchSemitones
    const shifter = pitchShifterRef.current

    if (shifter) {
      shifter.pitchSemitones = pitchSemitones
      if (pitchSemitones !== 0) return // still pitch-shifted, just retuned
      const offset = shifter.timePlayed
      stopPlayback()
      playRecording(offset)
      return
    }

    if (pitchSemitones === 0 || !playing) return
    // Pitch just became active while already playing on the raw engine —
    // swap over, preserving position.
    const ctx = playbackCtxRef.current
    const buffer = recordingBufferRef.current
    let offset = playbackTime
    if (ctx && buffer) {
      const elapsed = (ctx.currentTime - playbackStartCtxTimeRef.current) * playbackRateRef.current
      offset = Math.min(buffer.duration, playbackStartOffsetRef.current + elapsed)
    }
    stopPlayback()
    playRecording(offset)
  }, [pitchSemitones])

  // Releases the stream / playback context if the app closes (or this
  // component somehow unmounts) mid-recording or mid-playback, so neither is
  // ever left running in the background.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      playbackCtxRef.current?.close().catch(() => {})
      if (saveFailedTimeoutRef.current) clearTimeout(saveFailedTimeoutRef.current)
    }
  }, [])

  return {
    recording,
    starting,
    recordingPeaks,
    playing,
    playbackTime,
    duration: recordingDuration,
    trimPromptOpen,
    silenceRemoved,
    volume,
    saving,
    saveFailed,
    reversed,
    playbackRate,
    toggleRecording,
    togglePlayback,
    seek,
    save,
    discard,
    setVolume,
    confirmTrim,
    dismissTrim,
    removeSilence,
    beginManualTrim,
    applyManualTrim,
    confirmManualTrim,
    toggleReverse,
    setPlaybackRate,
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
}
