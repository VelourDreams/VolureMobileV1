import { useEffect, useRef, useState } from 'react'

export type RecordingContainer = 'mp4' | 'webm'

// Prefers a native MP4 (H.264/AAC) encode when Chromium's MediaRecorder
// supports it — stageRecording below then just writes those bytes straight
// to disk instead of re-encoding the whole recording through ffmpeg, which
// is what made this take 30+ seconds on builds that only have VP9/VP8
// encoders. Falls back to WebM (VP9, then VP8) wherever native MP4
// recording isn't available; either way ffmpeg (see electron/main.ts's
// library:stageScreenRecording) can still decode it as a last resort.
function pickSupportedMimeType(): string {
  const candidates = [
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm'
}

export interface ScreenRecorderHandle {
  recording: boolean
  countdown: number | null
  toggleRecording: () => void
  beginRecordingWithDelay: (seconds: number) => void
  cancelScheduledRecording: () => void
}

// Captures the app's own window (whatever view is currently showing — the
// record button only lives in Play, so in practice that's the Play view)
// plus system loopback audio, via the same getDisplayMedia handshake Studio
// uses for internal-audio recording (see electron/main.ts's
// setDisplayMediaRequestHandler) — except here the video track is kept
// instead of discarded. Recorded with MediaRecorder rather than the raw
// AudioWorklet pipeline useAudioRecorder uses, since MediaRecorder can
// encode video+audio together.
export function useScreenRecorder(onSaved?: (path: string) => void): ScreenRecorderHandle {
  const [recording, setRecording] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [staging, setStaging] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const containerRef = useRef<RecordingContainer>('webm')
  const countdownTimerRef = useRef<number | null>(null)
  const countdownIntervalRef = useRef<number | null>(null)
  // Guards the async window between getDisplayMedia resolving and
  // recorder.start() actually being called (see startRecording) — without
  // it, a double-click on Record while that's in flight would open a second
  // capture stream.
  const startingRef = useRef(false)

  // Resolves once the cue has had a moment to play (or immediately if it
  // fails to play at all), so startRecording can await it before starting
  // the encoder — see there for why that ordering matters. screenshot1.wav
  // is ~4.5s long — far too long to actually wait out here, since every
  // second spent waiting is a second of real content lost from the front of
  // the take — so playback is cut short well before that. A hard pause()
  // mid-sample leaves the waveform discontinuous, which is audible as a
  // click/pop, so the last stretch ramps the volume down to silence first
  // instead of just stopping cold. The cutoff is timed off the element's own
  // currentTime (via the 'playing' event) rather than a wall-clock
  // setTimeout from when this function was called — a freshly-constructed
  // Audio() can take a beat to actually start producing sound (decoding a
  // WAV it hasn't loaded before), and a wall-clock timer that fires before
  // playback truly starts would end up fading straight to silence with
  // little or nothing ever audible.
  function playRecordingStartedSound(): Promise<void> {
    return new Promise((resolve) => {
      const sound = new Audio('/sound-effects/screenshot1.wav')
      sound.volume = 1
      let settled = false
      let rafId: number | null = null
      const playMs = 240
      const fadeMs = 80
      const finish = () => {
        if (settled) return
        settled = true
        if (rafId !== null) cancelAnimationFrame(rafId)
        sound.pause()
        resolve()
      }
      const tick = () => {
        const elapsedMs = sound.currentTime * 1000
        if (elapsedMs >= playMs + fadeMs) {
          finish()
          return
        }
        if (elapsedMs >= playMs) {
          sound.volume = Math.max(0, 1 - (elapsedMs - playMs) / fadeMs)
        }
        rafId = requestAnimationFrame(tick)
      }
      sound.addEventListener('ended', finish, { once: true })
      sound.addEventListener('playing', () => { rafId = requestAnimationFrame(tick) }, { once: true })
      sound.play().catch(finish)
    })
  }

  function cancelScheduledRecording() {
    if (countdownTimerRef.current) {
      clearTimeout(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    setCountdown(null)
  }

  async function startRecording() {
    if (recording || startingRef.current) return
    startingRef.current = true
    cancelScheduledRecording()
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // cursor: 'never' is the standard way to ask the capture to exclude
        // the mouse pointer. Support for it is inconsistent across Chromium
        // versions/capture backends (a known, still-open Chromium/Electron
        // limitation — there is no other JS-level way to control this), so
        // treat it as best-effort rather than a guarantee.
        // TS's lib.dom types predate this constraint, hence the cast.
        video: { cursor: 'never' } as MediaTrackConstraints,
        // Disabling echo cancellation/noise suppression/AGC is what keeps
        // this a faithful capture of the system audio instead of degrading
        // it — same fix as Studio's internal-audio recorder (see
        // getInternalAudioStream in App.tsx). Without it, Chromium runs
        // loopback audio through the same call-oriented DSP pipeline it
        // uses for a microphone even though there's nothing real for echo
        // cancellation to cancel here, and the result comes out muffled and
        // distorted rather than a clean capture.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      const mimeType = pickSupportedMimeType()
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 192000 })
      containerRef.current = recorder.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        void stageRecording().then((stagedPath) => {
          if (stagedPath && onSaved) onSaved(stagedPath)
        })
      }
      streamRef.current = stream
      mediaRecorderRef.current = recorder
      // The chime plays through the system output — the same loopback audio
      // track being captured above — so it's played (and awaited) here,
      // before the encoder starts, rather than after starting it. Starting
      // MediaRecorder only encodes frames from that point forward, so
      // anything that happens before start() never ends up in the file.
      await playRecordingStartedSound()
      recorder.start()
      setRecording(true)
    } catch (err) {
      console.error('Failed to start screen recording:', err)
    } finally {
      startingRef.current = false
    }
  }

  function stopRecording() {
    cancelScheduledRecording()
    const recorder = mediaRecorderRef.current
    // Force whatever's been encoded so far out as its own chunk before the
    // stop-triggered final flush, shrinking the window of "since the last
    // dataavailable" data that flush has to account for — a defensive
    // nudge for the tail end of the take, in the same spirit as
    // useAudioRecorder's explicit flush-before-teardown.
    if (recorder?.state === 'recording') recorder.requestData()
    recorder?.stop()
    mediaRecorderRef.current = null
    streamRef.current = null
    setRecording(false)
  }

  function beginRecordingWithDelay(seconds: number) {
    if (recording || countdown !== null) return
    const delayMs = Math.max(0, seconds * 1000)
    const targetTime = Date.now() + delayMs
    setCountdown(seconds)

    countdownTimerRef.current = window.setTimeout(() => {
      void startRecording()
    }, delayMs)

    countdownIntervalRef.current = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000))
      setCountdown(remaining)
      if (remaining <= 0) {
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current)
          countdownIntervalRef.current = null
        }
      }
    }, 200)
  }

  function toggleRecording() {
    if (recording) stopRecording()
    else startRecording()
  }

  // Writes the just-finished recording to a throwaway temp file — never a
  // permanent save — purely so it can be loaded into the Video Viewer. The
  // user downloads it explicitly from there if they want to keep it (see
  // the Video Viewer's Download button / window.api.downloadScreenRecording).
  async function stageRecording(): Promise<string | null> {
    if (staging) return null
    setStaging(true)
    try {
      const container = containerRef.current
      const blob = new Blob(chunksRef.current, { type: container === 'mp4' ? 'video/mp4' : 'video/webm' })
      const buffer = await blob.arrayBuffer()
      const stagedPath = await window.api.stageScreenRecording(buffer, container)
      chunksRef.current = []
      return stagedPath
    } catch (err) {
      console.error('Failed to prepare screen recording:', err)
      return null
    } finally {
      setStaging(false)
    }
  }

  // Releases the capture stream if the app closes mid-recording, same
  // precedent as useAudioRecorder's own unmount cleanup.
  useEffect(() => {
    return () => {
      cancelScheduledRecording()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  return {
    recording,
    countdown,
    toggleRecording,
    beginRecordingWithDelay,
    cancelScheduledRecording,
  }
}
