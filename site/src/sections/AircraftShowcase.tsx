import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from '@/components/ui/carousel'
import { Reveal } from '@/components/Reveal'
import { SectionHeading } from '@/components/SectionHeading'
import { AIRCRAFT, type Aircraft } from '@/content/aircraft'

const formatAlt = (ft: number) => (ft >= 18_000 ? `FL${Math.round(ft / 100)}` : `${ft.toLocaleString('en-US')} ft`)

function AircraftCard({ aircraft }: { aircraft: Aircraft }) {
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01]">
      <div className="relative aspect-[16/10] overflow-hidden bg-[radial-gradient(70%_60%_at_50%_58%,oklch(0.3_0.03_250/0.9),transparent_75%)]">
        <div aria-hidden className="absolute inset-x-[18%] bottom-[16%] h-6 rounded-[50%] bg-black/50 blur-xl" />
        <picture>
          <source type="image/avif" srcSet={aircraft.image.avif} />
          <img
            src={aircraft.image.png}
            alt={`${aircraft.name}, rendered from the simulator’s own 3D model`}
            width={1200}
            height={750}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="relative size-full object-contain p-4 transition-transform duration-700 ease-out-expo [@media(hover:hover)]:group-hover:-translate-y-1.5 [@media(hover:hover)]:group-hover:scale-[1.03]"
          />
        </picture>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-6 pt-5">
        <Badge variant="outline" className="label-mono h-6 rounded-full border-white/15 px-2.5 text-[0.65rem] text-white/65">
          {aircraft.category}
        </Badge>
        <h3 className="text-xl font-medium tracking-[-0.02em]">{aircraft.name}</h3>
        <p className="text-[0.95rem] leading-relaxed text-muted-foreground">{aircraft.description}</p>
        <dl className="mt-auto grid grid-cols-2 gap-4 border-t border-white/10 pt-4">
          <div>
            <dt className="label-mono text-white/40">Cruise</dt>
            <dd className="mt-1 font-mono text-sm tabular-nums">{aircraft.cruiseKt} kt</dd>
          </div>
          <div>
            <dt className="label-mono text-white/40">Altitude</dt>
            <dd className="mt-1 font-mono text-sm tabular-nums">{formatAlt(aircraft.cruiseAltFt)}</dd>
          </div>
        </dl>
      </div>
    </article>
  )
}

export function AircraftShowcase() {
  const [api, setApi] = useState<CarouselApi>()
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!api) return
    const update = () => setIndex(api.selectedScrollSnap())
    update()
    api.on('select', update).on('reInit', update)
    return () => {
      api.off('select', update).off('reInit', update)
    }
  }, [api])
  const total = AIRCRAFT.length
  // With trimmed snaps, every card past the last snap is already in view.
  const perView = api ? total - api.scrollSnapList().length + 1 : 1
  const pad = (n: number) => String(n).padStart(2, '0')
  const first = index + 1
  const last = Math.min(total, index + perView)

  return (
    <section id="aircraft" aria-labelledby="aircraft-title" className="relative overflow-hidden py-28 sm:py-36">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeading id="aircraft-title" eyebrow="The hangar" title="Nine aircraft. One sky.">
          From a four-seat trainer to the world’s largest airliner, a business jet and an F-16. Each one has its own
          weight, performance and handling, and its own painted liveries.
        </SectionHeading>

        <Reveal className="mt-14 sm:mt-16">
          <Carousel setApi={setApi} opts={{ align: 'start', containScroll: 'trimSnaps' }} aria-label="Aircraft">
            <CarouselContent className="-ml-4 sm:-ml-5">
              {AIRCRAFT.map((a) => (
                <CarouselItem key={a.id} className="basis-[86%] pl-4 sm:basis-1/2 sm:pl-5 lg:basis-1/3">
                  <AircraftCard aircraft={a} />
                </CarouselItem>
              ))}
            </CarouselContent>
            <div className="mt-8 flex items-center justify-between">
              <p className="font-mono text-sm text-white/50 tabular-nums" aria-live="polite">
                <span className="text-white">{first === last ? pad(first) : `${pad(first)}–${pad(last)}`}</span> of {pad(total)}
              </p>
              <div className="flex gap-2">
                <CarouselPrevious className="static inset-auto my-0 size-11 translate-y-0 border-white/15 bg-white/5 hover:bg-white/10" />
                <CarouselNext className="static inset-auto my-0 size-11 translate-y-0 border-white/15 bg-white/5 hover:bg-white/10" />
              </div>
            </div>
          </Carousel>
        </Reveal>
      </div>
    </section>
  )
}
