# Development

## Setup

```sh
npm install
npm run build      # bundle extension + webview into dist/
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
```

Press **F5** in VS Code ("Run Extension") to launch an Extension Development
Host, then open any `.ulg` file. Press **ctrl+R** on an open Extension Development
Host to reload it during development.

## Updating the PX4 reference data

Parameter descriptions and enum/bitmask names are not in a ULog, so the
extension bundles two tables generated from upstream PX4. Refresh them before
building a release (needs network access and `git`):

```sh
node scripts/update-px4-params.mjs   # -> src/px4Parameters.json
node scripts/update-px4-msgs.mjs     # -> src/px4Messages.json
npm run build
```

(`npm run update-params` / `npm run update-msgs` do the same.) Commit the
regenerated JSON files; the build only bundles what is on disk.

- **Parameters** come from the `parameters.json` PX4's CI publishes with each
  build, the same metadata the docs.px4.io parameter reference is generated
  from: `https://px4-travis.s3.amazonaws.com/Firmware/<version>/_general/parameters.json`.
  The script finds the versions itself: the latest release is the reference,
  and `main`, the newest pre-release and older releases only fill in
  parameters it doesn't have. Each entry records its version, which the
  Parameters tab shows.
- **Enum/bitmask names** come from the `.msg` files in
  <https://github.com/PX4/px4_msgs>, branches `main`, `release/1.16`,
  `release/1.15` and `release/1.14`.

Both keep the last definition of anything renamed or removed upstream. To
add a px4_msgs branch, edit the list at the top of that script.

## Architecture

- `src/extension.ts` — activation; registers the custom editor and the
  activity bar tree view.
- `src/ulogFilesViewProvider.ts` — the "ULog Files" webview and its open-file
  commands.
- `src/ulogEditorProvider.ts` — `CustomReadonlyEditorProvider` for the
  `ulogViewer.ulog` view type. Parses logs with
  [`@foxglove/ulog`](https://github.com/foxglove/ulog) in the extension host,
  builds a JSON summary for the webview, and serves time-series data on
  demand (extracted once per topic, cached, transferred as `ArrayBuffer`s).
- `src/ulogData.ts` — summary building and per-topic time-series extraction.
- `src/paramScan.ts` — a single low-level pass over the data section (using
  only `@foxglove/ulog`'s public primitives, not its full message parser) that
  recovers the true flight time range and mid-flight parameter changes.
  See the comment at the top of the file for why this can't be done through
  the library's normal `readMessages()` API — in short, its full-struct
  parser throws on some real-world non-PX4-native topics (companion-computer
  metrics), and there's a latent bug in its `computeTimetampOffset` helper
  that only surfaces for topics that don't put `timestamp` first.
- `src/px4Parameters.json`, `src/px4Messages.json` — generated reference
  tables bundled into the extension host: the PX4 parameter reference, and
  the names of enum/bitmask field values from PX4's `.msg` definitions (a
  ULog carries neither). Regenerate from upstream with
  `node scripts/update-px4-params.mjs` and `node scripts/update-px4-msgs.mjs`;
  both describe upstream PX4, not the firmware that wrote a given log.
- `src/protocol.ts` — typed message protocol between host and webview.
- `src/webview/main.ts` — the viewer UI; charts rendered with
  [uPlot](https://github.com/leeoniya/uPlot), synced across plot panels via
  its built-in cursor/scale sync.

Parsing stays in the extension host so the webview only ever receives
display-ready data; new views (maps, flight-mode timelines, …) can be added by
extending the protocol.

## TODO

- Remove the display/hide buttons for each series on the bottom and overlay that
  functionality to the top elements with X to save vertical stacking space
- A way to "look for anomalies in this time period"
- GPS ground track / map view
- Flight-mode and failsafe timeline overlays on plots
- Vehicle attitude / 3D view
- Plot panel layouts (and selected series) persisted per file
- Parameter diff between two logs
- Downsampling for very large logs; streaming extraction with progress
- A stacked plot mode where multiple plots can be put on a vertically stacked display to save space and show more data on a common timeframe
- A way to change the displayed units/scale on plots, e.g. change 0.91 to 91%, change m/s to mph, etc.
