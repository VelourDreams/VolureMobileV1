import { useEffect, useState } from 'react'

const artCache = new Map<string, string | null>()

export function useTrackArt(filePath: string | null): string | null {
  const [art, setArt] = useState<string | null>(filePath ? artCache.get(filePath) ?? null : null)

  useEffect(() => {
    if (!filePath) {
      setArt(null)
      return
    }
    if (artCache.has(filePath)) {
      setArt(artCache.get(filePath) ?? null)
      return
    }
    let cancelled = false
    window.api.getArt(filePath).then((result) => {
      const url = result ? `data:${result.format};base64,${result.data}` : null
      artCache.set(filePath, url)
      if (!cancelled) setArt(url)
    })
    return () => {
      cancelled = true
    }
  }, [filePath])

  return art
}
