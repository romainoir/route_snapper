#!/usr/bin/env node
/**
 * Fetch Liberty vector tiles from OpenFreeMap, filter the transportation network,
 * and export a GeoJSON linestring network that can be converted into a RouteSnapper map.
 */

const fs = require("fs/promises");
const path = require("path");
const { VectorTile } = require("@mapbox/vector-tile");
const Pbf = require("pbf");

if (typeof fetch !== "function") {
  console.error("Node.js 18+ is required because this script depends on the built-in fetch API.");
  process.exit(1);
}

const OPENFREEMAP_ENDPOINT =
  process.env.OPENFREEMAP_ENDPOINT || "https://tiles.openfreemap.org/planet";

const USAGE = `Usage: node scripts/build-graph.js <lon> <lat> <radius_km> [zoom] [output_prefix]

Examples:
  # Export a 40 km network around Bristol (UK) at zoom 14
  node scripts/build-graph.js -2.5879 51.4545 40

  # Export a denser network (zoom 15) around Berlin and write berlin.geojson
  node scripts/build-graph.js 13.405 52.52 40 15 berlin
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(USAGE);
    process.exit(1);
  }

  const lon = Number(args[0]);
  const lat = Number(args[1]);
  const radiusKm = Number(args[2]);
  const zoom = args[3] ? Number(args[3]) : 14;
  const outputPrefix = args[4] || "liberty";

  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(radiusKm)) {
    console.error("lon, lat, and radius_km must be numbers");
    process.exit(1);
  }
  if (!Number.isFinite(zoom) || zoom < 6 || zoom > 16) {
    console.error("zoom must be a number between 6 and 16");
    process.exit(1);
  }

  console.log(
    `Fetching OpenFreeMap transportation tiles around (${lon.toFixed(5)}, ${lat.toFixed(
      5,
    )}) with a ${radiusKm} km radius at zoom ${zoom}`,
  );

  const tileBbox = computeTileBounds(lon, lat, radiusKm, zoom);
  console.log(
    `Covering tile range x:[${tileBbox.minX}, ${tileBbox.maxX}] y:[${tileBbox.minY}, ${tileBbox.maxY}] (${tileBbox.count} tiles)`,
  );

  const features = [];
  const bounds = {
    minLon: Infinity,
    minLat: Infinity,
    maxLon: -Infinity,
    maxLat: -Infinity,
  };
  let fetched = 0;

  for (let x = tileBbox.minX; x <= tileBbox.maxX; x++) {
    for (let y = tileBbox.minY; y <= tileBbox.maxY; y++) {
      const url = `${OPENFREEMAP_ENDPOINT}/${zoom}/${x}/${y}.pbf`;
      fetched++;
      process.stdout.write(`\rDownloading ${fetched}/${tileBbox.count}: ${url}`);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`\nSkipping ${url}: ${response.status} ${response.statusText}`);
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const tile = new VectorTile(new Pbf(buffer));
        const layer = tile.layers["transportation"];
        if (!layer) {
          continue;
        }
        collectTransportationFeatures({
          layer,
          x,
          y,
          zoom,
          center: { lon, lat },
          radiusKm,
          features,
          bounds,
        });
      } catch (err) {
        console.warn(`\nFailed to download ${url}: ${err}`);
      }
    }
  }
  process.stdout.write("\n");

  console.log(`Retained ${features.length} features inside the search radius.`);

  const featureCollection = {
    type: "FeatureCollection",
    features,
  };

    const outDir = path.join(__dirname, "..", "data");
    await fs.mkdir(outDir, { recursive: true });

    const outPath = path.join(outDir, `${outputPrefix}.geojson`);
    await fs.writeFile(outPath, JSON.stringify(featureCollection, null, 2));
    console.log(`Wrote ${outPath}.`);

    const metadataPath = path.join(outDir, `${outputPrefix}.metadata.json`);
    const metadata = {
      center: { lon, lat },
      radius_km: radiusKm,
      zoom,
      feature_count: features.length,
      bounds,
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    console.log(`Wrote ${metadataPath}.`);

    console.log(
      "Next: convert the GeoJSON to a RouteSnapper graph with:\n" +
        `  cargo run --release --bin geojson-to-route-snapper -- ${outPath} ${path.join(
          outDir,
          `${outputPrefix}.snap.bin`,
        )}`,
    );
}

const ALLOWED_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "service",
  "unclassified",
  "living_street",
  "road",
]);

function collectTransportationFeatures({
  layer,
  x,
  y,
  zoom,
  center,
  radiusKm,
  features,
  bounds,
}) {
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2) {
      continue;
    }
    const properties = feature.properties || {};
    if (properties.brunnel === "tunnel") {
      // Tunnels often duplicate surface roads; skip to keep the demo lightweight.
      continue;
    }
    if (properties.class && !ALLOWED_CLASSES.has(properties.class)) {
      continue;
    }

    const geom = feature.loadGeometry();
    for (const line of geom) {
      const coords = line.map((pt) => tilePointToLonLat({
        tileX: x,
        tileY: y,
        zoom,
        extent: layer.extent,
        x: pt.x,
        y: pt.y,
      }));
      if (coords.length < 2) {
        continue;
      }
      if (!lineWithinRadius(coords, center, radiusKm)) {
        continue;
      }
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
        },
        properties: {
          class: properties.class || null,
          name: properties.name || null,
        },
      });
      for (const [lon, lat] of coords) {
        bounds.minLon = Math.min(bounds.minLon, lon);
        bounds.maxLon = Math.max(bounds.maxLon, lon);
        bounds.minLat = Math.min(bounds.minLat, lat);
        bounds.maxLat = Math.max(bounds.maxLat, lat);
      }
    }
  }
}

function tilePointToLonLat({ tileX, tileY, zoom, extent, x, y }) {
  const worldSize = Math.pow(2, zoom);
  const lon = ((tileX + x / extent) / worldSize) * 360 - 180;
  const y2 = tileY + y / extent;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y2) / worldSize)));
  const lat = (latRad * 180) / Math.PI;
  return [lon, lat];
}

function lineWithinRadius(coords, center, radiusKm) {
  const radiusMeters = radiusKm * 1000;
  const radiusSquared = radiusMeters * radiusMeters;
  const centerCartesian = projectToCartesian(center.lon, center.lat);
  for (const [lon, lat] of coords) {
    const ptCartesian = projectToCartesian(lon, lat);
    const dx = ptCartesian.x - centerCartesian.x;
    const dy = ptCartesian.y - centerCartesian.y;
    const dz = ptCartesian.z - centerCartesian.z;
    if (dx * dx + dy * dy + dz * dz <= radiusSquared) {
      return true;
    }
  }
  return false;
}

function projectToCartesian(lon, lat) {
  const radLon = (lon * Math.PI) / 180;
  const radLat = (lat * Math.PI) / 180;
  const earthRadius = 6371000;
  const cosLat = Math.cos(radLat);
  return {
    x: earthRadius * cosLat * Math.cos(radLon),
    y: earthRadius * cosLat * Math.sin(radLon),
    z: earthRadius * Math.sin(radLat),
  };
}

function computeTileBounds(lon, lat, radiusKm, zoom) {
  const earthRadiusKm = 6371.0088;
  const radDist = radiusKm / earthRadiusKm;
  const latRad = (lat * Math.PI) / 180;
  const minLat = lat - (radDist * 180) / Math.PI;
  const maxLat = lat + (radDist * 180) / Math.PI;
  const deltaLon = Math.asin(Math.sin(radDist) / Math.cos(latRad));
  const minLon = lon - (deltaLon * 180) / Math.PI;
  const maxLon = lon + (deltaLon * 180) / Math.PI;

  const minTile = lonLatToTile(minLon, maxLat, zoom);
  const maxTile = lonLatToTile(maxLon, minLat, zoom);

  const minX = clampTile(minTile.x, zoom);
  const maxX = clampTile(maxTile.x, zoom);
  const minY = clampTile(minTile.y, zoom);
  const maxY = clampTile(maxTile.y, zoom);
  const count = (maxX - minX + 1) * (maxY - minY + 1);

  return { minX, maxX, minY, maxY, count };
}

function clampTile(v, zoom) {
  const maxIndex = Math.pow(2, zoom) - 1;
  return Math.max(0, Math.min(maxIndex, v));
}

function lonLatToTile(lon, lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
