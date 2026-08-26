// RMS-based silence detector: walks the take in short windows (~11ms at
// 48kHz) rather than testing individual samples, so an isolated click or a
// single noisy sample near an edge can't trick it into treating actual
// silence as the take's start/end. Trims both the leading and trailing run
// of silence in one pass. Shared by useAudioRecorder (mic/internal takes)
// and useFilePlayback (Studio's track slot) so both "Remove Silence" entry
// points agree on exactly what counts as silence.
const SILENCE_RMS_THRESHOLD = 0.02
const SILENCE_WINDOW_SAMPLES = 512
// A window's RMS is an average over its whole ~11ms span, so the window
// immediately before the one that first crosses the threshold can still
// contain real, audible signal (a soft attack, a breath, a reverb tail) —
// its *average* just isn't loud enough to cross on its own. Cutting flush at
// the detected boundary was chopping into that material. Keeping one extra
// window on each side is enough to catch it without leaving back more than
// an extra ~11ms of already near-inaudible lead-in/lead-out silence.
const SILENCE_PAD_SAMPLES = SILENCE_WINDOW_SAMPLES

export function trimSilence(buffer: AudioBuffer): AudioBuffer {
  const channelCount = buffer.numberOfChannels
  const channels = Array.from({ length: channelCount }, (_, ch) => buffer.getChannelData(ch))
  const length = buffer.length

  function windowRms(start: number, end: number): number {
    let sumSquares = 0
    let count = 0
    for (let ch = 0; ch < channelCount; ch++) {
      const data = channels[ch]
      for (let i = start; i < end; i++) {
        sumSquares += data[i] * data[i]
        count++
      }
    }
    return count > 0 ? Math.sqrt(sumSquares / count) : 0
  }

  let trimStart = length
  for (let start = 0; start < length; start += SILENCE_WINDOW_SAMPLES) {
    const end = Math.min(start + SILENCE_WINDOW_SAMPLES, length)
    if (windowRms(start, end) > SILENCE_RMS_THRESHOLD) {
      trimStart = start
      break
    }
  }

  // Leave untouched rather than producing an empty clip if the whole take
  // never crosses the threshold (silence throughout).
  if (trimStart >= length) return buffer

  // Same scan run backwards from the end, stopping at trimStart — windows
  // here are aligned to the end rather than the start, but that's fine, the
  // goal is just finding where the trailing silence run begins.
  let trimEnd = length
  for (let end = length; end > trimStart; end -= SILENCE_WINDOW_SAMPLES) {
    const start = Math.max(trimStart, end - SILENCE_WINDOW_SAMPLES)
    if (windowRms(start, end) > SILENCE_RMS_THRESHOLD) {
      trimEnd = end
      break
    }
  }

  // Back off from both detected boundaries by a pad window before cutting —
  // see SILENCE_PAD_SAMPLES above for why the flush boundary itself isn't
  // safe to cut at.
  trimStart = Math.max(0, trimStart - SILENCE_PAD_SAMPLES)
  trimEnd = Math.min(length, trimEnd + SILENCE_PAD_SAMPLES)

  if (trimStart <= 0 && trimEnd >= length) return buffer

  const trimmedLength = trimEnd - trimStart
  const trimmed = new AudioBuffer({
    numberOfChannels: channelCount,
    length: trimmedLength,
    sampleRate: buffer.sampleRate,
  })
  for (let ch = 0; ch < channelCount; ch++) {
    trimmed.copyToChannel(channels[ch].subarray(trimStart, trimEnd), ch)
  }
  return trimmed
}

export interface FadeSetting {
  on: boolean
  // Fraction of the *sliced* region's length the ramp spans, not the
  // original buffer's — matches how the Trim Audio tilt-handle expresses
  // fade speed relative to whatever's currently selected.
  ratio: number
}

// Manual counterpart to trimSilence above: cuts to an explicit
// [startRatio, endRatio] slice of the source (rather than detecting silence)
// and optionally bakes linear fade-in/fade-out gain ramps into the sliced
// region's own head/tail. Always re-slices from the untouched source buffer
// passed in, never a previous result, so repeated calls (e.g. one per handle
// drag) never compound cuts or fades into each other.
export function sliceAndFadeBuffer(
  buffer: AudioBuffer,
  startRatio: number,
  endRatio: number,
  fadeIn: FadeSetting,
  fadeOut: FadeSetting
): AudioBuffer {
  const length = buffer.length
  const startSample = Math.max(0, Math.min(length, Math.round(startRatio * length)))
  const endSample = Math.max(startSample, Math.min(length, Math.round(endRatio * length)))
  const slicedLength = Math.max(1, endSample - startSample)
  const channelCount = buffer.numberOfChannels

  const fadeInSamples = fadeIn.on ? Math.round(Math.min(0.5, Math.max(0, fadeIn.ratio)) * slicedLength) : 0
  const fadeOutSamples = fadeOut.on ? Math.round(Math.min(0.5, Math.max(0, fadeOut.ratio)) * slicedLength) : 0

  const result = new AudioBuffer({
    numberOfChannels: channelCount,
    length: slicedLength,
    sampleRate: buffer.sampleRate,
  })
  for (let ch = 0; ch < channelCount; ch++) {
    const source = buffer.getChannelData(ch)
    const dest = new Float32Array(slicedLength)
    for (let i = 0; i < slicedLength; i++) {
      let sample = source[startSample + i]
      if (fadeInSamples > 0 && i < fadeInSamples) sample *= i / fadeInSamples
      if (fadeOutSamples > 0 && i >= slicedLength - fadeOutSamples) {
        sample *= (slicedLength - i) / fadeOutSamples
      }
      dest[i] = sample
    }
    result.copyToChannel(dest, ch)
  }
  return result
}
