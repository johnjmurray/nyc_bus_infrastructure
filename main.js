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

// New York Long Island State Plane (EPSG:2263) parameters
const NY_STATE_PLANE = {
  a: 6378137.0,
  f: 1 / 298.257223563,
  lat0: 40.1666666667,
  lat1: 41.0333333333,
  lon0: -74.0,
  falseEasting: 984250.0,
  falseNorthing: 0.0,
  scale: 0.999933
};

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

function statePlaneToLatLon(xFeet, yFeet) {
  const a = NY_STATE_PLANE.a;
  const f = NY_STATE_PLANE.f;
  const e = xFeet * 0.3048;
  const n = yFeet * 0.3048;

  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const lat0 = NY_STATE_PLANE.lat0 * Math.PI / 180;
  const lat1 = NY_STATE_PLANE.lat1 * Math.PI / 180;
  const lon0 = NY_STATE_PLANE.lon0 * Math.PI / 180;
  const x0 = NY_STATE_PLANE.falseEasting * 0.3048;
  const y0 = NY_STATE_PLANE.falseNorthing * 0.3048;
  const k0 = NY_STATE_PLANE.scale;

  const m = (n - y0) / k0;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const mu = m / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));

  const C = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(mu) * Math.sin(mu), 1.5);
  const T = Math.tan(mu) * Math.tan(mu);
  const N = a / Math.sqrt(1 - e2 * Math.sin(mu) * Math.sin(mu));
  const R = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(mu) * Math.sin(mu), 1.5);
  const D = (e - x0) / (N * k0);

  const lat = mu - (N * Math.tan(mu) / R) * (
    (D * D) / 2 -
    (5 + 3 * T + 10 * C - 4 * C * C - 9 * ep2) * Math.pow(D, 4) / 24 +
    (61 + 90 * T + 298 * C + 45 * T * T - 252 * ep2 - 3 * C * C) * Math.pow(D, 6) / 720
  );

  const lon = lon0 + (
    D - (1 + 2 * T + C) * Math.pow(D, 3) / 6 +
    (5 - 2 * C + 28 * T - 3 * C * C + 8 * ep2 + 24 * T * T) * Math.pow(D, 5) / 120
  ) / Math.cos(mu);

  return [lat * 180 / Math.PI, lon * 180 / Math.PI];
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
// Bus Signs - NYC DOT Sign Order Dataset
// ----------------------------------------------------------

function resolveSignCoordinates(sign) {
  const x = safeNumber(sign.x ?? sign.x_coord ?? sign.X ?? sign.X_COORD ?? sign.longitude);
  const y = safeNumber(sign.y ?? sign.y_coord ?? sign.Y ?? sign.Y_COORD ?? sign.latitude);

  if (x == null || y == null) return null;

  const [lat, lon] = statePlaneToLatLon(x, y);
  return { lat, lon };
}

async function fetchSignsInBounds() {
  try {
    const bounds = map.getBounds();
    const allSigns = await fetchJSON(
      "https://data.cityofnewyork.us/resource/erm2-nwe9.json?$limit=100000"
    );

    const markers = [];
    for (const sign of allSigns) {
      const coords = resolveSignCoordinates(sign);
      if (!coords) continue;

      const { lat, lon } = coords;
      if (!bounds.contains([lat, lon])) continue;

      const desc = sign.sign_description || sign.description || "";
      const upper = desc.toUpperCase();
      const color = upper.includes("LANE") || upper.includes("ONLY") ? "#4B0082" :
        upper.includes("STOP") ? "#FF6B6B" : "#6c757d";

      markers.push(L.circleMarker([lat, lon], {
        renderer: canvasRenderer,
        radius: getScaledSignRadius(),
        color,
        fillColor: color,
        fillOpacity: 0.75,
        weight: 1
      }).bindTooltip(`${desc}<br>Order #: ${sign.order_number || "N/A"}`, { className: "sign-tooltip" }));
    }

    busSignsLayer.clearLayers();
    if (markers.length > 0) {
      L.layerGroup(markers).addTo(busSignsLayer);
      console.log(`Loaded ${markers.length} signs within current bounds`);
    } else {
      console.log("No signs found in current bounds");
    }
  } catch (err) {
    console.error("Failed to fetch signs:", err);
    alert("Failed to fetch signs: " + (err?.message || err));
  }
}

const fetchSignsControl = L.control({ position: "topleft" });
fetchSignsControl.onAdd = function () {
  const div = L.DomUtil.create("div", "leaflet-bar");
  div.style.padding = "10px";
  div.style.backgroundColor = "white";
  div.style.borderRadius = "4px";
  div.style.boxShadow = "0 2px 4px rgba(0,0,0,0.1)";

  const button = L.DomUtil.create("button", "", div);
  button.textContent = "Fetch Signs in View";
  button.style.padding = "8px 12px";
  button.style.backgroundColor = "#007bff";
  button.style.color = "white";
  button.style.border = "none";
  button.style.borderRadius = "4px";
  button.style.cursor = "pointer";
  button.style.fontSize = "14px";
  button.style.fontWeight = "bold";
  button.style.display = "block";
  button.style.width = "100%";

  button.onmouseover = () => button.style.backgroundColor = "#0056b3";
  button.onmouseout = () => button.style.backgroundColor = "#007bff";

  L.DomEvent.on(button, "click", (e) => {
    L.DomEvent.stopPropagation(e);
    fetchSignsInBounds();
  });

  return div;
};
fetchSignsControl.addTo(map);

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
