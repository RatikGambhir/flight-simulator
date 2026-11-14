/** Real destinations only. Every link here resolves today. */
export const REPO_URL = 'https://github.com/RatikGambhir/flight-simulator'
/** CI publishes a universal macOS .dmg to GitHub Releases on every simulator change. */
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest`
export const RELEASES_URL = `${REPO_URL}/releases`
export const SOURCE_README_URL = `${REPO_URL}/tree/main/app#readme`

export const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#explore', label: 'Explore' },
  { href: '#gallery', label: 'Gallery' },
  { href: '#download', label: 'Download' },
] as const

export type Platform = {
  name: string
  detail: string
  available: boolean
}

export const PLATFORMS: readonly Platform[] = [
  { name: 'macOS', detail: 'macOS 13 Ventura or later · Universal (Apple Silicon + Intel)', available: true },
  { name: 'Windows', detail: 'No release yet', available: false },
  { name: 'Linux', detail: 'No release yet', available: false },
]
