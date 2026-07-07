import requests
from collections import defaultdict, Counter
from pyproj import Transformer
import csv

def clean_date(value):
    if isinstance(value, str) and "T00:00:00.000" in value:
        return value.replace("T00:00:00.000", "")
    return value

# ----------------------------------------------------
# 1. Build URL-style SODA API query
# ----------------------------------------------------
url = (
    "https://data.cityofnewyork.us/resource/nfid-uabd.json"+
    "?$select=order_number,record_type,order_type,borough,on_street,on_street_suffix,"+
    "from_street,from_street_suffix,to_street,to_street_suffix,side_of_street,"+
    "order_completed_on_date,sign_code,sign_description,distance_from_intersection,"+
    "arrow_direction,facing_direction,sheeting_type,support,sign_notes,sign_x_coord,sign_y_coord"+
    "&$where=caseless_eq(record_type,%20'Current')%20AND%20caseless_one_of("+
        "sign_code,%20'SP-477BA',%20'SP-477B',%20'SI-1882G',%20'SI-1883G',"+
        "%20'SI-584G',%20'SI-1878G',%20'SI-1879G'"+
    ")"+
    "&$limit=50000"
)

# ----------------------------------------------------
# 2. Fetch data
# ----------------------------------------------------
response = requests.get(url)
response.raise_for_status()
records = response.json()

# ----------------------------------------------------
# 3. Group by order_number
# ----------------------------------------------------
orders = defaultdict(list)
for r in records:
    orders[r["order_number"]].append(r)

# ----------------------------------------------------
# 4. Prepare coordinate transformer (EPSG:2263 → EPSG:4326)
# ----------------------------------------------------
# Use NY State Plane (NAD83) for New York coordinates — EPSG:2263 is the common CRS for NYC datasets.
transformer = Transformer.from_crs("EPSG:2263", "EPSG:4326", always_xy=True)

# ----------------------------------------------------
# 5. Aggregate each order_number into one row
# ----------------------------------------------------
output = []

def first_non_null(signs, field):
    for s in signs:
        if s.get(field):
            return s.get(field)
    return None

for order_number, signs in orders.items():

    # Most common X/Y coordinate pair — ignore empty pairs so we don't pick (None, None)
    coords = [
        (s.get("sign_x_coord"), s.get("sign_y_coord"))
        for s in signs
        if s.get("sign_x_coord") and s.get("sign_y_coord")
    ]
    if coords:
        most_common_pair = Counter(coords).most_common(1)[0][0]
        x_coord, y_coord = most_common_pair
    else:
        x_coord, y_coord = (None, None)

    # Coordinate conversion (safe)
    if x_coord and y_coord:
        try:
            lon, lat = transformer.transform(float(x_coord), float(y_coord))
        except Exception:
            lon, lat = (None, None)
    else:
        lon, lat = (None, None)

    # Simple aggregations
    borough = first_non_null(signs, "borough")
    on_street = first_non_null(signs, "on_street")
    from_street = first_non_null(signs, "from_street")
    to_street = first_non_null(signs, "to_street")
    side_of_street = first_non_null(signs, "side_of_street")
    order_completed_on_date = clean_date(first_non_null(signs, "order_completed_on_date"))
    distance_from_intersection = first_non_null(signs, "distance_from_intersection")
    arrow_direction = first_non_null(signs, "arrow_direction")

    # Concatenate multi-value fields
    sign_description = " | ".join(
        s.get("sign_description", "") for s in signs if s.get("sign_description")
    )
    sign_notes = " | ".join(
        s.get("sign_notes", "") for s in signs if s.get("sign_notes")
    )

    output.append({
        "order_number": order_number,
        "borough": borough,
        "on_street": on_street,
        "from_street": from_street,
        "to_street": to_street,
        "side_of_street": side_of_street,
        "order_completed_on_date": order_completed_on_date,
        "distance_from_intersection": distance_from_intersection,
        "arrow_direction": arrow_direction,
        "latitude": lat,
        "longitude": lon,
        "sign_description": sign_description,
        "sign_notes": sign_notes
    })

# ----------------------------------------------------
# 6. Write to CSV
# ----------------------------------------------------
fieldnames = [
    "order_number",
    "borough",
    "on_street",
    "from_street",
    "to_street",
    "side_of_street",
    "order_completed_on_date",
    "distance_from_intersection",
    "arrow_direction",
    "latitude",
    "longitude",
    "sign_description",
    "sign_notes"
]

output_file = "data/sign_output.csv"

with open(output_file, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(output)

print(f"Wrote {len(output)} aggregated sign records to {output_file}")
