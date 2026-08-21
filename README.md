# PX4 ULog Viewer

Open and inspect PX4 ULog flight logs (`.ulg` and `.ulog`) directly in VS Code.
The extension replaces the binary file view with an interactive log viewer for
quick flight-data inspection.

## Getting started

1. Install **PX4 ULog Viewer** from the VS Code Marketplace.
2. Open a folder containing a `.ulg` or `.ulog` log file.
3. Open the log file from the Explorer, or select the **ULog Viewer** icon in
   the Activity Bar and choose a file from the list.

You can also run **ULog Viewer: Open ULog File** from the Command Palette to
open a log from anywhere on disk.

## Explore a flight log

The viewer provides the following sections:

- **Data**: browse logged topics and select numeric fields to chart them.
  Add plot panels to compare signals; their time axes stay synchronized.
  Drag to zoom, double-click a chart, or select **Reset zoom** to restore the
  full time range. The **Topics** button in the plot toolbar collapses the
  topic list to give the plots the full width. If the log contains raw GNSS
  communication (`gps_dump`, enabled with `GPS_DUMP_COMM`), it is decoded
  into per-direction protocol message counts (UBX, RTCM3, NMEA, SBF) shown
  under the topic, and each message type gets a plottable "gap" series —
  seconds since that type's previous frame — for spotting periods where a
  message stopped arriving. Message *contents* are not decoded; to inspect
  them, extract the raw streams with pyulog's `ulog_extract_gps_dump` and
  use a protocol tool such as u-blox u-center.
- **Replay**: replay the flight trajectory from a log on a 2D top-down map
  with HUD overlay showing critical flight data.
- **Info**: review log metadata, duration, software and hardware versions,
  and information entries recorded by the vehicle.
- **Parameters**: search logged parameters and inspect any values that
  changed during flight, including their timestamped history.
- **Messages**: view the onboard log console, including `PX4_INFO`,
  `PX4_WARN`, and `PX4_ERR` messages.
- **Structure**: inspect the raw ULog file internals like file layout and
  section sizes, compatibility flags, message-type and log-level counts, all
  format definitions, every logged subscription, and any dropout events.

Press `Ctrl+F` (`Cmd+F` on macOS) on any tab to jump to its search box: the
topic filter on Data, the parameter and message filters on their tabs, and
a content filter on Info and Structure.



## Supported files

PX4 ULog files with `.ulg` and `.ulog` extensions are supported. Logs remain
on your machine; the extension reads them locally in VS Code.

## License

Copyright 2026 Anil Kircaliali. All rights reserved.

