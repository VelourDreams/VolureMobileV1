// AudioWorkletProcessor for mic recording capture. Replaces an earlier
// ScriptProcessorNode-based approach: ScriptProcessorNode's onaudioprocess
// callback runs on the main thread, so other main-thread work happening
// during recording (e.g. the live waveform animation) could delay it enough
// that the browser dropped audio frames outright. Those gaps show up as
// clicks/pops once the surviving chunks are stitched into one buffer.
// AudioWorkletProcessor runs on the dedicated real-time audio thread instead,
// so capture keeps up regardless of what the main thread is doing.
const CHUNK_SIZE = 4096

class MicRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._channelBuffers = []
    this._writeIndex = 0
    this._recording = false
    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this._recording = true
        return
      }
      if (event.data === 'flush') this._flush()
    }
  }

  _flush() {
    if (this._writeIndex === 0) {
      this.port.postMessage(null)
      return
    }
    const chunk = this._channelBuffers.map((buf) => buf.slice(0, this._writeIndex))
    this.port.postMessage(chunk, chunk.map((c) => c.buffer))
    this._writeIndex = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true
    if (!this._recording) return true

    const channelCount = input.length
    if (this._channelBuffers.length !== channelCount) {
      this._channelBuffers = Array.from({ length: channelCount }, () => new Float32Array(CHUNK_SIZE))
      this._writeIndex = 0
    }

    const frameCount = input[0].length
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < channelCount; ch++) {
        this._channelBuffers[ch][this._writeIndex] = input[ch][i]
      }
      this._writeIndex++
      if (this._writeIndex >= CHUNK_SIZE) {
        const chunk = this._channelBuffers.map((buf) => buf.slice())
        this.port.postMessage(chunk, chunk.map((c) => c.buffer))
        this._writeIndex = 0
      }
    }
    return true
  }
}

registerProcessor('mic-recorder-processor', MicRecorderProcessor)
