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
  return Math.max(1.5, Math.min(5, zoom / 5));
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

    const polyline = L.polyline(pts, {
      color,
      weight: getScaledLineWeight(),
      opacity: 0.85
    });

    // Add mouse-following tooltip
    polyline.on("mousemove", (e) => {
      polyline.bindTooltip(shortName, {
        permanent: false,
        sticky: false,
        offset: [10, 10]
      }).setTooltipContent(shortName).openTooltip(e.latlng);
    });

    polyline.on("mouseout", () => {
      polyline.closeTooltip();
    });

    lines.push(polyline);
  }

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
