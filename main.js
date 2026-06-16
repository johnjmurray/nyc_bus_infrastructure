// ----------------------------------------------------------
// Load secret API key from config.json (injected by GitHub Actions)
// ----------------------------------------------------------
async function loadConfig() {
  const resp = await fetch("config.json", { cache: "no-store" });
  return resp.json(); // { MTA_KEY: "..." }
}

// ----------------------------------------------------------
// Map Initialization
// ----------------------------------------------------------
const map = L.map("map").setView([40.71, -74.00], 12);

// Carto Positron basemap
L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  {
    attribution: "© OpenStreetMap contributors © CARTO",
    maxZoom: 19
  }
).addTo(map);

// Layer groups
const busStopsLayer = L.layerGroup().addTo(map);
const busRoutesLayer = L.layerGroup().addTo(map);
const busSignsLayer = L.layerGroup().addTo(map);
const busLanesLayer = L.layerGroup().addTo(map);

// ----------------------------------------------------------
// 1. Load MTA BusTime GTFS
// ----------------------------------------------------------
async function loadMTA_GTFS(key) {
  const routesURL = `https://bustime.mta.info/api/gtfs/routes?key=${key}`;
  const stopsURL  = `https://bustime.mta.info/api/gtfs/stops?key=${key}`;

  const [routesResp, stopsResp] = await Promise.all([
    fetch(routesURL),
    fetch(stopsURL)
  ]);

  const routes = await routesResp.json();
  const stops  = await stopsResp.json();

  drawStops(stops);
  drawRoutes(routes);
}

// Draw stops
function drawStops(stops) {
  stops.forEach(s => {
    L.circleMarker([s.lat, s.lon], {
      radius: 3,
      color: "blue",
      fillColor: "blue",
      fillOpacity: 0.7
    })
    .addTo(busStopsLayer)
    .bindTooltip(s.stop_name);
  });
}

// Draw routes (BusTime includes shapes)
function drawRoutes(routes) {
  routes.forEach(route => {
    if (!route.shapes) return;

    route.shapes.forEach(shape => {
      const pts = shape.shape_points.map(pt => [pt.lat, pt.lon]);

      L.polyline(pts, {
        color: "purple",
        weight: 2,
        opacity: 0.6
      })
      .addTo(busRoutesLayer)
      .bindTooltip(route.route_short_name || route.route_id);
    });
  });
}

// ----------------------------------------------------------
// 2. DOT BUS Signs
// ----------------------------------------------------------
async function loadBusSigns() {
  const url =
    "https://data.cityofnewyork.us/resource/qiz3-aqxq.json" +
    "?$select=latitude,longitude,sign_description" +
    "&$where=upper(sign_description)%20like%20'%25BUS%25'";

  const data = await fetch(url).then(r => r.json());

  data.forEach(sign => {
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
// 3. DOT Bus Lanes
// ----------------------------------------------------------
async function loadBusLanes() {
  const url = "https://data.cityofnewyork.us/resource/ycrg-ses3.json";
  const rows = await fetch(url).then(r => r.json());

  const gj = {
    type: "FeatureCollection",
    features: rows.map(r => ({
      type: "Feature",
      geometry: r.the_geom,
      properties: r
    }))
  };

  L.geoJSON(gj, {
    style: { color: "orange", weight: 3 }
  }).addTo(busLanesLayer);
}

// ----------------------------------------------------------
// Init
// ----------------------------------------------------------
(async function init() {
  try {
    const cfg = await loadConfig();
    const key = cfg.MTA_KEY;

    await loadMTA_GTFS(key);
    await loadBusSigns();
    await loadBusLanes();
  } catch (err) {
    console.error(err);
    alert("Error loading GTFS or overlays.");
  }
})();

// ----------------------------------------------------------
// Layer Control UI
// ----------------------------------------------------------
L.control.layers(
  {},
  {
    "MTA Bus Stops": busStopsLayer,
    "MTA Bus Routes": busRoutesLayer,
    'DOT "BUS" Signs': busSignsLayer,
    "DOT Bus Lanes": busLanesLayer
  },
  { collapsed: false }
).addTo(map);
