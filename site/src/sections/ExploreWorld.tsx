import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { Building2, CloudSun, Globe2, Mountain, SunMoon, type LucideIcon } from 'lucide-react'
import { Picture } from '@/components/Picture'
import { RevealGroup, RevealItem } from '@/components/Reveal'
import { SectionHeading } from '@/components/SectionHeading'
import { PHOTOS } from '@/content/images'

type Pillar = { icon: LucideIcon; title: string; body: string }

const PILLARS: readonly Pillar[] = [
  {
    icon: Globe2,
    title: 'Go anywhere',
    body: 'Start on a runway at any of ~9,600 real airports, on final approach, or drop in mid-air above any point on the globe.',
  },
  {
    icon: Mountain,
    title: 'Real terrain',
    body: 'Streamed elevation and imagery at true height. You land on the actual runway, rooftop or mountainside under your wheels.',
  },
  {
    icon: Building2,
    title: 'Cities in full 3D',
    body: 'Google Photorealistic 3D Tiles put real buildings and landmarks in more than 2,500 cities.',
  },
  {
    icon: SunMoon,
    title: 'Day and night',
    body: 'The sun and moon sit where they really are for today’s date, stars come out at dusk, and you can pick any hour.',
  },
  {
    icon: CloudSun,
    title: 'Living skies',
    body: 'Volumetric clouds drift with the wind and cast shadows. Turn on live weather for real cloud, rain, snow and wind.',
  },
]

export function ExploreWorld() {
  const imageRef = useRef<HTMLDivElement>(null)
  const still = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: imageRef, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], still ? ['0%', '0%'] : ['-7%', '7%'])

  return (
    <section id="explore" aria-labelledby="explore-title" className="relative py-28 sm:py-36">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeading id="explore-title" eyebrow="Explore the entire world" title="Every coastline. Every peak. Every city.">
          GeoFlight streams a geographically accurate Earth around you as you fly, so the view out the window is the real
          one, wherever you point the nose.
        </SectionHeading>

        <div className="mt-16 grid gap-10 lg:mt-20 lg:grid-cols-12 lg:gap-14">
          <div
            ref={imageRef}
            className="relative overflow-hidden rounded-3xl border border-white/10 lg:col-span-7 aspect-[4/3] lg:aspect-auto lg:min-h-[560px]"
          >
            <motion.div style={{ y }} className="absolute -inset-y-[8%] inset-x-0 will-change-transform">
              <Picture photo={PHOTOS.matterhorn} sizes="(min-width: 1024px) 58vw, 100vw" imgClassName="object-[50%_62%]" />
            </motion.div>
            <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />
            <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5 sm:p-6">
              <div>
                <p className="text-lg font-medium tracking-[-0.01em]">The Matterhorn</p>
                <p className="label-mono text-white/65">45.976° N 7.659° E · 16,000 ft</p>
              </div>
              <p className="label-mono rounded-full border border-white/20 bg-black/30 px-2.5 py-1 text-white/80 backdrop-blur-md">In-game</p>
            </div>
          </div>

          <RevealGroup as="ul" className="flex flex-col lg:col-span-5">
            {PILLARS.map((pillar, i) => (
              <RevealItem as="li" key={pillar.title} className="group grid grid-cols-[auto_1fr] gap-x-5 border-t border-white/10 py-6 first:border-t-0 first:pt-0 lg:first:pt-2">
                <span className="mt-0.5 font-mono text-xs text-white/40 tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <h3 className="flex items-center gap-2.5 text-lg font-medium tracking-[-0.01em]">
                    <pillar.icon className="size-[1.1rem] text-sun" aria-hidden strokeWidth={1.75} />
                    {pillar.title}
                  </h3>
                  <p className="mt-2 text-[0.95rem] leading-relaxed text-muted-foreground">{pillar.body}</p>
                </div>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>

        <p className="mt-12 max-w-3xl text-sm leading-relaxed text-white/45">
          Photorealistic 3D cities use your own Google Map Tiles API key (or a Cesium ion token), added in Settings. Without a
          key, the free Open data mode flies over real terrain and satellite imagery, with no 3D buildings.
        </p>
      </div>
    </section>
  )
}
