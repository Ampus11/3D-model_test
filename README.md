# VRM Avatar Tracker — Wajah & Tangan (real-time webcam)

Avatar 3D VRM yang **mengikuti gerakan wajah dan tangan** kamu langsung dari webcam.
Dibuat dengan **Three.js + @pixiv/three-vrm + MediaPipe Tasks Vision + lil-gui**.
Semua proses berjalan **lokal di browser** — tidak ada gambar yang di-upload.

## Menjalankan

```bash
cd vrm-tracker
npm install
npm run dev
```

Buka `http://localhost:5173`.

## Izin kamera

Kamera hanya bisa diakses di **secure context**:

- ✅ `http://localhost` / `http://127.0.0.1` (dev server Vite) — aman.
- ✅ `https://...`
- ❌ `http://<ip-lan>` tanpa HTTPS — browser menolak `getUserMedia`.

Saat pertama kali dimuat, browser akan meminta izin kamera. Bila ditolak, aktifkan lagi lewat
ikon kamera di address bar lalu nyalakan `enableCamera` di panel.

## Panel kontrol (kanan atas)

| Kontrol | Fungsi |
| --- | --- |
| `enableCamera` | nyalakan / matikan webcam + tracker |
| `hideCamera` | sembunyikan preview webcam di kiri atas |
| `enableFaceTrack` | aktif / nonaktif tracking wajah |
| `enableHandTrack` | aktif / nonaktif tracking tangan & jari |
| `enablePoseTrack (lengan)` | aktif / nonaktif tracking bahu-siku (lengan & badan atas) |
| `wajah (λ)` / `tangan (λ)` / `lengan/pose (λ)` | kekuatan smoothing (makin besar = makin responsif) |
| `cermin wajah` | balik orientasi kepala bila terasa terbalik |
| `transpose matrix` | balik matriks transform wajah bila kepala bergerak ke arah berlawanan |
| `badan (kekuatan)` | seberapa kuat badan atas ikut condong/miring/memutar (0 = diam) |
| `Reset pose` / `Kalibrasi (duduk/berdiri tegak)` | set ulang posisi netral wajah & badan |
| `Buka VRM…` | muat file `.vrm` dari folder mana pun (atau drag & drop ke jendela) |
| `Buka folder PMX…` | muat model MMD: pilih folder berisi `.pmx` + teksturnya (atau seret foldernya) |

## Fitur tracking

- **Pose diam** — saat dimuat atau saat tidak ada yang terdeteksi, avatar berdiri santai
  (lengan turun di samping badan, siku sedikit menekuk, jari agak melengkung), bukan T-pose.
- **Wajah** — blendshape MediaPipe diremap ke rentang penuh lalu dihaluskan →
  ekspresi VRM: `blink`, vokal mulut `aa/ih/ou/ee/oh`, `happy`, `surprised`, `angry`, `sad`.
  Kepala memakai smoothing adaptif (gerak besar dikejar cepat, getaran kecil diredam). Pose kepala diambil dari *facial transformation matrix* →
  tulang `head` (penuh) & `neck` (sebagian), dihaluskan dengan **slerp**.
- **Lengan (PoseLandmarker)** — titik 3D **bahu, siku, pergelangan** asli dari tubuhmu
  menentukan arah `upperArm` & `lowerArm`, jadi tekukan siku dan arah lengan mengikuti
  gerak manusia. Roll lengan memakai **kerangka engsel siku** (tidak terpelintir), dan
  separuh puntiran pergelangan dibagi ke lengan bawah.
- **Badan atas (PoseLandmarker)** — kerangka badan dari **bahu + pinggul** (atas = pinggul→bahu,
  samping = bahu kanan→kiri) → **condong maju/mundur, miring, memutar badan**. Rotasi dibagi
  ke `spine` → `chest` → `upperChest` agar melengkung alami, maks 45°. Posisi netral
  dikalibrasi otomatis dari ~15 frame pertama (tekan **Kalibrasi** sambil tegak untuk mengulang).
  Bila pinggul tak terlihat, hanya menoleh & miring yang dipakai.
  Bila pose tak terlihat, lengan memakai **IK 2-tulang** dari posisi pergelangan sebagai cadangan.
- **Tangan & jari (HandLandmarker)** — `worldLandmarks` (meter) → orientasi telapak
  (palm twist) + semua ruas jari. Tangan dicocokkan ke sisi kiri/kanan berdasarkan
  pergelangan pose terdekat.
- **Preview** — webcam kecil + landmark wajah/tangan digambar sebagai **garis & titik hijau**.

## Ganti model avatar

Ada tiga cara, pilih yang paling praktis:

**1. Tombol "Buka VRM…" (paling cepat, tanpa copy file).**
Di panel kanan atas → folder **Aksi** → klik **`Buka VRM…`** → pilih file `.vrm`
dari folder mana pun di komputermu. Model langsung dimuat dan rig dibangun ulang.

**2. Drag & drop.** Seret file `.vrm` lalu lepas ke jendela browser.

**3. Timpa file default.** Ganti isi:

```
public/models/avatar.vrm
```

lalu refresh. Cara ini mengubah model yang dimuat otomatis saat aplikasi dibuka.

Aplikasi **model-agnostic**: semua tulang diambil dari humanoid VRM berdasarkan nama,
dan orientasi diukur relatif terhadap *pose istirahat* model. Jadi VRM apa pun
(VRM 0.x maupun 1.0) bisa langsung dipakai tanpa ubah kode.

> Catatan: tombol & drag-drop memuat file dari disk-mu sendiri (lewat `blob:`),
> tidak di-upload ke mana pun. Format yang didukung: `.vrm`, `.glb`, `.gltf`, `.pmx`, `.pmd`.

### Model MMD (`.pmx` / `.pmd`)

PMX menyimpan tekstur sebagai **file terpisah** (mis. `textures\Body.png`), jadi muat
**satu folder sekaligus**:

- Panel → **Aksi** → **`Buka folder PMX…`** → pilih folder yang berisi file `.pmx`
  (beserta subfolder teksturnya), atau
- **seret folder** model ke jendela browser.

Yang dilakukan otomatis (`src/pmx-adapter.js`):

| Hal | Cara |
| --- | --- |
| Tulang | nama standar MMD → humanoid: `頭` head, `首` neck, `上半身/上半身2` spine/chest, `腕/ひじ/手首` lengan, `親指/人指/中指/薬指/小指` jari |
| Ekspresi | morph `まばたき` blink, `あいうえお` vokal, `笑い/にこり` happy, `怒り` angry, `困る` sad, `びっくり` surprised |
| Skala & posisi | tinggi diskalakan ke 1,6 m, kaki di lantai, pinggul di tengah |
| Cahaya | ambient scene dimatikan untuk toon MMD (agar tidak pucat) |
| Transparansi | material bertekstur alpha (kain tipis, renda) dipindah ke pass transparan |

Ekspresi yang berhasil dipetakan ditampilkan di bar bawah setelah model dimuat.

Batasan: model harus memakai **nama tulang standar MMD** (Jepang); fisika rambut/rok
(MMD physics) tidak dijalankan; pilih satu file `.pmx` saja = model tampil **tanpa tekstur**.

## Cara kerja **palm twist** (puntiran telapak)

Tujuannya menentukan seberapa besar telapak **berputar mengelilingi sumbu lengan**
(misalnya saat menelungkupkan/menengadahkan tangan). Langkahnya:

1. **Normal telapak lewat cross product.**
   Dari 21 landmark dibuat dua vektor pada bidang telapak:

   ```
   a = indexMCP − wrist        (titik 5 − titik 0)
   b = pinkyMCP − wrist        (titik 17 − titik 0)
   n = a × b                   (normal bidang telapak)
   ```

   Sisi `n` bergantung pada tangan kiri/kanan, jadi dibalik bila perlu agar selalu
   **menunjuk keluar dari telapak**.

2. **Proyeksi ke bidang tegak lurus sumbu lengan (dot product).**
   Sumbu lengan = arah telapak `f = wrist → pangkal jari tengah`. Normal telapak
   diproyeksikan:

   ```
   p = n − f · (n · f)
   ```

3. **Sudut puntir lewat cross & dot.** Sudut dari normal *pose istirahat* `n0`
   ke normal *sekarang* `n1` (keduanya sudah diproyeksikan) dihitung:

   ```
   sin θ = (p0 × p1) · f      ← cross product
   cos θ = p0 · p1            ← dot product
   θ     = atan2(sin θ, cos θ)
   ```

4. **Terapkan.** Tangan diarahkan ke arah telapak (`q_align`), lalu diputar mengelilingi
   sumbu lengan sebesar θ (`q_twist`):

   ```
   target = q_twist · q_align · q_rest
   ```

Semua nilai di-slerp antar-frame (low-pass filter) supaya tidak bergetar.

## Struktur berkas

```
vrm-tracker/
├─ index.html
├─ package.json
├─ public/
│  ├─ models/
│  │  ├─ avatar.vrm              ← ganti dengan VRM-mu
│  │  ├─ face_landmarker.task
│  │  ├─ hand_landmarker.task
│  │  └─ pose_landmarker_lite.task
│  └─ libs/vision/               ← wasm MediaPipe
└─ src/
   ├─ main.js                    ← scene, cahaya, lantai, loop
   ├─ ui.js                      ← panel lil-gui
   └─ tracking/
      ├─ face.js                 ← wajah → ekspresi + head/neck
      ├─ hands.js                ← lengan (pose/IK) + tangan + jari + palm twist
      ├─ pose.js                 ← PoseLandmarker, filter pose, badan atas
      └─ math.js                 ← vektor, quaternion, palm twist
```

## Troubleshooting

- **Kepala terbalik / miring aneh** → coba matikan `cermin wajah`, lalu `Kalibrasi wajah`
  sambil menatap lurus ke kamera.
- **Kepala menoleh ke arah berlawanan** → nyalakan `transpose matrix` di panel (layout
  matrix MediaPipe bisa berbeda antar versi), lalu `Kalibrasi wajah`.
- **Lengan tidak ikut** → pastikan **bahu & siku terlihat di kamera** (mundur sedikit dari
  webcam). Garis hijau tebal di preview = kerangka pose yang terdeteksi.
- **Tracking berat / patah-patah** — turunkan resolusi kamera atau matikan salah satu
  (`enableFaceTrack` / `enableHandTrack`). Delegate sengaja `CPU` karena GPU sering menggantung.
- **Avatar tidak muncul** — pastikan `public/models/avatar.vrm` ada dan valid (ekstensi `.vrm`).
- **Kamera tidak muncul** — pastikan dibuka via `localhost`, bukan IP LAN.

## Lisensi aset

- `avatar.vrm` (Seed-san) & `VRM1_Constraint_Twist_Sample` — dari repo
  [vrm-c/vrm-specification](https://github.com/vrm-c/vrm-specification) (MIT).
- Model MediaPipe: `face_landmarker.task`, `hand_landmarker.task`, `pose_landmarker_lite.task` (Apache-2.0).