// Every photo on the site except the hero is an unedited frame captured inside
// GeoFlight (Ultra quality, Google Photorealistic 3D Tiles), resized and encoded.
import hero1280 from '@/assets/images/hero-1280.avif'
import hero1672 from '@/assets/images/hero-1672.avif'
import heroJpg from '@/assets/images/hero-1600.jpg'
import chicago1280 from '@/assets/images/chicago-1280.avif'
import chicago2560 from '@/assets/images/chicago-2560.avif'
import chicagoJpg from '@/assets/images/chicago-1600.jpg'
import newYork1280 from '@/assets/images/new-york-1280.avif'
import newYork2560 from '@/assets/images/new-york-2560.avif'
import newYorkJpg from '@/assets/images/new-york-1600.jpg'
import paris1280 from '@/assets/images/paris-1280.avif'
import paris2560 from '@/assets/images/paris-2560.avif'
import parisJpg from '@/assets/images/paris-1600.jpg'
import tokyo1280 from '@/assets/images/tokyo-1280.avif'
import tokyo2560 from '@/assets/images/tokyo-2560.avif'
import tokyoJpg from '@/assets/images/tokyo-1600.jpg'
import matterhorn1280 from '@/assets/images/matterhorn-1280.avif'
import matterhorn2560 from '@/assets/images/matterhorn-2560.avif'
import matterhornJpg from '@/assets/images/matterhorn-1600.jpg'
import sunset1280 from '@/assets/images/sunset-above-clouds-1280.avif'
import sunset2560 from '@/assets/images/sunset-above-clouds-2560.avif'
import sunsetJpg from '@/assets/images/sunset-above-clouds-1600.jpg'
import night1280 from '@/assets/images/night-above-clouds-1280.avif'
import night2560 from '@/assets/images/night-above-clouds-2560.avif'
import nightJpg from '@/assets/images/night-above-clouds-1600.jpg'
import channel1280 from '@/assets/images/english-channel-1280.avif'
import channel1736 from '@/assets/images/english-channel-1736.avif'
import channelJpg from '@/assets/images/english-channel-1736.jpg'

export type Photo = {
  /** AVIF candidates with their intrinsic widths. */
  avif: readonly { src: string; width: number }[]
  /** JPEG fallback for browsers without AVIF. */
  fallback: string
  width: number
  height: number
  alt: string
}

const capture = (small: string, large: string, fallback: string, alt: string): Photo => ({
  avif: [
    { src: small, width: 1280 },
    { src: large, width: 2560 },
  ],
  fallback,
  width: 2560,
  height: 1440,
  alt,
})

export const PHOTOS = {
  hero: {
    avif: [
      { src: hero1280, width: 1280 },
      { src: hero1672, width: 1672 },
    ],
    fallback: heroJpg,
    width: 1672,
    height: 940,
    alt: 'A twin-engine airliner climbing over snow-capped mountains and a river valley at sunset.',
  },
  chicago: capture(chicago1280, chicago2560, chicagoJpg, 'A 737 banks along the Chicago lakefront with the Loop skyline and Grant Park behind it.'),
  newYork: capture(newYork1280, newYork2560, newYorkJpg, 'An A320 flies up the Hudson River with Lower Manhattan on the right and Jersey City on the left.'),
  paris: capture(paris1280, paris2560, parisJpg, 'A Skyhawk approaches the Eiffel Tower over the Seine in late-afternoon light.'),
  tokyo: capture(tokyo1280, tokyo2560, tokyoJpg, 'An A380 banks over the Tokyo waterfront above a dense field of towers.'),
  matterhorn: capture(matterhorn1280, matterhorn2560, matterhornJpg, 'An F-16 flies toward the Matterhorn above a layer of cloud in the Swiss Alps.'),
  sunset: capture(sunset1280, sunset2560, sunsetJpg, 'An A380 cruising above a cloud deck as the sun sets on the horizon.'),
  night: capture(night1280, night2560, nightJpg, 'An A380 at night above moonlit clouds, cabin windows lit, stars overhead.'),
  channel: {
    avif: [
      { src: channel1280, width: 1280 },
      { src: channel1736, width: 1736 },
    ],
    fallback: channelJpg,
    width: 1736,
    height: 1126,
    alt: 'A four-engine airlifter cruising high above the English Channel, the coastline fading into haze below a bright sun.',
  },
} satisfies Record<string, Photo>

export type PhotoId = keyof typeof PHOTOS
