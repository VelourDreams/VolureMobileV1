// Runs off the main thread so batch key detection on newly-added tracks never
// stalls playback or the UI. Receives PCM (at the track's native sample rate)
// for one track at a time and posts back the detected key or null.
//
// Earlier version analyzed the whole clip as one giant single-bin Goertzel
// block. That's fine for a static one-shot sample, but for a real song it
// produces an extremely narrow frequency bin (bandwidth ~1/duration) that
// vibrato, chord movement, and ordinary pitch drift fall straight out of —
// most of the track's actual energy at a pitch simply never lands in that
// bin. It also fed the analysis a naively decimated signal (every Nth sample,
// no anti-alias filtering), which folds high-frequency content back down
// into the analysis band as noise. Both combine to make real songs detect
// essentially at random.
//
// This version builds a proper chromagram instead: short overlapping,
// Hann-windowed frames (~185ms) analyzed at the track's native rate, with
// per-frame energy accumulated into the 12 pitch classes over the whole
// analysis window. That tolerates real-world pitch variation the way actual
// key-detection tools do.

export interface KeyDetectionRequest {
  id: number
  sampleRate: number
  samples: Float32Array
}

export interface KeyDetectionResult {
  key: string
  keySignature: string
}

export interface KeyDetectionResponse {
  id: number
  result: KeyDetectionResult | null
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Krumhansl-Kessler tonal hierarchy profiles: the classic reference weights
// for how "at home" each of the 12 scale degrees feels in a major/minor key.
// Correlating a track's pitch-class energy against every rotation of these
// is the standard Krumhansl-Schmuckler key-finding method.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const FRAME_SIZE = 8192
const HOP_SIZE = 4096
const MIN_OCTAVE = 2
const MAX_OCTAVE = 6

interface TargetFrequency {
  freq: number
  pitchClass: number
}

function buildTargetFrequencies(): TargetFrequency[] {
  const freqs: TargetFrequency[] = []
  for (let octave = MIN_OCTAVE; octave <= MAX_OCTAVE; octave++) {
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      const midi = (octave + 1) * 12 + pitchClass
      const freq = 440 * Math.pow(2, (midi - 69) / 12)
      freqs.push({ freq, pitchClass })
    }
  }
  return freqs
}

const TARGET_FREQUENCIES = buildTargetFrequencies()

function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  }
  return window
}

// A bank of Hann-windowed complex exponentials, one pair (cos/sin) per
// target pitch frequency, precomputed once per sample rate and reused for
// every frame of every track that shares that rate (nearly all of them, in
// practice). Turns each frame's per-frequency analysis into a plain dot
// product instead of repeated trig calls.
interface FilterBank {
  cos: Float32Array[]
  sin: Float32Array[]
}

const filterBankCache = new Map<number, FilterBank>()

function getFilterBank(sampleRate: number): FilterBank {
  const cached = filterBankCache.get(sampleRate)
  if (cached) return cached

  const window = hannWindow(FRAME_SIZE)
  const cos: Float32Array[] = []
  const sin: Float32Array[] = []
  for (const { freq } of TARGET_FREQUENCIES) {
    const omega = (2 * Math.PI * freq) / sampleRate
    const cosTable = new Float32Array(FRAME_SIZE)
    const sinTable = new Float32Array(FRAME_SIZE)
    for (let i = 0; i < FRAME_SIZE; i++) {
      cosTable[i] = window[i] * Math.cos(omega * i)
      sinTable[i] = window[i] * Math.sin(omega * i)
    }
    cos.push(cosTable)
    sin.push(sinTable)
  }
  const bank: FilterBank = { cos, sin }
  filterBankCache.set(sampleRate, bank)
  return bank
}

// Builds the chromagram: for every frame across the signal, measures energy
// at each target pitch (via the precomputed filter bank) and accumulates it
// into that pitch's chroma bin. Short frames + accumulation over many of
// them is what makes this robust to vibrato and chord movement, unlike a
// single huge analysis block.
function extractChroma(samples: Float32Array, sampleRate: number): number[] {
  const chroma = new Array(12).fill(0)
  if (samples.length === 0) return chroma

  const { cos, sin } = getFilterBank(sampleRate)
  const frame = samples.length < FRAME_SIZE ? padToFrameSize(samples) : samples
  const lastStart = Math.max(0, frame.length - FRAME_SIZE)

  for (let start = 0; start <= lastStart; start += HOP_SIZE) {
    for (let f = 0; f < TARGET_FREQUENCIES.length; f++) {
      const cosTable = cos[f]
      const sinTable = sin[f]
      let real = 0
      let imag = 0
      for (let i = 0; i < FRAME_SIZE; i++) {
        const s = frame[start + i]
        real += s * cosTable[i]
        imag += s * sinTable[i]
      }
      chroma[TARGET_FREQUENCIES[f].pitchClass] += Math.sqrt(real * real + imag * imag)
    }
  }

  return chroma
}

function padToFrameSize(samples: Float32Array): Float32Array {
  const padded = new Float32Array(FRAME_SIZE)
  padded.set(samples)
  return padded
}

function rotateProfile(profile: number[], tonic: number): number[] {
  return Array.from({ length: 12 }, (_, pitchClass) => profile[(pitchClass - tonic + 12) % 12])
}

function correlate(a: number[], b: number[]): number {
  const n = a.length
  const meanA = a.reduce((sum, v) => sum + v, 0) / n
  const meanB = b.reduce((sum, v) => sum + v, 0) / n
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den === 0 ? 0 : num / den
}

function estimateKey(chroma: number[]): KeyDetectionResult | null {
  const totalEnergy = chroma.reduce((sum, v) => sum + v, 0)
  if (!Number.isFinite(totalEnergy) || totalEnergy < 1e-6) return null

  let bestTonic = 0
  let bestMode: 'major' | 'minor' = 'major'
  let bestCorrelation = -Infinity
  for (let tonic = 0; tonic < 12; tonic++) {
    const majorCorrelation = correlate(chroma, rotateProfile(MAJOR_PROFILE, tonic))
    const minorCorrelation = correlate(chroma, rotateProfile(MINOR_PROFILE, tonic))
    if (majorCorrelation > bestCorrelation) {
      bestCorrelation = majorCorrelation
      bestTonic = tonic
      bestMode = 'major'
    }
    if (minorCorrelation > bestCorrelation) {
      bestCorrelation = minorCorrelation
      bestTonic = tonic
      bestMode = 'minor'
    }
  }

  if (!Number.isFinite(bestCorrelation)) return null
  const tonicName = NOTE_NAMES[bestTonic]
  const modeName = bestMode === 'major' ? 'Major' : 'Minor'
  return { key: tonicName, keySignature: `${tonicName} ${modeName}` }
}

self.addEventListener('message', (event: MessageEvent<KeyDetectionRequest>) => {
  const { id, sampleRate, samples } = event.data
  let result: KeyDetectionResult | null = null
  try {
    const chroma = extractChroma(samples, sampleRate)
    result = estimateKey(chroma)
  } catch (err) {
    console.error(`Key detection failed for track ${id}:`, err)
  }
  const response: KeyDetectionResponse = { id, result }
  ;(self as unknown as Worker).postMessage(response)
})
