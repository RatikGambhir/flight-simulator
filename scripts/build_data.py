#!/usr/bin/env python3
"""Builds the compact world datasets bundled into the Rust simulation core.

Sources (download into a folder and pass it as argv[1]):
  - OurAirports (public domain): airports.csv, runways.csv, countries.csv
    https://github.com/davidmegginson/ourairports-data
  - Natural Earth populated places (public domain):
    ne_10m_populated_places_simple.geojson -> saved as places.geojson
    https://github.com/nvkelso/natural-earth-vector

Outputs to data/: airports.tsv, runways.tsv, places.tsv
"""
import csv, json, sys, os

src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), "..", "data")

def clean(s):
    return (s or "").replace("\t", " ").replace("\n", " ").strip()

countries = {}
with open(os.path.join(src, "countries.csv"), newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        countries[r["code"]] = r["name"]

HARD = ("ASP", "CON", "PEM", "BIT", "TAR", "PAV", "ASF", "CONC", "TARMAC", "BITUMEN", "MACADAM")

runways_by_ap = {}
with open(os.path.join(src, "runways.csv"), newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        if r["closed"] == "1":
            continue
        try:
            le_lat, le_lon = float(r["le_latitude_deg"]), float(r["le_longitude_deg"])
            he_lat, he_lon = float(r["he_latitude_deg"]), float(r["he_longitude_deg"])
            length = float(r["length_ft"] or 0)
        except ValueError:
            continue
        if length < 1500:
            continue
        runways_by_ap.setdefault(r["airport_ident"], []).append(r)

airports = []
with open(os.path.join(src, "airports.csv"), newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        t = r["type"]
        if t not in ("large_airport", "medium_airport", "small_airport"):
            continue
        rws = runways_by_ap.get(r["ident"])
        if not rws:
            continue
        if t == "small_airport":
            # keep small airfields with a paved runway or scheduled service
            paved = any(any(h in (rw["surface"] or "").upper() for h in HARD) for rw in rws)
            if not paved and r["scheduled_service"] != "yes":
                continue
        airports.append(r)

idents = set()
with open(os.path.join(out, "airports.tsv"), "w", encoding="utf-8") as f:
    for r in airports:
        idents.add(r["ident"])
        kind = {"large_airport": "L", "medium_airport": "M", "small_airport": "S"}[r["type"]]
        f.write("\t".join([
            clean(r["ident"]), clean(r["icao_code"] or r["gps_code"]), clean(r["iata_code"]),
            clean(r["name"]), clean(r["municipality"]), clean(countries.get(r["iso_country"], r["iso_country"])),
            kind, "%.6f" % float(r["latitude_deg"]), "%.6f" % float(r["longitude_deg"]),
            str(int(float(r["elevation_ft"] or 0))),
        ]) + "\n")

n_rw = 0
with open(os.path.join(out, "runways.tsv"), "w", encoding="utf-8") as f:
    for ident in idents:
        for r in runways_by_ap[ident]:
            n_rw += 1
            f.write("\t".join([
                ident, str(int(float(r["length_ft"] or 0))), str(int(float(r["width_ft"] or 0))), clean(r["surface"]),
                clean(r["le_ident"]), r["le_latitude_deg"], r["le_longitude_deg"], r["le_elevation_ft"] or "",
                r["le_heading_degT"] or "", r["le_displaced_threshold_ft"] or "",
                clean(r["he_ident"]), r["he_latitude_deg"], r["he_longitude_deg"], r["he_elevation_ft"] or "",
                r["he_heading_degT"] or "", r["he_displaced_threshold_ft"] or "",
            ]) + "\n")

with open(os.path.join(src, "places.geojson"), encoding="utf-8") as f:
    gj = json.load(f)
n_pl = 0
with open(os.path.join(out, "places.tsv"), "w", encoding="utf-8") as f:
    for feat in gj["features"]:
        p = feat["properties"]
        lon, lat = feat["geometry"]["coordinates"]
        f.write("\t".join([clean(p["name"]), clean(p.get("adm1name")), clean(p["adm0name"]),
                           "%.5f" % lat, "%.5f" % lon, str(int(p.get("pop_max") or 0))]) + "\n")
        n_pl += 1

print(f"airports={len(airports)} runways={n_rw} places={n_pl}")
