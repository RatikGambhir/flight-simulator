# Dataset scripts

The bundled datasets in `data/` are generated from public-domain sources and committed,
so you only need these scripts to refresh them.

| Output | Script | Inputs |
| --- | --- | --- |
| `data/airports.tsv`, `data/runways.tsv`, `data/places.tsv` | `python3 scripts/build_data.py <dir>` | `<dir>` containing OurAirports `airports.csv`, `runways.csv`, `countries.csv` and Natural Earth `ne_10m_populated_places_simple.geojson` saved as `places.geojson` |
| `data/geoid_1deg.bin` | `node scripts/build_geoid.mjs <egm96-universal esm file>` | `npm pack egm96-universal`, then point at `package/dist/egm96-universal.esm.js` (needs `rfc4648` installed next to it) |
| `src/assets/world-land.json` | `python3 scripts/build_worldmap.py ne_50m_land.geojson` | Natural Earth 1:50m land GeoJSON |
| `public/clouds/stbn.bin` | `node scripts/build_stbn.mjs` | — |
| `public/sim/sim.wasm` | `npm run build:wasm` | — (browser dev mode only) |

Sources:

* OurAirports: https://github.com/davidmegginson/ourairports-data
* Natural Earth: https://github.com/nvkelso/natural-earth-vector (`geojson/`)
