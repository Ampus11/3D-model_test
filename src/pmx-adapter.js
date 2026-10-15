// ------------------------------------------------------------------
// pmx-adapter.js — muat model MMD (.pmx / .pmd) dan bungkus agar
// "terlihat seperti VRM" bagi rig tracking (face/hands/pose).
// ------------------------------------------------------------------
//  Rig hanya memakai:
//    vrm.scene, vrm.humanoid.getNormalizedBoneNode(nama),
//    vrm.expressionManager.setValue/getValue, vrm.update(dt), vrm.meta
//  Jadi cukup memetakan:
//    • nama tulang Jepang MMD  → nama tulang humanoid VRM
//    • nama morph Jepang MMD   → nama ekspresi VRM
//  Semua orientasi di rig diukur relatif pose bind, jadi A-pose MMD tetap jalan.
// ------------------------------------------------------------------
import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';

const TARGET_HEIGHT = 1.6; // meter — tinggi model setelah diskalakan

// ---------- pemetaan tulang (alternatif pertama yang ditemukan dipakai) ----------
const FINGERS = [
  ['Index', '人指'], ['Middle', '中指'], ['Ring', '薬指'], ['Little', '小指'],
];
function buildBoneMap() {
  const m = {
    hips: ['下半身', 'センター'],
    spine: ['上半身'],
    chest: ['上半身2', '上半身２'],
    neck: ['首'],
    head: ['頭'],
  };
  for (const [vSide, j] of [['left', '左'], ['right', '右']]) {
    m[`${vSide}Shoulder`] = [`${j}肩`];
    m[`${vSide}UpperArm`] = [`${j}腕`];
    m[`${vSide}LowerArm`] = [`${j}ひじ`, `${j}肘`];
    m[`${vSide}Hand`] = [`${j}手首`];
    m[`${vSide}UpperLeg`] = [`${j}足`];
    m[`${vSide}LowerLeg`] = [`${j}ひざ`, `${j}膝`];
    m[`${vSide}Foot`] = [`${j}足首`];
    for (const [v, jf] of FINGERS) {
      const alt = jf === '人指' ? ['人指', '人差指'] : [jf];
      m[`${vSide}${v}Proximal`] = alt.map((a) => `${j}${a}１`);
      m[`${vSide}${v}Intermediate`] = alt.map((a) => `${j}${a}２`);
      m[`${vSide}${v}Distal`] = alt.map((a) => `${j}${a}３`);
    }
    // ibu jari diisi terpisah (親指０ tidak selalu ada)
  }
  return m;
}

// ---------- pemetaan ekspresi → satu/lebih morph MMD ----------
//  Tiap entri: daftar grup; tiap grup = alternatif nama (yang pertama ada dipakai).
const EXPR_MAP = {
  blink: [['まばたき', '瞬き']],
  blinkLeft: [['ウィンク２', 'ウィンク']],
  blinkRight: [['ウィンク２右', 'ウィンク右']],
  aa: [['あ']],
  ih: [['い']],
  ou: [['う']],
  ee: [['え']],
  oh: [['お']],
  happy: [['笑い', '笑い目'], ['にこり']],
  angry: [['怒り']],
  sad: [['困る']],
  surprised: [['びっくり', '驚き']],
  relaxed: [['なごみ']],
};

// ------------------------------------------------------------------
// Perbaikan transparansi: MMDLoader menggambar material bertekstur alpha
// (jubah tipis, renda, decal) di pass OPAK sambil menulis depth → objek di
// belakangnya (lantai) terpotong & model tampak pudar. Di sini alpha tiap
// tekstur diukur setelah termuat:
//   • ada piksel transparan          → material.transparent = true
//   • banyak piksel setengah-transparan → juga depthWrite = false (benar-benar tembus)
// ------------------------------------------------------------------
function analyseAlpha(image) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data;
  let clear = 0;
  let semi = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 8) clear++;
    else if (d[i] < 248) semi++;
  }
  const n = S * S;
  return { clear: clear / n, semi: semi / n };
}

function fixAlphaMaterials(mesh, tries = 0) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let pending = 0;
  for (const m of mats) {
    if (!m || m.userData._alphaChecked || !m.map) continue;
    const img = m.map.image;
    const ready = img && (img.complete === undefined || img.complete) && (img.width || img.naturalWidth);
    if (!ready) { pending++; continue; }
    m.userData._alphaChecked = true;
    let a;
    try {
      a = analyseAlpha(img);
    } catch {
      continue; // gambar lintas-origin / format tak terbaca
    }
    if (a.clear + a.semi < 0.002) continue; // opak penuh
    m.transparent = true;
    if (a.semi > 0.05) m.depthWrite = false; // kain tipis / kaca
    else m.alphaTest = Math.max(m.alphaTest, 0.02); // potongan tegas (rambut, renda)
    m.needsUpdate = true;
  }
  if (pending && tries < 60) setTimeout(() => fixAlphaMaterials(mesh, tries + 1), 250);
}

// angka lebar-penuh ↔ biasa, agar "人指1" dan "人指１" sama-sama ketemu
const toHalf = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/**
 * @param {string} url  URL file .pmx/.pmd (boleh URL palsu, lihat createFolderManager)
 * @param {{manager?: THREE.LoadingManager, label?: string}} opt
 */
export async function loadPMX(url, opt = {}) {
  const loader = new MMDLoader(opt.manager);
  const mesh = await new Promise((res, rej) => loader.load(url, res, undefined, rej));

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  fixAlphaMaterials(mesh);

  const root = new THREE.Group();
  root.name = 'pmx-root';
  root.add(mesh);

  // ---- tulang ----
  const byName = new Map();
  for (const b of mesh.skeleton.bones) {
    byName.set(b.name, b);
    byName.set(toHalf(b.name), b);
  }
  const find = (alts) => {
    for (const a of alts) {
      const b = byName.get(a) || byName.get(toHalf(a));
      if (b) return b;
    }
    return null;
  };
  const humanBones = {};
  for (const [k, alts] of Object.entries(buildBoneMap())) humanBones[k] = find(alts);
  for (const [vSide, j] of [['left', '左'], ['right', '右']]) {
    const t0 = find([`${j}親指０`]);
    const t1 = find([`${j}親指１`]);
    const t2 = find([`${j}親指２`]);
    if (t0) Object.assign(humanBones, { [`${vSide}ThumbMetacarpal`]: t0, [`${vSide}ThumbProximal`]: t1, [`${vSide}ThumbDistal`]: t2 });
    else Object.assign(humanBones, { [`${vSide}ThumbMetacarpal`]: t1, [`${vSide}ThumbProximal`]: t2, [`${vSide}ThumbDistal`]: null });
  }
  if (!humanBones.head || !humanBones.rightUpperArm || !humanBones.leftUpperArm) {
    throw new Error('PMX tidak memakai nama tulang standar MMD (頭 / 右腕 / 左腕 tidak ditemukan).');
  }

  // ---- skala & posisi: tinggi = TARGET_HEIGHT, kaki di lantai, pinggul di tengah ----
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const h = Math.max(1e-6, box.max.y - box.min.y);
  root.scale.setScalar(TARGET_HEIGHT / h);
  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(mesh);
  const hip = new THREE.Vector3();
  (humanBones.hips || humanBones.spine || humanBones.head).getWorldPosition(hip);
  root.position.set(-hip.x, -box2.min.y, -hip.z);
  root.updateMatrixWorld(true);

  // ---- morph / ekspresi ----
  const dict = mesh.morphTargetDictionary || {};
  const dictHalf = {};
  for (const [k, v] of Object.entries(dict)) dictHalf[toHalf(k)] = v;
  const exprIdx = {};
  for (const [name, groups] of Object.entries(EXPR_MAP)) {
    const idx = [];
    for (const alts of groups) {
      for (const a of alts) {
        const i = dict[a] ?? dictHalf[toHalf(a)];
        if (i !== undefined) { idx.push(i); break; }
      }
    }
    if (idx.length) exprIdx[name] = idx;
  }
  const values = {};
  const infl = mesh.morphTargetInfluences;

  const expressionManager = {
    setValue(name, v) {
      const idx = exprIdx[name];
      if (!idx || !infl) return;
      values[name] = v;
      for (const i of idx) infl[i] = v;
    },
    getValue(name) {
      return values[name] ?? 0;
    },
    get expressionNames() {
      return Object.keys(exprIdx);
    },
  };

  return {
    isPMX: true,
    scene: root,
    mesh,
    meta: { name: opt.label || mesh.name || 'PMX', metaVersion: 'pmx' },
    humanoid: {
      getNormalizedBoneNode: (name) => humanBones[name] || null,
      getRawBoneNode: (name) => humanBones[name] || null,
    },
    expressionManager,
    update() {
      /* morph diterapkan langsung; tanpa fisika MMD */
    },
    dispose() {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m) continue;
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose();
      }
    },
  };
}

// ------------------------------------------------------------------
// Memuat PMX dari FOLDER lokal: tekstur PMX ditulis relatif terhadap file .pmx
// (mis. "textures\Body.png"), jadi semua file di folder dipetakan ke blob URL.
// ------------------------------------------------------------------
const ROOT = 'pmx-local://root/';

function normPath(p) {
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/').toLowerCase();
}

/**
 * @param {{file: File, path: string}[]} entries  path relatif, mis. "lucia/model/lucia.pmx"
 * @returns {{url: string, label: string, manager: THREE.LoadingManager, revoke: Function} | null}
 */
export function createFolderManager(entries) {
  const models = entries
    .filter((e) => /\.(pmx|pmd)$/i.test(e.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length);
  if (!models.length) return null;

  const blobs = [];
  const exact = new Map();
  const byBase = new Map();
  for (const e of entries) {
    const u = URL.createObjectURL(e.file);
    blobs.push(u);
    const key = normPath(e.path);
    exact.set(key, u);
    const base = key.split('/').pop();
    if (!byBase.has(base)) byBase.set(base, u);
  }

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith(ROOT)) return url; // data:, blob:, http: biarkan
    let raw = url.slice(ROOT.length);
    try {
      raw = decodeURI(raw);
    } catch {
      /* nama file mengandung '%' → pakai apa adanya */
    }
    const key = normPath(raw);
    const hit = exact.get(key) || byBase.get(key.split('/').pop());
    if (!hit) console.warn('[pmx] file tidak ditemukan di folder:', key);
    return hit || url;
  });

  const model = models[0];
  return {
    url: ROOT + model.path.replace(/\\/g, '/'),
    label: model.path.split('/').pop(),
    manager,
    revoke: () => blobs.forEach((u) => URL.revokeObjectURL(u)),
  };
}

/** Kumpulkan file (beserta path relatif) dari drag & drop, termasuk isi folder. */
export async function filesFromDataTransfer(dt) {
  const out = [];
  const items = [...(dt?.items || [])];
  const entries = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) {
    for (const f of dt?.files || []) out.push({ file: f, path: f.name });
    return out;
  }
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}
