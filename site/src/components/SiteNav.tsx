import { useState } from 'react'
import { motion, useMotionValueEvent, useScroll } from 'motion/react'
import { ArrowDownToLine, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { NAV_LINKS } from '@/lib/site'
import { useDownloadUrl } from '@/lib/latest-release'
import { EASE_OUT } from '@/lib/motion'

export function Wordmark({ className }: { className?: string }) {
  return (
    <a href="#top" className={cn('flex items-center gap-2.5 rounded-md', className)} aria-label="GeoFlight, back to top">
      <img src="/app-icon.png" alt="" width={28} height={28} className="size-7 rounded-[7px]" />
      <span className="text-[0.95rem] font-semibold tracking-[-0.01em]">GeoFlight</span>
    </a>
  )
}

export function SiteNav() {
  const downloadUrl = useDownloadUrl()
  const { scrollY } = useScroll()
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  // React skips the render when the boolean is unchanged, so this only
  // re-renders when the threshold is crossed, not on every scroll frame.
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 24))

  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.1 }}
      className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5"
    >
      <nav
        aria-label="Main"
        className={cn(
          'mx-auto flex h-14 max-w-6xl items-center justify-between rounded-2xl border px-3 pl-4 transition-[background-color,border-color,backdrop-filter] duration-500',
          scrolled
            ? 'border-white/10 bg-[oklch(0.15_0.012_260/0.62)] backdrop-blur-xl backdrop-saturate-150'
            : 'border-transparent bg-transparent',
        )}
      >
        <Wordmark />

        <ul className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="group relative rounded-md px-3 py-2 text-sm text-white/75 transition-colors duration-200 hover:text-white focus-visible:text-white"
              >
                {link.label}
                <span
                  aria-hidden
                  className="absolute inset-x-3 -bottom-px h-px origin-left scale-x-0 bg-white/60 transition-transform duration-300 ease-out-expo group-hover:scale-x-100 group-focus-visible:scale-x-100"
                />
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <Button asChild size="lg" className="hidden rounded-full px-4 sm:inline-flex">
            <a href={downloadUrl} target="_blank" rel="noreferrer">
              <ArrowDownToLine data-icon="inline-start" aria-hidden />
              Download
            </a>
          </Button>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-lg" className="rounded-full md:hidden" aria-label="Open menu">
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(86vw,22rem)] border-white/10 bg-[oklch(0.15_0.012_260/0.92)] backdrop-blur-xl">
              <SheetHeader className="pt-6">
                <SheetTitle className="sr-only">Menu</SheetTitle>
                <SheetDescription className="sr-only">Jump to a section of the page</SheetDescription>
                <Wordmark />
              </SheetHeader>
              <ul className="flex flex-col px-2">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      onClick={() => setOpen(false)}
                      className="flex min-h-12 items-center rounded-lg px-3 text-2xl font-medium tracking-[-0.02em] text-white/85 transition-colors active:bg-white/5"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
              <div className="mt-auto p-4">
                <Button asChild size="xl" className="w-full">
                  <a href={downloadUrl} target="_blank" rel="noreferrer">
                    <ArrowDownToLine data-icon="inline-start" aria-hidden />
                    Download for macOS
                  </a>
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
    </motion.header>
  )
}
