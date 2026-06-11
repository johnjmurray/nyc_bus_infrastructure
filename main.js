// ----------------------------------------------------------
// Map Initialization
// ----------------------------------------------------------
const map = L.map("map").setView([40.71, -74.00], 12);

// Carto Positron basemap
L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  {
    attribution:
      "© OpenStreetMap contributors © CARTO",
    maxZoom: 19
  }
).addTo(map);

// Layer groups
const busStopsLayer = L.layerGroup().addTo(map);
const busRoutesLayer = L.layerGroup().addTo(map);
const busSignsLayer = L.layerGroup().addTo(map);
const busLanesLayer = L.layerGroup().addTo(map);

// ----------------------------------------------------------
// 1. MTA GTFS: Stops + Routes (TransitLand API)
// ----------------------------------------------------------
async function loadMTA() {
  try {
    const stopsURL =
      "https://transit.land/api/v2/rest/stops?operator_onestop_id=o-dr5-mta";
    const routesURL =
      "https://transit.land/api/v2/rest/routes?operator_onestop_id=o-dr5-mta";

    const stops = await fetch(stopsURL).then((r) => r.json());
    const routes = await fetch(routesURL).then((r) => r.json());

    // Plot stops
    stops.stops.forEach((s) => {
      if (!s.geometry) return;

      L.circleMarker(
        [s.geometry.coordinates[1], s.geometry.coordinates[0]],
        {
          radius: 3,
          color: "blue",
          fillColor: "blue",
          fillOpacity: 0.7
        }
      )
        .addTo(busStopsLayer)
        .bindTooltip(s.name);
    });

    // Plot route lines
    routes.routes.forEach((rt) => {
      if (!rt.geometry) return;

      L.geoJSON(rt.geometry, {
        style: {
          color: "purple",
          weight: 2,
          opacity: 0.6
        }
      }).addTo(busRoutesLayer);
    });
  } catch (err) {
    console.error("Error fetching MTA GTFS data:", err);
  }
}

// ----------------------------------------------------------
// 2. DOT Street Sign Orders with "BUS" in description
// ----------------------------------------------------------
async function loadBusSigns() {
  const url =
    "https://data.cityofnewyork.us/resource/qt6m-xctn.json" +
    "?$select=latitude,longitude,sign_description" +
    "&$where=upper(sign_description)%20like%20'%25BUS%25'";

  const data = await fetch(url).then((r) => r.json());

  data.forEach((sign) => {
    if (!sign.latitude || !sign.longitude) return;

    L.circleMarker([sign.latitude, sign.longitude], {
      radius: 4,
      color: "red",
      fillColor: "red",
      fillOpacity: 0.8
    })
      .addTo(busSignsLayer)
      .bindTooltip(sign.sign_description || "BUS sign");
  });
}

// ----------------------------------------------------------
// 3. DOT Bus Lanes – Local Streets
// ----------------------------------------------------------
async function loadBusLanes() {
  const url = "https://data.cityofnewyork.us/resource/ycrg-ses3.json";


const rows = await fetch(url).then(r => r.json());


const geojson = {
  type: "FeatureCollection",
  features: rows.map(r => ({
    type: "Feature",
    geometry: r.the_geom, // already GeoJSON
    properties: r
  }))
};

L.geoJSON(geojson, { style: { color: "orange", weight: 3 } })
  .addTo(busLanesLayer);


// ----------------------------------------------------------
// Load all datasets
// ----------------------------------------------------------
loadMTA();
loadBusSigns();
loadBusLanes();

// ----------------------------------------------------------
// Layer Control UI
// ----------------------------------------------------------
L.control
  .layers(
    {},
    {
      "MTA Bus Stops": busStopsLayer,
      "MTA Bus Routes": busRoutesLayer,
      'DOT "BUS" Signs': busSignsLayer,
      "DOT Bus Lanes": busLanesLayer
    },
    { collapsed: false }
  )
  .addTo(map);
