import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useInView, useReducedMotion } from 'motion/react'
import { Camera, Gamepad2, Navigation, PlaneLanding, PlaneTakeoff, ShieldCheck, type LucideIcon } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RevealGroup, RevealItem } from '@/components/Reveal'
import { SectionHeading } from '@/components/SectionHeading'
import { cn } from '@/lib/utils'

/** The autopilot's own phase names, as shown on the in-game HUD. */
const PHASES = ['Takeoff', 'Climb', 'Cruise', 'Descent', 'Approach', 'Flare', 'Landed']

function AutopilotPreview() {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useInView(ref, { margin: '-20% 0px' })
  const still = useReducedMotion()
  const [active, setActive] = useState(2)
  useEffect(() => {
    if (!visible || still) return
    const id = window.setInterval(() => setActive((i) => (i + 1) % PHASES.length), 1400)
    return () => window.clearInterval(id)
  }, [visible, still])

  return (
    <div ref={ref} className="rounded-2xl border border-white/10 bg-black/30 p-4">
      <div className="mb-4 flex items-center justify-between">
        <span className="label-mono text-white/45">Autopilot</span>
        <span className="label-mono flex items-center gap-1.5 text-sun">
          <span className="size-1.5 rounded-full bg-sun" aria-hidden />
          CMD
        </span>
      </div>
      <ol className="flex flex-wrap gap-1.5 sm:grid sm:grid-cols-7" aria-label="Autopilot flight phases">
        {PHASES.map((phase, i) => (
          <li
            key={phase}
            aria-current={i === active ? 'step' : undefined}
            className="relative overflow-hidden rounded-md border border-white/10 px-2.5 py-2 text-center font-mono text-[0.62rem] tracking-[0.06em] uppercase sm:px-1.5"
          >
            {i === active ? (
              <motion.span
                layoutId="ap-phase"
                className="absolute inset-0 bg-sun/15 ring-1 ring-sun/50 ring-inset"
                transition={{ type: 'spring', stiffness: 380, damping: 34 }}
              />
            ) : null}
            <span className={cn('relative transition-colors duration-300', i === active ? 'text-sun' : 'text-white/45')}>{phase}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function Key({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-9 min-w-9 items-center justify-center rounded-lg border border-white/15 border-b-white/5 bg-gradient-to-b from-white/10 to-white/[0.03] px-2 font-mono text-xs text-white/85 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_2px_0_rgb(0_0_0/0.4)]',
        wide && 'px-3',
      )}
    >
      {children}
    </kbd>
  )
}

function ControlsPreview() {
  const rows = [
    { keys: ['W', 'S'], label: 'Pitch' },
    { keys: ['A', 'D'], label: 'Roll' },
    { keys: ['R', 'F'], label: 'Throttle' },
    { keys: ['G'], label: 'Gear' },
    { keys: ['Z'], label: 'Autopilot' },
  ]
  return (
    <dl className="grid grid-cols-1 gap-2.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3">
          <dt className="text-sm text-white/55">{row.label}</dt>
          <dd className="flex gap-1.5">
            {row.keys.map((k) => (
              <Key key={k}>{k}</Key>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function RoutePreview() {
  return (
    <div className="relative rounded-2xl border border-white/10 bg-black/30 p-4">
      <svg viewBox="0 0 280 96" className="h-24 w-full" role="img" aria-label="A great-circle route between two airports">
        <defs>
          <linearGradient id="route" x1="0" x2="1">
            <stop offset="0" stopColor="white" stopOpacity="0.25" />
            <stop offset="1" stopColor="var(--sun)" />
          </linearGradient>
        </defs>
        <path d="M18 78 C 90 6, 190 6, 262 60" fill="none" stroke="url(#route)" strokeWidth="1.5" strokeDasharray="3 5" />
        <circle cx="18" cy="78" r="3.5" fill="white" />
        <circle cx="262" cy="60" r="3.5" fill="var(--sun)" />
        <circle cx="262" cy="60" r="9" fill="none" stroke="var(--sun)" strokeOpacity="0.35" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-xs tabular-nums">
        <span className="text-white/70">KORD</span>
        <span className="text-white/40">Great circle</span>
        <span className="text-sun">KMKE</span>
      </div>
    </div>
  )
}

const CAMERAS = ['Exterior', 'Cockpit', 'Wing', 'Free look', 'Cinematic', 'Flyby']

type Feature = {
  icon: LucideIcon
  title: string
  body: string
  preview?: ReactNode
  /** wide: two columns; full: the whole row, with the preview beside the copy. */
  span?: 'wide' | 'full'
}

const SPAN_CLASS = {
  wide: 'sm:col-span-2',
  full: 'sm:col-span-2 lg:col-span-3',
} as const

const FEATURES: readonly Feature[] = [
  {
    icon: PlaneLanding,
    title: 'An autopilot that flies the whole trip',
    body: 'Choose a destination and press Z. It taxis, takes off, climbs, cruises the great circle, descends and lands, picking a runway from the wind. If an approach isn’t stable, it goes around and tries again.',
    preview: <AutopilotPreview />,
    span: 'wide',
  },
  {
    icon: Gamepad2,
    title: 'One set of controls',
    body: 'The same keys fly every aircraft, and a tap is a small correction. Gamepads work too.',
    preview: <ControlsPreview />,
  },
  {
    icon: PlaneTakeoff,
    title: 'Takeoffs and landings',
    body: 'Line up on a real runway, rotate at the speed on your aircraft card, and flare into ground effect. Every touchdown gets a rating.',
  },
  {
    icon: Navigation,
    title: 'Fly somewhere',
    body: 'Search for an arrival airport, follow its bearing on the compass, watch your progress on the live route map, or skip ahead to any distance out.',
    preview: <RoutePreview />,
  },
  {
    icon: ShieldCheck,
    title: 'Help when you want it',
    body: 'Assisted flight holds your path, levels the wings and protects against stalls. Switch to Direct for the unfiltered airplane.',
  },
  {
    icon: Camera,
    title: 'Six ways to watch',
    body: 'Jump between cameras at any moment, or drag to orbit and look around the cockpit.',
    preview: (
      <ul className="flex flex-wrap gap-1.5">
        {CAMERAS.map((cam, i) => (
          <li key={cam} className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] py-1 pr-3 pl-1.5 text-sm text-white/70">
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-white/10 font-mono text-[0.65rem]">{i + 1}</span>
            {cam}
          </li>
        ))}
      </ul>
    ),
    span: 'full',
  },
]

export function JoyOfFlying() {
  return (
    <section id="features" aria-labelledby="features-title" className="relative py-28 sm:py-36">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeading id="features-title" eyebrow="Built for the joy of flying" title="Easy to pick up. Hard to put down.">
          Real flight physics under a control scheme you learn in a minute. Hand the hard parts to the autopilot, or fly
          every mile yourself.
        </SectionHeading>

        <RevealGroup className="mt-14 grid gap-4 sm:mt-16 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <RevealItem key={feature.title} className={cn('flex', feature.span && SPAN_CLASS[feature.span])}>
              <Card
                className={cn(
                  'flex w-full flex-col gap-6 rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.015] py-7 ring-0',
                  feature.span === 'full' && 'lg:flex-row lg:items-center',
                )}
              >
                <CardHeader className={cn('content-start gap-3 px-7', feature.span === 'full' && 'lg:flex-1')}>
                  <span className="mb-1 inline-flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
                    <feature.icon className="size-5 text-sun" strokeWidth={1.75} aria-hidden />
                  </span>
                  <CardTitle className="text-xl font-medium tracking-[-0.02em]">{feature.title}</CardTitle>
                  <CardDescription className="max-w-[52ch] text-[0.95rem] leading-relaxed">{feature.body}</CardDescription>
                </CardHeader>
                {feature.preview ? (
                  <CardContent className={cn('mt-auto px-7', feature.span === 'full' && 'lg:mt-0 lg:flex-1')}>{feature.preview}</CardContent>
                ) : null}
              </Card>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  )
}
