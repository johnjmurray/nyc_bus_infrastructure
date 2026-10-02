// ----------------------------------------------------------
// NYC Bus Infrastructure Map (Fully Optimized)
// ----------------------------------------------------------

const map = L.map("map", { preferCanvas: true }).setView([40.71, -74.00], 12);
const canvasRenderer = L.canvas({ padding: 0.5 });

L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  {
    attribution: "© OpenStreetMap contributors © CARTO",
    maxZoom: 19
  }
).addTo(map);

// ----------------------------------------------------------
// Layers
// ----------------------------------------------------------

const busStopsLayer = L.layerGroup().addTo(map);
const busRoutesLayer = L.layerGroup().addTo(map);
const busSignsLayer = L.layerGroup();
const busLanesLayer = L.layerGroup();

L.control.layers(
  null,
  {
    "Bus Stops": busStopsLayer,
    "Bus Routes": busRoutesLayer,
    "Bus Signs": busSignsLayer,
    "Bus Lanes": busLanesLayer
  },
  { collapsed: false }
).addTo(map);

// ----------------------------------------------------------
// Utilities
// ----------------------------------------------------------

const GTFS_FEEDS = ["gtfs_bx", "gtfs_q", "gtfs_m", "gtfs_si", "gtfs_b", "gtfs_busco"];
const routeColorCache = {};
const routes = [];
let busSignsLoaded = false;
let busLanesLoaded = false;
let stopsVisible = true;
const STOPS_MIN_ZOOM = 13;

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function scheduleIdleTask(task, timeout = 0) {
  if (typeof window !== "undefined" && window.requestIdleCallback) {
    return window.requestIdleCallback(() => task(), { timeout: Math.max(1500, timeout) });
  }
  return setTimeout(task, timeout);
}

async function fetchText(url) {
  const resp = await fetch(url, { cache: "force-cache" });
  if (!resp.ok) throw new Error(url);
  return resp.text();
}

async function fetchJSON(url) {
  const resp = await fetch(url, { cache: "force-cache" });
  if (!resp.ok) throw new Error(url);
  return resp.json();
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length !== headers.length) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j];
    rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------
// Zoom-based scaling
// ----------------------------------------------------------

function getScaledMarkerRadius() {
  const zoom = map.getZoom();
  return Math.max(1.5, Math.min(4, zoom / 10));
}

function getScaledLineWeight() {
  return Math.max(2, Math.min(6, map.getZoom() / 2.5));
}

function getScaledSignRadius() {
  return Math.max(2, Math.min(5, map.getZoom() / 8));
}

function updateMarkerAndLineScaling() {
  const markerRadius = getScaledMarkerRadius();
  const lineWeight = getScaledLineWeight();
  const signRadius = getScaledSignRadius();

  busStopsLayer.eachLayer(group => group.eachLayer?.(layer => {
    if (layer.setRadius) layer.setRadius(markerRadius);
  }));
  busRoutesLayer.eachLayer(group => group.setStyle?.({ weight: lineWeight }));
  busSignsLayer.eachLayer(group => group.eachLayer?.(layer => {
    if (layer.setRadius) layer.setRadius(signRadius);
  }));
}

function updateStopVisibility() {
  const shouldShow = map.getZoom() >= STOPS_MIN_ZOOM;
  if (shouldShow === stopsVisible) return;
  stopsVisible = shouldShow;
  if (shouldShow) map.addLayer(busStopsLayer);
  else map.removeLayer(busStopsLayer);
}

map.on("zoomend", () => {
  updateMarkerAndLineScaling();
  updateStopVisibility();
});

// ----------------------------------------------------------
// GTFS Helpers
// ----------------------------------------------------------

function randomRouteColor(routeId) {
  if (routeColorCache[routeId]) return routeColorCache[routeId];
  const hue = Math.floor(Math.random() * 360);
  return (routeColorCache[routeId] = `hsl(${hue},70%,45%)`);
}

async function loadRoutesForFeed(feed) {
  const rows = parseCSV(await fetchText(`feeds/${feed}/routes.txt`));
  const result = {};
  for (const r of rows) {
    result[r.route_id] = {
      short: r.route_short_name || r.route_long_name || r.route_id,
      color: r.route_color ? `#${r.route_color}` : null,
      textColor: r.route_text_color ? `#${r.route_text_color}` : "#000000"
    };
  }
  return result;
}

async function loadGTFSFeeds() {
  await Promise.all(GTFS_FEEDS.map(async feed => {
    try {
      const [shapesTxt, stopsTxt, routesMap] = await Promise.all([
        fetchText(`feeds/${feed}/shapes.txt`),
        fetchText(`feeds/${feed}/stops.txt`),
        loadRoutesForFeed(feed)
      ]);
      drawStops(parseCSV(stopsTxt));
      drawShapesFromGTFS(parseCSV(shapesTxt), routesMap);
    } catch (e) {
      console.warn("GTFS load failed:", feed, e);
    }
  }));
}

function drawStops(stops) {
  const markers = [];
  for (const s of stops) {
    const lat = safeNumber(s.lat);
    const lon = safeNumber(s.lon);
    if (!lat || !lon) continue;
    markers.push(L.circleMarker([lat, lon], {
      renderer: canvasRenderer,
      radius: getScaledMarkerRadius(),
      color: "#66CCFF",
      fillColor: "#66CCFF",
      fillOpacity: 0.65,
      weight: 1
    }).bindTooltip(s.stop_name || s.stop_id || ""));
  }
  L.layerGroup(markers).addTo(busStopsLayer);
}

function drawShapesFromGTFS(shapes, routesMap) {
  const grouped = {};
  for (const row of shapes) {
    const id = row.shape_id;
    if (!grouped[id]) grouped[id] = [];
    grouped[id].push({
      lat: Number(row.shape_pt_lat),
      lon: Number(row.shape_pt_lon),
      seq: Number(row.shape_pt_sequence)
    });
  }

  const lines = [];
  for (const id in grouped) {
    const pts = grouped[id].sort((a, b) => a.seq - b.seq).map(p => [p.lat, p.lon]);
    if (pts.length < 2) continue;

    const shortName = routesMap[id]?.short || id;
    const route = {
      routeKey: `${shortName}:${id}`,
      shortName
    };
    routes.push(route);

    const polyline = L.polyline(pts, {
      renderer: canvasRenderer,
      color: randomRouteColor(id),
      weight: getScaledLineWeight(),
      opacity: 0.85
    });
    polyline.bindTooltip(shortName, { permanent: false, sticky: false, offset: [10, 10] });
    lines.push(polyline);
  }
  L.layerGroup(lines).addTo(busRoutesLayer);
}

// ----------------------------------------------------------
// Optional dense overlays
// ----------------------------------------------------------

async function loadBusSigns() {
  if (busSignsLoaded) return;
  busSignsLoaded = true;
  try {
    const rows = parseCSV(await fetchText("data/sign_output.csv"));
    const markers = [];
    for (const sign of rows) {
      const lat = safeNumber(sign.latitude), lon = safeNumber(sign.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const desc = sign.sign_description || "";
      const upper = desc.toUpperCase();
      const color = upper.includes("LANE") || upper.includes("ONLY") ? "#4B0082" :
        upper.includes("STOP") ? "#66CCFF" : "#6c757d";
      markers.push(L.circleMarker([lat, lon], {
        renderer: canvasRenderer,
        radius: getScaledSignRadius(), color, fillColor: color, fillOpacity: 0.75, weight: 1
      }).bindTooltip(`${desc}<br>Order #: ${sign.order_number || "N/A"}`, { className: "sign-tooltip" }));
    }
    L.layerGroup(markers).addTo(busSignsLayer);
  } catch (err) {
    console.error("CSV bus signs load failed:", err);
  }
}

async function loadBusLanes() {
  if (busLanesLoaded) return;
  busLanesLoaded = true;
  try {
    const rows = await fetchJSON("https://data.cityofnewyork.us/resource/ycrg-ses3.json?$limit=50000");
    const features = [];
    for (const r of rows) {
      let geom = r.the_geom;
      if (!geom) continue;
      if (typeof geom === "string") {
        try { geom = JSON.parse(geom); } catch { continue; }
      }
      features.push({ type: "Feature", geometry: geom, properties: r });
    }
    L.geoJSON({ type: "FeatureCollection", features }, {
      renderer: canvasRenderer,
      style: { color: "red", weight: 8, opacity: 0.45 },
      onEachFeature: (f, layer) => {
        const p = f.properties;
        const label = `${p.Days || ""} ${p.Hours || ""} ${p.Lane_Type || ""} ${p.Lane_Width || ""}`.trim();
        if (label) layer.bindTooltip(label, { sticky: true });
      }
    }).addTo(busLanesLayer);
  } catch (e) {
    console.error("Bus lanes failed:", e);
  }
}

map.on("overlayadd", event => {
  if (event.layer === busSignsLayer) scheduleIdleTask(loadBusSigns, 100);
  if (event.layer === busLanesLayer) scheduleIdleTask(loadBusLanes, 100);
});

// ----------------------------------------------------------
// Fit map and initialization
// ----------------------------------------------------------

function fitToInfrastructure() {
  const bounds = busRoutesLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
}

async function init() {
  console.log("Loading infrastructure...");
  await loadGTFSFeeds();
  fitToInfrastructure();
  console.log("Map initialized");
}

init();
