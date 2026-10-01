// geometry.js: controllers relative to Steam's VR keyboard
// (vr-keyboard-controllers.nix). Pure functions, used by bridge-patch.js
// (SteamVR systemui) and tests; consumers may take it as an extraArg too.
// Evaluates to { VERSION, rotate, multiply, tipPose, toKeyboard, rayHit,
// rotationDegrees }.
//
// Poses are SteamVR transforms { translation: {x,y,z}, rotation: {w,x,y,z} }.
// - tipPose(device, tip): the controller's tip, where SteamVR's laser starts
//   (the laser mouse's pose is /pose/tip): the device pose
//   (xfDeviceToAbsoluteTracking) times the render model's "tip" component
//   (xfTrackingToComponentLocal), or the device pose without one.
// - Keyboard kb = { translation, rotation, width }: its top edge centre in
//   tracking space, +z toward the viewer, width in m (bridge-patch.js).
//   Keyboard coordinates: u 0..1 left to right, v down from the top edge in
//   keyboard widths (page px = u * page width, v * page width).
// - toKeyboard(p, kb): a point -> { u, v, d } (d: m behind the surface).
// - rayHit(pose, kb): the laser (the pose's -z axis) on the keyboard's
//   plane, from the front -> { u, v, dist (m) } or null.
(() => {
  const VERSION = 1;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  // v rotated by the unit quaternion q.
  function rotate(q, v) {
    const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
    return {
      x: v.x + q.w * tx + q.y * tz - q.z * ty,
      y: v.y + q.w * ty + q.z * tx - q.x * tz,
      z: v.z + q.w * tz + q.x * ty - q.y * tx,
    };
  }
  const qmul = (a, b) => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
  const conj = (q) => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });
  // a * b (b in a's frame).
  const multiply = (a, b) => ({ translation: add(a.translation, rotate(a.rotation, b.translation)), rotation: qmul(a.rotation, b.rotation) });
  const tipPose = (device, tip) => (tip ? multiply(device, tip) : { translation: { ...device.translation }, rotation: { ...device.rotation } });
  const local = (p, kb) => rotate(conj(kb.rotation), sub(p, kb.translation));

  function toKeyboard(p, kb) {
    const l = local(p, kb);
    return { u: l.x / kb.width + 0.5, v: -l.y / kb.width, d: -l.z };
  }
  function rayHit(pose, kb) {
    const o = local(pose.translation, kb), dir = rotate(conj(kb.rotation), rotate(pose.rotation, { x: 0, y: 0, z: -1 }));
    if (o.z <= 0 || dir.z >= -1e-6) return null;       // behind the plane or not pointing at its front
    const t = -o.z / dir.z;
    return { u: (o.x + t * dir.x) / kb.width + 0.5, v: -(o.y + t * dir.y) / kb.width, dist: t };
  }
  // Rotation angle of a quaternion (degrees), e.g. of an animated render
  // model component (the trigger).
  const rotationDegrees = (q) => (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;

  return { VERSION, rotate, multiply, tipPose, toKeyboard, rayHit, rotationDegrees };
})()
