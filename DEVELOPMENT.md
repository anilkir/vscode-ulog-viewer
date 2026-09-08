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
- `src/protocol.ts` — typed message protocol between host and webview.
- `src/webview/main.ts` — the viewer UI; charts rendered with
  [uPlot](https://github.com/leeoniya/uPlot), synced across plot panels via
  its built-in cursor/scale sync.

Parsing stays in the extension host so the webview only ever receives
display-ready data; new views (maps, flight-mode timelines, …) can be added by
extending the protocol.

## TODO

- Log start timestamp displayed next to log name in header
- If a new plot is added while others are zoomed in with markers, then markers
  on new plot's default range could overflow from the view area which can 
  stop the plot from being dragged to a different spot in the order
- Remove the display/hide buttons for each series on the bottom and overlay that
  functionality to the top elements with X to save vertical stacking space
- A way to "look for anomalies in this time period"
- Add an internal reference for PX4 parameters in different PX4 versions
- GPS ground track / map view
- Flight-mode and failsafe timeline overlays on plots
- Vehicle attitude / 3D view
- Plot panel layouts (and selected series) persisted per file
- Parameter diff between two logs
- Downsampling for very large logs; streaming extraction with progress
- Marker legend should be movable to left/right and hideable
- Add a quick integer display next to topic names if the value is constant throughout the log, don't display it if the value changes
- Topics are listed where the order goes [0] [1] [10] [11] [2], we should order them properly
- A stacked plot mode where multiple plots can be put on a vertically stacked display to save space and show more data on a common timeframe
- A way to convert quaternion in attitude message to RPY for plots
- A way to change the displayed units/scale on plots, e.g. change 0.91 to 91%, change m/s to mph, etc.
