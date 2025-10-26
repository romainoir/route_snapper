# OpenFreeMap + RouteSnapper demo

This folder contains a self-contained example that downloads the Liberty vector tiles from [OpenFreeMap](https://openfreemap.org), turns them into a RouteSnapper graph, and hosts a MapLibre demo that lets you draw snapped routes inside the downloaded area.

## Prerequisites

* Rust toolchain (for `geojson-to-route-snapper`)
* Node.js 18 or newer
* `wasm-pack` (only required if you want to rebuild the WASM bindings locally instead of loading them from a CDN)

## 1. Fetch Liberty tiles and build a GeoJSON network

```
cd openfreemap-demo
npm install
node scripts/build-graph.js <lon> <lat> <radius_km> [zoom] [output_prefix]
```

For example, to cover a 40 km radius around Berlin at zoom level 14:

```
node scripts/build-graph.js 13.4050 52.5200 40
```

The script will download all `transportation` features from the Liberty tiles intersecting the circle, filter out walking/cycling paths to keep the graph lightweight, and write the result to `data/liberty.geojson`. It also records a bounding box and the input parameters in `data/liberty.metadata.json`. You can change the output prefix (for example `berlin`) by passing it as the last argument.

If you want to use a private mirror of the tiles, set the `OPENFREEMAP_ENDPOINT` environment variable to the tile base URL (the script appends `/{z}/{x}/{y}.pbf`).

## 2. Convert the GeoJSON into a RouteSnapper graph

Use the Rust CLI that ships in this repository to convert the network to a `.snap.bin` file and copy the metadata into `public/`:

```
cargo run --release --bin geojson-to-route-snapper -- data/liberty.geojson public/liberty.snap.bin
cp data/liberty.metadata.json public/liberty.metadata.json
```

This produces the binary that the browser demo loads directly and mirrors the metadata so the UI can auto-center and display statistics.

## 3. Host the MapLibre demo

The `public` folder contains a lightweight HTML page that loads the [RouteSnapper WASM bundle from npm](https://www.npmjs.com/package/route-snapper), the Liberty MapLibre style, and the `liberty.snap.bin` file you generated in the previous step. If you exported a different prefix (for example `berlin.snap.bin` and `berlin.metadata.json`), pass `?graph=berlin` in the URL.

```
python3 -m http.server --directory public
```

Then open `http://localhost:8000` and start drawing routes. Use the **Route snapper** control in the top right corner to enable snapping and the buttons in the top left corner to clear or download the captured routes.

### Rebuilding the WASM locally (optional)

By default the demo loads `route-snapper@0.4.9` from the CDN. If you prefer to work with the local sources, run:

```
cd ..
wasm-pack build --release --target web route-snapper
```

Then copy the generated `route-snapper/pkg` directory into `openfreemap-demo/public/route-snapper` and replace the CDN import in `public/index.html` with a relative path import (mirroring how `examples/index.html` in this repository works).

## Output structure

```
openfreemap-demo/
  data/                # GeoJSON extracts and generated snap.bin files (ignored by git)
  public/
    index.html         # MapLibre demo
    liberty.snap.bin   # Generated in step 2
    liberty.metadata.json # Copied from data/ if you want the demo to auto-center
  scripts/
    build-graph.js     # Tile downloader and GeoJSON builder
```

The `serve` npm script starts a Python static server from the `public` folder, but you can use any static file host.

