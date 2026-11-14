# GeoFlight website

The public landing page for GeoFlight. A standalone Vite app, independent of the simulator in `../app`.

**Stack:** React 19, TypeScript (strict), Tailwind CSS 4, shadcn/ui (Radix, Nova preset), Lucide icons and Motion.

```bash
npm install
```

```bash
npm run dev
```

Opens on http://localhost:5180. `npm run build` type-checks and writes a static site to `dist/`; `npm run lint` runs oxlint.

## Layout

```
src/
  sections/      One file per page section (Hero, ExploreWorld, CityShowcase, JoyOfFlying,
                 ImmersiveExperience, AircraftShowcase, FinalCta)
  components/    Site chrome and shared pieces (nav, footer, Picture, Reveal, SectionHeading)
  components/ui/ shadcn/ui primitives (add more with `npx shadcn@latest add <name>`)
  content/       Typed data: photos and the aircraft list (mirrors app/crates/sim-core/src/aircraft.rs)
  lib/           Links, motion constants and utilities
  assets/images/ AVIF images (1280 and 2560 wide) with JPEG fallbacks
```

## Images

Except for the hero, every photo is an unedited frame captured inside the simulator at Ultra quality
with Google Photorealistic 3D Tiles, then resized and encoded. Aircraft portraits are rendered from the
simulator's own procedural models. When adding a capture, export AVIF at 1280 and 2560 px wide (even
pixel dimensions) plus a 1600 px JPEG, and register it in `src/content/images.ts`.

## Links

Download buttons resolve the newest `.dmg` from the GitHub Releases API at page load
(`src/lib/latest-release.ts`), falling back to the latest-release page. The simulator's CI
(`.github/workflows/build-macos.yml`) publishes each release as a universal macOS `.dmg`. Platform
availability is listed in `src/lib/site.ts`; only add a platform there once a real build exists.
