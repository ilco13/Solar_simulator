#!/usr/bin/env python3
"""Télécharge les données PVGIS (année météo type + horizon) pour un lieu.

Usage :
    python3 tools/fetch_pvgis.py 43.45 5.65

Les coordonnées sont arrondies à 0,05° (≈ 5 km, la maille de la base
satellite SARAH-3) : le fichier produit ne révèle donc pas l'adresse exacte
et peut être versionné dans un dépôt public.

Sortie : public/data/pvgis/tmy_<lat>_<lon>.json (format compact lu par l'appli).
"""
import json
import sys
import urllib.request
from pathlib import Path

API = "https://re.jrc.ec.europa.eu/api/v5_3"


def get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.load(r)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    lat = round(round(float(sys.argv[1]) / 0.05) * 0.05, 2)
    lon = round(round(float(sys.argv[2]) / 0.05) * 0.05, 2)
    # Horizon non appliqué : l'appli le gère elle-même pour chiffrer la perte "relief".
    tmy = get(f"{API}/tmy?lat={lat}&lon={lon}&usehorizon=0&outputformat=json")
    hor = get(f"{API}/printhorizon?lat={lat}&lon={lon}&outputformat=json")
    rows = tmy["outputs"]["tmy_hourly"]
    out = {
        "source": "PVGIS 5.3 (JRC, Commission européenne) – année météo type",
        "lat": lat,
        "lon": lon,
        "elevation": tmy["inputs"]["location"]["elevation"],
        "radiation_db": tmy["inputs"]["meteo_data"]["radiation_db"],
        # Décalage horaire (h) entre le début de l'heure et la mesure satellite.
        "time_offset_h": tmy["inputs"]["location"].get("irradiance_time_offset", 0.5),
        "years": [tmy["inputs"]["meteo_data"]["year_min"], tmy["inputs"]["meteo_data"]["year_max"]],
        "months_selected": tmy["outputs"]["months_selected"],
        # Une valeur par heure (UTC), 8760 valeurs, heure de début.
        "ghi": [r["G(h)"] for r in rows],
        "dni": [r["Gb(n)"] for r in rows],
        "dhi": [r["Gd(h)"] for r in rows],
        "t2m": [r["T2m"] for r in rows],
        "ws": [r["WS10m"] for r in rows],
        # Azimut depuis le nord (sens horaire) ; PVGIS donne 0 = sud.
        "horizon": [
            {"az": (h["A"] + 180) % 360, "h": h["H_hor"]}
            for h in hor["outputs"]["horizon_profile"]
        ],
    }
    dest = Path(__file__).resolve().parent.parent / "public" / "data" / "pvgis" / f"tmy_{lat:.2f}_{lon:.2f}.json"
    dest.write_text(json.dumps(out, separators=(",", ":")))
    index = dest.parent / "index.json"
    entries = json.loads(index.read_text()) if index.exists() else []
    name = dest.name
    entries = [e for e in entries if e["file"] != name] + [{"lat": lat, "lon": lon, "file": name}]
    index.write_text(json.dumps(entries, indent=1))
    print(f"OK : {dest} ({len(rows)} heures, {out['radiation_db']} {out['years']})")


if __name__ == "__main__":
    main()
