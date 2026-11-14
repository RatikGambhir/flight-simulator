import { useState } from 'react'
import { Cloud, Plane, Sparkles, Sunrise, type LucideIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Picture } from '@/components/Picture'
import { Reveal, RevealGroup, RevealItem } from '@/components/Reveal'
import { SectionHeading } from '@/components/SectionHeading'
import { PHOTOS, type PhotoId } from '@/content/images'
import { cn } from '@/lib/utils'

type Moment = {
  id: string
  label: string
  /** Small label above the title. */
  eyebrow: string
  /** Crop anchor when the photo's aspect differs from the stage. */
  focus?: string
  photo: PhotoId
  title: string
  body: string
}

const MOMENTS: readonly Moment[] = [
  {
    id: 'long-haul',
    label: 'Long haul',
    eyebrow: 'Cruise altitude',
    photo: 'channel',
    focus: 'object-[50%_12%]',
    title: 'Long haul over the English Channel',
    body: 'Physically based atmospheric scattering colors the sky, the haze and the light on your wings. From cruise altitude the coastline fades into blue and the horizon curves away.',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    eyebrow: 'Local solar time 16:33',
    photo: 'sunset',
    title: 'Golden hour above the deck',
    body: 'Volumetric clouds are lit from within as the sun sinks, and exposure adapts the way your eyes would, so a sunset glows instead of going grey.',
  },
  {
    id: 'night',
    label: 'Night',
    eyebrow: 'Local solar time 17:36',
    photo: 'night',
    title: 'Moonlight and a sky full of stars',
    body: 'Stars keep their real positions and brightness and fade in through twilight. The moon shows today’s phase, and your nav lights, strobes and cabin windows glow.',
  },
]

type Spec = { icon: LucideIcon; title: string; body: string }

const SPECS: readonly Spec[] = [
  { icon: Sunrise, title: 'Real sky physics', body: 'Precomputed atmospheric scattering for sky, sun and aerial perspective.' },
  { icon: Cloud, title: 'Volumetric clouds', body: 'Weather-driven layers that drift with the wind and shade the ground.' },
  { icon: Plane, title: 'Living aircraft', body: 'Hinged flaps, ailerons and spoilers, spinning fans, retracting gear.' },
  { icon: Sparkles, title: 'Cinematic finish', body: 'AgX tone mapping, lens flare and smooth anti-aliasing on every frame.' },
]

export function ImmersiveExperience() {
  const [active, setActive] = useState(MOMENTS[0].id)

  return (
    <section aria-labelledby="immersive-title" className="relative py-28 sm:py-36">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeading id="immersive-title" eyebrow="Immersive flight experience" title="From first light to starlight.">
          Fly with the real sun and moon for today’s date, or pick any hour. Every scene is lit by the same physically
          based sky.
        </SectionHeading>

        <Reveal className="mt-14 sm:mt-16">
          <Tabs value={active} onValueChange={setActive} className="gap-0">
            <div className="relative">
            <div className="relative isolate aspect-[4/3] overflow-hidden rounded-3xl border border-white/10 bg-card sm:aspect-[16/9]">
              {MOMENTS.map((m) => {
                const on = m.id === active
                return (
                  <div
                    key={m.id}
                    aria-hidden={!on}
                    className={cn(
                      'absolute inset-0 -z-10 transition-[opacity,transform] duration-[900ms] ease-out-expo',
                      on ? 'scale-100 opacity-100' : 'scale-[1.03] opacity-0',
                    )}
                  >
                    <Picture photo={PHOTOS[m.photo]} sizes="(min-width: 1152px) 1100px, 100vw" imgClassName={m.focus} />
                  </div>
                )
              })}
              <div aria-hidden className="absolute inset-0 -z-10 hidden bg-gradient-to-t from-black/70 via-black/10 to-transparent sm:block" />
            </div>

              {/* Phones: tabs then copy below the photo. Larger screens: overlaid on it. */}
              <div className="mt-4 flex flex-col-reverse gap-5 sm:absolute sm:inset-x-5 sm:bottom-5 sm:mt-0 sm:flex-col sm:gap-4 lg:flex-row lg:items-end lg:justify-between">
                {MOMENTS.map((m) => (
                  <TabsContent key={m.id} value={m.id} className="max-w-md px-1 pb-1 sm:px-2 data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:slide-in-from-bottom-1 data-[state=active]:duration-500">
                    <p className="label-mono text-white/60">{m.eyebrow}</p>
                    <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">{m.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-white/75 sm:text-[0.95rem]">{m.body}</p>
                  </TabsContent>
                ))}
                <TabsList
                  aria-label="Time of day"
                  className="h-auto w-full shrink-0 gap-1 rounded-full border border-white/15 bg-black/35 p-1 backdrop-blur-xl lg:w-auto"
                >
                  {MOMENTS.map((m) => (
                    <TabsTrigger
                      key={m.id}
                      value={m.id}
                      className="h-10 min-w-24 rounded-full px-4 text-sm text-white/65 hover:text-white dark:text-white/65 dark:hover:text-white data-active:border-transparent data-active:bg-white data-active:text-black data-active:hover:text-black dark:data-active:border-transparent dark:data-active:bg-white dark:data-active:text-black dark:data-active:hover:text-black"
                    >
                      {m.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </div>
          </Tabs>
        </Reveal>

        <RevealGroup as="ul" className="mt-6 grid gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
          {SPECS.map((spec) => (
            <RevealItem as="li" key={spec.title} className="flex flex-col gap-3 bg-background p-6">
              <spec.icon className="size-5 text-sun" strokeWidth={1.75} aria-hidden />
              <h3 className="text-base font-medium tracking-[-0.01em]">{spec.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{spec.body}</p>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  )
}
