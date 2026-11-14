import { NAV_LINKS, RELEASES_URL, REPO_URL } from '@/lib/site'
import { Wordmark } from './SiteNav'

const YEAR = new Date().getFullYear()

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-12 sm:px-8">
        <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-center">
          <Wordmark />
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/60">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="transition-colors hover:text-white">
                    {link.label}
                  </a>
                </li>
              ))}
              <li>
                <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-white">
                  Releases
                </a>
              </li>
              <li>
                <a href={REPO_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-white">
                  GitHub
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="flex flex-col justify-between gap-3 text-xs leading-relaxed text-white/40 sm:flex-row">
          <p>© {YEAR} GeoFlight contributors · MIT License</p>
          <p className="max-w-[60ch] sm:text-right">
            Airports: OurAirports. Cities: Natural Earth. In-game scenery © Google and its data providers. Aircraft are
            original models in the style of each type, not licensed replicas.
          </p>
        </div>
      </div>
    </footer>
  )
}
