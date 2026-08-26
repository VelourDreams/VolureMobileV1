// Shared by every pitch-shift-capable playback engine (main Now Playing,
// Studio's track slot, Studio's mic/internal recorders).
export const PITCH_SEMITONES_MIN = -12
export const PITCH_SEMITONES_MAX = 12

// Vestigial: PitchShifterWorklet (pitchShiftWorkletNode.ts) renders through
// an AudioWorkletNode, which always processes fixed-size quanta set by the
// browser, not a configurable buffer size. Kept only so call sites (and the
// soundtouchjs-shaped constructor signature) don't need to change.
export const PITCH_SHIFT_BUFFER_SIZE = 4096
