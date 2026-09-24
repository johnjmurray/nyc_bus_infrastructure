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
const overlapGrid = new Map();
const OVERLAP_TOLERANCE_METERS = 20;
const MINIMUM_OVERLAP_METERS = 100;
const GRID_SIZE_METERS = 100;
const METERS_PER_DEGREE = 111320;
const REFERENCE_LATITUDE = 40.71;
const STOPS_MIN_ZOOM = 13;
let busSignsLoaded = false;
let busLanesLoaded = false;
let stopsVisible = true;

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

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ----------------------------------------------------------
// Zoom-based scaling and dense-layer visibility
// ----------------------------------------------------------

function getScaledMarkerRadius() {
  const zoom = map.getZoom();
  return Math.max(1.5, Math.min(4, zoom / 10));
}

function getScaledLineWeight() {
  // Twice the original route-line thickness.
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
// Fast route-overlap index
// ----------------------------------------------------------

function toMeters([lat, lon]) {
  return {
    x: lon * METERS_PER_DEGREE * Math.cos(REFERENCE_LATITUDE * Math.PI / 180),
    y: lat * METERS_PER_DEGREE
  };
}

function gridKey(x, y) {
  return `${Math.floor(x / GRID_SIZE_METERS)},${Math.floor(y / GRID_SIZE_METERS)}`;
}

function addSegmentToGrid(route, segmentIndex, start, end) {
  const minX = Math.floor((Math.min(start.x, end.x) - OVERLAP_TOLERANCE_METERS) / GRID_SIZE_METERS);
  const maxX = Math.floor((Math.max(start.x, end.x) + OVERLAP_TOLERANCE_METERS) / GRID_SIZE_METERS);
  const minY = Math.floor((Math.min(start.y, end.y) - OVERLAP_TOLERANCE_METERS) / GRID_SIZE_METERS);
  const maxY = Math.floor((Math.max(start.y, end.y) + OVERLAP_TOLERANCE_METERS) / GRID_SIZE_METERS);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const key = gridKey(x * GRID_SIZE_METERS, y * GRID_SIZE_METERS);
      if (!overlapGrid.has(key)) overlapGrid.set(key, []);
      overlapGrid.get(key).push({ route, segmentIndex, start, end });
    }
  }
}

function distancePointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  ));
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

function nearbySegments(point) {
  const result = [];
  const cellX = Math.floor(point.x / GRID_SIZE_METERS);
  const cellY = Math.floor(point.y / GRID_SIZE_METERS);
  for (let x = cellX - 1; x <= cellX + 1; x++) {
    for (let y = cellY - 1; y <= cellY + 1; y++) {
      const segments = overlapGrid.get(gridKey(x * GRID_SIZE_METERS, y * GRID_SIZE_METERS));
      if (segments) result.push(...segments);
    }
  }
  return result;
}

function buildOverlapIndex() {
  overlapGrid.clear();
  for (const route of routes) {
    for (let i = 1; i < route.meterPoints.length; i++) {
      addSegmentToGrid(route, i, route.meterPoints[i - 1], route.meterPoints[i]);
    }
  }
}

function getOverlappingRouteNames(route) {
  if (route.overlaps) return route.overlaps;

  const overlapByRoute = new Map();
  const seen = new Set();

  // A 25 m sample interval is accurate enough for the 100 m threshold and
  // avoids the old all-segments-against-all-segments comparison.
  for (let i = 1; i < route.meterPoints.length; i++) {
    const start = route.meterPoints[i - 1];
    const end = route.meterPoints[i];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const count = Math.max(1, Math.ceil(length / 25));
    const step = length / count;

    for (let j = 0; j < count; j++) {
      const t = (j + 0.5) / count;
      const point = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
      for (const candidate of nearbySegments(point)) {
        if (candidate.route === route) continue;
        const candidateKey = `${candidate.route.routeKey}:${i}:${candidate.segmentIndex}`;
        if (seen.has(candidateKey)) continue;
        seen.add(candidateKey);
        if (distancePointToSegment(point, candidate.start, candidate.end) <= OVERLAP_TOLERANCE_METERS) {
          overlapByRoute.set(candidate.route.routeKey,
            (overlapByRoute.get(candidate.route.routeKey) || 0) + step);
        }
      }
    }
  }

  route.overlaps = [...overlapByRoute.entries()]
    .filter(([, meters]) => meters >= MINIMUM_OVERLAP_METERS)
    .sort((a, b) => b[1] - a[1])
    .map(([name, meters]) => `${name} (${Math.round(meters)} m)`);
  return route.overlaps;
}

function routeTooltip(route) {
  const overlaps = getOverlappingRouteNames(route);
  return `<strong>Route ${escapeHTML(route.shortName)}</strong><br>` +
    `<strong>Overlapping routes:</strong> ` +
    (overlaps.length ? overlaps.map(escapeHTML).join(", ") : "None");
}

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
      shortName,
      meterPoints: pts.map(toMeters),
      overlaps: null
    };
    routes.push(route);

    const polyline = L.polyline(pts, {
      renderer: canvasRenderer,
      color: randomRouteColor(id),
      weight: getScaledLineWeight(),
      opacity: 0.85
    });
    route.polyline = polyline;
    polyline.bindTooltip(shortName, { permanent: false, sticky: false, offset: [10, 10] });
    polyline.on("mousemove", e => {
      polyline.setTooltipContent(routeTooltip(route)).openTooltip(e.latlng);
    });
    polyline.on("mouseout", () => polyline.closeTooltip());
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

  // Indexing is deferred until the route geometry is visible. It no longer
  // blocks initial map rendering or repeats for each hovered route.
  scheduleIdleTask(() => {
    buildOverlapIndex();
    console.log(`Indexed ${routes.length} routes for overlap lookup`);
  }, 500);

  console.log("Map initialized");
}

init();
