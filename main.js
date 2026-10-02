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

// NY State Plane Coordinate System (Long Island/EPSG:2263) parameters
const NY_STATE_PLANE = {
  a: 6378137.0,                    // WGS84 semi-major axis
  f: 1.0 / 298.257223563,          // WGS84 flattening
  lat0: 40.166666667,              // standard parallel 1
  lat1: 41.033333333,              // standard parallel 2
  lon0: -74.0,                     // central meridian
  falseEasting: 984250.0,          // false easting (ft)
  falseNorthing: 0.0,              // false northing (ft)
  scale: 0.9999330000000001        // scale factor
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

// Convert NY State Plane coordinates (Long Island, feet) to lat/lon
function statePlaneToLatLon(easting, northing) {
  // Convert feet to meters
  const e = easting * 0.3048;
  const n = northing * 0.3048;

  const a = NY_STATE_PLANE.a;
  const f = NY_STATE_PLANE.f;
  const lat0 = NY_STATE_PLANE.lat0 * Math.PI / 180;
  const lat1 = NY_STATE_PLANE.lat1 * Math.PI / 180;
  const lon0 = NY_STATE_PLANE.lon0 * Math.PI / 180;
  const k0 = NY_STATE_PLANE.scale;
  const x0 = NY_STATE_PLANE.falseEasting * 0.3048;
  const y0 = NY_STATE_PLANE.falseNorthing * 0.3048;

  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const n_param = (a - a * (1 - e2)) / (a * Math.sqrt(1 - e2));

  const x = e - x0;
  const y = n - y0;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));

  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const footpointLat = mu + (3 * e1 / 2 - 27 * e1 * e1 * e1 / 32) * Math.sin(2 * mu) +
    (21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 32) * Math.sin(4 * mu);

  const c1 = ep2 * Math.cos(footpointLat) * Math.cos(footpointLat);
  const t1 = Math.tan(footpointLat) * Math.tan(footpointLat);
  const r1 = a * (1 - e2) / Math.sqrt(Math.pow(1 - e2 * Math.sin(footpointLat), 3));
  const d = x / (r1 * k0);

  const lat = footpointLat - (Math.tan(footpointLat) / r1) * (d * d / 2 -
    (d * d * d * d / 24) * (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) +
    (d * d * d * d * d * d / 720) * (61 + 90 * t1 + 28 * t1 * t1 + 45 * ep2 - 252 * ep2 * ep2 - 3 * c1 * c1));

  const lon = (d - (d * d * d / 6) * (1 + 2 * t1 + c1) +
    (d * d * d * d * d / 120) * (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 - 8 * ep2 * ep2)) / Math.cos(footpointLat) + lon0;

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

async function fetchSignsInBounds() {
  try {
    // Get current map bounds
    const bounds = map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();

    // Fetch all signs from NYC DOT dataset
    const allSigns = await fetchJSON("https://data.cityofnewyork.us/resource/erm2-nwe9.json?$limit=100000");

    // Filter signs within current bounds and convert coordinates
    const markers = [];
    for (const sign of allSigns) {
      const x = safeNumber(sign.x);
      const y = safeNumber(sign.y);
      if (!x || !y) continue;

      const [lat, lon] = statePlaneToLatLon(x, y);

      // Check if within current map bounds
      if (lat < sw.lat || lat > ne.lat || lon < sw.lng || lon > ne.lng) continue;

      const desc = sign.sign_description || "";
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

    // Clear previous signs and add new ones
    busSignsLayer.clearLayers();
    if (markers.length > 0) {
      L.layerGroup(markers).addTo(busSignsLayer);
      console.log(`Loaded ${markers.length} signs within current bounds`);
    } else {
      console.log("No signs found in current bounds");
    }
  } catch (err) {
    console.error("Failed to fetch signs:", err);
    alert("Failed to fetch signs: " + err.message);
  }
}

// Add control button for fetching signs
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
  button.style.marginBottom = "10px";
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
