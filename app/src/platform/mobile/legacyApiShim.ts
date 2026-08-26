// A stand-in for the Electron preload bridge (`window.api`) on Android.
//
// App.tsx is one 13k-line file: Studio, Play, the viewers and the window
// chrome all mount their effects even when their views aren't shown, and many
// of those still call `window.api.*` directly (the desktop-only methods the
// Phase 2 sweep deliberately left in place). On Android there is no preload,
// so `window.api` is undefined and the first such call throws before the UI
// paints.
//
// This installs a Proxy that answers every one of those calls with a harmless
// no-op, so the app boots. The real fix is Phase 6 — gate Studio/Play out of
// the mount path entirely — after which this shim can shrink or go away.
// Anything routed through the `platform` boundary does NOT come here.

// Methods that return an unsubscribe function rather than a value.
const SUBSCRIBE = new Set(['onDeveloperToggle', 'onWindowFullscreenChange'])

// Methods the caller uses synchronously (not awaited).
const SYNC = new Set(['getPathForFile', 'getMediaUrl', 'setScreenshotCountdownOverlay'])

const warned = new Set<string>()

function noop(name: string) {
  return (...args: unknown[]): unknown => {
    if (!warned.has(name)) {
      warned.add(name)
      console.warn(`[volure] window.api.${name} is a no-op in the Android build`)
    }
    if (name === 'ensurePlayableAudio') return args[0] ?? null // identity fallback
    if (name === 'getAdvancedTracks') return []
    if (name === 'getBassIntervals') return {}
    return null
  }
}

export function installLegacyApiShim(): void {
  const w = window as unknown as { api?: unknown }
  if (w.api) return

  w.api = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (SUBSCRIBE.has(prop)) return () => () => {}
        if (SYNC.has(prop)) {
          if (prop === 'getMediaUrl' || prop === 'getPathForFile') {
            return (arg: unknown) => String(arg ?? '')
          }
          return () => undefined
        }
        return async (...args: unknown[]) => noop(prop)(...args)
      },
    },
  )
}
