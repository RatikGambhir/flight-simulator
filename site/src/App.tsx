import { MotionConfig } from 'motion/react'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteNav } from '@/components/SiteNav'
import { AircraftShowcase } from '@/sections/AircraftShowcase'
import { CityShowcase } from '@/sections/CityShowcase'
import { ExploreWorld } from '@/sections/ExploreWorld'
import { FinalCta } from '@/sections/FinalCta'
import { Hero } from '@/sections/Hero'
import { ImmersiveExperience } from '@/sections/ImmersiveExperience'
import { JoyOfFlying } from '@/sections/JoyOfFlying'

export default function App() {
  return (
    // "user": honour prefers-reduced-motion everywhere (transforms off, fades kept).
    <MotionConfig reducedMotion="user">
      <a
        href="#main"
        className="fixed top-3 left-3 z-[60] -translate-y-20 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>
      <SiteNav />
      <main id="main">
        <Hero />
        <ExploreWorld />
        <CityShowcase />
        <JoyOfFlying />
        <ImmersiveExperience />
        <AircraftShowcase />
        <FinalCta />
      </main>
      <SiteFooter />
    </MotionConfig>
  )
}
