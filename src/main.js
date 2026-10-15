// ------------------------------------------------------------------
// main.js — scene Three.js + VRM + loop tracking wajah & tangan.
// ------------------------------------------------------------------
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createUI } from './ui.js';
import { loadPMX, createFolderManager, filesFromDataTransfer } from './pmx-adapter.js';
import { createFaceLandmarker, createFaceRig } from './tracking/face.js';
import { createHandLandmarker, createHandRig } from './tracking/hands.js';
import { createPoseLandmarker, createPoseFilter, createBodyRig, POSE_CONNECTIONS } from './tracking/pose.js';

const MODEL_URL = '/models/avatar.vrm';
const state = {
  enableCamera: true,
  hideCamera: false,
  enableFaceTrack: true,
  enableHandTrack: true,
  enablePoseTrack: true,
  physics: true,
  faceSmoothing: 14,
  handSmoothing: 18,
  poseSmoothing: 12,
  bodyAmount: 1,
  mirrorFace: false,
  transposeFaceMatrix: false,
};

// ---------- DOM ----------
const appEl = document.getElementById('app');
const video = document.getElementById('video');
const preview = document.getElementById('preview');
const pctx = preview.getContext('2d');
const previewWrap = document.getElementById('preview-wrap');
const hintEl = document.getElementById('hint');
const loaderEl = document.getElementById('loader');

// ---------- Renderer / Scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
appEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2d33);

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 50);
camera.position.set(0, 1.35, 3.4);
camera.lookAt(0, 1.15, 0);

// ---------- Cahaya ----------
const ambient = new THREE.AmbientLight(0xffffff, 1.1);
const hemi = new THREE.HemisphereLight(0xffffff, 0x888899, 0.6);
scene.add(ambient, hemi);

// MToon (VRM) butuh ambient kuat; toon MMD sudah membawa "ambient" sendiri
// (dipakai sebagai emissive) → ambient scene harus jauh lebih kecil agar tidak pucat.
const LIGHTING = {
  vrm: { ambient: 1.1, hemi: 0.6, dir: 2.0 },
  pmx: { ambient: 0.0, hemi: 0.55, dir: 2.2 },
};
function applyLighting(kind) {
  const L = LIGHTING[kind] || LIGHTING.vrm;
  ambient.intensity = L.ambient;
  hemi.intensity = L.hemi;
  dir.intensity = L.dir;
}

const dir = new THREE.DirectionalLight(0xffffff, 2.0);
dir.position.set(2.5, 4.5, 3.5);
dir.castShadow = true;
dir.shadow.mapSize.set(2048, 2048);
dir.shadow.camera.near = 0.5;
dir.shadow.camera.far = 15;
dir.shadow.camera.left = -3;
dir.shadow.camera.right = 3;
dir.shadow.camera.top = 3;
dir.shadow.camera.bottom = -3;
dir.shadow.bias = -0.0005;
scene.add(dir);

// ---------- Lantai ----------
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ color: 0x4a4f58, roughness: 1, metalness: 0 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ---------- State runtime ----------
let vrm = null;
let faceRig = null;
let handRig = null;
let bodyRig = null;
let faceLandmarker = null;
let handLandmarker = null;
let poseLandmarker = null;
let poseResult = null;
let detectMs = 0;
let frameNo = 0;
const poseFilter = createPoseFilter();
let stream = null;
let lastVideoTime = -1;
let faceResult = null;
let handResult = null;

// ---------- Preview webcam ----------
const GREEN = '#22c55e';
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function drawPreview() {
  const W = preview.width;
  const H = preview.height;
  pctx.clearRect(0, 0, W, H);
  if (!stream || video.readyState < 2) return;

  // video dicermin agar terasa seperti bercermin
  pctx.save();
  pctx.scale(-1, 1);
  pctx.drawImage(video, -W, 0, W, H);
  pctx.restore();

  pctx.strokeStyle = GREEN;
  pctx.fillStyle = GREEN;
  pctx.lineWidth = 1.4;

  const mx = (x) => (1 - x) * W; // koordinat sumbu-x setelah cermin
  const my = (y) => y * H;

  // landmark wajah (titik hijau)
  if (state.enableFaceTrack && faceResult?.faceLandmarks?.[0]) {
    const lm = faceResult.faceLandmarks[0];
    for (let i = 0; i < lm.length; i += 2) {
      pctx.fillRect(mx(lm[i].x) - 0.75, my(lm[i].y) - 0.75, 1.5, 1.5);
    }
  }

  // kerangka pose: bahu-siku-pergelangan (garis hijau tebal)
  if (state.enablePoseTrack && poseResult?.landmarks?.[0]) {
    const lm = poseResult.landmarks[0];
    pctx.lineWidth = 2.5;
    for (const [a, b] of POSE_CONNECTIONS) {
      if ((lm[a].visibility ?? 1) < 0.5 || (lm[b].visibility ?? 1) < 0.5) continue;
      pctx.beginPath();
      pctx.moveTo(mx(lm[a].x), my(lm[a].y));
      pctx.lineTo(mx(lm[b].x), my(lm[b].y));
      pctx.stroke();
    }
    pctx.lineWidth = 1.4;
  }

  // landmark + sambungan tangan (garis hijau)
  if (state.enableHandTrack && handResult?.landmarks) {
    for (const lm of handResult.landmarks) {
      for (const [a, b] of HAND_CONNECTIONS) {
        pctx.beginPath();
        pctx.moveTo(mx(lm[a].x), my(lm[a].y));
        pctx.lineTo(mx(lm[b].x), my(lm[b].y));
        pctx.stroke();
      }
      for (const p of lm) {
        pctx.beginPath();
        pctx.arc(mx(p.x), my(p.y), 2, 0, Math.PI * 2);
        pctx.fill();
      }
    }
  }
}

// ---------- Kamera & model MediaPipe ----------
async function startCamera() {
  if (stream) return;
  hintEl.textContent = 'Meminta izin kamera…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    console.error(err);
    hintEl.textContent = 'Kamera ditolak/tidak tersedia — izinkan akses kamera lalu aktifkan lagi.';
    state.enableCamera = false;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    return;
  }

  try {
    hintEl.textContent = 'Memuat model MediaPipe…';
    if (!faceLandmarker) faceLandmarker = await createFaceLandmarker();
    if (!handLandmarker) handLandmarker = await createHandLandmarker();
    if (!poseLandmarker) poseLandmarker = await createPoseLandmarker();
    hintEl.textContent = 'Tracking aktif — gerakkan wajah & tangan.';
  } catch (err) {
    console.error(err);
    hintEl.textContent = 'Gagal memuat mediapipe — periksa /libs/vision & /models.';
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  lastVideoTime = -1;
  faceResult = null;
  handResult = null;
  poseResult = null;
  poseFilter.reset();
  pctx.clearRect(0, 0, preview.width, preview.height);
  hintEl.textContent = 'Kamera nonaktif.';
}

// ---------- Muat VRM ----------
const gltfLoader = new GLTFLoader();
gltfLoader.register((parser) => new VRMLoaderPlugin(parser));

async function loadVRM(url) {
  const gltf = await gltfLoader.loadAsync(url);
  const model = gltf.userData.vrm;
  if (!model) throw new Error('File bukan VRM yang valid.');

  try {
    VRMUtils.removeUnnecessaryVertices(model.scene);
    VRMUtils.combineSkeletons(model.scene);
  } catch {
    /* opsional */
  }
  try {
    VRMUtils.rotateVRM0(model);
  } catch {
    /* VRM1: tidak perlu */
  }

  model.scene.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  return model;
}

// Pasang model ke scene + bangun ulang rig (model-agnostic: VRM maupun PMX).
let releaseFiles = null; // blob URL milik model aktif (folder PMX)
function setModel(model, label = 'avatar', release = null) {
  if (vrm) {
    scene.remove(vrm.scene);
    try {
      if (vrm.isPMX) vrm.dispose();
      else VRMUtils.deepDispose(vrm.scene);
    } catch {
      /* opsional */
    }
  }
  releaseFiles?.();
  releaseFiles = release;
  vrm = model;
  applyLighting(model.isPMX ? 'pmx' : 'vrm');
  scene.add(model.scene);
  model.scene.updateMatrixWorld(true);
  faceRig = createFaceRig(vrm);
  handRig = createHandRig(vrm, camera);
  bodyRig = createBodyRig(vrm);
  poseFilter.reset();
  document.title = `VRM Avatar Tracker — ${model.meta?.name || label}`;
}

const isPMXName = (s) => /\.(pmx|pmd)(\?|#|$)/i.test(s || '');

/**
 * Muat model dari URL. Format ditebak dari label/URL (.pmx/.pmd → MMD, selain itu VRM).
 * @param {{manager?: THREE.LoadingManager, release?: Function}} opt
 */
async function useModelUrl(url, label, opt = {}) {
  loaderEl.style.display = 'flex';
  loaderEl.textContent = 'Memuat model avatar…';
  hintEl.textContent = 'Memuat model…';
  try {
    const pmx = isPMXName(label) || isPMXName(url);
    const model = pmx ? await loadPMX(url, { manager: opt.manager, label }) : await loadVRM(url);
    setModel(model, label, opt.release || null);
    loaderEl.style.display = 'none';
    const exprs = pmx ? ` (ekspresi: ${model.expressionManager.expressionNames.join(', ') || '-'})` : '';
    hintEl.textContent = (stream ? 'Tracking aktif — gerakkan wajah & tangan.' : 'Model dimuat.') + exprs;
  } catch (err) {
    console.error(err);
    opt.release?.();
    loaderEl.style.display = 'none';
    hintEl.textContent = 'Gagal memuat model: ' + (err?.message ?? err);
  }
}

/** Muat dari daftar file lokal {file, path}. PMX → seluruh folder (tekstur), VRM → satu file. */
async function useModelFiles(entries) {
  if (!entries?.length) return;
  const folder = createFolderManager(entries);
  if (folder) {
    const onlyModel = entries.length === 1;
    await useModelUrl(folder.url, folder.label, { manager: folder.manager, release: folder.revoke });
    if (onlyModel && vrm?.isPMX) {
      hintEl.textContent = 'PMX dimuat TANPA tekstur — pakai "Buka folder PMX…" agar tekstur ikut.';
    }
    return;
  }
  const vrmFile = entries.find((e) => /\.(vrm|glb|gltf)$/i.test(e.path))?.file;
  if (!vrmFile) {
    hintEl.textContent = 'Tidak ada file .vrm / .pmx yang dikenali.';
    return;
  }
  const url = URL.createObjectURL(vrmFile);
  await useModelUrl(url, vrmFile.name, { release: () => URL.revokeObjectURL(url) });
}

function pickFiles({ directory = false, accept = '' } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  if (directory) {
    input.webkitdirectory = true;
    input.multiple = true;
  }
  input.onchange = () => {
    const files = [...(input.files || [])];
    useModelFiles(files.map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
  };
  input.click();
}

const openModelDialog = () => pickFiles({ accept: '.vrm,.glb,.gltf,.pmx,.pmd' });
const openPMXFolderDialog = () => pickFiles({ directory: true });

// drag & drop: file .vrm, atau FOLDER berisi .pmx + teksturnya
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const entries = await filesFromDataTransfer(e.dataTransfer);
  useModelFiles(entries);
});

// ---------- UI ----------
const gui = createUI(state, {
  onCamera: () => (state.enableCamera ? startCamera() : stopCamera()),
  onHide: () => {
    previewWrap.style.display = state.hideCamera ? 'none' : 'block';
  },
  onResetPose: () => {
    faceRig?.calibrate();
    bodyRig?.calibrate?.();
    handRig?.reset?.();
  },
  onCalibrate: () => {
    faceRig?.calibrate();
    bodyRig?.calibrate?.();
  },
  onOpenModel: () => openModelDialog(),
  onOpenPMXFolder: () => openPMXFolderDialog(),
});

// ---------- Loop ----------
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (stream && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    // Wajah SELALU tiap frame (prioritas responsif). Bila deteksi terlalu berat
    // (> ~1 frame kamera), tangan & pose dijalankan bergantian.
    const heavy = detectMs > 34;
    const doHand = !heavy || frameNo % 2 === 0;
    const doPose = !heavy || frameNo % 2 === 1;
    if (state.enableFaceTrack && faceLandmarker) faceResult = faceLandmarker.detectForVideo(video, now);
    if (doHand && state.enableHandTrack && handLandmarker) handResult = handLandmarker.detectForVideo(video, now);
    if (doPose && state.enablePoseTrack && poseLandmarker) poseResult = poseLandmarker.detectForVideo(video, now);
    const took = performance.now() - now;
    detectMs = heavy ? detectMs * 0.9 + took * 1.6 * 0.1 : detectMs * 0.9 + took * 0.1; // EMA (perkiraan biaya penuh)
    frameNo++;
    drawPreview();
  }

  if (vrm) {
    // pose dihaluskan dulu, lalu urutan: badan → kepala → lengan/tangan
    const poseAlpha = 1 - Math.exp(-state.poseSmoothing * dt);
    const pose = state.enablePoseTrack ? poseFilter.update(poseResult, poseAlpha) : null;
    bodyRig?.apply(pose, dt, { enabled: state.enablePoseTrack, lambda: state.poseSmoothing, amount: state.bodyAmount });

    faceRig?.apply(state.enableFaceTrack ? faceResult : null, dt, {
      enabled: state.enableFaceTrack,
      lambda: state.faceSmoothing,
      mirrored: state.mirrorFace,
      transpose: state.transposeFaceMatrix,
    });
    handRig?.apply(state.enableHandTrack ? handResult : null, pose, dt, {
      enabled: state.enableHandTrack || state.enablePoseTrack,
      lambda: state.handSmoothing,
    });
    vrm.update(dt);
    // fisika "jiggle" (spring bone) untuk rambut/aksesori VRM
    if (state.physics && vrm.springBoneManager) vrm.springBoneManager.update(dt);
  }

  renderer.render(scene, camera);
}

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Mulai ----------
(async () => {
  await useModelUrl(MODEL_URL, 'avatar');
  if (!vrm) return; // gagal muat model default
  if (state.enableCamera) await startCamera();
  loop();
})();

// diagnostik
window.__vrm = () => ({ vrm, faceRig, handRig, bodyRig, poseFilter });
window.__useModelFiles = useModelFiles; // diagnostik / uji otomatis
window.__useModelUrl = useModelUrl;