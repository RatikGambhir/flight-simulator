import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { ArrowDownToLine, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Picture } from '@/components/Picture'
import { EASE_OUT } from '@/lib/motion'
import { PHOTOS } from '@/content/images'
import { DOWNLOAD_URL } from '@/lib/site'

const HEADLINE = ['The world', 'is yours', 'to explore.']

const STATS = [
  { value: '~9,600', label: 'real airports' },
  { value: '9', label: 'aircraft to fly' },
  { value: '2,500+', label: 'cities in 3D' },
  { value: '120 Hz', label: 'flight physics' },
]

const intro = (delay: number) => ({
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.9, ease: EASE_OUT, delay },
})

export function Hero() {
  const ref = useRef<HTMLElement>(null)
  const still = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] })
  // Image drifts down slower than the page; copy lifts and fades as you leave.
  const imageY = useTransform(scrollYProgress, [0, 1], ['0%', still ? '0%' : '16%'])
  const imageScale = useTransform(scrollYProgress, [0, 1], [1.04, still ? 1.04 : 1.12])
  const copyY = useTransform(scrollYProgress, [0, 0.7], ['0%', still ? '0%' : '-14%'])
  const copyOpacity = useTransform(scrollYProgress, [0, 0.55], [1, 0])

  return (
    <section ref={ref} id="top" aria-labelledby="hero-title" className="relative isolate flex min-h-[640px] items-end overflow-hidden h-svh">
      <motion.div
        className="absolute inset-x-0 -top-[14%] bottom-0 -z-20 will-change-transform"
        style={{ y: imageY, scale: imageScale }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.4, ease: EASE_OUT }}
      >
        <Picture photo={PHOTOS.hero} sizes="100vw" priority imgClassName="object-[62%_center]" />
      </motion.div>

      {/* Legibility: a low horizon fade into the page, plus a soft vignette behind the copy. */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-background/35 to-transparent" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(120%_80%_at_0%_100%,oklch(0.13_0.012_260/0.85),transparent_60%)]" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-r from-[oklch(0.13_0.012_260/0.55)] via-[oklch(0.13_0.012_260/0.12)] via-45% to-transparent" />
      <div aria-hidden className="hero-glow absolute -z-10 h-[60vmax] w-[60vmax] rounded-full" />

      <motion.div style={{ y: copyY, opacity: copyOpacity }} className="mx-auto w-full max-w-6xl px-5 pb-10 sm:px-8 sm:pb-14">
        <motion.p {...intro(0.25)} className="label-mono mb-5 flex items-center gap-2 text-white/80">
          <span className="inline-block size-1.5 rounded-full bg-sun" aria-hidden />
          Flight simulator for macOS
        </motion.p>

        <h1 id="hero-title" className="text-[clamp(3rem,7.2vw,6.25rem)] leading-[0.94] font-semibold tracking-[-0.045em]">
          {HEADLINE.map((line, i) => (
            <span key={line} className="block overflow-hidden pb-[0.06em]">
              <motion.span
                className="block"
                initial={{ y: '105%' }}
                animate={{ y: '0%' }}
                transition={{ duration: 1.1, ease: EASE_OUT, delay: 0.35 + i * 0.1 }}
              >
                {line}
              </motion.span>
            </span>
          ))}
        </h1>

        <motion.p {...intro(0.7)} className="mt-6 max-w-[42ch] text-base leading-relaxed text-white/80 sm:text-lg">
          Take off from any of thousands of real airports and fly over a photorealistic, geographically accurate Earth,
          from city skylines to mountain ranges, at any hour of the day.
        </motion.p>

        <motion.div {...intro(0.82)} className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="xl" className="shadow-[0_8px_30px_-8px_oklch(0.83_0.12_72/0.5)]">
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
              <ArrowDownToLine data-icon="inline-start" aria-hidden />
              Download Simulator
            </a>
          </Button>
          <Button asChild size="xl" variant="outline" className="border-white/20 bg-white/5 backdrop-blur-md hover:bg-white/10">
            <a href="#features">
              Explore Features
              <ArrowRight data-icon="inline-end" aria-hidden className="transition-transform duration-300 ease-out-expo group-hover/button:translate-x-0.5" />
            </a>
          </Button>
        </motion.div>

        <motion.dl
          {...intro(1)}
          className="mt-12 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-white/15 pt-6 sm:grid-cols-4 sm:gap-x-10"
        >
          {STATS.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-1">
              <dt className="order-2 label-mono text-white/55">{stat.label}</dt>
              <dd className="order-1 font-mono text-xl font-medium tabular-nums tracking-[-0.02em] sm:text-2xl">{stat.value}</dd>
            </div>
          ))}
        </motion.dl>
      </motion.div>
    </section>
  )
}
