#!/usr/bin/env python3
"""Builds the route map's political layer from Natural Earth 1:50m data (public domain):
country and state/province outlines, lakes, and label anchors for countries, states,
oceans, seas and lakes. Output: src/assets/world-map.json, in the same equirectangular
space as world-land.json (x = lon + 180, y = 90 - lat); paths are relative integer
moves on a 0.1 degree grid (lakes 0.05), so draw them with the matching scale().

Usage (GeoJSON from https://github.com/nvkelso/natural-earth-vector/tree/master/geojson):
  python3 scripts/build_routemap.py DIR
where DIR holds ne_50m_admin_0_countries, ne_50m_admin_1_states_provinces,
ne_50m_lakes and ne_50m_geography_marine_polys (.geojson)."""
import json, math, os, sys

src = sys.argv[1]
load = lambda name: json.load(open(os.path.join(src, name + ".geojson")))["features"]


def polygons(geometry):
    if geometry is None:
        return []
    return geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]


def simplify(pts, eps):
    """Ramer-Douglas-Peucker on a closed ring of grid points."""
    if len(pts) < 5:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i], pts[j]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1.0
        best, at = 0.0, -1
        for k in range(i + 1, j):
            x, y = pts[k]
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm if (dx or dy) else math.hypot(x - x1, y - y1)
            if d > best:
                best, at = d, k
        if best > eps and at > 0:
            keep[at] = True
            stack += [(i, at), (at, j)]
    return [p for p, k in zip(pts, keep) if k]


def ring_path(coords, step):
    """A closed ring as relative integer moves in units of `step` degrees (drawn with scale(step))."""
    pts, last = [], None
    for lon, lat in coords:
        p = (round((lon + 180) / step), round((90 - lat) / step))
        if p != last:
            pts.append(p)
            last = p
    pts = simplify(pts, 0.7)
    if len(pts) < 4:
        return ""
    moves = [f"{b[0] - a[0]} {b[1] - a[1]}" for a, b in zip(pts, pts[1:])]
    return f"M{pts[0][0]} {pts[0][1]}l" + " ".join(moves).replace(" -", "-") + "z"


def path(features, step=0.1, keep=lambda f: True):
    out = []
    for f in features:
        if not keep(f):
            continue
        for poly in polygons(f["geometry"]):
            for ring in poly:
                s = ring_path(ring, step)
                if s:
                    out.append(s)
    return "".join(out)


def ring_area(r):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(r, r[1:] + r[:1]))) / 2


def inside(x, y, poly):
    hit = False
    for ring in poly:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                hit = not hit
    return hit


def edge_distance(x, y, edges):
    """Distance in degrees of latitude to the nearest boundary point (longitude scaled by cos lat)."""
    c = math.cos(math.radians(y))
    return min(math.hypot((x - ex) * c, y - ey) for ex, ey in edges)


def anchors(feature, count=1, spacing=30.0, clearance=0.0):
    """Interior points far from any shore (a coarse pole of inaccessibility), largest polygon first."""
    polys = sorted(polygons(feature["geometry"]), key=lambda p: -ring_area(p[0]))[:2]
    found = []
    for poly in polys:
        outer = poly[0]
        step = max(1, len(outer) // 600)
        edges = [p for ring in poly for p in ring[::step]]
        xs, ys = [p[0] for p in outer], [p[1] for p in outer]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        n = 48
        candidates = []
        for i in range(n):
            for j in range(n):
                x = x0 + (x1 - x0) * (i + 0.5) / n
                y = y0 + (y1 - y0) * (j + 0.5) / n
                if abs(y) < 80 and inside(x, y, poly):
                    candidates.append((edge_distance(x, y, edges), x, y))
        candidates.sort(reverse=True)
        for d, x, y in candidates:
            if len(found) >= count or d < clearance:
                break
            if all(math.hypot((x - fx) * math.cos(math.radians(y)), y - fy) > spacing for _, fx, fy in found):
                found.append((d, x, y))
        if len(found) >= count:
            break
    return [(x, y) for _, x, y in found]


labels = []


def label(name, lon, lat, kind, min_zoom):
    labels.append([name, round(lon + 180, 2), round(90 - lat, 2), kind, round(min_zoom, 1)])


countries = load("ne_50m_admin_0_countries")
for f in countries:
    p = f["properties"]
    name = {"United States of America": "United States"}.get(p["NAME"], p["NAME"])
    label(name, p["LABEL_X"], p["LABEL_Y"], "country", p["MIN_LABEL"])
    # Large countries also get names elsewhere inside them, so a map zoomed onto one
    # part (the Great Lakes, say) still shows whose territory it is.
    largest = max((ring_area(poly[0]) for poly in polygons(f["geometry"])), default=0)
    if largest > 250:
        for x, y in anchors(f, count=6, spacing=10, clearance=3):
            if math.hypot(x - p["LABEL_X"], y - p["LABEL_Y"]) > 8:
                label(name, x, y, "country", p["MIN_LABEL"] + 1)

states = load("ne_50m_admin_1_states_provinces")
for f in states:
    p = f["properties"]
    if p.get("latitude") is not None and p.get("name"):
        label(p.get("name_en") or p["name"], p["longitude"], p["latitude"], "state", p.get("min_label") or 4)

for f in load("ne_50m_geography_marine_polys"):
    p = f["properties"]
    name = p.get("name") or p.get("name_en")
    if not name:
        continue
    name = name.title() if name.isupper() else name
    ocean = "ocean" in name.lower()
    for x, y in anchors(f, count=4 if ocean else 1, spacing=40 if ocean else 30):
        label(name, x, y, "ocean" if ocean else "sea", p["min_label"])

lakes = [f for f in load("ne_50m_lakes") if f["properties"].get("featurecla") != "Reservoir" or f["properties"].get("name")]
for f in lakes:
    p = f["properties"]
    if p.get("name") and (p.get("min_label") or 9) <= 5:
        for x, y in anchors(f):
            label(p["name"], x, y, "lake", p["min_label"])

out = {
    # Paths are integer grids: draw countries and states with scale(0.1), lakes with scale(0.05).
    "countries": path(countries),
    "states": path(states),
    "lakes": path(lakes, step=0.05),
    "labels": labels,
}
dest = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "world-map.json")
json.dump(out, open(dest, "w"), separators=(",", ":"), ensure_ascii=False)
print({k: len(v) for k, v in out.items()}, os.path.getsize(dest))
