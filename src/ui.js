// ------------------------------------------------------------------
// ui.js — panel kontrol lil-gui (kanan atas).
// ------------------------------------------------------------------
import GUI from 'lil-gui';

/**
 * @param {object} state  objek state yang dibaca main.js
 * @param {{onCamera:Function,onHide:Function,onResetPose:Function,onCalibrate:Function}} actions
 */
export function createUI(state, actions) {
  const gui = new GUI({ title: 'Kontrol' });

  const fCam = gui.addFolder('Kamera & Tracking');
  fCam.add(state, 'enableCamera').name('enableCamera').onChange(actions.onCamera);
  fCam.add(state, 'hideCamera').name('hideCamera').onChange(actions.onHide);
  fCam.add(state, 'enableFaceTrack').name('enableFaceTrack');
  fCam.add(state, 'enableHandTrack').name('enableHandTrack');
  fCam.add(state, 'enablePoseTrack').name('enablePoseTrack (lengan)');
  fCam.add(state, 'physics').name('jiggle physics');

  const fTune = gui.addFolder('Smoothing (low-pass)');
  fTune.add(state, 'faceSmoothing', 1, 30, 0.5).name('wajah (λ)');
  fTune.add(state, 'handSmoothing', 1, 40, 0.5).name('tangan (λ)');
  fTune.add(state, 'poseSmoothing', 1, 30, 0.5).name('lengan/pose (λ)');
  fTune.add(state, 'bodyAmount', 0, 1.5, 0.05).name('badan (kekuatan)');
  fTune.add(state, 'mirrorFace').name('cermin wajah');
  fTune.add(state, 'transposeFaceMatrix').name('transpose matrix');

  const fAct = gui.addFolder('Aksi');
  fAct.add(actions, 'onResetPose').name('Reset pose');
  fAct.add(actions, 'onCalibrate').name('Kalibrasi (duduk/berdiri tegak)');
  fAct.add(actions, 'onOpenModel').name('Buka VRM…');
  fAct.add(actions, 'onOpenPMXFolder').name('Buka folder PMX…');

  return gui;
}