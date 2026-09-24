// ----------------------------------------------------------
// NYC Bus Infrastructure Map (Fully Optimized)
// ----------------------------------------------------------

const map = L.map("map", { preferCanvas: true }).setView([40.71, -74.00], 12);

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
const busSignsLayer = L.layerGroup().addTo(map);
const busLanesLayer = L.layerGroup().addTo(map);

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
const routeRecords = [];
const routeOverlapCache = new Map();
const OVERLAP_TOLERANCE_METERS = 20;
const MINIMUM_OVERLAP_METERS = 100;
const METERS_PER_DEGREE_LAT = 111320;
const REFERENCE_LATITUDE = 40.71;

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url) {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(url);
  return resp.text();
}

async function fetchJSON(url) {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(url);
  return resp.json();
}

// Fast CSV parser
function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  const H = headers.length;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length !== H) continue;
    const obj = {};
    for (let j = 0; j < H; j++) obj[headers[j]] = cols[j];
    rows.push(obj);
  }
  return rows;
}

// ----------------------------------------------------------
// Zoom-based Scaling
// ----------------------------------------------------------

function getScaledMarkerRadius() {
  const zoom = map.getZoom();
  return Math.max(1.5, Math.min(4, zoom / 10));
}

function getScaledLineWeight() {
  const zoom = map.getZoom();
  // Keep the existing zoom scaling, but make every route line twice as thick.
  return 2 * Math.max(1.5, Math.min(5, zoom / 5));
}

function getScaledSignRadius() {
  const zoom = map.getZoom();
  return Math.max(2, Math.min(5, zoom / 8));
}

function updateMarkerAndLineScaling() {
  const markerRadius = getScaledMarkerRadius();
  const lineWeight = getScaledLineWeight();
  const signRadius = getScaledSignRadius();

  busStopsLayer.getLayers().forEach(layer => {
    if (layer.setRadius) layer.setRadius(markerRadius);
  });

  busRoutesLayer.getLayers().forEach(layer => {
    if (layer.setStyle) layer.setStyle({ weight: lineWeight });
  });

  busSignsLayer.getLayers().forEach(layer => {
    if (layer.setRadius) layer.setRadius(signRadius);
  });
}

map.on("zoom", updateMarkerAndLineScaling);

// ----------------------------------------------------------
// Route overlap helpers
// ----------------------------------------------------------

function toMeters(point) {
  return {
    x: point[1] * METERS_PER_DEGREE_LAT * Math.cos(REFERENCE_LATITUDE * Math.PI / 180),
    y: point[0] * METERS_PER_DEGREE_LAT
  };
}

function distancePointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);

  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  ));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function distancePointToRoute(point, route) {
  let minimum = Infinity;
  for (let i = 1; i < route.meterPoints.length; i++) {
    minimum = Math.min(
      minimum,
      distancePointToSegment(point, route.meterPoints[i - 1], route.meterPoints[i])
    );
    if (minimum <= OVERLAP_TOLERANCE_METERS) return minimum;
  }
  return minimum;
}

function routeBoundingBox(route) {
  return route.meterPoints.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x),
    minY: Math.min(box.minY, point.y),
    maxX: Math.max(box.maxX, point.x),
    maxY: Math.max(box.maxY, point.y)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function boxesCouldOverlap(a, b) {
  return a.minX <= b.maxX + OVERLAP_TOLERANCE_METERS &&
    a.maxX >= b.minX - OVERLAP_TOLERANCE_METERS &&
    a.minY <= b.maxY + OVERLAP_TOLERANCE_METERS &&
    a.maxY >= b.minY - OVERLAP_TOLERANCE_METERS;
}

function sampleRoute(route) {
  const samples = [];
  for (let i = 1; i < route.meterPoints.length; i++) {
    const start = route.meterPoints[i - 1];
    const end = route.meterPoints[i];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const count = Math.max(1, Math.ceil(length / 10));
    for (let j = 0; j < count; j++) {
      const t = j / count;
      samples.push({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        step: length / count
      });
    }
  }
  const last = route.meterPoints[route.meterPoints.length - 1];
  samples.push({ x: last.x, y: last.y, step: 0 });
  return samples;
}

function calculateOverlapMeters(route, otherRoute) {
  if (!boxesCouldOverlap(route.bounds, otherRoute.bounds)) return 0;

  let overlap = 0;
  const samples = sampleRoute(route);
  for (let i = 0; i < samples.length - 1; i++) {
    const sample = samples[i];
    const next = samples[i + 1];
    const midpoint = {
      x: (sample.x + next.x) / 2,
      y: (sample.y + next.y) / 2
    };
    if (distancePointToRoute(midpoint, otherRoute) <= OVERLAP_TOLERANCE_METERS) {
      overlap += Math.hypot(next.x - sample.x, next.y - sample.y);
    }
  }
  return overlap;
}

function getOverlappingRoutes(route) {
  if (routeOverlapCache.has(route)) return routeOverlapCache.get(route);

  const totals = new Map();
  for (const other of routeRecords) {
    if (other === route || other.routeKey === route.routeKey) continue;
    const overlap = calculateOverlapMeters(route, other);
    if (overlap >= MINIMUM_OVERLAP_METERS) {
      totals.set(other.routeKey, (totals.get(other.routeKey) || 0) + overlap);
    }
  }

  const result = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, meters]) => `${name} (${Math.round(meters)} m)`);
  routeOverlapCache.set(route, result);
  return result;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function routeTooltip(route) {
  const overlapping = getOverlappingRoutes(route);
  return `<strong>Route ${escapeHTML(route.shortName)}</strong><br>` +
    `<strong>Overlapping routes:</strong> ` +
    (overlapping.length ? overlapping.map(escapeHTML).join(", ") : "None");
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
  const txt = await fetchText(`feeds/${feed}/routes.txt`);
  const rows = parseCSV(txt);

  const map = {};
  for (const r of rows) {
    map[r.route_id] = {
      short: r.route_short_name || r.route_long_name || r.route_id,
      color: r.route_color ? `#${r.route_color}` : null,
      textColor: r.route_text_color ? `#${r.route_text_color}` : "#000000"
    };
  }
  return map;
}

async function loadGTFSFeeds() {
  for (const feed of GTFS_FEEDS) {
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
  }
}

function drawStops(stops) {
  const markers = [];
  for (const s of stops) {
    const lat = safeNumber(s.lat);
    const lon = safeNumber(s.lon);
    if (!lat || !lon) continue;

    markers.push(
      L.circleMarker([lat, lon], {
        radius: getScaledMarkerRadius(),
        color: "#66CCFF",
        fillColor: "#66CCFF",
        fillOpacity: 0.65,
        weight: 1
      }).bindTooltip(s.stop_name || s.stop_id || "")
    );
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
    const pts = grouped[id]
      .sort((a, b) => a.seq - b.seq)
      .map(p => [p.lat, p.lon]);

    if (pts.length < 2) continue;

    const routeId = id;
    const shortName = routesMap[routeId]?.short || routeId;
    const color = randomRouteColor(routeId);
    const route = {
      routeKey: shortName,
      shortName,
      points: pts,
      meterPoints: pts.map(toMeters)
    };
    route.bounds = routeBoundingBox(route);
    routeRecords.push(route);

    const polyline = L.polyline(pts, {
      color,
      weight: getScaledLineWeight(),
      opacity: 0.85
    });
    route.polyline = polyline;

    // Show the route and its qualifying overlaps in a mouse-following tooltip.
    polyline.bindTooltip(routeTooltip(route), {
      permanent: false,
      sticky: false,
      offset: [10, 10]
    });
    polyline.on("mousemove", (e) => {
      polyline.setTooltipContent(routeTooltip(route)).openTooltip(e.latlng);
    });

    lines.push(polyline);
  }

  // Any newly loaded shapes can change the overlap results for existing routes.
  routeOverlapCache.clear();
  L.layerGroup(lines).addTo(busRoutesLayer);
}

// ----------------------------------------------------------
// Bus Signs (CSV + EPSG 2263)
// ----------------------------------------------------------

async function loadBusSigns() {
  try {
    const csvText = await fetchText("data/sign_output.csv");
    const rows = parseCSV(csvText);

    const markers = [];

    for (const sign of rows) {
      const lat = safeNumber(sign.latitude);
      const lon = safeNumber(sign.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const desc = sign.sign_description || "";
      const U = desc.toUpperCase();

      let color;
      if (U.includes("LANE") || U.includes("ONLY")) color = "#4B0082";
      else if (U.includes("STOP")) color = "#66CCFF";
      else color = "#6c757d";

      const tooltip =
        `<div style="max-width: 200px; word-wrap: break-word; white-space: normal;">` +
        `${desc}<br>` +
        `Order #: ${sign.order_number || "N/A"}<br>` +
        (sign.order_completed_on_date ? `Completed: ${sign.order_completed_on_date}` : "") +
        `</div>`;

      markers.push(
        L.circleMarker([lat, lon], {
          radius: getScaledSignRadius(),
          color: color,
          fillColor: color,
          fillOpacity: 0.75,
          weight: 1
        }).bindTooltip(tooltip, { className: "sign-tooltip" })
      );
    }

    L.layerGroup(markers).addTo(busSignsLayer);
    console.log(`Loaded ${rows.length} bus signs`);
  } catch (err) {
    console.error("CSV bus signs load failed:", err);
  }
}
// ----------------------------------------------------------
// Bus Lanes
// ----------------------------------------------------------

async function loadBusLanes() {
  try {
    const rows = await fetchJSON(
      "https://data.cityofnewyork.us/resource/ycrg-ses3.json?$limit=50000"
    );

    const features = [];
    for (const r of rows) {
      let geom = r.the_geom;
      if (!geom) continue;

      if (typeof geom === "string") {
        try { geom = JSON.parse(geom); }
        catch { continue; }
      }

      features.push({
        type: "Feature",
        geometry: geom,
        properties: r
      });
    }

    L.geoJSON(
      { type: "FeatureCollection", features },
      {
        style: {
          color: "red",
          weight: 8,
          opacity: 0.45
        },
        onEachFeature: (f, layer) => {
          const p = f.properties;
          const label =
            `${p.Days || ""} ${p.Hours || ""} ${p.Lane_Type || ""} ${p.Lane_Width || ""}`.trim();
          if (label) layer.bindTooltip(label, { sticky: true });
        }
      }
    ).addTo(busLanesLayer);

  } catch (e) {
    console.error("Bus lanes failed:", e);
  }
}

// ----------------------------------------------------------
// Fit Map to Data
// ----------------------------------------------------------

function fitToInfrastructure() {
  const groups = [busRoutesLayer, busStopsLayer, busLanesLayer];
  let bounds = null;

  for (const layer of groups) {
    if (layer.getLayers && layer.getLayers().length > 0 && layer.getBounds) {
      const b = layer.getBounds();
      if (b.isValid()) bounds = bounds ? bounds.extend(b) : b;
    }
  }

  if (bounds && bounds.isValid()) {
    map.fitBounds(bounds, { padding: [20, 20] });
  }
}

// ----------------------------------------------------------
// Initialization
// ----------------------------------------------------------

async function init() {
  console.log("Loading infrastructure...");

  await loadGTFSFeeds();

  requestIdleCallback(() => {
    loadBusSigns();
    loadBusLanes();
  });

  fitToInfrastructure();

  console.log("Map initialized");
}

init();
