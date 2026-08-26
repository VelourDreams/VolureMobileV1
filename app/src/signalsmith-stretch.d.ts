// signalsmith-stretch ships no TypeScript types — this declares just the
// surface actually used in this app. See pitchShiftWorkletNode.ts.
declare module 'signalsmith-stretch' {
  interface ScheduleOptions {
    output?: number
    active?: boolean
    input?: number
    rate?: number
    semitones?: number
    tonalityHz?: number
    formantSemitones?: number
    formantCompensation?: boolean
    formantBaseHz?: number
    loopStart?: number
    loopEnd?: number
  }

  interface StretchNode extends AudioWorkletNode {
    readonly inputTime: number
    schedule(options: ScheduleOptions, adjustPrevious?: boolean): Promise<ScheduleOptions>
    start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<ScheduleOptions>
    stop(when?: number): Promise<ScheduleOptions>
    addBuffers(sampleBuffers: Float32Array[]): Promise<number>
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>
    latency(): Promise<number>
    configure(options: { blockMs?: number; intervalMs?: number; splitComputation?: boolean }): Promise<void>
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<void>
  }

  function SignalsmithStretch(
    audioContext: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions
  ): Promise<StretchNode>

  export default SignalsmithStretch
}
