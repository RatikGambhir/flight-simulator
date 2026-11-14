import { describe, expect, it, vi } from 'vitest'
import { fetchLatestDmgUrl } from '@/lib/latest-release'

const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('fetchLatestDmgUrl', () => {
  it('returns the .dmg asset link', async () => {
    const url = await fetchLatestDmgUrl(respond({ assets: [{ name: 'GeoFlight.dmg', browser_download_url: 'https://x/GeoFlight.dmg' }] }))
    expect(url).toBe('https://x/GeoFlight.dmg')
  })

  it('returns null when the release has no .dmg', async () => {
    expect(await fetchLatestDmgUrl(respond({ assets: [] }))).toBeNull()
  })

  it('returns null on rate limits and network errors', async () => {
    expect(await fetchLatestDmgUrl(respond({ message: 'rate limited' }, 403))).toBeNull()
    expect(await fetchLatestDmgUrl(vi.fn(async () => Promise.reject(new TypeError('offline'))))).toBeNull()
  })
})
