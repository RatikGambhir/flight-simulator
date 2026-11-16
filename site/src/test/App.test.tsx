import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_URL, NAV_LINKS, WEB_APP_URL } from '@/lib/site'

// The release lookup is cached per page load, so each test gets a fresh module graph.
beforeEach(() => {
  vi.resetModules()
})

async function renderApp() {
  const { default: App } = await import('@/App')
  return render(<App />)
}

const DMG_URL = 'https://github.com/RatikGambhir/flight-simulator/releases/download/v9.9.9/GeoFlight_9.9.9_universal.dmg'

function stubLatestRelease(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// Nav, hero and final call to action (the mobile menu's button only mounts when the menu opens).
const downloadLinks = () =>
  screen.getAllByRole('link', { name: /download/i }).filter((link) => !link.getAttribute('href')?.startsWith('#'))

describe('landing page', () => {
  it('renders the hero, the download section and every section the nav links to', async () => {
    stubLatestRelease({ assets: [] })
    const { container } = await renderApp()

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: /window seat/i })).toBeInTheDocument()
    for (const link of NAV_LINKS) {
      expect(container.querySelector(link.href), `${link.href} section`).not.toBeNull()
    }
  })

  it('lists only macOS and the browser as platforms', async () => {
    stubLatestRelease({ assets: [] })
    await renderApp()

    const download = document.getElementById('download')!
    expect(within(download).getByText('macOS')).toBeInTheDocument()
    expect(within(download).getByText('Browser')).toBeInTheDocument()
    expect(download).not.toHaveTextContent(/\b(windows|linux)\b/i)
  })

  it('points every download button at the newest .dmg from GitHub Releases', async () => {
    const fetchMock = stubLatestRelease({
      assets: [
        { name: 'checksums.txt', browser_download_url: 'https://example.invalid/checksums.txt' },
        { name: 'GeoFlight_9.9.9_universal.dmg', browser_download_url: DMG_URL },
      ],
    })
    await renderApp()

    expect(downloadLinks()).toHaveLength(3)
    // Before the API answers, buttons already work via the latest-release page.
    for (const link of downloadLinks()) expect(link).toHaveAttribute('href', DOWNLOAD_URL)

    await waitFor(() => {
      for (const link of downloadLinks()) expect(link).toHaveAttribute('href', DMG_URL)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('links to the browser version of the simulator from the nav, hero and download section', async () => {
    stubLatestRelease({ assets: [] })
    await renderApp()
    const links = screen.getAllByRole('link', { name: /fly in (your )?browser/i })
    expect(links).toHaveLength(3)
    for (const link of links) expect(link).toHaveAttribute('href', WEB_APP_URL)
  })
})
