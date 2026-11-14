// Mirrors the aircraft defined in app/crates/sim-core/src/aircraft.rs.
// Names, categories, descriptions and cruise figures come from that file.
import c172 from '@/assets/images/aircraft/c172.avif'
import c172Png from '@/assets/images/aircraft/c172.png'
import bizjet from '@/assets/images/aircraft/bizjet.avif'
import bizjetPng from '@/assets/images/aircraft/bizjet.png'
import longitude from '@/assets/images/aircraft/longitude.avif'
import longitudePng from '@/assets/images/aircraft/longitude.png'
import a320 from '@/assets/images/aircraft/a320.avif'
import a320Png from '@/assets/images/aircraft/a320.png'
import b737 from '@/assets/images/aircraft/b737.avif'
import b737Png from '@/assets/images/aircraft/b737.png'
import a380 from '@/assets/images/aircraft/a380.avif'
import a380Png from '@/assets/images/aircraft/a380.png'
import c17 from '@/assets/images/aircraft/c17.avif'
import c17Png from '@/assets/images/aircraft/c17.png'
import c5m from '@/assets/images/aircraft/c5m.avif'
import c5mPng from '@/assets/images/aircraft/c5m.png'
import f16 from '@/assets/images/aircraft/f16.avif'
import f16Png from '@/assets/images/aircraft/f16.png'

export type Aircraft = {
  id: string
  name: string
  category: string
  description: string
  /** Typical cruise, indicated airspeed (kt). */
  cruiseKt: number
  /** Typical cruise altitude (ft). */
  cruiseAltFt: number
  image: { avif: string; png: string }
}

export const AIRCRAFT: readonly Aircraft[] = [
  {
    id: 'c172',
    name: 'Skyhawk style',
    category: 'General aviation',
    description: 'The classic four-seat trainer. Slow, gentle and perfect for low-level sightseeing.',
    cruiseKt: 115,
    cruiseAltFt: 5_500,
    image: { avif: c172, png: c172Png },
  },
  {
    id: 'b737',
    name: '737-800 style',
    category: 'Commercial airliner',
    description: 'Twin-engine narrowbody workhorse. Heavy, stable and fast; plan your descents early. Comes with a full NG-style flight deck.',
    cruiseKt: 290,
    cruiseAltFt: 35_000,
    image: { avif: b737, png: b737Png },
  },
  {
    id: 'a320',
    name: 'A320neo style',
    category: 'Commercial airliner',
    description: 'Modern fly-by-wire narrowbody with a wide, comfortable flight envelope.',
    cruiseKt: 280,
    cruiseAltFt: 36_000,
    image: { avif: a320, png: a320Png },
  },
  {
    id: 'a380',
    name: 'Airbus A380-800',
    category: 'Commercial airliner',
    description: 'Full-length double-decker with four turbofans and slow, steady handling.',
    cruiseKt: 290,
    cruiseAltFt: 37_000,
    image: { avif: a380, png: a380Png },
  },
  {
    id: 'bizjet',
    name: 'Midsize business jet',
    category: 'Business jet',
    description: 'Light, quick and high-flying. Climbs like a rocket and turns crisply.',
    cruiseKt: 300,
    cruiseAltFt: 41_000,
    image: { avif: bizjet, png: bizjetPng },
  },
  {
    id: 'longitude',
    name: 'Longitude style',
    category: 'Business jet',
    description: 'Long-range super-midsize twin with a T-tail. Cruises near Mach 0.84 at FL410 and handles like a lighter jet.',
    cruiseKt: 250,
    cruiseAltFt: 41_000,
    image: { avif: longitude, png: longitudePng },
  },
  {
    id: 'f16',
    name: 'F-16C style',
    category: 'Fighter jet',
    description: 'Fly-by-wire fighter: 9 g, 280°/s rolls and Mach 2 at altitude. Push the throttle past 80% to light the afterburner.',
    cruiseKt: 350,
    cruiseAltFt: 30_000,
    image: { avif: f16, png: f16Png },
  },
  {
    id: 'c17',
    name: 'Boeing C-17 Globemaster III',
    category: 'Military airlifter',
    description: 'Strategic and tactical transport with high-lift wings for short, austere airfields.',
    cruiseKt: 282,
    cruiseAltFt: 33_000,
    image: { avif: c17, png: c17Png },
  },
  {
    id: 'c5m',
    name: 'C-5M Super Galaxy',
    category: 'Military airlifter',
    description: 'Heavy strategic transport with a lifting nose and a rear ramp for drive-through loading.',
    cruiseKt: 275,
    cruiseAltFt: 33_000,
    image: { avif: c5m, png: c5mPng },
  },
]
