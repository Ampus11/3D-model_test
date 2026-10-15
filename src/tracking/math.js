// ---------------------------------------------------------------------------
// math.js — helper vektor, quaternion, dan perhitungan PALM TWIST.
// ------------------------------------------------------------------
// Konvensi ruang:
//   Landmark MediaPipe : x → kanan, y → bawah , z → menjauh (masuk layar)
//   Dunia avatar (Three): x → kanan, y → atas  , z → menuju kamera
//
// Pemetaan arah landmark → dunia memakai M = diag(+1,-1,-1) = rotasi 180°
// mengelilingi sumbu X. Determinan +1 → tetap rotasi proper (aman untuk
// quaternion). Tangan yang MAJU ke kamera → tangan avatar maju ke DEPAN badan.
// ------------------------------------------------------------------
import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

// Ubah vektor arah dari ruang landmark MediaPipe → ruang dunia avatar.
//   x tetap (tangan kanan pengguna ada di kiri gambar mentah = sisi -x avatar,
//            sama dengan posisi lengan kanan avatar di layar)
//   y dibalik (bawah → atas)
//   z dibalik (menjauh dari kamera → ke belakang avatar; mendekat → ke DEPAN)
// M = diag(+1,-1,-1) = rotasi 180° keliling X (det +1, aman untuk quaternion).
export function lmDir(x, y, z, out = new THREE.Vector3()) {
  return out.set(x, -y, -z);
}

export function safeNormalize(v, fallback = null) {
  const l = v.length();
  if (l < 1e-8) return fallback ? v.copy(fallback) : v.set(0, 0, 0);
  return v.multiplyScalar(1 / l);
}

// Quaternion rotasi-minimal (great-circle) dari arah `from` → `to`.
export function quatFromTo(fromDir, toDir, out = new THREE.Quaternion()) {
  return out.setFromUnitVectors(fromDir, toDir);
}

// Quaternion dari tiga sumbu basis ortonormal (kolom x, y, z).
// Harus tangan-kanan: x × y = z.
export function quatFromBasis(x, y, z, out = new THREE.Quaternion()) {
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

// Rotasi yang membawa kerangka (a0, b0) → (a1, b1).
//   a = sumbu utama (mis. arah tulang), b = sumbu sekunder (mis. engsel siku),
//   b diortogonalkan terhadap a. Hasilnya menentukan arah DAN roll tulang.
const _f0 = new THREE.Matrix4();
const _f1 = new THREE.Matrix4();
const _x0 = new THREE.Vector3(), _y0 = new THREE.Vector3(), _z0 = new THREE.Vector3();
const _x1 = new THREE.Vector3(), _y1 = new THREE.Vector3(), _z1 = new THREE.Vector3();
export function quatFromFrames(a0, b0, a1, b1, out = new THREE.Quaternion()) {
  _x0.copy(a0).normalize();
  _y0.copy(b0).addScaledVector(_x0, -b0.dot(_x0));
  _x1.copy(a1).normalize();
  _y1.copy(b1).addScaledVector(_x1, -b1.dot(_x1));
  if (_y0.lengthSq() < 1e-8 || _y1.lengthSq() < 1e-8) return out.setFromUnitVectors(_x0, _x1);
  _y0.normalize();
  _y1.normalize();
  _z0.crossVectors(_x0, _y0);
  _z1.crossVectors(_x1, _y1);
  _f0.makeBasis(_x0, _y0, _z0).transpose(); // invers basis ortonormal
  _f1.makeBasis(_x1, _y1, _z1).multiply(_f0);
  return out.setFromRotationMatrix(_f1);
}

// Komponen TWIST dari quaternion q mengelilingi `axis` (swing-twist decomposition).
export function twistAround(q, axis, out = new THREE.Quaternion()) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  if (out.lengthSq() < 1e-12) return out.identity();
  return out.normalize();
}

// Proyeksi vektor ke bidang yang tegak lurus `axis` (menggunakan dot product).
export function projectOnPlane(v, axis, out = new THREE.Vector3()) {
  return out.copy(v).addScaledVector(axis, -v.dot(axis));
}

// Sudut PUNTIR (twist) bertanda dari `from` ke `to`, mengelilingi `axis`.
//   • cross product → komponen sinus (arah putaran)
//   • dot   product → komponen kosinus (besar sudut)
// Ini inti perhitungan palm twist.
export function signedTwistAroundAxis(axis, from, to) {
  const a = safeNormalize(projectOnPlane(from, axis, _a));
  const b = safeNormalize(projectOnPlane(to, axis, _b));
  const sin = _c.crossVectors(a, b).dot(axis); // cross → sin
  const cos = a.dot(b);                        // dot   → cos
  return Math.atan2(sin, cos);
}

// Normal telapak dari 21 landmark tangan (masih di ruang landmark).
//   a = indexMCP(5) − wrist(0)
//   b = pinkyMCP(17) − wrist(0)
//   c = a × b
// Sisi c bergantung handedness: untuk tangan kanan c menuju PUNGGUNG tangan,
// untuk tangan kiri c menuju TELAPAK. Kita balik agar selalu keluar dari telapak.
export function palmNormalLandmark(lm, isRightHand, out = new THREE.Vector3()) {
  const w = lm[0], im = lm[5], pm = lm[17];
  _a.set(im.x - w.x, im.y - w.y, (im.z ?? 0) - (w.z ?? 0));
  _b.set(pm.x - w.x, pm.y - w.y, (pm.z ?? 0) - (w.z ?? 0));
  out.crossVectors(_a, _b);
  if (isRightHand) out.negate();
  return safeNormalize(out);
}

// Cermin quaternion agar sesuai pemetaan sumbu di atas.
// M = rotasi 180° keliling Z → orientasi dunia = M · R · Mᵀ  (Mᵀ = M).
const MIRROR_M = new THREE.Matrix4().makeRotationZ(Math.PI);
export function mirrorQuat(q, out = new THREE.Quaternion()) {
  _m.makeRotationFromQuaternion(q); // R
  _m.premultiply(MIRROR_M);         // M · R
  _m.multiply(MIRROR_M);            // M · R · Mᵀ
  return out.setFromRotationMatrix(_m);
}

// Cermin khusus untuk orientasi WAJAH. Ruang metrik wajah MediaPipe memakai
// y ke ATAS (bukan ke bawah seperti landmark tangan), sehingga cermin kiri-kanan
// yang benar = konjugasi dengan rotasi 180° mengelilingi sumbu X:
//   yaw & roll dibalik, pitch dibiarkan.
export function mirrorFaceQuat(q, out = new THREE.Quaternion()) {
  return out.set(q.x, -q.y, -q.z, q.w);
}

// Smoothing eksponensial (low-pass filter). lambda besar → makin responsif.
export function dampAlpha(lambda, dt) {
  return 1 - Math.exp(-lambda * dt);
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Ambil orientasi world bone & ubah target world → local (lalu di-slerp).
// parent.getWorldQuaternion() otomatis memperbarui matriks leluhurnya, jadi
// hasilnya konsisten bila bone diproses berurutan dari induk ke anak.
const _pq = new THREE.Quaternion();
export function setWorldQuat(bone, targetWorld, alpha) {
  bone.parent.getWorldQuaternion(_pq);
  _pq.invert().multiply(targetWorld);          // local = parentWorld⁻¹ · targetWorld
  bone.quaternion.slerp(_pq, clamp(alpha, 0, 1));
}