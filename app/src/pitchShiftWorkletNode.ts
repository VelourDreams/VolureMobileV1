// Drop-in replacement for soundtouchjs's PitchShifter, matching its public
// surface (soundtouchjs.d.ts, now removed) so every call site keeps working
// by only swapping its import.
//
// Backed by signalsmith-stretch (MIT), a purpose-built Web Audio/AudioWorklet
// pitch/time library, rather than the WSOLA algorithm SoundTouchJS used.
// Two reasons for the swap:
//   - SoundTouchJS rendered through a ScriptProcessorNode (main-thread,
//     per-callback allocation) — a well-known source of clicks/pops. An
//     earlier pass fixed that by porting SoundTouch's DSP into this app's
//     own AudioWorklet, which worked (no more clicks/pops).
//   - That still left WSOLA's own inherent quality ceiling: audible splice
//     "bubbling" on complex/polyphonic material, worse at larger pitch
//     shifts, from its cross-correlation splice-point search not always
//     finding a clean match. That's an algorithm limitation, not a
//     threading/allocation bug, so no amount of tuning fully fixes it.
//     Signalsmith Stretch uses a different (spectral) approach designed
//     specifically to avoid this artifact class, and ships its own
//     AudioWorkletNode — so this wrapper is now a thin adapter over that
//     rather than owning the DSP itself.
import SignalsmithStretch from 'signalsmith-stretch'

type PlayDetail = { timePlayed: number; formattedTimePlayed: string; percentagePlayed: number }

// How often the worklet reports its playback position back to us. Plenty
// smooth for a UI scrubber/time display without flooding the main thread.
const POSITION_UPDATE_INTERVAL_SECONDS = 0.05

// Registering the module is idempotent per context (signalsmith-stretch
// caches this on the AudioContext itself), so this can safely run ahead of
// time — e.g. right after a context is created — to avoid a silent gap on
// the very first pitch-shift engage of a session while the worklet module
// and its WASM are still compiling/instantiating.
export function warmPitchShiftWorklet(ctx: BaseAudioContext): void {
  SignalsmithStretch(ctx)
    .then((node) => node.disconnect())
    .catch((err) => console.error('Failed to pre-load pitch-shift worklet module:', err))
}

// Bakes a pitch shift into an offline render — used by Studio's export (see
// renderEqBoostOffline in App.tsx) so a track edited with Pitch Shift saves
// with the shift actually applied, instead of only ever being heard live.
// Same SignalsmithStretch engine PitchShifterWorklet wraps above for live
// playback — SignalsmithStretch takes any BaseAudioContext, which
// OfflineAudioContext is one of — just fed the whole buffer up front and
// connected straight to the caller's destination node rather than driven by
// play/seek calls over a session. rate/semitones move independently (time-
// stretch and pitch shift respectively), matching the live engine.
export async function renderPitchShiftOffline(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  rate: number,
  semitones: number,
  destination: AudioNode
): Promise<void> {
  const stretch = await SignalsmithStretch(ctx)
  const channels: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(new Float32Array(buffer.getChannelData(ch)))
  }
  await stretch.addBuffers(channels)
  stretch.connect(destination)
  stretch.schedule({ active: true, input: 0, rate, semitones })
}

function pad(n: number, width: number): string {
  const s = String(n)
  return s.length >= width ? s : '0'.repeat(width - s.length) + s
}

function formatTime(secs: number): string {
  const mins = Math.floor(secs / 60)
  const seconds = secs - mins * 60
  return `${mins}:${pad(Math.trunc(seconds), 2)}`
}

export class PitchShifterWorklet {
  private ctx: AudioContext
  private node: Awaited<ReturnType<typeof SignalsmithStretch>> | null = null
  private connectedTo: AudioNode | null = null
  // Matches how every call site actually uses .disconnect(): as a permanent
  // teardown (the ref is discarded right after), never followed by another
  // .connect(). Guards a pending _init from finishing the handoff into a
  // graph the caller has already moved on from.
  private disposed = false

  private _tempo = 1
  private _pitchSemitones = 0
  private _timePlayed = 0
  private _pendingSeekSeconds: number | null = null
  private endFired = false

  readonly duration: number
  private readonly onEnd: () => void
  private listeners: { name: string; cb: (detail: PlayDetail) => void }[] = []

  constructor(context: AudioContext, buffer: AudioBuffer, _bufferSize: number, onEnd: () => void = () => {}) {
    this.ctx = context
    this.duration = buffer.duration
    this.onEnd = onEnd
    void this._init(buffer)
  }

  private async _init(buffer: AudioBuffer) {
    let node: Awaited<ReturnType<typeof SignalsmithStretch>>
    try {
      node = await SignalsmithStretch(this.ctx)
    } catch (err) {
      console.error('Failed to create pitch-shift worklet node:', err)
      return
    }
    if (this.disposed) {
      node.disconnect()
      return
    }

    // Copies (not views) — getChannelData returns a live reference to the
    // AudioBuffer's own storage, and structured-cloning it through
    // addBuffers's postMessage should never risk detaching a buffer callers
    // reuse across pitch-shift sessions (e.g. decodedBufferRef).
    const channels: Float32Array[] = []
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channels.push(new Float32Array(buffer.getChannelData(ch)))
    }
    await node.addBuffers(channels)
    if (this.disposed) {
      node.disconnect()
      return
    }

    await node.setUpdateInterval(POSITION_UPDATE_INTERVAL_SECONDS, (inputTime) => {
      this._timePlayed = inputTime
      this._emitPlay()
      if (!this.endFired && inputTime >= this.duration - POSITION_UPDATE_INTERVAL_SECONDS) {
        this.endFired = true
        this.onEnd()
      }
    })

    const startAt = this._pendingSeekSeconds ?? 0
    this._pendingSeekSeconds = null
    node.schedule({ active: true, input: startAt, rate: this._tempo, semitones: this._pitchSemitones })

    if (this.disposed) {
      node.disconnect()
      return
    }
    this.node = node
    if (this.connectedTo) node.connect(this.connectedTo)
  }

  private _emitPlay() {
    const detail: PlayDetail = {
      timePlayed: this._timePlayed,
      formattedTimePlayed: this.formattedTimePlayed,
      percentagePlayed: this.percentagePlayed,
    }
    for (const listener of this.listeners) {
      if (listener.name === 'play') listener.cb(detail)
    }
  }

  get formattedDuration() {
    return formatTime(this.duration)
  }
  get timePlayed() {
    return this._timePlayed
  }
  get formattedTimePlayed() {
    return formatTime(this._timePlayed)
  }
  get percentagePlayed() {
    return this.duration > 0 ? (100 * this._timePlayed) / this.duration : 0
  }
  // soundtouchjs's own setter treats perc as a 0-1 fraction (not 0-100,
  // despite the getter above) — every call site relies on that, passing
  // offsetSeconds / duration, so this matches it exactly.
  set percentagePlayed(perc: number) {
    const seconds = perc * this.duration
    this._pendingSeekSeconds = seconds
    this._timePlayed = seconds
    this.endFired = false
    if (this.node) {
      this._pendingSeekSeconds = null
      this.node.schedule({ input: seconds })
    }
  }
  set pitchSemitones(semitone: number) {
    this._pitchSemitones = semitone
    this.node?.schedule({ semitones: semitone })
  }
  set tempo(tempo: number) {
    this._tempo = tempo
    this.node?.schedule({ rate: tempo })
  }
  connect(toNode: AudioNode) {
    this.connectedTo = toNode
    this.node?.connect(toNode)
  }
  disconnect() {
    this.disposed = true
    this.node?.disconnect()
  }
  on(eventName: 'play', cb: (detail: PlayDetail) => void) {
    this.listeners.push({ name: eventName, cb })
  }
  off(eventName: string | null = null) {
    this.listeners = eventName ? this.listeners.filter((l) => l.name !== eventName) : []
  }
}
