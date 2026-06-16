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
// 1. Load cached GTFS (routes + stops) from /data/
// ----------------------------------------------------------
async function loadCachedGTFS() {
  const stopsURL = "data/stops.json";
  const routesURL = "data/routes.json";

  const [stopsResp, routesResp] = await Promise.all([
    fetch(stopsURL),
    fetch(routesURL)
  ]);

  const stops = await stopsResp.json();
  const routes = await routesResp.json();

  drawStops(stops);
  drawRoutes(routes);
}

// Stops
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

// Routes (BusTime includes shapes)
function drawRoutes(routes) {
  routes.forEach(rt => {
    if (!rt.shapes) return;

    rt.shapes.forEach(shape => {
      const pts = shape.shape_points.map(pt => [pt.lat, pt.lon]);

      L.polyline(pts, {
        color: "purple",
        weight: 2,
        opacity: 0.6
      })
      .addTo(busRoutesLayer)
      .bindTooltip(rt.route_short_name || rt.route_id);
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
    .bindTooltip(sign.sign_description);
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

  L.geoJSON(gj, { style: { color: "orange", weight: 3 } })
    .addTo(busLanesLayer);
}

// ----------------------------------------------------------
// Init
// ----------------------------------------------------------
(async function init() {
  await loadCachedGTFS();
  await loadBusSigns();
  await loadBusLanes();
})();
