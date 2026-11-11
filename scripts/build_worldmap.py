#!/usr/bin/env python3
"""Converts Natural Earth 1:50m land polygons (public domain) into a compact
SVG path (equirectangular, 360x180 viewBox) for the location picker map.
Usage: python3 scripts/build_worldmap.py ne_50m_land.geojson"""
import json, sys, os
gj = json.load(open(sys.argv[1]))
parts = []
def ring(coords):
    pts = []
    last = None
    for lon, lat in coords:
        p = (round(lon + 180, 1), round(90 - lat, 1))
        if p != last:
            pts.append(p)
            last = p
    if len(pts) < 4:
        return ""
    return "M" + "L".join(f"{x:g} {y:g}" for x, y in pts) + "Z"
for f in gj["features"]:
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    for poly in polys:
        for r in poly:
            s = ring(r)
            if s:
                parts.append(s)
out = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "world-land.json")
json.dump({"path": "".join(parts)}, open(out, "w"))
print(len("".join(parts)))
