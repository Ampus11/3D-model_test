// ------------------------------------------------------------------
// hands.js — lengan + tangan + jari avatar.
// ------------------------------------------------------------------
//  Sumber data (prioritas):
//   1. PoseLandmarker  → arah lengan atas & bawah dari titik bahu-siku-pergelangan
//      ASLI (3D, meter). Inilah yang membuat gerak lengan terasa manusiawi.
//   2. Fallback IK 2-tulang dari posisi pergelangan bila pose tidak terlihat.
//   3. HandLandmarker (worldLandmarks, meter) → orientasi telapak + semua jari.
//
//  Roll lengan memakai KERANGKA ENGSEL SIKU (sumbu tulang + sumbu engsel),
//  bukan rotasi minimal, sehingga lengan tidak "terpelintir". Separuh puntiran
//  pergelangan dibagi ke lengan bawah (seperti radius/ulna manusia).
// ------------------------------------------------------------------
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import * as THREE from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  lmDir, safeNormalize, quatFromTo, quatFromFrames, twistAround,
  signedTwistAroundAxis, setWorldQuat,
} from './math.js';
import { POSE_ARM } from './pose.js';

export async function createHandLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/libs/vision');
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

// Definisi rantai jari: nama tulang VRM + indeks landmark [pangkal..ujung].
const FINGER_DEFS = [
  { bones: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'], lms: [1, 2, 3, 4] },
  { bones: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'], lms: [5, 6, 7, 8] },
  { bones: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'], lms: [9, 10, 11, 12] },
  { bones: ['RingProximal', 'RingIntermediate', 'RingDistal'], lms: [13, 14, 15, 16] },
  { bones: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'], lms: [17, 18, 19, 20] },
];

// --- parameter fallback IK (dipakai hanya bila pose tidak terlihat) ---
const REACH = 0.30;   // jarak layar (ternormalisasi) = jangkauan penuh
const FORWARD = 0.18; // dorong target ke DEPAN badan
const FOREARM_TWIST_SHARE = 0.5; // porsi puntiran pergelangan yang dibawa lengan bawah
const VIDEO_ASPECT = 640 / 480;  // untuk koreksi koordinat gambar bila worldLandmarks tak ada

// --- ketahanan saat tangan saling menutupi / menyatu ---
const HAND_HOLD_MS = 450;          // tahan pose tangan terakhir bila deteksi hilang/meragukan
const OUTLIER_RAD = THREE.MathUtils.degToRad(110); // lonjakan orientasi per-frame dianggap salah deteksi
const OUTLIER_MAX = 3;             // …tapi setelah 3 frame berturut-turut dianggap gerakan asli
const DUP_DIST = 0.035;            // rata-rata jarak landmark (ternormalisasi) → deteksi ganda
const CLOSE_DIST = 0.25;           // pergelangan sedekat ini = situasi ambigu (tangan menyatu)
const LABEL_MIN = 0.6;             // skor handedness minimum agar labelnya dipakai

const Z_FWD = new THREE.Vector3(0, 0, 1);

function captureBone(bone) {
  if (!bone) return null;
  const worldPos = new THREE.Vector3();
  bone.getWorldPosition(worldPos);
  const restWorld = new THREE.Quaternion();
  bone.getWorldQuaternion(restWorld);
  return { bone, worldPos, restWorld, restLocal: bone.quaternion.clone(), restDir: null };
}

// IK dua tulang: cari arah tulang atas & bawah agar ujung mencapai `target`.
function solveTwoBoneIK(shoulder, target, L1, L2, pole, outUpper, outFore) {
  const axis = target.clone().sub(shoulder);
  let d = axis.length();
  d = Math.min(L1 + L2 - 1e-3, Math.max(Math.abs(L1 - L2) + 1e-3, d));
  axis.normalize();
  const bend = pole.clone().addScaledVector(axis, -pole.dot(axis));
  if (bend.lengthSq() < 1e-6) bend.crossVectors(axis, new THREE.Vector3(0, 0, 1));
  if (bend.lengthSq() < 1e-6) bend.crossVectors(axis, new THREE.Vector3(1, 0, 0));
  bend.normalize();
  const cosA = Math.min(1, Math.max(-1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  const a = Math.acos(cosA);
  outUpper.copy(axis).multiplyScalar(Math.cos(a)).addScaledVector(bend, Math.sin(a)).normalize();
  const elbow = shoulder.clone().addScaledVector(outUpper, L1);
  outFore.copy(shoulder).addScaledVector(axis, d).sub(elbow).normalize();
}

export function createHandRig(vrm, camera) {
  vrm.scene.updateMatrixWorld(true);

  function buildSide(side) {
    const C = side === 'right' ? 'Right' : 'Left';
    const get = (part) => vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName[C + part]);

    const upperArm = captureBone(get('UpperArm'));
    const lowerArm = captureBone(get('LowerArm'));
    const hand = captureBone(get('Hand'));
    if (!upperArm || !lowerArm || !hand) return null;

    upperArm.restDir = safeNormalize(lowerArm.worldPos.clone().sub(upperArm.worldPos), new THREE.Vector3(0, -1, 0));
    lowerArm.restDir = safeNormalize(hand.worldPos.clone().sub(lowerArm.worldPos), new THREE.Vector3(0, -1, 0));
    const L1 = upperArm.worldPos.distanceTo(lowerArm.worldPos);
    const L2 = lowerArm.worldPos.distanceTo(hand.worldPos);

    // engsel siku saat T-pose: siku menekuk ke DEPAN → sumbu = arahLengan × depan
    const hingeRest = safeNormalize(new THREE.Vector3().crossVectors(upperArm.restDir, Z_FWD), new THREE.Vector3(0, 1, 0));

    // kerangka tangan saat bind (untuk palm twist)
    const idxB = captureBone(get('IndexProximal'));
    const midB = captureBone(get('MiddleProximal'));
    const litB = captureBone(get('LittleProximal'));
    hand.restForward = midB ? safeNormalize(midB.worldPos.clone().sub(hand.worldPos), new THREE.Vector3(0, 1, 0)) : null;
    hand.restAcross = idxB && litB ? safeNormalize(litB.worldPos.clone().sub(idxB.worldPos), new THREE.Vector3(1, 0, 0)) : null;

    const shoulder = upperArm.worldPos.clone();
    const ndc = shoulder.clone().project(camera);
    const shoulderScreen = new THREE.Vector2((ndc.x + 1) / 2, (1 - ndc.y) / 2);

    const fingers = [];
    for (const def of FINGER_DEFS) {
      const caps = def.bones.map((b) => captureBone(get(b)));
      for (let k = 0; k < caps.length; k++) {
        const c = caps[k];
        if (!c) continue;
        const next = caps[k + 1];
        const prev = caps[k - 1] || hand;
        const dir = next ? next.worldPos.clone().sub(c.worldPos) : c.worldPos.clone().sub(prev.worldPos);
        c.restDir = safeNormalize(dir, new THREE.Vector3(0, 1, 0));
        c.lmPair = [def.lms[k], def.lms[k + 1]];
        fingers.push(c);
      }
    }

    const rig = {
      side, upperArm, lowerArm, hand, fingers, L1, L2, shoulder, shoulderScreen,
      hingeRest, hinge: hingeRest.clone(), idleHinge: hingeRest.clone(), target: null,
      // status pelacakan tangan (anti-glitch)
      lastQHand: null, handSeenAt: -1e9, outliers: 0, prevWrist: null,
      lastResult: null, lastAccepted: false,
    };
    computeIdle(rig);
    return rig;
  }

  // ---------- POSE DIAM (idle) ----------
  //  Lengan turun di samping badan, siku sedikit menekuk ke depan, jari agak
  //  melengkung. Dipakai saat awal dimuat & saat tracking tidak mendeteksi apa-apa.
  function computeIdle(rig) {
    const side = Math.sign(rig.upperArm.restDir.x) || 1; // -1 lengan kanan, +1 kiri
    const up = new THREE.Vector3(side * 0.14, -1, 0.03).normalize();
    const fore = new THREE.Vector3(side * 0.06, -1, 0.32).normalize();
    const hinge = new THREE.Vector3().crossVectors(up, fore).normalize();
    rig.idleHinge.copy(hinge);
    rig.hinge.copy(hinge);

    const qU = quatFromFrames(rig.upperArm.restDir, rig.hingeRest, up, hinge, new THREE.Quaternion());
    const qL = quatFromFrames(rig.lowerArm.restDir, rig.hingeRest, fore, hinge, new THREE.Quaternion());
    setWorldQuat(rig.upperArm.bone, qU.multiply(rig.upperArm.restWorld), 1);
    setWorldQuat(rig.lowerArm.bone, qL.multiply(rig.lowerArm.restWorld), 1);
    rig.upperArm.idleLocal = rig.upperArm.bone.quaternion.clone();
    rig.lowerArm.idleLocal = rig.lowerArm.bone.quaternion.clone();
    rig.hand.idleLocal = rig.hand.restLocal.clone(); // telapak menghadap badan
    // kembalikan ke bind; pose idle dipasang lewat reset()
    rig.upperArm.bone.quaternion.copy(rig.upperArm.restLocal);
    rig.lowerArm.bone.quaternion.copy(rig.lowerArm.restLocal);

    // jari melengkung santai: tekuk ke arah telapak (VRM T-pose: telapak menghadap -Y)
    const CURL = [0.22, 0.32, 0.22]; // proximal, intermediate, distal (radian)
    const down = new THREE.Vector3(0, -1, 0);
    const axisW = new THREE.Vector3();
    const invRest = new THREE.Quaternion();
    for (const fb of rig.fingers) {
      const isThumb = fb.lmPair[0] <= 3;
      const joint = isThumb ? 0 : (fb.lmPair[0] - 5) % 4; // 0,1,2
      const angle = isThumb ? 0.08 : CURL[joint] ?? 0.2;
      axisW.crossVectors(fb.restDir, down);
      if (axisW.lengthSq() < 1e-8) { fb.idleLocal = fb.restLocal.clone(); continue; }
      axisW.normalize().applyQuaternion(invRest.copy(fb.restWorld).invert()); // ke ruang lokal tulang
      fb.idleLocal = fb.restLocal.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axisW, angle));
    }
  }

  const right = buildSide('right');
  const left = buildSide('left');

  // vektor/quaternion kerja
  const _upperDir = new THREE.Vector3();
  const _foreDir = new THREE.Vector3();
  const _hf = new THREE.Vector3();
  const _ha = new THREE.Vector3();
  const _h = new THREE.Vector3();
  const _pole = new THREE.Vector3();
  const _tgt = new THREE.Vector3();
  const _restN = new THREE.Vector3();
  const _liveN = new THREE.Vector3();
  const _qUp = new THREE.Quaternion();
  const _qLow = new THREE.Quaternion();
  const _qHand = new THREE.Quaternion();
  const _qAlign = new THREE.Quaternion();
  const _qTwist = new THREE.Quaternion();
  const _d = new THREE.Quaternion();
  const _tw = new THREE.Quaternion();
  const _tq = new THREE.Quaternion();
  const _I = new THREE.Quaternion();

  // arah antar dua landmark tangan, utamakan worldLandmarks (meter, tanpa distorsi aspek)
  function handDir(hand, a, b, out) {
    if (hand.world) {
      const A = hand.world[a], B = hand.world[b];
      return lmDir(B.x - A.x, B.y - A.y, B.z - A.z, out);
    }
    const A = hand.img[a], B = hand.img[b];
    return lmDir((B.x - A.x) * VIDEO_ASPECT, B.y - A.y, ((B.z ?? 0) - (A.z ?? 0)) * VIDEO_ASPECT, out);
  }

  function armFromIK(rig, wristImg, alpha) {
    const dx = wristImg.x - rig.shoulderScreen.x;
    const dy = wristImg.y - rig.shoulderScreen.y;
    const scale = (rig.L1 + rig.L2) / REACH;
    _tgt.set(rig.shoulder.x + dx * scale, rig.shoulder.y - dy * scale, rig.shoulder.z + FORWARD);
    if (!rig.target) rig.target = _tgt.clone();
    else rig.target.lerp(_tgt, alpha);
    _pole.set(rig.shoulder.x < 0 ? -0.3 : 0.3, -1, 0.35);
    solveTwoBoneIK(rig.shoulder, rig.target, rig.L1, rig.L2, _pole, _upperDir, _foreDir);
  }

  function applySide(rig, hand, pose, alpha, fresh = true) {
    if (!rig) return false;
    const ix = POSE_ARM[rig.side];
    const poseArm = !!pose && pose.visible(ix.s, ix.e, ix.w);
    if (!poseArm && !hand) {
      // tak ada data sama sekali: bila tangan baru saja terlihat (mis. tertutup
      // tangan lain sesaat), TAHAN seluruh lengan di posisi terakhir.
      return performance.now() - rig.handSeenAt < HAND_HOLD_MS;
    }

    // ---------- 1. arah lengan atas & bawah ----------
    if (poseArm) {
      const P = pose.pts;
      _upperDir.subVectors(P[ix.e], P[ix.s]);
      _foreDir.subVectors(P[ix.w], P[ix.e]);
      if (_upperDir.lengthSq() < 1e-8 || _foreDir.lengthSq() < 1e-8) return false;
      _upperDir.normalize();
      _foreDir.normalize();
      rig.target = null;
    } else {
      armFromIK(rig, hand.img[0], alpha);
    }

    // ---------- 2. engsel siku (menentukan roll lengan) ----------
    _h.crossVectors(_upperDir, _foreDir);
    const bend = _h.length(); // = sin(sudut tekuk siku)
    if (bend > 1e-4) {
      _h.multiplyScalar(1 / bend);
      // makin menekuk → makin yakin dengan sumbu engsel; saat lurus, pakai yang lama
      rig.hinge.lerp(_h, Math.min(1, bend / 0.35)).normalize();
    }
    quatFromFrames(rig.upperArm.restDir, rig.hingeRest, _upperDir, rig.hinge, _qUp);
    quatFromFrames(rig.lowerArm.restDir, rig.hingeRest, _foreDir, rig.hinge, _qLow);

    // ---------- 3. orientasi telapak (dengan penolakan glitch) ----------
    const now = performance.now();
    let handOk = false;
    let fingersLive = false;

    if (hand && handQuatFromLandmarks(rig, hand, _qHand)) {
      // Keputusan terima/tolak hanya dibuat SEKALI per hasil deteksi baru
      // (apply dipanggil tiap frame render dengan hasil yang sama).
      if (fresh) {
        let accept = true;
        if (rig.lastQHand && now - rig.handSeenAt < 250) {
          const jump = _qHand.angleTo(rig.lastQHand);
          if (jump > OUTLIER_RAD && rig.outliers < OUTLIER_MAX) accept = false;
        }
        rig.outliers = accept ? 0 : rig.outliers + 1;
        rig.lastAccepted = accept;
        if (accept) {
          (rig.lastQHand ||= new THREE.Quaternion()).copy(_qHand);
          rig.handSeenAt = now;
          (rig.prevWrist ||= new THREE.Vector2()).set(hand.img[0].x, hand.img[0].y);
        }
      }
      if (rig.lastAccepted) {
        handOk = true;
        fingersLive = true;
      }
    }

    if (!handOk && rig.lastQHand && now - rig.handSeenAt < HAND_HOLD_MS) {
      // deteksi hilang / meragukan sebentar (mis. tangan saling menutupi) → TAHAN
      _qHand.copy(rig.lastQHand);
      handOk = true;
    } else if (!handOk && poseArm && pose.visible(ix.index, ix.pinky) && rig.hand.restForward && rig.hand.restAcross) {
      // lama tak terlihat → perkiraan kasar dari titik telunjuk/kelingking pose
      const P = pose.pts;
      _hf.addVectors(P[ix.index], P[ix.pinky]).multiplyScalar(0.5).sub(P[ix.w]);
      _ha.subVectors(P[ix.pinky], P[ix.index]);
      if (_hf.lengthSq() > 1e-10 && _ha.lengthSq() > 1e-10) handOk = palmQuat(rig, _hf.normalize(), _ha.normalize(), _qHand);
    }

    if (handOk) {
      // bagi puntiran pergelangan ke lengan bawah (anti "candy wrapper")
      _d.copy(_qHand).multiply(_tq.copy(_qLow).invert());
      twistAround(_d, _foreDir, _tw);
      _qLow.premultiply(_tq.copy(_I).slerp(_tw, FOREARM_TWIST_SHARE));
    }

    // ---------- 4. terapkan (induk → anak) ----------
    setWorldQuat(rig.upperArm.bone, _tq.copy(_qUp).multiply(rig.upperArm.restWorld), alpha);
    setWorldQuat(rig.lowerArm.bone, _tq.copy(_qLow).multiply(rig.lowerArm.restWorld), alpha);
    if (handOk) setWorldQuat(rig.hand.bone, _tq.copy(_qHand).multiply(rig.hand.restWorld), alpha);
    else rig.hand.bone.quaternion.slerp(rig.hand.restLocal, alpha); // ikut lengan bawah apa adanya

    // ---------- 5. jari ----------
    if (fingersLive) {
      for (const fb of rig.fingers) {
        const d = safeNormalize(handDir(hand, fb.lmPair[0], fb.lmPair[1], _h));
        if (d.lengthSq() < 1e-8) continue;
        setWorldQuat(fb.bone, _tq.setFromUnitVectors(fb.restDir, d).multiply(fb.restWorld), alpha);
      }
    } else if (now - rig.handSeenAt >= HAND_HOLD_MS) {
      for (const fb of rig.fingers) fb.bone.quaternion.slerp(fb.idleLocal ?? fb.restLocal, alpha * 0.5);
    } // selama ditahan: jari dibiarkan pada bentuk terakhir
    return true;
  }

  // PALM TWIST: arah tangan + puntiran dari normal telapak → quaternion delta dunia.
  function palmQuat(rig, fwd, across, out) {
    //  a) arahkan tangan: restForward → forward
    quatFromTo(rig.hand.restForward, fwd, _qAlign);
    //  b) normal telapak (cross) — normal istirahat IKUT diputar qAlign dulu
    _restN.crossVectors(rig.hand.restForward, rig.hand.restAcross).normalize().applyQuaternion(_qAlign);
    _liveN.crossVectors(fwd, across);
    if (_liveN.lengthSq() < 1e-10) return false;
    _liveN.normalize();
    //  c) sudut puntir di sekitar sumbu tangan (cross → sin, dot → cos)
    const twist = signedTwistAroundAxis(fwd, _restN, _liveN);
    _qTwist.setFromAxisAngle(fwd, twist);
    out.copy(_qTwist).multiply(_qAlign);
    return true;
  }

  function handQuatFromLandmarks(rig, hand, out) {
    if (!rig.hand.restForward || !rig.hand.restAcross) return false;
    handDir(hand, 0, 9, _hf);  // pergelangan → pangkal jari tengah
    handDir(hand, 5, 17, _ha); // pangkal telunjuk → pangkal kelingking
    if (_hf.lengthSq() < 1e-10 || _ha.lengthSq() < 1e-10) return false;
    return palmQuat(rig, _hf.normalize(), _ha.normalize(), out);
  }

  // kembali ke POSE DIAM (bukan T-pose)
  function restSide(rig, alpha) {
    if (!rig) return;
    for (const c of [rig.upperArm, rig.lowerArm, rig.hand, ...rig.fingers]) {
      if (c) c.bone.quaternion.slerp(c.idleLocal ?? c.restLocal, alpha);
    }
    rig.target = null;
    rig.hinge.lerp(rig.idleHinge, alpha).normalize();
  }

  // ---------- Pencocokan tangan terdeteksi → sisi avatar ----------
  //  Biaya per pasangan (tangan, sisi) dari 3 sumber, lalu pilih kombinasi termurah:
  //   1. label handedness MediaPipe (kiri/kanan dari BENTUK tangan, tahan saat menyatu)
  //   2. jarak ke pergelangan pose (kanan=16, kiri=15)
  //   3. jarak ke posisi tangan sisi itu pada frame sebelumnya (anti lompat sisi)
  //  MediaPipe mengasumsikan gambar dicermin; feed kita mentah, jadi label "Left"
  //  = tangan KANAN pengguna. Konvensi ini dikalibrasi otomatis (voting) saat
  //  kedua tangan jelas terpisah, untuk berjaga-jaga bila versi lain berbeda.
  let labelFlipped = false;
  let labelVote = 0;

  function labelSide(h) {
    if (!h.label || h.score < LABEL_MIN) return null;
    const userRight = (h.label === 'Left') !== labelFlipped;
    return userRight ? 'right' : 'left';
  }

  function meanLmDist(a, b) {
    let s = 0;
    for (let i = 0; i < 21; i++) s += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
    return s / 21;
  }

  function assignHands(result, pose) {
    const img = result?.landmarks || [];
    const wld = result?.worldLandmarks || [];
    const hd = result?.handedness || result?.handednesses || [];
    let hands = img
      .map((lm, i) => {
        const c = hd[i]?.[0];
        return {
          img: lm,
          world: wld[i] && wld[i].length >= 21 ? wld[i] : null,
          label: c?.categoryName ?? null,
          score: c?.score ?? 0,
        };
      })
      .filter((h) => h.img && h.img.length >= 21);

    // deteksi ganda (tangan yang sama terdeteksi dua kali saat saling menutupi)
    if (hands.length >= 2 && meanLmDist(hands[0].img, hands[1].img) < DUP_DIST) {
      hands = [hands[0].score >= hands[1].score ? hands[0] : hands[1]];
    }
    hands = hands.slice(0, 2);
    if (!hands.length) return { r: null, l: null };

    // kalibrasi konvensi label: dua tangan jelas terpisah → yang di kiri gambar = kanan pengguna
    if (hands.length === 2) {
      const [a, b] = hands[0].img[0].x < hands[1].img[0].x ? hands : [hands[1], hands[0]];
      if (b.img[0].x - a.img[0].x > 0.3) {
        const la = labelSide(a);
        const lb = labelSide(b);
        if (la && lb && la !== lb) {
          labelVote = Math.max(-20, Math.min(20, labelVote + (la === 'right' ? 1 : -1)));
          if (labelVote < -8) {
            labelFlipped = !labelFlipped;
            labelVote = 8;
          }
        }
      }
    }

    const now = performance.now();
    const P = pose?.valid ? pose.image : null;
    function cost(h, side) {
      const w = h.img[0];
      let c = 0;
      const ls = labelSide(h);
      if (ls) c += (ls === side ? 0 : 0.9) * h.score;
      if (P) {
        const k = side === 'right' ? 16 : 15;
        c += 1.5 * Math.hypot(w.x - P[k].x, w.y - P[k].y);
      } else {
        c += 0.5 * (side === 'right' ? w.x : 1 - w.x); // tanpa pose: kanan pengguna di kiri gambar
      }
      const rig = side === 'right' ? right : left;
      if (rig?.prevWrist && now - rig.handSeenAt < 600) {
        c += 1.0 * Math.hypot(w.x - rig.prevWrist.x, w.y - rig.prevWrist.y);
      }
      return c;
    }

    let r = null;
    let l = null;
    if (hands.length === 1) {
      const h = hands[0];
      if (cost(h, 'right') <= cost(h, 'left')) r = h;
      else l = h;
    } else {
      const [a, b] = hands;
      if (cost(a, 'right') + cost(b, 'left') <= cost(a, 'left') + cost(b, 'right')) { r = a; l = b; }
      else { r = b; l = a; }

      // Tangan menyatu (pergelangan berdekatan): bila label yakin BERTENTANGAN
      // dengan hasil penugasan, landmark kemungkinan tercampur → jangan dipakai
      // (sisi itu menahan pose terakhir).
      const close = Math.hypot(a.img[0].x - b.img[0].x, a.img[0].y - b.img[0].y) < CLOSE_DIST;
      if (close) {
        if (r && r.score > 0.85 && labelSide(r) === 'left') r = null;
        if (l && l.score > 0.85 && labelSide(l) === 'right') l = null;
      }
    }
    return { r, l };
  }

  let lastResult = undefined;
  let lastAssign = { r: null, l: null };

  function reset() {
    for (const rig of [right, left]) {
      if (!rig) continue;
      restSide(rig, 1);
      rig.hinge.copy(rig.idleHinge);
      rig.lastQHand = null;
      rig.handSeenAt = -1e9;
      rig.outliers = 0;
      rig.prevWrist = null;
      rig.lastAccepted = false;
    }
    lastResult = undefined;
  }
  reset(); // langsung pasang pose diam begitu model dimuat

  return {
    reset,

    /**
     * @param {object|null} result  hasil HandLandmarker
     * @param {object|null} pose    filter pose (createPoseFilter) atau null
     */
    apply(result, pose, dt, opt = {}) {
      const { enabled = true, lambda = 18 } = opt;
      const alpha = Math.min(1, Math.max(0, 1 - Math.exp(-lambda * dt)));
      // hasil deteksi yang sama dipakai ulang di beberapa frame render → cache penugasan
      const fresh = result !== lastResult;
      if (fresh) {
        lastResult = result;
        lastAssign = enabled ? assignHands(result, pose) : { r: null, l: null };
      }
      const { r, l } = enabled ? lastAssign : { r: null, l: null };
      const p = enabled ? pose : null;

      if (!applySide(right, r, p, alpha, fresh)) restSide(right, alpha * 0.7);
      if (!applySide(left, l, p, alpha, fresh)) restSide(left, alpha * 0.7);
    },
  };
}
