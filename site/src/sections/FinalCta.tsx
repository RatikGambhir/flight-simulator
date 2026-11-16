import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, Globe, Laptop, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Picture } from '@/components/Picture'
import { Reveal } from '@/components/Reveal'
import { PHOTOS } from '@/content/images'
import { PLATFORMS, REPO_URL, WEB_APP_URL } from '@/lib/site'
import { useDownloadUrl } from '@/lib/latest-release'
import { cn } from '@/lib/utils'

export function FinalCta() {
  const downloadUrl = useDownloadUrl()
  const ref = useRef<HTMLElement>(null)
  const still = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end end'] })
  const scale = useTransform(scrollYProgress, [0, 1], still ? [1, 1] : [1.14, 1])

  return (
    <section ref={ref} id="download" aria-labelledby="download-title" className="relative isolate overflow-hidden">
      <motion.div aria-hidden style={{ scale }} className="absolute inset-0 -z-20 will-change-transform">
        <Picture photo={PHOTOS.sunset} sizes="100vw" imgClassName="object-[50%_40%]" />
      </motion.div>
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-background via-transparent via-45% to-background" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(70%_60%_at_50%_50%,oklch(0.13_0.012_260/0.35),transparent_70%)]" />

      <div className="mx-auto flex min-h-[90svh] max-w-6xl flex-col items-center justify-center px-5 py-32 text-center sm:px-8">
        <Reveal>
          <p className="label-mono text-sun">Ready for departure</p>
        </Reveal>
        <Reveal delay={0.06}>
          <h2 id="download-title" className="mt-5 max-w-[14ch] text-[clamp(2.75rem,7vw,5.75rem)] leading-[0.98] font-semibold tracking-[-0.045em]">
            Your window seat is waiting.
          </h2>
        </Reveal>
        <Reveal delay={0.12}>
          <p className="mt-6 max-w-[44ch] text-base leading-relaxed text-white/75 sm:text-lg">
            GeoFlight is free and open source. Download it or fly right here in your browser, pick an airport, and see where the afternoon takes you.
          </p>
        </Reveal>

        <Reveal delay={0.18} className="mt-9 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
          <Button asChild size="xl" className="w-full sm:w-auto">
            <a href={downloadUrl} target="_blank" rel="noreferrer">
              <ArrowDownToLine data-icon="inline-start" aria-hidden />
              Download for macOS
            </a>
          </Button>
          <Button asChild size="xl" variant="outline" className="w-full border-white/20 bg-white/5 backdrop-blur-md hover:bg-white/10 sm:w-auto">
            <a href={WEB_APP_URL} target="_blank" rel="noreferrer">
              Fly in your browser
              <ArrowRight data-icon="inline-end" aria-hidden />
            </a>
          </Button>
          <Button asChild size="xl" variant="ghost" className="w-full text-white/80 hover:bg-white/10 sm:w-auto">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              View source on GitHub
              <ArrowUpRight data-icon="inline-end" aria-hidden />
            </a>
          </Button>
        </Reveal>

        <Reveal delay={0.24} className="mt-14 w-full max-w-2xl">
          <ul className="grid overflow-hidden rounded-2xl border border-white/10 bg-black/30 text-left backdrop-blur-xl sm:grid-cols-2">
            {PLATFORMS.map((p) => (
              <li key={p.name} className={cn('flex items-start gap-3 border-white/10 p-4 not-last:border-b sm:odd:border-r sm:nth-last-[-n+2]:border-b-0', !p.available && 'opacity-60')}>
                {p.name === 'Browser' ? (
                  <Globe className="mt-0.5 size-4 shrink-0 text-white/70" strokeWidth={1.75} aria-hidden />
                ) : (
                  <Laptop className="mt-0.5 size-4 shrink-0 text-white/70" strokeWidth={1.75} aria-hidden />
                )}
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {p.name}
                    {p.available ? (
                      <Check className="size-3.5 text-sun" aria-label="Available" />
                    ) : (
                      <Minus className="size-3.5 text-white/50" aria-label="Not available" />
                    )}
                  </span>
                  <span className="text-xs leading-relaxed text-white/55">{p.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-white/45">
            The macOS build isn’t notarized yet. The first time you open it, right-click GeoFlight in Applications and choose Open.
          </p>
        </Reveal>
      </div>
    </section>
  )
}
