# Changelog

## Unreleased

### Added
- Enum and bitmask names in plot legends, from PX4's message definitions.
- ESC error count type names in plot legends, with decoded CAN TEC and REC fields per ESC.
- Click-to-expand Info values, with JSON pretty-printed.
- Center on Vehicle button in Replay; larger vehicle marker.
- Replay readouts lead with the key number of each group.
- Parameter descriptions, ranges, units and value meanings from the PX4 parameter reference.

### Fixed
- A new plot starting at the full log instead of the other plots' zoom.
- Replay jumping when the speed is changed during playback.
- Large Y-axis values cut off at the left edge of a plot.

## 0.0.7

### Added
- Log start timestamp in the header.
- Derived roll, pitch, and yaw fields from quaternions.
- Constant values and min/max ranges beside fields.
- Multiple battery displays in Replay.
- Draggable, hideable marker legends.

### Fixed
- Numeric ordering of topic instances.
- Overlapping marker timestamps.
- Field names disappearing in narrow topic panels.
