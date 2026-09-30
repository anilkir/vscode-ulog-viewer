/** PX4 Hamilton quaternions, body to reference frame, aerospace ZYX angles. */
export function quaternionToRpy(w: number, x: number, y: number, z: number): [number, number, number] {
  const invalid: [number, number, number] = [NaN, NaN, NaN];
  if (![w, x, y, z].every(Number.isFinite)) return invalid;
  const norm = Math.hypot(w, x, y, z);
  // Allow rounding/drift in unit quaternions, not arbitrary four-vectors.
  if (Math.abs(norm - 1) > 0.01) return invalid;
  w /= norm; x /= norm; y /= norm; z /= norm;
  const sinPitch = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  const pitch = Math.asin(sinPitch);
  // At gimbal lock roll and yaw cannot be uniquely recovered.
  if (1 - Math.abs(sinPitch) < 1e-10) return [NaN, Math.sign(sinPitch) * Math.PI / 2, NaN];
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    pitch,
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  ];
}

const attitudeTopics = new Set([
  "vehicle_attitude", "estimator_attitude", "vehicle_attitude_groundtruth", "external_ins_attitude",
]);
const setpointTopics = new Set([
  "vehicle_attitude_setpoint", "mc_virtual_attitude_setpoint", "fw_virtual_attitude_setpoint",
]);
export const odometryTopics = new Set([
  "vehicle_odometry", "estimator_odometry", "vehicle_visual_odometry", "vehicle_mocap_odometry",
]);
export function quaternionSource(topic: string): string | undefined {
  if (attitudeTopics.has(topic) || odometryTopics.has(topic)) return "q";
  if (setpointTopics.has(topic)) return "q_d";
  return undefined;
}

export function rpyDescription(source: string): string {
  return `Computed from logged ${source}[0…3], not directly logged.`;
}
