// ------------------------------------------------------------------
// pose.js — tracking badan (PoseLandmarker) → bahu, siku, pergelangan.
// ------------------------------------------------------------------
//  HandLandmarker hanya tahu bentuk TANGAN; letak siku & bahu tidak ada.
//  PoseLandmarker memberi titik 3D (meter) bahu-siku-pergelangan sungguhan,
//  sehingga arah lengan atas/bawah & tekukan siku mengikuti tubuh pengguna.
// ------------------------------------------------------------------
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import * as THREE from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import { lmDir, setWorldQuat, quatFromFrames } from './math.js';

export async function createPoseLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/libs/vision');
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

// Indeks landmark pose. "kanan" = kanan PENGGUNA → lengan kanan avatar.
export const POSE_ARM = {
  right: { s: 12, e: 14, w: 16, pinky: 18, index: 20 },
  left: { s: 11, e: 13, w: 15, pinky: 17, index: 19 },
};

export const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 19], [16, 18], [16, 20],
  [11, 23], [12, 24], [23, 24],
];

const VIS_MIN = 0.5;
const HOLD_MS = 300; // pertahankan pose terakhir sebentar bila deteksi hilang

/**
 * Filter low-pass untuk world landmark pose. Titik langsung dikonversi ke
 * ruang dunia avatar (lmDir), lalu dihaluskan dengan lerp antar-frame.
 */
export function createPoseFilter() {
  const pts = [];
  const vis = new Float32Array(33);
  let valid = false;
  let lastSeen = -1e9;
  const _p = new THREE.Vector3();

  const f = {
    pts,
    vis,
    image: null, // landmark ternormalisasi (untuk mencocokkan tangan)
    get valid() {
      return valid;
    },
    visible(...ids) {
      return valid && ids.every((i) => vis[i] > VIS_MIN);
    },
    reset() {
      valid = false;
    },
    update(result, alpha) {
      const w = result?.worldLandmarks?.[0];
      const n = result?.landmarks?.[0];
      if (!w || !n) {
        if (performance.now() - lastSeen > HOLD_MS) valid = false;
        return valid ? f : null;
      }
      lastSeen = performance.now();
      for (let i = 0; i < w.length; i++) {
        lmDir(w[i].x, w[i].y, w[i].z, _p);
        if (!pts[i] || !valid) pts[i] = _p.clone();
        else pts[i].lerp(_p, alpha);
        vis[i] = n[i].visibility ?? w[i].visibility ?? 1;
      }
      f.image = n;
      valid = true;
      return f;
    },
  };
  return f;
}

/**
 * BADAN ATAS: condong maju/mundur, miring kiri/kanan, & memutar badan.
 *
 *  Kerangka badan dibangun dari pose:
 *    up     = tengah pinggul → tengah bahu   (condong maju/mundur & miring)
 *    across = bahu kanan → bahu kiri          (memutar & miring)
 *  Rotasi = quatFromFrames(kerangka bind → kerangka live), relatif terhadap
 *  posisi NETRAL hasil kalibrasi (meniadakan kemiringan webcam / postur duduk).
 *  Rotasi dibagi ke spine → chest → upperChest agar badan melengkung alami.
 *  Bila pinggul tak terlihat (duduk dekat webcam), dipakai garis bahu saja.
 */
const BODY_MAX = THREE.MathUtils.degToRad(45);
const CALIB_FRAMES = 15;
const HIP_VIS = 0.5;

export function createBodyRig(vrm) {
  vrm.scene.updateMatrixWorld(true);
  const get = (n) => vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName[n]);
  const lU = get('LeftUpperArm');
  const rU = get('RightUpperArm');
  const cap = (bone) =>
    bone ? { bone, restWorld: bone.getWorldQuaternion(new THREE.Quaternion()), restLocal: bone.quaternion.clone() } : null;
  const chain = [cap(get('Spine')), cap(get('Chest')), cap(get('UpperChest'))].filter(Boolean);
  if (!chain.length || !lU || !rU) return { apply() {}, calibrate() {} };
  // porsi kumulatif rotasi per ruas (ruas teratas selalu = 1)
  const SHARE = { 1: [1], 2: [0.5, 1], 3: [0.4, 0.75, 1] }[chain.length];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  lU.getWorldPosition(a);
  rU.getWorldPosition(b);
  const shoulderMid = a.clone().add(b).multiplyScalar(0.5);
  const restAcross = a.sub(b).normalize(); // bahu kanan → bahu kiri
  const hipsBone = get('Hips');
  const restUp = new THREE.Vector3(0, 1, 0);
  if (hipsBone) {
    const hp = hipsBone.getWorldPosition(new THREE.Vector3());
    if (shoulderMid.distanceTo(hp) > 1e-4) restUp.subVectors(shoulderMid, hp).normalize();
  }

  const I = new THREE.Quaternion();
  const _q = new THREE.Quaternion();
  const _t = new THREE.Quaternion();
  const _inv = new THREE.Quaternion();
  const _across = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _m1 = new THREE.Vector3();

  // netral terpisah untuk mode "bahu+pinggul" dan "bahu saja"
  const neutral = [null, null];
  const calibN = [0, 0];

  function rest(alpha) {
    for (const c of chain) c.bone.quaternion.slerp(c.restLocal, alpha);
  }

  return {
    /** set ulang posisi netral (duduk/berdiri tegak lalu tekan) */
    calibrate() {
      neutral[0] = neutral[1] = null;
      calibN[0] = calibN[1] = 0;
    },

    apply(pose, dt, opt = {}) {
      const { enabled = true, lambda = 10, amount = 1 } = opt;
      const alpha = Math.min(1, Math.max(0, 1 - Math.exp(-lambda * dt)));
      if (!enabled || !pose || !pose.visible(11, 12)) {
        rest(alpha * 0.6);
        return;
      }
      const P = pose.pts;
      _across.subVectors(P[11], P[12]);
      if (_across.lengthSq() < 1e-6) return;
      _across.normalize();

      const hipsOk = pose.vis[23] > HIP_VIS && pose.vis[24] > HIP_VIS;
      if (hipsOk) {
        _up.addVectors(P[11], P[12]).multiplyScalar(0.5).sub(_m1.addVectors(P[23], P[24]).multiplyScalar(0.5));
        if (_up.lengthSq() < 1e-6) return;
        quatFromFrames(restUp, restAcross, _up.normalize(), _across, _q);
      } else {
        _q.setFromUnitVectors(restAcross, _across); // hanya menoleh & miring
      }

      // kalibrasi netral: rata-rata beberapa frame pertama
      const k = hipsOk ? 0 : 1;
      if (calibN[k] < CALIB_FRAMES) {
        if (!neutral[k]) neutral[k] = _q.clone();
        else neutral[k].slerp(_q, 1 / (calibN[k] + 1));
        calibN[k]++;
      }
      _q.multiply(_inv.copy(neutral[k]).invert()); // delta terhadap netral

      if (amount !== 1) _q.copy(_t.copy(I).slerp(_q, Math.max(0, amount)));
      const ang = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
      if (ang > BODY_MAX) _q.slerp(I, 1 - BODY_MAX / ang);

      for (let i = 0; i < chain.length; i++) {
        const c = chain[i];
        setWorldQuat(c.bone, _t.copy(I).slerp(_q, SHARE[i]).multiply(c.restWorld), alpha);
      }
    },
  };
}
