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
// EPSG:2263 Projection (Precomputed)
// ----------------------------------------------------------

const proj2263 = (() => {
  const usFtToMeters = 0.3048006096012192;
  const lat1 = 40.66666666666666 * Math.PI / 180;
  const lat2 = 41.03333333333333 * Math.PI / 180;
  const lat0 = 40.16666666666666 * Math.PI / 180;
  const lon0 = -74.0 * Math.PI / 180;

  const x0_ft = 300000.0;
  const y0_ft = 0.0;

  const a = 6378137.0;
  const f = 1 / 298.257222101;
  const e = Math.sqrt(2 * f - f * f);

  function m(phi) {
    return Math.cos(phi) / Math.sqrt(1 - (e * e) * Math.sin(phi) * Math.sin(phi));
  }

  function t(phi) {
    const sinp = Math.sin(phi);
    const part = (1 - e * sinp) / (1 + e * sinp);
    return Math.tan(Math.PI / 4 - phi / 2) / Math.pow(part, e / 2);
  }

  const m1 = m(lat1);
  const m2 = m(lat2);
  const t1 = t(lat1);
  const t2 = t(lat2);
  const t0 = t(lat0);

  const n = Math.log(m1 / m2) / Math.log(t1 / t2);
  const F = m1 / (n * Math.pow(t1, n));
  const rho0 = a * F * Math.pow(t0, n);

  return { usFtToMeters, lon0, x0_ft, y0_ft, a, F, e, n, rho0 };
})();

function epsg2263ToWGS84(x_ft, y_ft) {
  const { usFtToMeters, lon0, x0_ft, y0_ft, a, F, e, n, rho0 } = proj2263;

  const x = (x_ft - x0_ft) * usFtToMeters;
  const y = (y_ft - y0_ft) * usFtToMeters;

  const rho = Math.sqrt(x * x + (rho0 - y) * (rho0 - y));
  const theta = Math.atan2(x, rho0 - y);
  const tVal = Math.pow(rho / (a * F), 1 / n);

  let phi = Math.PI / 2 - 2 * Math.atan(tVal);
  for (let i = 0; i < 15; i++) {
    const esin = e * Math.sin(phi);
    const phiNext =
      Math.PI / 2 -
      2 * Math.atan(tVal * Math.pow((1 - esin) / (1 + esin), e / 2));
    if (Math.abs(phiNext - phi) < 1e-12) break;
    phi = phiNext;
  }

  const lat = phi * 180 / Math.PI;
  const lon = (lon0 + theta / n) * 180 / Math.PI;

  return [lat, lon];
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
        radius: 2.5,
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

    lines.push(
      L.polyline(pts, {
        color,
        weight: 3,
        opacity: 0.85
      }).bindTooltip(shortName)
    );
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
    for (const s of rows) {
      const lat = safeNumber(s.latitude);
      const lon = safeNumber(s.longitude);
      if (!lat || !lon) continue;

      const desc = s.sign_description || "";
      const U = desc.toUpperCase();

      let color;
      if (U.includes("LANE") || U.includes("ONLY")) color = "#4B0082";
      else if (U.includes("STOP")) color = "#66CCFF";
      else color = "#6c757d";

      const tooltip =
        `${desc}<br>Order #: ${s.order_number || "N/A"}<br>` +
        (s.order_completed_on_date ? `Completed: ${s.order_completed_on_date}` : "");

      markers.push(
        L.circleMarker([lat, lon], {
          radius: 3,
          color,
          fillColor: color,
          fillOpacity: 0.75,
          weight: 1
        }).bindTooltip(tooltip)
      );
    }

    L.layerGroup(markers).addTo(busSignsLayer);
  } catch (e) {
    console.error("Bus signs failed:", e);
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
