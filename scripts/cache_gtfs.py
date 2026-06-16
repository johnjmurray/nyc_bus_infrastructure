import os, json, requests
from pathlib import Path

DATA = Path("data")
DATA.mkdir(exist_ok=True)

key = os.environ.get("MTA_BUSTIME_KEY")
if not key:
    raise SystemExit("Missing MTA_BUSTIME_KEY")

URL_ROUTES = f"https://bustime.mta.info/api/gtfs/routes?key={key}"
URL_STOPS  = f"https://bustime.mta.info/api/gtfs/stops?key={key}"

print("Downloading GTFS…")

routes = requests.get(URL_ROUTES).json()
stops  = requests.get(URL_STOPS).json()

with open(DATA / "routes.json", "w") as f:
    json.dump(routes, f, indent=2)

with open(DATA / "stops.json", "w") as f:
    json.dump(stops, f, indent=2)

print("GTFS cached → data/routes.json, data/stops.json")
