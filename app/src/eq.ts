// Shared by the Customize (Equalizer) menu, Studio's own per-slot Equalizer
// tool, and the studio export's offline render — one definition of the band
// layout so all three stay in lockstep.
export const EQ_BANDS: { freq: number; type: BiquadFilterType }[] = [
  { freq: 60, type: 'lowshelf' },
  { freq: 150, type: 'peaking' },
  { freq: 400, type: 'peaking' },
  { freq: 1000, type: 'peaking' },
  { freq: 2400, type: 'peaking' },
  { freq: 6000, type: 'peaking' },
  { freq: 15000, type: 'highshelf' },
]

export function formatEqFreq(freq: number): string {
  return freq >= 1000 ? `${freq / 1000}kHz` : `${freq}Hz`
}
