import { motion } from 'motion/react'
import { Camera } from 'lucide-react'
import { Picture } from '@/components/Picture'
import { EASE_OUT } from '@/lib/motion'
import { SectionHeading } from '@/components/SectionHeading'
import { PHOTOS, type PhotoId } from '@/content/images'
import { cn } from '@/lib/utils'

type City = {
  name: string
  place: string
  coords: string
  flight: string
  photo: PhotoId
  /** Where the subject sits in the frame, so every crop keeps it. */
  focus: string
  sizes: string
  className: string
  titleClassName?: string
}

const CITIES: readonly City[] = [
  {
    name: 'Paris',
    place: 'Île-de-France, France',
    coords: '48.858° N 2.294° E',
    flight: 'Skyhawk · 950 ft',
    photo: 'paris',
    focus: 'object-[52%_50%]',
    sizes: '(min-width: 1024px) 58vw, 100vw',
    className: 'aspect-[4/5] sm:col-span-2 sm:aspect-[16/10] lg:col-span-7 lg:row-span-2 lg:aspect-auto',
    titleClassName: 'sm:text-5xl',
  },
  {
    name: 'Chicago',
    place: 'Lake Michigan, Illinois',
    coords: '41.866° N 87.598° W',
    flight: '737 · 1,500 ft',
    photo: 'chicago',
    focus: 'object-[30%_50%]',
    sizes: '(min-width: 1024px) 40vw, (min-width: 640px) 50vw, 100vw',
    className: 'aspect-[4/3] lg:col-span-5 lg:aspect-auto',
  },
  {
    name: 'Tokyo',
    place: 'Minato, Japan',
    coords: '35.636° N 139.772° E',
    flight: 'A380 · 1,700 ft',
    photo: 'tokyo',
    focus: 'object-[45%_60%]',
    sizes: '(min-width: 1024px) 40vw, (min-width: 640px) 50vw, 100vw',
    className: 'aspect-[4/3] lg:col-span-5 lg:aspect-auto',
  },
  {
    name: 'New York City',
    place: 'Hudson River, Manhattan',
    coords: '40.694° N 74.036° W',
    flight: 'A320 · 1,100 ft',
    photo: 'newYork',
    focus: 'object-[50%_42%]',
    sizes: '100vw',
    className: 'aspect-[4/3] sm:col-span-2 sm:aspect-[21/9] lg:col-span-12 lg:aspect-[21/8]',
    titleClassName: 'sm:text-5xl',
  },
]

function CityCard({ city, index }: { city: City; index: number }) {
  return (
    <motion.figure
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -10% 0px' }}
      transition={{ duration: 0.9, ease: EASE_OUT, delay: (index % 3) * 0.08 }}
      className={cn(
        'group relative isolate overflow-hidden rounded-3xl border border-white/10 bg-card',
        'shadow-[0_30px_80px_-40px_rgb(0_0_0/0.8)]',
        city.className,
      )}
    >
      <div className="absolute inset-0 -z-10 transition-transform duration-[1.4s] ease-out-expo [@media(hover:hover)]:group-hover:scale-[1.045]">
        <Picture photo={PHOTOS[city.photo]} sizes={city.sizes} imgClassName={city.focus} />
      </div>
      {/* Atmosphere: a low dusk fade for the caption, a faint top fade for the chip. */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-t from-[oklch(0.1_0.02_260/0.85)] via-[oklch(0.1_0.02_260/0.15)] via-45% to-transparent" />
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-24 bg-gradient-to-b from-black/35 to-transparent" />

      <div className="absolute top-4 right-4 left-4 flex items-start justify-between gap-3 sm:top-5 sm:right-5 sm:left-5">
        <span className="label-mono text-white/70">{String(index + 1).padStart(2, '0')}</span>
        <span className="label-mono rounded-full border border-white/15 bg-black/30 px-2.5 py-1 text-white/80 backdrop-blur-md">
          {city.flight}
        </span>
      </div>

      <figcaption className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 p-5 sm:p-7">
        <span className="label-mono text-white/60">{city.place}</span>
        <span className={cn('text-3xl font-semibold tracking-[-0.035em]', city.titleClassName)}>{city.name}</span>
        <span className="font-mono text-xs text-white/50 tabular-nums transition-colors duration-500 group-hover:text-white/75">
          {city.coords}
        </span>
      </figcaption>
    </motion.figure>
  )
}

export function CityShowcase() {
  return (
    <section id="gallery" aria-labelledby="gallery-title" className="relative py-28 sm:py-36">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <SectionHeading id="gallery-title" eyebrow="City showcase" title="Fly the skylines you know by heart.">
            Every frame here was captured inside GeoFlight at Ultra quality: no renders, no retouching. Just the simulator,
            a camera angle and the right time of day.
          </SectionHeading>
          <p className="label-mono flex shrink-0 items-center gap-2 text-white/50">
            <Camera className="size-3.5" aria-hidden />
            Real in-game captures
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:mt-16 lg:grid-cols-12 lg:grid-rows-[300px_300px]">
          {CITIES.map((city, i) => (
            <CityCard key={city.name} city={city} index={i} />
          ))}
        </div>

        <p className="mt-6 text-xs text-white/40">
          Scenery: Google Photorealistic 3D Tiles. Imagery © Google and its data providers.
        </p>
      </div>
    </section>
  )
}
