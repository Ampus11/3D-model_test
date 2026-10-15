// ------------------------------------------------------------------
// face.js — tracking wajah (FaceLandmarker) → ekspresi + pose kepala VRM.
// ------------------------------------------------------------------
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import * as THREE from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import { mirrorFaceQuat } from './math.js';

export async function createFaceLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/libs/vision');
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

const MAX_HEAD_ANGLE = THREE.MathUtils.degToRad(55); // batas putaran kepala

// Smoothing adaptif kepala: makin besar selisih sudut, makin cepat mengejar.
// Gerak kecil (getaran) tetap halus, gerak besar (menoleh) langsung responsif.
const HEAD_BOOST = 45;

// Kecepatan ekspresi (λ). Mata harus hampir instan agar kedipan terlihat.
const EXPR_LAMBDA = 40;
const BLINK_LAMBDA = 60;

// Remap skor blendshape [lo..hi] → [0..1]. Skor MediaPipe jarang mencapai 1,
// jadi tanpa remap ekspresi tidak pernah tampil penuh.
const remap = (v, lo, hi) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));

function toMap(cats) {
  const m = {};
  for (const c of cats) m[c.categoryName] = c.score;
  return m;
}

export function createFaceRig(vrm) {
  const head = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);
  const neck = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck);

  vrm.scene.updateMatrixWorld(true);
  const headRestWorld = new THREE.Quaternion();
  const neckRestWorld = new THREE.Quaternion();
  const headRestLocal = head ? head.quaternion.clone() : null;
  const neckRestLocal = neck ? neck.quaternion.clone() : null;
  if (head) head.getWorldQuaternion(headRestWorld);
  if (neck) neck.getWorldQuaternion(neckRestWorld);

  // kalibrasi: orientasi wajah saat dianggap "netral" (frame valid pertama)
  let neutral = null;
  let lastSeen = -1e9;

  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _scl = new THREE.Vector3();
  const _qFace = new THREE.Quaternion();
  const _delta = new THREE.Quaternion();
  const _tmpQ = new THREE.Quaternion();
  const _identity = new THREE.Quaternion();

  function setExpr(name, value) {
    const em = vrm.expressionManager;
    if (!em) return;
    try {
      em.setValue(name, Math.min(1, Math.max(0, value)));
    } catch {
      /* nama ekspresi tidak ada di model → abaikan */
    }
  }

  // ekspresi dengan low-pass ringan (cepat naik/turun, tapi tidak berkedip-kedip)
  const exprVal = {};
  function setExprSmooth(name, target, dt, lambda = EXPR_LAMBDA) {
    const a = 1 - Math.exp(-lambda * dt);
    const cur = exprVal[name] ?? 0;
    const v = cur + (target - cur) * a;
    exprVal[name] = v;
    setExpr(name, v);
  }
  const EXPRS = ['blink', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'surprised'];
  function relaxExpressions(dt) {
    for (const n of EXPRS) setExprSmooth(n, 0, dt, 10);
  }

  function localOf(bone, targetWorld, out) {
    bone.parent.getWorldQuaternion(out); // menyegarkan matriks leluhur
    return out.invert().multiply(targetWorld);
  }

  function resetToRest(alpha) {
    if (head && headRestLocal) head.quaternion.slerp(headRestLocal, alpha);
    if (neck && neckRestLocal) neck.quaternion.slerp(neckRestLocal, alpha);
  }

  return {
    /** paksa kalibrasi ulang pada frame berikutnya */
    calibrate() {
      neutral = null;
    },

    /**
     * @param {object|null} result hasil FaceLandmarker.detectForVideo
     * @param {number} dt detik
     * @param {{enabled?:boolean, lambda?:number, mirrored?:boolean}} opt
     */
    apply(result, dt, opt = {}) {
      const { enabled = true, lambda = 8, mirrored = true, transpose = false } = opt;
      const alpha = Math.min(1, Math.max(0, 1 - Math.exp(-lambda * dt)));
      const now = performance.now();

      if (!enabled) {
        resetToRest(alpha);
        return;
      }

      // --- ekspresi dari blendshape (diremap + dihaluskan) ---
      const cats = result?.faceBlendshapes?.[0]?.categories;
      if (cats && cats.length) {
        const b = toMap(cats);
        const g = (n) => b[n] ?? 0;
        const avg = (l, r) => (g(l) + g(r)) / 2;

        const smile = remap(avg('mouthSmileLeft', 'mouthSmileRight'), 0.15, 0.6);
        const blink = remap(avg('eyeBlinkLeft', 'eyeBlinkRight'), 0.22, 0.55);
        // bentuk mulut (vokal): saling berbagi agar tidak menumpuk
        const oh = remap(g('mouthFunnel'), 0.08, 0.4);
        const ou = remap(g('mouthPucker'), 0.2, 0.65);
        const ee = remap(avg('mouthStretchLeft', 'mouthStretchRight'), 0.08, 0.35);
        const ih = remap(avg('mouthUpperUpLeft', 'mouthUpperUpRight'), 0.1, 0.45) * (1 - smile);
        const aa = remap(g('jawOpen'), 0.03, 0.35) * (1 - 0.6 * Math.max(oh, ou));

        const surprised = remap(g('browInnerUp') * 0.6 + avg('eyeWideLeft', 'eyeWideRight') * 0.4, 0.2, 0.6);
        const angry = remap(avg('browDownLeft', 'browDownRight'), 0.25, 0.6);
        const sad = remap(avg('mouthFrownLeft', 'mouthFrownRight'), 0.12, 0.5) * (1 - smile);

        setExprSmooth('blink', blink * (1 - 0.7 * smile), dt, BLINK_LAMBDA);
        setExprSmooth('aa', aa, dt);
        setExprSmooth('oh', oh * 0.9, dt);
        setExprSmooth('ou', ou * 0.9, dt);
        setExprSmooth('ee', ee * 0.8, dt);
        setExprSmooth('ih', ih * 0.7, dt);
        setExprSmooth('happy', smile, dt);
        setExprSmooth('surprised', surprised * 0.8, dt);
        setExprSmooth('angry', angry * 0.8, dt);
        setExprSmooth('sad', sad * 0.8, dt);
      } else if (now - lastSeen > 500) {
        relaxExpressions(dt);
      }

      const mats = result?.facialTransformationMatrixes;
      const hasFace = !!(mats && mats.length);

      if (hasFace) {
        lastSeen = now;
        // MatrixData MediaPipe default-nya COLUMN_MAJOR → fromArray sudah cocok.
        // Bila terasa terbalik, `transpose` bisa diaktifkan dari panel.
        _m.fromArray(mats[0].data);
        if (transpose) _m.transpose();
        _m.decompose(_pos, _qFace, _scl);
        if (mirrored) mirrorFaceQuat(_qFace, _qFace);

        if (!neutral) neutral = _qFace.clone();
        _delta.copy(_qFace).multiply(_tmpQ.copy(neutral).invert());

        // batasi besar putaran agar tidak ekstrem
        const ang = 2 * Math.acos(Math.min(1, Math.max(-1, _delta.w)));
        if (ang > MAX_HEAD_ANGLE) _delta.slerp(_identity, 1 - MAX_HEAD_ANGLE / ang);

        // kepala: putaran penuh; leher: sebagian (0.5) agar ikut menoleh
        // leher dulu (induk), lalu kepala. Alpha adaptif: selisih besar → kejar cepat.
        if (neck) {
          _tmpQ.copy(_identity).slerp(_delta, 0.45).multiply(neckRestWorld);
          const target = localOf(neck, _tmpQ, _qFace);
          const e = neck.quaternion.angleTo(target);
          neck.quaternion.slerp(target, 1 - Math.exp(-(lambda + HEAD_BOOST * e) * dt));
        }
        if (head) {
          _tmpQ.copy(_delta).multiply(headRestWorld);
          const target = localOf(head, _tmpQ, _qFace);
          const e = head.quaternion.angleTo(target);
          head.quaternion.slerp(target, 1 - Math.exp(-(lambda + HEAD_BOOST * e) * dt));
        }
      } else if (now - lastSeen > 1000) {
        // wajah tak terlihat cukup lama → kembali mulus ke pose bind
        resetToRest(alpha * 0.6);
      }
    },
  };
}