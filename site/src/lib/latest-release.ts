import { useEffect, useState } from 'react'
import { DOWNLOAD_URL, LATEST_RELEASE_API_URL } from '@/lib/site'

type ReleaseAsset = { name: string; browser_download_url: string }

/** Resolves to the newest release's .dmg, or null if GitHub can't be reached. */
export async function fetchLatestDmgUrl(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(LATEST_RELEASE_API_URL, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const release = (await res.json()) as { assets?: ReleaseAsset[] }
    return release.assets?.find((asset) => asset.name.endsWith('.dmg'))?.browser_download_url ?? null
  } catch {
    return null
  }
}

// One request per page load, shared by every download button.
let pending: Promise<string | null> | undefined

/**
 * The direct download link for the newest simulator build. Starts as the
 * latest-release page, so the button works before (or without) the API call.
 */
export function useDownloadUrl(): string {
  const [url, setUrl] = useState(DOWNLOAD_URL)
  useEffect(() => {
    let active = true
    pending ??= fetchLatestDmgUrl()
    void pending.then((dmg) => {
      if (active && dmg) setUrl(dmg)
    })
    return () => {
      active = false
    }
  }, [])
  return url
}
