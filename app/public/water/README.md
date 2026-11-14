# Great Lakes water surfaces

`great-lakes.json` contains simplified lake polygons (including island holes),
representative mean-sea-level elevations, and small EGM96 geoid grids used to
place curved water meshes in WGS84 coordinates. It covers Michigan, Huron,
Superior, Erie and Ontario, for every scenery provider.

Shorelines: Natural Earth **1:10m lakes**, downloaded November 10, 2026 from
[natural-earth-vector](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_lakes.geojson).
Natural Earth data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/).
The generalised shorelines are intended for flight-scale views; they do not
resolve every beach, harbour or small island. These meshes keep depth testing
enabled so higher terrain and buildings remain visible.

Representative elevations (metres MSL): Michigan/Huron 177, Superior 183.5,
Erie 174, Ontario 75. These are fixed visual levels, not live measurements.
See [NOAA GLERL's Great Lakes physical characteristics](https://apps.glerl.noaa.gov/coastwatch/webdata/statistic/physical.html)
for lake-level datums and seasonal ranges. EGM96 offsets come from the project's
bundled `data/geoid_1deg.bin`; a 0.75 m rendering clearance avoids coincident
provider water surfaces. Differences in provider elevations can still affect
the shoreline intersection.

Regenerate from the repository root:

```sh
curl -L https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson -o /tmp/ne_10m_lakes.geojson
node scripts/build_lakes.mjs /tmp/ne_10m_lakes.geojson
```

# Ocean and lake scenery

`shorelines.bin` contains Natural Earth 1:10m ocean, lake and reservoir
polygons, including island holes. The renderer uses them to give the interiors
of water bodies consistent lighting across imagery tiles and keeps the
scenery provider's finer detail at the shore. Coverage follows the Natural
Earth map, which is generalized at local scales.

Regenerate from the repository root with the lake source above and the
[Natural Earth ocean polygons](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-ocean/).

```sh
curl -L https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_ocean.geojson -o /tmp/ne_10m_ocean.geojson
node scripts/build_water_mask.mjs /tmp/ne_10m_ocean.geojson /tmp/ne_10m_lakes.geojson
```
