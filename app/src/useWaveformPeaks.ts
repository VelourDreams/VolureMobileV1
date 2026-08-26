import { useEffect, useState } from 'react'
import { platform } from './platform'

const BAR_COUNT = 96

const peaksCache = new Map<string, number[]>()
const pending = new Map<string, Promise<number[]>>()
let decodeCtx: AudioContext | null = null

// Downsamples a decoded buffer's first channel into per-bar amplitude peaks,
// normalized to [0, 1]. Shared by the file-based extraction below and by
// anything else that already has an AudioBuffer in hand (e.g. a freshly
// recorded mic take with no file on disk yet).
export function computePeaksFromBuffer(buffer: AudioBuffer, barCount = BAR_COUNT): number[] {
  const channel = buffer.getChannelData(0)
  const blockSize = Math.max(1, Math.floor(channel.length / barCount))

  const peaks: number[] = []
  for (let i = 0; i < barCount; i++) {
    const start = i * blockSize
    let max = 0
    for (let j = 0; j < blockSize && start + j < channel.length; j++) {
      const value = Math.abs(channel[start + j])
      if (value > max) max = value
    }
    peaks.push(max)
  }

  const peakMax = Math.max(...peaks, 0.0001)
  return peaks.map((p) => p / peakMax)
}

async function extractPeaks(filePath: string): Promise<number[]> {
  const res = await fetch(platform.getMediaUrl(filePath))
  const arrayBuffer = await res.arrayBuffer()
  if (!decodeCtx) decodeCtx = new AudioContext()
  const buffer = await decodeCtx.decodeAudioData(arrayBuffer)
  return computePeaksFromBuffer(buffer)
}

// Real per-track amplitude peaks, decoded once from the audio file and
// cached by path — same fetch+decodeAudioData approach the key detection
// path already uses for this app's file sizes.
export function useWaveformPeaks(filePath: string | null | undefined): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(
    filePath ? (peaksCache.get(filePath) ?? null) : null
  )

  useEffect(() => {
    if (!filePath) {
      setPeaks(null)
      return
    }
    const cached = peaksCache.get(filePath)
    if (cached) {
      setPeaks(cached)
      return
    }
    setPeaks(null)
    let cancelled = false
    let promise = pending.get(filePath)
    if (!promise) {
      promise = extractPeaks(filePath)
      pending.set(filePath, promise)
    }
    promise
      .then((result) => {
        peaksCache.set(filePath, result)
        pending.delete(filePath)
        if (!cancelled) setPeaks(result)
      })
      .catch((err) => {
        pending.delete(filePath)
        console.error(`Failed to extract waveform for ${filePath}:`, err)
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  return peaks
}
