/** Real destinations only. Every link here resolves today. */
export const REPO_URL = 'https://github.com/RatikGambhir/flight-simulator'
/** CI publishes a universal macOS .dmg to GitHub Releases on every simulator change. */
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest`
/** Read at runtime so download buttons always point at the newest .dmg (see useDownloadUrl). */
export const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/RatikGambhir/flight-simulator/releases/latest'
export const RELEASES_URL = `${REPO_URL}/releases`
export const SOURCE_README_URL = `${REPO_URL}/tree/main/app#readme`
/** Browser build of the simulator: the `web` service of the geoflight-site Railway project (deploy-web workflow). */
export const WEB_APP_URL = 'https://web-production-55c4131e.up.railway.app'

export const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#explore', label: 'Explore' },
  { href: '#gallery', label: 'Gallery' },
  { href: '#download', label: 'Download' },
] as const

export type Platform = {
  name: string
  detail: string
}

export const PLATFORMS: readonly Platform[] = [
  { name: 'macOS', detail: 'macOS 13 Ventura or later · Universal (Apple Silicon + Intel)' },
  { name: 'Browser', detail: 'Chrome, Edge or Safari 16+ with WebGL 2 · nothing to install' },
]
