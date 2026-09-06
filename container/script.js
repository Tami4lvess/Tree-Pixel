import * as THREE from "three/webgpu";
import {
  color,
  float,
  vec3,
  normalize,
  positionWorld,
  cameraPosition,
  pow,
  max,
  dot,
  reflect,
  mix,
  uniform,
  materialReference,
  pass,
  mrt,
  output,
  normalView,
  normalWorld,
  metalness,
  roughness,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";

// Dynamic import for GTAO and SSR (addons may fail in some environments)
let ao, denoise, ssrModule, bloomModule;
try {
  const gtaoMod = await import("three/addons/tsl/display/GTAONode.js");
  ao = gtaoMod.ao;
  console.log("GTAO module loaded successfully");
} catch (e) {
  console.warn("GTAO addon module not available:", e.message);
}
try {
  const denoiseMod = await import("three/addons/tsl/display/DenoiseNode.js");
  denoise = denoiseMod.denoise;
  console.log("Denoise module loaded successfully");
} catch (e) {
  console.warn(
    "Denoise addon module not available, will use AO without denoising:",
    e.message,
  );
}
try {
  ssrModule = await import("three/addons/tsl/display/SSRNode.js");
  console.log("SSR module loaded successfully");
} catch (e) {
  console.warn("SSR addon module not available:", e.message);
}
try {
  bloomModule = await import("three/addons/tsl/display/BloomNode.js");
  console.log("Bloom module loaded successfully");
} catch (e) {
  console.warn("Bloom addon module not available:", e.message);
}

// Scene setup
const scene = new THREE.Scene();

// ⚡ Detecção de dispositivo leve: telas pequenas e/ou touch (sem mouse fino)
// rodam em GPUs bem mais fracas que desktop, então usamos isso para cortar
// os efeitos mais caros (AO, SSR, sombras em alta resolução, MSAA) e manter
// a animação fluida no celular.
const isMobile =
  window.matchMedia("(max-width: 820px)").matches ||
  window.matchMedia("(pointer: coarse)").matches;

//  CORRIGIDO: aponta para o container correto no HTML
const sceneContainer = document.getElementById("canvas-container");

const containerW = () => sceneContainer.clientWidth || window.innerWidth;
const containerH = () => sceneContainer.clientHeight || window.innerHeight;

const camera = new THREE.PerspectiveCamera(
  40,
  containerW() / containerH(),
  0.5,
  150, // ⚡ Otimização de leveza: era 500. A árvore + folhas caindo nunca
  // passam de ~85 unidades de distância da câmera; 150 dá margem confortável
  // sem desperdiçar GPU processando ~350 unidades de espaço vazio que
  // nunca aparecem na tela (sombra, AO e profundidade calculam menos).
);
camera.position.set(30, 30, 66);
camera.lookAt(0, 6, 0);

// Offset the view so the 3D object appears on the right side of the screen
function applyViewOffset() {
  const w = containerW();
  const h = containerH();
  const offsetX = -w * 0.12; // shift view to the right
  camera.setViewOffset(w, h, offsetX, 0, w, h);
}
applyViewOffset();

let renderer;
try {
  renderer = new THREE.WebGPURenderer({ antialias: !isMobile });
  renderer.setSize(containerW(), containerH());
  renderer.setPixelRatio(
    isMobile ? 1 : Math.min(window.devicePixelRatio, 1.5),
  );
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = isMobile
    ? THREE.PCFShadowMap
    : THREE.VSMShadowMap;
  //  CORRIGIDO: canvas vai direto pro sceneContainer
  sceneContainer.appendChild(renderer.domElement);
  await renderer.init();
  console.log("WebGPU renderer initialized");
} catch (e) {
  console.warn("WebGPU not available, falling back to WebGL:", e);
  renderer = new THREE.WebGPURenderer({
    antialias: !isMobile,
    forceWebGL: true,
  });
  renderer.setSize(containerW(), containerH());
  renderer.setPixelRatio(
    isMobile ? 1 : Math.min(window.devicePixelRatio, 1.5),
  );
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = isMobile
    ? THREE.PCFShadowMap
    : THREE.VSMShadowMap;
  //  CORRIGIDO: canvas vai direto pro sceneContainer
  sceneContainer.appendChild(renderer.domElement);
  await renderer.init();
}

// Instant procedural environment — no external HDR fetch needed for initial load
const pmremGenerator = new THREE.PMREMGenerator(renderer);

// Create a warm sky gradient environment cube
function createSkyEnvironment() {
  const envScene = new THREE.Scene();

  // Sky dome with gradient
  const skyGeo = new THREE.SphereGeometry(50, 32, 16);
  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const skyUV = normalWorld;
  skyMat.colorNode = mix(
    color(0x87ceeb), // light blue sky
    color(0xffeedd), // warm horizon
    pow(max(float(0).sub(skyUV.y), float(0)), float(0.8)),
  ).add(
    mix(
      color(0x000000),
      color(0xfff5e0),
      max(skyUV.y, float(0)).mul(float(0.3)),
    ),
  );
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.name = "skyDome";
  envScene.add(skyMesh);

  // Bright area to simulate sun
  const sunGeo = new THREE.SphereGeometry(3, 16, 8);
  const sunMat = new THREE.MeshBasicNodeMaterial();
  sunMat.colorNode = color(0xffffee).mul(float(2.0));
  const sunMesh = new THREE.Mesh(sunGeo, sunMat);
  sunMesh.name = "sunGlow";
  sunMesh.position.set(15, 20, 10);
  envScene.add(sunMesh);

  const envRT = pmremGenerator.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;
  scene.background = envRT.texture;
  scene.backgroundBlurriness = 0.25;
  scene.backgroundIntensity = 0.8;

  envScene.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  });
}
createSkyEnvironment();

// Lazy-load HDR for higher quality (non-blocking, replaces procedural env when ready)
const rgbeLoader = new RGBELoader();
requestIdleCallback(
  () => {
    rgbeLoader.load(
      "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_puresky_1k.hdr",
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        if (scene.environment) scene.environment.dispose();
        if (scene.background && scene.background.isTexture)
          scene.background.dispose();
        scene.environment = texture;
        scene.background = texture;
        scene.backgroundBlurriness = 0.25;
        scene.backgroundIntensity = 0.8;
        console.log("HDR environment loaded (deferred)");
      },
    );
  },
  { timeout: 3000 },
);

// Shared geometry — use lower-poly boxes (1 segment each)
const voxelSize = 1.0;
const gap = 0.0;
const step = voxelSize + gap;
const voxelGeo = new THREE.BoxGeometry(
  voxelSize,
  voxelSize,
  voxelSize,
  1,
  1,
  1,
);

// Color palettes for different elements
const grassColors = [
  "#4a8c3f",
  "#3d7a34",
  "#5a9e4a",
  "#2d6b24",
  "#68ad58",
  "#3f8535",
  "#4d9040",
  "#55a048",
];
const rockColors = [
  "#a0978a",
  "#8c8478",
  "#b5ad9e",
  "#9a9184",
  "#c2bab0",
  "#7d756a",
  "#bbb3a6",
  "#938b7f",
];
const trunkColors = ["#4a3728", "#3d2e20", "#5c4535", "#2e2218", "#6b5444"];
const leafColors = [
  "#e63c2e",
  "#d4452f",
  "#f05a3a",
  "#c93525",
  "#ff6b45",
  "#e8502a",
  "#d94a30",
  "#f24832",
  "#ff7f50",
  "#e06030",
];
const flowerColors = [
  "#e63c2e",
  "#f05a3a",
  "#ff6b45",
  "#f5a623",
  "#ff8c42",
  "#e8502a",
];

// Instanced rendering — ONE InstancedMesh per category with per-instance colors
const voxelMats = [];
const voxels = []; // will hold InstancedMesh references

// Category-based batching: all voxels of same category share ONE material + InstancedMesh
// Categories: grass, underside, rock, trunk, leaf, flower, grassTuft, mushroom
const categoryBatches = {};

// Global occupied position tracker to prevent duplicate voxels at the same location
const occupiedPositions = new Set();
function posKey(x, y, z) {
  return `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Queue a voxel into a category batch (standard voxelGeo size)
function createVoxel(name, x, y, z, hex, roughnessVal, metalnessVal, category) {
  const pk = posKey(x, y, z);
  if (occupiedPositions.has(pk)) return;
  occupiedPositions.add(pk);
  const cat = category || "default";
  if (!categoryBatches[cat]) {
    categoryBatches[cat] = {
      rough: roughnessVal ?? 0.6,
      metal: metalnessVal ?? 0.15,
      geo: "voxel",
      transforms: [],
      colors: [],
    };
  }
  categoryBatches[cat].transforms.push({
    x,
    y,
    z,
    sx: 1,
    sy: 1,
    sz: 1,
    rx: 0,
    rz: 0,
  });
  categoryBatches[cat].colors.push(hex);
}

// Queue a custom-sized voxel into a category batch
function createCustomVoxel(
  hex,
  x,
  y,
  z,
  sx,
  sy,
  sz,
  rx,
  rz,
  roughnessVal,
  metalnessVal,
  category,
) {
  const pk = posKey(x, y, z);
  if (occupiedPositions.has(pk)) return;
  occupiedPositions.add(pk);
  const cat = category || "custom";
  const geoKey = sx.toFixed(2) + "_" + sy.toFixed(2) + "_" + sz.toFixed(2);
  const catKey = cat + "|" + geoKey;
  if (!categoryBatches[catKey]) {
    categoryBatches[catKey] = {
      rough: roughnessVal ?? 0.6,
      metal: metalnessVal ?? 0.15,
      geo: geoKey,
      transforms: [],
      colors: [],
    };
  }
  categoryBatches[catKey].transforms.push({
    x,
    y,
    z,
    sx: 1,
    sy: 1,
    sz: 1,
    rx: rx || 0,
    rz: rz || 0,
  });
  categoryBatches[catKey].colors.push(hex);
}

// Geometry cache for custom sizes
const geoCache = { voxel: voxelGeo };
function getGeo(key, sx, sy, sz) {
  if (key === "voxel") return voxelGeo;
  if (!geoCache[key]) {
    geoCache[key] = new THREE.BoxGeometry(
      voxelSize * sx,
      voxelSize * sy,
      voxelSize * sz,
    );
  }
  return geoCache[key];
}

// Material presets per category (use cheaper MeshStandardNodeMaterial where clearcoat isn't needed)
const categoryMatPresets = {
  grass: { rough: 0.85, metal: 0.05, clearcoat: 0, physical: false },
  underside: { rough: 0.92, metal: 0.03, clearcoat: 0, physical: false },
  rock: { rough: 0.75, metal: 0.1, clearcoat: 0.3, physical: true },
  trunk: { rough: 0.9, metal: 0.05, clearcoat: 0, physical: false },
  leaf: { rough: 0.7, metal: 0.05, clearcoat: 0.3, physical: true },
  flower: { rough: 0.7, metal: 0.0, clearcoat: 0, physical: false },
  grassTuft: { rough: 0.9, metal: 0.0, clearcoat: 0, physical: false },
  mushroom: { rough: 0.8, metal: 0.0, clearcoat: 0, physical: false },
};

// Finalize all batches into InstancedMesh objects with per-instance colors
function buildInstancedMeshes() {
  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  for (const catKey in categoryBatches) {
    const batch = categoryBatches[catKey];
    const count = batch.transforms.length;
    if (count === 0) continue;

    const baseCat = catKey.split("|")[0];
    const preset = categoryMatPresets[baseCat] || {
      rough: 0.6,
      metal: 0.15,
      clearcoat: 0.3,
      physical: true,
    };

    let mat;
    if (preset.physical) {
      mat = new THREE.MeshPhysicalNodeMaterial();
      mat.clearcoat = preset.clearcoat;
      mat.clearcoatRoughness = 0.5;
      mat.reflectivity = 0.3;
      mat.ior = 1.5;
    } else {
      mat = new THREE.MeshStandardNodeMaterial();
    }
    mat.color = new THREE.Color(0xffffff);
    mat.roughness = preset.rough;
    mat.metalness = preset.metal;
    mat.envMapIntensity = 1.2;
    mat.flatShading = true;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 1;
    mat.polygonOffsetUnits = 1;
    voxelMats.push(mat);

    let geo;
    if (batch.geo === "voxel") {
      geo = voxelGeo;
    } else {
      const parts = batch.geo.split("_").map(Number);
      geo = getGeo(batch.geo, parts[0], parts[1], parts[2]);
    }

    const im = new THREE.InstancedMesh(geo, mat, count);
    im.name = "cat_" + catKey.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
    im.castShadow = !isMobile;
    im.receiveShadow = !isMobile;

    for (let i = 0; i < count; i++) {
      const t = batch.transforms[i];
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(t.rx, 0, t.rz);
      dummy.scale.set(t.sx, t.sy, t.sz);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      tmpColor.set(batch.colors[i]);
      im.setColorAt(i, tmpColor);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.frustumCulled = true;

    scene.add(im);
    voxels.push(im);
  }
  console.log(
    `Built ${voxels.length} instanced meshes from ${Object.keys(categoryBatches).length} categories`,
  );
}

// === MORPHING SYSTEM — 3 island variations ===
let currentVariation = 0;
const VARIATION_COUNT = 3;
const VARIATION_NAMES = ["Autumn Maple", "Snowy Pine", "Cherry Blossom"];
const VARIATION_BLOOM = [0.5, 0.15, 0.25, 0.4];
let isMorphing = false;
const morphDuration = 1.8;

const hillData = [];
const undersideData = [];

function pseudoNoise(x, z) {
  return (
    Math.sin(x * 1.7 + z * 0.9) * 0.4 +
    Math.cos(z * 2.1 - x * 0.6) * 0.35 +
    Math.sin((x + z) * 1.1) * 0.25
  );
}

const dirtColors = [
  "#8B6914",
  "#7A5C12",
  "#6B4E10",
  "#9C7A1E",
  "#5C4010",
  "#A07828",
  "#6E5518",
];
const stoneUndersideColors = [
  "#706860",
  "#5E564F",
  "#887F75",
  "#4D4640",
  "#63594F",
  "#7A7068",
];

for (let x = -8; x <= 8; x++) {
  for (let z = -6; z <= 6; z++) {
    const dist = Math.sqrt(x * x * 0.45 + z * z * 0.55);
    if (dist < 7.5 + pseudoNoise(x, z) * 1.5)
      hillData.push({ x, y: 0, z, type: "grass" });
  }
}
for (let x = -9; x <= 9; x++) {
  for (let z = -7; z <= 7; z++) {
    const dist = Math.sqrt(x * x * 0.4 + z * z * 0.5);
    if (dist < 8.5 + pseudoNoise(x * 0.7, z * 0.7) * 1.2)
      hillData.push({ x, y: -1, z, type: "grass" });
  }
}
for (let x = -7; x <= 6; x++) {
  for (let z = -5; z <= 5; z++) {
    const dist = Math.sqrt(x * x * 0.5 + z * z * 0.6);
    if (dist < 6.0 + pseudoNoise(x, z) * 1.2)
      hillData.push({ x, y: 1, z, type: "grass" });
  }
}
for (let x = -5; x <= 4; x++) {
  for (let z = -4; z <= 3; z++) {
    const dist = Math.sqrt(x * x * 0.55 + z * z * 0.65);
    if (dist < 4.5 + pseudoNoise(x, z) * 0.9)
      hillData.push({ x, y: 2, z, type: "grass" });
  }
}
for (let x = -4; x <= 3; x++) {
  for (let z = -3; z <= 2; z++) {
    const dist = Math.sqrt(x * x * 0.6 + z * z * 0.7);
    if (dist < 3.5 + pseudoNoise(x, z) * 0.7)
      hillData.push({ x, y: 3, z, type: "grass" });
  }
}
for (let x = -3; x <= 2; x++) {
  for (let z = -2; z <= 2; z++) {
    const dist = Math.sqrt(x * x * 0.7 + z * z * 0.8);
    if (dist < 2.8 + pseudoNoise(x, z) * 0.5)
      hillData.push({ x, y: 4, z, type: "grass" });
  }
}
for (let x = -2; x <= 1; x++) {
  for (let z = -1; z <= 1; z++) {
    const dist = Math.sqrt(x * x + z * z);
    if (dist < 2.0) hillData.push({ x, y: 5, z, type: "grass" });
  }
}
for (let x = -1; x <= 0; x++) {
  for (let z = -1; z <= 0; z++) {
    hillData.push({ x, y: 6, z, type: "grass" });
  }
}
for (let x = 4; x <= 8; x++) {
  for (let z = -2; z <= 3; z++) {
    const cx = x - 6,
      cz = z - 0.5;
    const dist = Math.sqrt(cx * cx + cz * cz);
    if (dist < 2.8 + pseudoNoise(x, z) * 0.5)
      hillData.push({ x, y: 1, z, type: "grass" });
    if (dist < 2.0 + pseudoNoise(x, z) * 0.3)
      hillData.push({ x, y: 2, z, type: "grass" });
    if (dist < 1.2) hillData.push({ x, y: 3, z, type: "grass" });
  }
}
for (let x = -6; x <= -3; x++) {
  for (let z = -5; z <= -2; z++) {
    const cx = x + 4.5,
      cz = z + 3.5;
    const dist = Math.sqrt(cx * cx + cz * cz);
    if (dist < 2.0 + pseudoNoise(x, z) * 0.4)
      hillData.push({ x, y: 1, z, type: "grass" });
    if (dist < 1.2) hillData.push({ x, y: 2, z, type: "grass" });
  }
}

const topSurfaceSet = new Set();
hillData.forEach((d) => topSurfaceSet.add(`${d.x},${d.y},${d.z}`));

for (let y = -2; y >= -14; y--) {
  const depth = Math.abs(y + 1);
  const maxRadius = Math.max(
    0.5,
    8.5 - depth * 0.55 + Math.sin(depth * 0.8) * 0.8,
  );
  const cx = Math.sin(depth * 0.7) * 0.4;
  const cz = Math.cos(depth * 0.9) * 0.3;
  for (let x = -10; x <= 10; x++) {
    for (let z = -8; z <= 8; z++) {
      const dx = x - cx,
        dz = z - cz;
      const dist = Math.sqrt(dx * dx * 0.45 + dz * dz * 0.55);
      const noise =
        pseudoNoise(x * 0.8 + depth * 0.3, z * 0.8 - depth * 0.2) *
        (1.0 + depth * 0.08);
      if (dist < maxRadius + noise) {
        const isDirt = depth < 4;
        undersideData.push({ x, y, z, type: isDirt ? "dirt" : "stone" });
      }
    }
  }
}

const stalactites = [
  { cx: 0, cz: 0, length: 4, r: 1.2 },
  { cx: -3, cz: -1, length: 3, r: 0.9 },
  { cx: 2, cz: 2, length: 3, r: 0.8 },
  { cx: -1, cz: -3, length: 2, r: 0.7 },
  { cx: 3, cz: -2, length: 2, r: 0.6 },
  { cx: -4, cz: 1, length: 2, r: 0.7 },
  { cx: 1, cz: -4, length: 2, r: 0.5 },
  { cx: -2, cz: 3, length: 3, r: 0.8 },
];
stalactites.forEach((st) => {
  for (let y = -14; y >= -14 - st.length; y--) {
    const tipDist = Math.abs(y + 14);
    const r = Math.max(0.3, st.r - tipDist * 0.25);
    for (
      let x = Math.floor(st.cx - r - 1);
      x <= Math.ceil(st.cx + r + 1);
      x++
    ) {
      for (
        let z = Math.floor(st.cz - r - 1);
        z <= Math.ceil(st.cz + r + 1);
        z++
      ) {
        const dx = x - st.cx,
          dz = z - st.cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < r + pseudoNoise(x + tipDist, z - tipDist) * 0.3) {
          undersideData.push({ x, y, z, type: "stone" });
        }
      }
    }
  }
});

undersideData.forEach((d, i) => {
  const c =
    d.type === "dirt"
      ? pickRandom(dirtColors)
      : pickRandom(stoneUndersideColors);
  createVoxel(
    `underside_${i}`,
    d.x * step,
    d.y * step + voxelSize / 2,
    d.z * step,
    c,
    0.92,
    0.03,
    "underside",
  );
});

hillData.forEach((d, i) => {
  const c = pickRandom(grassColors);
  createVoxel(
    `grass_${i}`,
    d.x * step,
    d.y * step + voxelSize / 2,
    d.z * step,
    c,
    0.85,
    0.05,
    "grass",
  );
});

const rockPositions = [
  { x: -2, y: 5, z: -1 },
  { x: -1, y: 5, z: -1 },
  { x: 0, y: 5, z: -1 },
  { x: 1, y: 5, z: -1 },
  { x: -2, y: 5, z: 0 },
  { x: -1, y: 5, z: 0 },
  { x: 0, y: 5, z: 0 },
  { x: 1, y: 5, z: 0 },
  { x: -1, y: 5, z: 1 },
  { x: 0, y: 5, z: 1 },
  { x: 1, y: 5, z: 1 },
  { x: -2, y: 5, z: 1 },
  { x: -1, y: 6, z: -1 },
  { x: 0, y: 6, z: -1 },
  { x: 1, y: 6, z: -1 },
  { x: -2, y: 6, z: 0 },
  { x: -1, y: 6, z: 0 },
  { x: 0, y: 6, z: 0 },
  { x: 1, y: 6, z: 0 },
  { x: -1, y: 6, z: 1 },
  { x: 0, y: 6, z: 1 },
  { x: -2, y: 6, z: -1 },
  { x: -1, y: 7, z: -1 },
  { x: 0, y: 7, z: -1 },
  { x: -1, y: 7, z: 0 },
  { x: 0, y: 7, z: 0 },
  { x: 1, y: 7, z: 0 },
  { x: 0, y: 7, z: 1 },
  { x: -1, y: 7, z: 1 },
  { x: 0, y: 8, z: 0 },
  { x: -1, y: 8, z: 0 },
  { x: 0, y: 8, z: -1 },
  { x: -1, y: 8, z: -1 },
  { x: 3, y: 2, z: 2 },
  { x: 3, y: 3, z: 2 },
  { x: 4, y: 1, z: -1 },
  { x: 4, y: 2, z: -1 },
  { x: -4, y: 1, z: -2 },
  { x: -4, y: 2, z: -2 },
  { x: -3, y: 2, z: 2 },
  { x: -3, y: 3, z: 2 },
  { x: 5, y: 1, z: 1 },
  { x: 5, y: 1, z: 0 },
  { x: -5, y: 1, z: 0 },
  { x: 2, y: 3, z: -2 },
  { x: 2, y: 4, z: -2 },
  { x: -3, y: 3, z: -1 },
  { x: 6, y: 1, z: -2 },
  { x: -6, y: 0, z: 2 },
  { x: 1, y: 4, z: 2 },
  { x: -2, y: 4, z: -2 },
  { x: 3, y: 1, z: -3 },
  { x: -2, y: 1, z: 3 },
  { x: 6, y: 2, z: 0 },
  { x: 6, y: 3, z: 0 },
  { x: 7, y: 2, z: 1 },
];
rockPositions.forEach((d, i) => {
  const c = pickRandom(rockColors);
  createVoxel(
    `rock_${i}`,
    d.x * step,
    d.y * step + voxelSize / 2,
    d.z * step,
    c,
    0.75,
    0.1,
    "rock",
  );
});

const trunkPositions = [
  { x: 0, y: 9, z: 0 },
  { x: -1, y: 9, z: 0 },
  { x: 0, y: 9, z: -1 },
  { x: -1, y: 9, z: -1 },
  { x: 0, y: 10, z: 0 },
  { x: -1, y: 10, z: 0 },
  { x: 0, y: 10, z: -1 },
  { x: -1, y: 10, z: -1 },
  { x: 0, y: 11, z: 0 },
  { x: -1, y: 11, z: 0 },
  { x: 0, y: 11, z: -1 },
  { x: 0, y: 12, z: 0 },
  { x: -1, y: 12, z: 0 },
  { x: 0, y: 12, z: -1 },
  { x: 0, y: 13, z: 0 },
  { x: -1, y: 13, z: 0 },
  { x: 0, y: 14, z: 0 },
  { x: -1, y: 14, z: 0 },
  { x: 0, y: 15, z: 0 },
  { x: 0, y: 16, z: 0 },
  { x: -1, y: 14, z: 0 },
  { x: -2, y: 15, z: 0 },
  { x: -3, y: 15, z: 0 },
  { x: -3, y: 16, z: 0 },
  { x: -4, y: 16, z: 0 },
  { x: -4, y: 16, z: 1 },
  { x: -5, y: 17, z: 0 },
  { x: -5, y: 17, z: 1 },
  { x: 1, y: 14, z: 0 },
  { x: 2, y: 14, z: 0 },
  { x: 2, y: 15, z: 0 },
  { x: 3, y: 15, z: 0 },
  { x: 3, y: 16, z: 0 },
  { x: 4, y: 16, z: 0 },
  { x: 4, y: 17, z: 0 },
  { x: 5, y: 17, z: -1 },
  { x: 0, y: 14, z: 1 },
  { x: 0, y: 15, z: 1 },
  { x: 0, y: 15, z: 2 },
  { x: 1, y: 16, z: 2 },
  { x: 1, y: 16, z: 3 },
  { x: 0, y: 13, z: -1 },
  { x: 0, y: 14, z: -2 },
  { x: 0, y: 15, z: -2 },
  { x: -1, y: 15, z: -2 },
  { x: -1, y: 16, z: -3 },
  { x: 0, y: 16, z: -3 },
  { x: 0, y: 17, z: 0 },
  { x: 0, y: 18, z: 0 },
  { x: 1, y: 13, z: -1 },
  { x: -2, y: 14, z: -1 },
  { x: 2, y: 16, z: 1 },
  { x: -3, y: 17, z: -1 },
  { x: 1, y: 8, z: 0 },
  { x: -2, y: 8, z: 0 },
  { x: 0, y: 8, z: 1 },
  { x: -1, y: 8, z: -1 },
  { x: 1, y: 7, z: 1 },
  { x: -2, y: 7, z: -1 },
];
trunkPositions.forEach((d, i) => {
  const c = pickRandom(trunkColors);
  createVoxel(
    `trunk_${i}`,
    d.x * step,
    d.y * step + voxelSize / 2,
    d.z * step,
    c,
    0.9,
    0.05,
    "trunk",
  );
});

const leafPositions = [];
const leafSet = new Set();
function addLeaf(x, y, z) {
  const key = `${x},${y},${z}`;
  if (!leafSet.has(key)) {
    leafSet.add(key);
    leafPositions.push({ x, y, z });
  }
}

const canopyCenterX = 0,
  canopyCenterY = 20,
  canopyCenterZ = 0;
const canopyRadiusH = 6.5,
  canopyRadiusV = 4.5;

for (let x = -8; x <= 8; x++) {
  for (let y = 15; y <= 26; y++) {
    for (let z = -7; z <= 7; z++) {
      const dx = x - canopyCenterX;
      const dy = (y - canopyCenterY) * (canopyRadiusH / canopyRadiusV);
      const dz = z - canopyCenterZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const edgeNoise =
        Math.sin(x * 1.8 + z * 1.4) * 0.7 +
        Math.cos(y * 1.1 + x * 0.7) * 0.6 +
        Math.sin(z * 2.3 - y * 0.5) * 0.4;
      if (dist < canopyRadiusH + edgeNoise && Math.random() > 0.18)
        addLeaf(x, y, z);
    }
  }
}

const branchTips = [
  { cx: -5, cy: 17, cz: 0, r: 3.5 },
  { cx: -5, cy: 17, cz: 1, r: 2.8 },
  { cx: 5, cy: 17, cz: -1, r: 3.5 },
  { cx: 4, cy: 18, cz: 0, r: 3.0 },
  { cx: 1, cy: 17, cz: 3, r: 3.2 },
  { cx: 1, cy: 17, cz: -3, r: 3.0 },
  { cx: -1, cy: 17, cz: -3, r: 2.8 },
  { cx: 0, cy: 24, cz: 0, r: 3.0 },
  { cx: -2, cy: 23, cz: 1, r: 2.5 },
  { cx: 2, cy: 23, cz: -1, r: 2.5 },
  { cx: 1, cy: 24, cz: 1, r: 2.0 },
  { cx: -1, cy: 24, cz: -1, r: 2.0 },
  { cx: -7, cy: 18, cz: 0, r: 2.0 },
  { cx: 6, cy: 18, cz: 0, r: 2.0 },
  { cx: 0, cy: 18, cz: 5, r: 2.2 },
  { cx: 0, cy: 18, cz: -5, r: 2.2 },
  { cx: -3, cy: 15, cz: 2, r: 2.5 },
  { cx: 3, cy: 15, cz: -2, r: 2.5 },
  { cx: -2, cy: 15, cz: -3, r: 2.0 },
  { cx: 2, cy: 15, cz: 3, r: 2.0 },
];
branchTips.forEach((tip) => {
  for (
    let x = Math.floor(tip.cx - tip.r - 1);
    x <= Math.ceil(tip.cx + tip.r + 1);
    x++
  ) {
    for (
      let y = Math.floor(tip.cy - tip.r);
      y <= Math.ceil(tip.cy + tip.r + 1);
      y++
    ) {
      for (
        let z = Math.floor(tip.cz - tip.r - 1);
        z <= Math.ceil(tip.cz + tip.r + 1);
        z++
      ) {
        const dx = x - tip.cx,
          dy = (y - tip.cy) * 1.15,
          dz = z - tip.cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < tip.r && Math.random() > 0.2) addLeaf(x, y, z);
      }
    }
  }
});

for (let i = 0; i < 25; i++) {
  addLeaf(
    Math.round((Math.random() - 0.5) * 14),
    Math.floor(Math.random() * 3) + 1,
    Math.round((Math.random() - 0.5) * 10),
  );
}

leafPositions.forEach((d, i) => {
  const c = pickRandom(leafColors);
  createVoxel(
    `leaf_${i}`,
    d.x * step,
    d.y * step + voxelSize / 2,
    d.z * step,
    c,
    0.7,
    0.05,
    "leaf",
  );
});

const grassTopMap = {};
hillData.forEach((d) => {
  const key = `${d.x},${d.z}`;
  if (!grassTopMap[key] || d.y > grassTopMap[key]) grassTopMap[key] = d.y;
});

const grassTuftColors = ["#3a8530", "#4a9540", "#2d7020", "#5aad50", "#3d8a35"];
const rockSet = new Set(rockPositions.map((r) => `${r.x},${r.z}`));

Object.entries(grassTopMap).forEach(([key, topY]) => {
  const [gx, gz] = key.split(",").map(Number);
  const blocked = rockSet.has(key);
  if (!blocked && Math.random() < 0.4) {
    const numFlowers = Math.random() < 0.3 ? 2 : 1;
    for (let f = 0; f < numFlowers; f++) {
      const c = pickRandom(flowerColors);
      createCustomVoxel(
        c,
        gx * step + (Math.random() - 0.5) * 0.5,
        (topY + 1) * step + voxelSize * 0.22,
        gz * step + (Math.random() - 0.5) * 0.5,
        0.35,
        0.35,
        0.35,
        0,
        0,
        0.7,
        0.0,
        "flower",
      );
    }
  }
  if (!blocked && Math.random() < 0.3) {
    const c = pickRandom(grassTuftColors);
    createCustomVoxel(
      c,
      gx * step + (Math.random() - 0.5) * 0.6,
      (topY + 1) * step + voxelSize * 0.32,
      gz * step + (Math.random() - 0.5) * 0.6,
      0.25,
      0.55,
      0.25,
      (Math.random() - 0.5) * 0.15,
      (Math.random() - 0.5) * 0.15,
      0.9,
      0.0,
      "grassTuft",
    );
  }
});

const mushroomColors = ["#f5e6c8", "#e8d5b0", "#d4c49a", "#c9b88e"];
Object.entries(grassTopMap).forEach(([key, topY]) => {
  const [gx, gz] = key.split(",").map(Number);
  if (gx < -2 && Math.random() < 0.15 && !rockSet.has(key)) {
    const c = pickRandom(mushroomColors);
    createCustomVoxel(
      c,
      gx * step + (Math.random() - 0.5) * 0.3,
      (topY + 1) * step + voxelSize * 0.15,
      gz * step + (Math.random() - 0.5) * 0.3,
      0.25,
      0.22,
      0.25,
      0,
      0,
      0.8,
      0.0,
      "mushroom",
    );
  }
});

buildInstancedMeshes();

const instanceData = new Map();
const _islandBBox = new THREE.Box3();

{
  const dummy = new THREE.Object3D();
  const mat4 = new THREE.Matrix4();
  voxels.forEach((im) => {
    const count = im.count;
    const orig = new Float32Array(count * 3);
    const offsets = new Float32Array(count * 3);
    const randDirs = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      im.getMatrixAt(i, mat4);
      mat4.decompose(dummy.position, dummy.quaternion, dummy.scale);
      orig[i * 3] = dummy.position.x;
      orig[i * 3 + 1] = dummy.position.y;
      orig[i * 3 + 2] = dummy.position.z;
      _islandBBox.expandByPoint(dummy.position);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      randDirs[i * 3] = Math.sin(phi) * Math.cos(theta);
      randDirs[i * 3 + 1] = Math.sin(phi) * Math.sin(theta);
      randDirs[i * 3 + 2] = Math.cos(phi);
    }
    instanceData.set(im, { origPositions: orig, offsets, randDirs, count });
  });
  _islandBBox.expandByScalar(3.0);
}

const variationData = [];

function snapshotVariation() {
  const snap = new Map();
  const dummy = new THREE.Object3D();
  const mat4 = new THREE.Matrix4();
  const tmpColor = new THREE.Color();
  voxels.forEach((im) => {
    const count = im.count;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      im.getMatrixAt(i, mat4);
      mat4.decompose(dummy.position, dummy.quaternion, dummy.scale);
      positions[i * 3] = dummy.position.x;
      positions[i * 3 + 1] = dummy.position.y;
      positions[i * 3 + 2] = dummy.position.z;
      if (im.instanceColor) {
        im.getColorAt(i, tmpColor);
        colors[i * 3] = tmpColor.r;
        colors[i * 3 + 1] = tmpColor.g;
        colors[i * 3 + 2] = tmpColor.b;
      } else {
        colors[i * 3] = im.material.color.r;
        colors[i * 3 + 1] = im.material.color.g;
        colors[i * 3 + 2] = im.material.color.b;
      }
    }
    snap.set(im, { positions, colors });
  });
  return snap;
}

variationData[0] = snapshotVariation();

function meshCategory(im) {
  const n = im.name || "";
  if (n.startsWith("cat_leaf")) return "leaf";
  if (n.startsWith("cat_trunk")) return "trunk";
  if (n.startsWith("cat_grass")) return "grass";
  if (n.startsWith("cat_rock")) return "rock";
  if (n.startsWith("cat_underside")) return "underside";
  if (n.startsWith("cat_flower")) return "flower";
  if (n.startsWith("cat_mushroom")) return "mushroom";
  return "other";
}

function generateSnowyPineOffsets() {
  const snap = new Map();
  const dummy = new THREE.Object3D();
  const mat4 = new THREE.Matrix4();
  const tmpColor = new THREE.Color();
  const snowGrass = ["#e8f0e8", "#d0e0d0", "#c8dcc8", "#f0f5f0", "#dceadc"];
  const snowRock = ["#d0d0d0", "#c0c0c0", "#e0e0e0", "#b8b8b8", "#cccccc"];
  const pineColors = [
    "#1a4a2a",
    "#224e30",
    "#183e24",
    "#2a5a38",
    "#1e4828",
    "#164020",
  ];
  const pineTrunk = ["#3a2818", "#2e2010", "#4a3420", "#342818"];
  const snowWhite = ["#f0f5ff", "#e8eeff", "#ffffff", "#f5f8ff", "#eaf0ff"];
  const iceBlue = ["#c8e0f8", "#b0d0f0", "#a8c8e8"];
  voxels.forEach((im) => {
    const data = instanceData.get(im);
    if (!data) return;
    const count = im.count;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const origPositions = data.origPositions;
    const cat = meshCategory(im);
    for (let i = 0; i < count; i++) {
      const ox = origPositions[i * 3],
        oy = origPositions[i * 3 + 1],
        oz = origPositions[i * 3 + 2];
      let cr, cg, cb;
      if (im.instanceColor) {
        im.getColorAt(i, tmpColor);
        cr = tmpColor.r;
        cg = tmpColor.g;
        cb = tmpColor.b;
      } else {
        cr = im.material.color.r;
        cg = im.material.color.g;
        cb = im.material.color.b;
      }
      let nx = ox,
        ny = oy,
        nz = oz;
      if (cat === "leaf") {
        const relY = (oy - 14) / 12;
        const angle = Math.atan2(oz, ox);
        const origR = Math.sqrt(ox * ox + oz * oz);
        const tier = Math.floor(relY * 5);
        const tierFrac = relY * 5 - tier;
        const tierRadius = Math.max(
          0.3,
          (5.5 - tier * 1.0) * (1.0 - tierFrac * 0.3),
        );
        const mappedR =
          Math.min(origR, tierRadius) * (tierRadius / Math.max(3, origR + 1));
        nx = Math.cos(angle) * mappedR * 1.1;
        nz = Math.sin(angle) * mappedR * 1.1;
        ny = oy + relY * 2.0;
        nx += (Math.random() - 0.5) * 0.25;
        ny += (Math.random() - 0.5) * 0.25;
        nz += (Math.random() - 0.5) * 0.25;
        if (tierFrac > 0.6 || relY > 0.8) {
          const sc = new THREE.Color(pickRandom(snowWhite));
          cr = sc.r * 0.72;
          cg = sc.g * 0.72;
          cb = sc.b * 0.75;
        } else {
          const pc = new THREE.Color(pickRandom(pineColors));
          cr = pc.r;
          cg = pc.g;
          cb = pc.b;
        }
      } else if (cat === "trunk") {
        nx = ox * 0.7 + (Math.random() - 0.5) * 0.15;
        nz = oz * 0.7 + (Math.random() - 0.5) * 0.15;
        const tc = new THREE.Color(pickRandom(pineTrunk));
        cr = tc.r;
        cg = tc.g;
        cb = tc.b;
      } else if (cat === "grass") {
        const sc = new THREE.Color(pickRandom(snowGrass));
        cr = sc.r * 0.82;
        cg = sc.g * 0.82;
        cb = sc.b * 0.84;
      } else if (cat === "rock") {
        const rc = new THREE.Color(
          pickRandom(Math.random() < 0.3 ? iceBlue : snowRock),
        );
        cr = rc.r * 0.85;
        cg = rc.g * 0.85;
        cb = rc.b * 0.88;
      } else if (cat === "underside") {
        const uc = new THREE.Color(pickRandom(stoneUndersideColors));
        cr = uc.r;
        cg = uc.g;
        cb = uc.b * 1.05;
      }
      positions[i * 3] = nx;
      positions[i * 3 + 1] = ny;
      positions[i * 3 + 2] = nz;
      colors[i * 3] = cr;
      colors[i * 3 + 1] = cg;
      colors[i * 3 + 2] = cb;
    }
    snap.set(im, { positions, colors });
  });
  return snap;
}
variationData[1] = generateSnowyPineOffsets();

function generateCherryBlossomOffsets() {
  const snap = new Map();
  const dummy = new THREE.Object3D();
  const mat4 = new THREE.Matrix4();
  const tmpColor = new THREE.Color();
  const sakuraGrass = ["#5a9e4a", "#4a8c3f", "#68ad58", "#3d7a34", "#55a048"];
  const sakuraRock = ["#a09888", "#8c847a", "#b5ada0", "#9a9284", "#706860"];
  const blossomPink = [
    "#ffb7c5",
    "#ff97b0",
    "#ffc8d6",
    "#ff85a0",
    "#ffd0db",
    "#ffa0b8",
    "#ff90a8",
    "#ffccd8",
  ];
  const blossomWhite = ["#fff0f5", "#ffe8ef", "#fff5f8", "#ffeef3"];
  const sakuraTrunk = ["#5c3a28", "#4a2e1e", "#6b4835", "#3d2418", "#7a5840"];
  const mossGreen = ["#6b8c50", "#5a7a40", "#7a9c60"];
  voxels.forEach((im) => {
    const data = instanceData.get(im);
    if (!data) return;
    const count = im.count;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const origPositions = data.origPositions;
    const cat = meshCategory(im);
    for (let i = 0; i < count; i++) {
      const ox = origPositions[i * 3],
        oy = origPositions[i * 3 + 1],
        oz = origPositions[i * 3 + 2];
      let cr, cg, cb;
      if (im.instanceColor) {
        im.getColorAt(i, tmpColor);
        cr = tmpColor.r;
        cg = tmpColor.g;
        cb = tmpColor.b;
      } else {
        cr = im.material.color.r;
        cg = im.material.color.g;
        cb = im.material.color.b;
      }
      let nx = ox,
        ny = oy,
        nz = oz;
      if (cat === "leaf") {
        const relY = (oy - 14) / 12;
        const origR = Math.sqrt(ox * ox + oz * oz);
        const droop = origR * 0.06;
        nx = ox * 1.3;
        nz = oz * 1.3;
        ny = oy - droop - relY * 1.5;
        nx += (Math.random() - 0.5) * 0.25;
        ny += (Math.random() - 0.5) * 0.25;
        nz += (Math.random() - 0.5) * 0.25;
        if (Math.random() < 0.15) {
          const wc = new THREE.Color(pickRandom(blossomWhite));
          cr = wc.r;
          cg = wc.g;
          cb = wc.b;
        } else {
          const pc = new THREE.Color(pickRandom(blossomPink));
          cr = pc.r;
          cg = pc.g;
          cb = pc.b;
        }
      } else if (cat === "trunk") {
        const bend = Math.sin(oy * 0.15) * 0.8;
        nx = ox * 0.85 + bend + (Math.random() - 0.5) * 0.15;
        nz = oz * 0.85 + (Math.random() - 0.5) * 0.15;
        const tc = new THREE.Color(pickRandom(sakuraTrunk));
        cr = tc.r;
        cg = tc.g;
        cb = tc.b;
      } else if (cat === "grass") {
        const gc = new THREE.Color(
          pickRandom(Math.random() < 0.2 ? mossGreen : sakuraGrass),
        );
        cr = gc.r;
        cg = gc.g;
        cb = gc.b;
      } else if (cat === "rock") {
        const rc = new THREE.Color(pickRandom(sakuraRock));
        cr = rc.r;
        cg = rc.g;
        cb = rc.b;
      } else if (cat === "flower") {
        const pc = new THREE.Color(pickRandom(blossomPink));
        cr = pc.r;
        cg = pc.g;
        cb = pc.b;
      } else if (cat === "underside") {
        const uc = new THREE.Color(pickRandom(dirtColors));
        cr = uc.r;
        cg = uc.g;
        cb = uc.b;
      }
      positions[i * 3] = nx;
      positions[i * 3 + 1] = ny;
      positions[i * 3 + 2] = nz;
      colors[i * 3] = cr;
      colors[i * 3 + 1] = cg;
      colors[i * 3 + 2] = cb;
    }
    snap.set(im, { positions, colors });
  });
  return snap;
}
variationData[2] = generateCherryBlossomOffsets();

function generateSummerOffsets() {
  const snap = new Map();
  const dummy = new THREE.Object3D();
  const mat4 = new THREE.Matrix4();
  const tmpColor = new THREE.Color();
  // Folhagem cheia e viçosa, verde profundo de verão, com folhas mais
  // claras "batidas de sol" salpicadas pela copa para dar luz entre as
  // sombras — sem neve, sem flor caindo, só o pico da estação.
  const summerLeaf = [
    "#2d6a1f",
    "#3a7d28",
    "#256118",
    "#438a30",
    "#1f5a15",
    "#4f9635",
    "#347522",
  ];
  const summerLeafSunkissed = ["#8fae2e", "#a8c93f", "#7fa028"];
  const summerFruit = ["#c9302c", "#e04030", "#d4501f", "#b82820"];
  const summerTrunk = ["#6b4423", "#7a5230", "#5c3a1c", "#8a5c34"];
  const summerGrass = ["#4a9e30", "#5cb03e", "#3d8a28", "#69bd4a"];
  const summerGrassDry = ["#c9a227", "#d4b23a", "#b8941f"];
  const summerRock = ["#c9a876", "#b89860", "#d4b888", "#a8875a"];
  voxels.forEach((im) => {
    const data = instanceData.get(im);
    if (!data) return;
    const count = im.count;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const origPositions = data.origPositions;
    const cat = meshCategory(im);
    for (let i = 0; i < count; i++) {
      const ox = origPositions[i * 3],
        oy = origPositions[i * 3 + 1],
        oz = origPositions[i * 3 + 2];
      let cr, cg, cb;
      if (im.instanceColor) {
        im.getColorAt(i, tmpColor);
        cr = tmpColor.r;
        cg = tmpColor.g;
        cb = tmpColor.b;
      } else {
        cr = im.material.color.r;
        cg = im.material.color.g;
        cb = im.material.color.b;
      }
      let nx = ox,
        ny = oy,
        nz = oz;
      if (cat === "leaf") {
        const relY = (oy - 14) / 12;
        // Copa cheia, arredondada, se abrindo pro sol — mais fechada que a
        // sakura (que "chora" pra baixo), mais densa que o outono.
        nx = ox * 1.15;
        nz = oz * 1.15;
        ny = oy + relY * 0.3;
        nx += (Math.random() - 0.5) * 0.25;
        ny += (Math.random() - 0.5) * 0.2;
        nz += (Math.random() - 0.5) * 0.25;
        if (Math.random() < 0.16) {
          const sc = new THREE.Color(pickRandom(summerLeafSunkissed));
          cr = sc.r;
          cg = sc.g;
          cb = sc.b;
        } else {
          const lc = new THREE.Color(pickRandom(summerLeaf));
          cr = lc.r;
          cg = lc.g;
          cb = lc.b;
        }
      } else if (cat === "trunk") {
        nx = ox * 0.95 + (Math.random() - 0.5) * 0.15;
        nz = oz * 0.95 + (Math.random() - 0.5) * 0.15;
        const tc = new THREE.Color(pickRandom(summerTrunk));
        cr = tc.r;
        cg = tc.g;
        cb = tc.b;
      } else if (cat === "grass") {
        const gc = new THREE.Color(
          pickRandom(Math.random() < 0.25 ? summerGrassDry : summerGrass),
        );
        cr = gc.r;
        cg = gc.g;
        cb = gc.b;
      } else if (cat === "rock") {
        const rc = new THREE.Color(pickRandom(summerRock));
        cr = rc.r;
        cg = rc.g;
        cb = rc.b;
      } else if (cat === "flower") {
        // Reaproveita as posições de flor da primavera para pequenos
        // frutos vermelhos maduros — a árvore de verão dá fruto.
        const fc = new THREE.Color(pickRandom(summerFruit));
        cr = fc.r;
        cg = fc.g;
        cb = fc.b;
      } else if (cat === "underside") {
        const uc = new THREE.Color(pickRandom(dirtColors));
        cr = uc.r;
        cg = uc.g;
        cb = uc.b;
      }
      positions[i * 3] = nx;
      positions[i * 3 + 1] = ny;
      positions[i * 3 + 2] = nz;
      colors[i * 3] = cr;
      colors[i * 3 + 1] = cg;
      colors[i * 3 + 2] = cb;
    }
    snap.set(im, { positions, colors });
  });
  return snap;
}
variationData[3] = generateSummerOffsets();

// A árvore agora nasce direto na variação "Verão" (a que fica ativa por
// padrão no botão), em vez de nascer no Outono (posição 0) e só trocar
// quando o usuário clicasse. Como isso roda antes do primeiro frame,
// aplica a posição/cor final sem nenhuma animação de transição.
function applyVariationInstant(variation) {
  const toSnap = variationData[variation];
  const dummy = new THREE.Object3D();
  const mat4tmp = new THREE.Matrix4();
  const tmpColor = new THREE.Color();
  voxels.forEach((im) => {
    const data = instanceData.get(im);
    const toData = toSnap.get(im);
    if (!data || !toData) return;
    const count = data.count;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const nx = toData.positions[i3],
        ny = toData.positions[i3 + 1],
        nz = toData.positions[i3 + 2];
      data.origPositions[i3] = nx;
      data.origPositions[i3 + 1] = ny;
      data.origPositions[i3 + 2] = nz;
      const offX = data.offsets[i3],
        offY = data.offsets[i3 + 1],
        offZ = data.offsets[i3 + 2];
      im.getMatrixAt(i, mat4tmp);
      mat4tmp.decompose(dummy.position, dummy.quaternion, dummy.scale);
      dummy.position.set(nx + offX, ny + offY, nz + offZ);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      if (im.instanceColor) {
        tmpColor.setRGB(
          toData.colors[i3],
          toData.colors[i3 + 1],
          toData.colors[i3 + 2],
        );
        im.setColorAt(i, tmpColor);
      }
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  });
  currentVariation = variation;
}
applyVariationInstant(3);

let morphStartTime = 0,
  morphFrom = 0,
  morphTo = 0;
let morphBasePositions = null,
  morphBaseColors = null;

function snapshotCurrentState() {
  const posMap = new Map(),
    colMap = new Map();
  const tmpColor = new THREE.Color();
  voxels.forEach((im) => {
    const data = instanceData.get(im);
    if (!data) return;
    const count = data.count;
    const pos = new Float32Array(count * 3),
      col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = data.origPositions[i * 3];
      pos[i * 3 + 1] = data.origPositions[i * 3 + 1];
      pos[i * 3 + 2] = data.origPositions[i * 3 + 2];
      if (im.instanceColor) {
        im.getColorAt(i, tmpColor);
        col[i * 3] = tmpColor.r;
        col[i * 3 + 1] = tmpColor.g;
        col[i * 3 + 2] = tmpColor.b;
      } else {
        col[i * 3] = im.material.color.r;
        col[i * 3 + 1] = im.material.color.g;
        col[i * 3 + 2] = im.material.color.b;
      }
    }
    posMap.set(im, pos);
    colMap.set(im, col);
  });
  return { posMap, colMap };
}

function startMorph(toVariation) {
  if (isMorphing && morphTo === toVariation) return;
  if (currentVariation === toVariation && !isMorphing) return;
  const current = snapshotCurrentState();
  morphBasePositions = current.posMap;
  morphBaseColors = current.colMap;
  morphFrom = currentVariation;
  morphTo = toVariation;
  morphStartTime = performance.now();
  isMorphing = true;
  // Uma troca de variação precisa reativar o render caso a cena esteja
  // pausada por inatividade, para que o morph seja concluído normalmente.
  lastUserActivityTime = performance.now();
  if (idleModeActive) exitIdleMode();
}

function updateMorph() {
  if (!isMorphing) return;
  const elapsed = (performance.now() - morphStartTime) / 1000;
  let t = Math.min(elapsed / morphDuration, 1.0);
  t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const toSnap = variationData[morphTo];
  const autumnSnap = variationData[0];
  const dummy = new THREE.Object3D();
  const mat4tmp = new THREE.Matrix4();
  const _morphColor = new THREE.Color();
  voxels.forEach((im) => {
    const data = instanceData.get(im);
    if (!data) return;
    const toData = toSnap.get(im);
    const basePos = morphBasePositions.get(im);
    const baseCol = morphBaseColors.get(im);
    const autumnData = autumnSnap.get(im);
    if (!toData || !basePos || !baseCol) return;
    const count = data.count;
    let needsUpdate = false;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const fromX = basePos[i3],
        fromY = basePos[i3 + 1],
        fromZ = basePos[i3 + 2];
      const toX = toData.positions[i3],
        toY = toData.positions[i3 + 1],
        toZ = toData.positions[i3 + 2];
      const staggerX = autumnData ? autumnData.positions[i3] : fromX;
      const staggerZ = autumnData ? autumnData.positions[i3 + 2] : fromZ;
      const stagger =
        (Math.sin(staggerX * 0.5 + staggerZ * 0.7) * 0.5 + 0.5) * 0.3;
      const localT = Math.max(0, Math.min(1, (t - stagger) / (1.0 - stagger)));
      const nx = fromX + (toX - fromX) * localT;
      const ny = fromY + (toY - fromY) * localT;
      const nz = fromZ + (toZ - fromZ) * localT;
      data.origPositions[i3] = nx;
      data.origPositions[i3 + 1] = ny;
      data.origPositions[i3 + 2] = nz;
      const offX = data.offsets[i3],
        offY = data.offsets[i3 + 1],
        offZ = data.offsets[i3 + 2];
      im.getMatrixAt(i, mat4tmp);
      mat4tmp.decompose(dummy.position, dummy.quaternion, dummy.scale);
      dummy.position.set(nx + offX, ny + offY, nz + offZ);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      if (im.instanceColor) {
        _morphColor.setRGB(
          baseCol[i3] + (toData.colors[i3] - baseCol[i3]) * localT,
          baseCol[i3 + 1] + (toData.colors[i3 + 1] - baseCol[i3 + 1]) * localT,
          baseCol[i3 + 2] + (toData.colors[i3 + 2] - baseCol[i3 + 2]) * localT,
        );
        im.setColorAt(i, _morphColor);
      }
      needsUpdate = true;
    }
    if (needsUpdate) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  });
  if (bloomPass && bloomEnabled) {
    const fromBloom = VARIATION_BLOOM[morphFrom],
      toBloom = VARIATION_BLOOM[morphTo];
    const lerpedBloom = fromBloom + (toBloom - fromBloom) * t;
    bloomPass.strength.value = lerpedBloom;
    bloomSavedStrength = lerpedBloom;
  }
  if (t >= 1.0) {
    isMorphing = false;
    currentVariation = morphTo;
    morphBasePositions = null;
    morphBaseColors = null;
  }
}

// === PARTICLE SYSTEM ===
const particleGroup = new THREE.Group();
particleGroup.name = "particleGroup";
scene.add(particleGroup);

const dustCount = isMobile ? 35 : 120;
const dustGeo = new THREE.BufferGeometry();
const dustPositions = new Float32Array(dustCount * 3);
const dustVelocities = new Float32Array(dustCount * 3);
const dustSizes = new Float32Array(dustCount);
const dustOpacities = new Float32Array(dustCount);
const dustLifetimes = new Float32Array(dustCount);
const dustSpeeds = new Float32Array(dustCount);

for (let i = 0; i < dustCount; i++) {
  dustPositions[i * 3] = (Math.random() - 0.5) * 30;
  dustPositions[i * 3 + 1] = Math.random() * 35 - 5;
  dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 24;
  dustVelocities[i * 3] = (Math.random() - 0.5) * 0.3;
  dustVelocities[i * 3 + 1] = (Math.random() - 0.5) * 0.1;
  dustVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
  dustSizes[i] = 0.18 + Math.random() * 0.25;
  dustLifetimes[i] = Math.random();
  dustSpeeds[i] = 0.02 + Math.random() * 0.04;
  dustOpacities[i] = 0.4 + Math.random() * 0.5;
}
dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
dustGeo.setAttribute("aSize", new THREE.BufferAttribute(dustSizes, 1));
dustGeo.setAttribute("aOpacity", new THREE.BufferAttribute(dustOpacities, 1));

const dustMat = new THREE.PointsNodeMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});
dustMat.colorNode = color(0xffffcc);
dustMat.opacityNode = float(0.65);
const dustPoints = new THREE.Points(dustGeo, dustMat);
dustPoints.name = "dustMotes";
dustPoints.frustumCulled = false;
particleGroup.add(dustPoints);

const fallingLeafCount = isMobile ? 8 : 40;
const leafQuadGeo = new THREE.PlaneGeometry(0.5, 0.5);
const leafQuadMat = new THREE.MeshBasicNodeMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});
leafQuadMat.colorNode = color(0xe8502a);
leafQuadMat.opacityNode = float(0.8);
const fallingLeaves = new THREE.InstancedMesh(
  leafQuadGeo,
  leafQuadMat,
  fallingLeafCount,
);
fallingLeaves.name = "fallingLeaves";
fallingLeaves.frustumCulled = false;
particleGroup.add(fallingLeaves);

const leafState = [],
  leafDummy = new THREE.Object3D();
const leafParticleColors = [
  ["#e63c2e", "#d4452f", "#f05a3a", "#ff6b45", "#f5a623", "#ff8c42"],
  ["#1a4a2a", "#224e30", "#2a5a38", "#1e4828", "#164020", "#2e6e3e"],
  ["#ffb7c5", "#ff97b0", "#ffc8d6", "#fff0f5", "#ffd0db"],
  ["#3a7d28", "#4f9635", "#2d6a1f", "#69bd4a", "#8fae2e"],
];

function resetLeaf(i) {
  const angle = Math.random() * Math.PI * 2,
    radius = Math.random() * 6.0;
  leafState[i] = {
    x: Math.cos(angle) * radius,
    y: 18 + Math.random() * 8,
    z: Math.sin(angle) * radius,
    vx: (Math.random() - 0.5) * 0.8,
    vy: -(1.5 + Math.random() * 1.5),
    vz: (Math.random() - 0.5) * 0.8,
    rotX: Math.random() * Math.PI * 2,
    rotY: Math.random() * Math.PI * 2,
    rotZ: Math.random() * Math.PI * 2,
    spinX: (Math.random() - 0.5) * 2.0,
    spinY: (Math.random() - 0.5) * 1.5,
    spinZ: (Math.random() - 0.5) * 2.0,
    scale: 0.25 + Math.random() * 0.45,
    wobblePhase: Math.random() * Math.PI * 2,
    wobbleFreq: 1.5 + Math.random() * 2.0,
    wobbleAmp: 0.3 + Math.random() * 0.5,
    life: 0,
    maxLife: 4 + Math.random() * 6,
  };
}
for (let i = 0; i < fallingLeafCount; i++) {
  resetLeaf(i);
  leafState[i].life = Math.random() * leafState[i].maxLife;
}

function updateParticles(dt) {
  const dtCl = Math.min(dt, 0.05);
  const time = performance.now() * 0.001;
  const dPos = dustGeo.attributes.position.array;
  for (let i = 0; i < dustCount; i++) {
    dustLifetimes[i] += dustSpeeds[i] * dtCl;
    if (dustLifetimes[i] > 1) dustLifetimes[i] -= 1;
    dPos[i * 3] +=
      (dustVelocities[i * 3] + Math.sin(time * 0.5 + i * 0.7) * 0.15) * dtCl;
    dPos[i * 3 + 1] +=
      (dustVelocities[i * 3 + 1] + Math.sin(time * 0.3 + i * 1.1) * 0.08) *
      dtCl;
    dPos[i * 3 + 2] +=
      (dustVelocities[i * 3 + 2] + Math.cos(time * 0.4 + i * 0.9) * 0.15) *
      dtCl;
    if (dPos[i * 3] > 18) dPos[i * 3] = -18;
    if (dPos[i * 3] < -18) dPos[i * 3] = 18;
    if (dPos[i * 3 + 1] > 35) dPos[i * 3 + 1] = -5;
    if (dPos[i * 3 + 1] < -5) dPos[i * 3 + 1] = 35;
    if (dPos[i * 3 + 2] > 14) dPos[i * 3 + 2] = -14;
    if (dPos[i * 3 + 2] < -14) dPos[i * 3 + 2] = 14;
  }
  dustGeo.attributes.position.needsUpdate = true;
  const curPalette =
    leafParticleColors[currentVariation] || leafParticleColors[0];
  leafQuadMat.colorNode = color(0xffffff);
  if (fallingLeaves._lastVariation !== currentVariation) {
    fallingLeaves._lastVariation = currentVariation;
    for (let j = 0; j < fallingLeafCount; j++) {
      const c = new THREE.Color(
        curPalette[Math.floor(Math.random() * curPalette.length)],
      );
      fallingLeaves.setColorAt(j, c);
    }
    if (fallingLeaves.instanceColor)
      fallingLeaves.instanceColor.needsUpdate = true;
  }
  for (let i = 0; i < fallingLeafCount; i++) {
    const s = leafState[i];
    s.life += dtCl;
    if (s.life >= s.maxLife || s.y < -16) {
      resetLeaf(i);
      const c = new THREE.Color(
        curPalette[Math.floor(Math.random() * curPalette.length)],
      );
      fallingLeaves.setColorAt(i, c);
      if (fallingLeaves.instanceColor)
        fallingLeaves.instanceColor.needsUpdate = true;
    }
    const wobble = Math.sin(time * s.wobbleFreq + s.wobblePhase) * s.wobbleAmp;
    s.x += (s.vx + wobble) * dtCl;
    s.y += s.vy * dtCl;
    s.z +=
      (s.vz +
        Math.cos(time * s.wobbleFreq * 0.7 + s.wobblePhase) *
          s.wobbleAmp *
          0.6) *
      dtCl;
    s.rotX += s.spinX * dtCl;
    s.rotY += s.spinY * dtCl;
    s.rotZ += s.spinZ * dtCl;
    const lifeFrac = s.life / s.maxLife;
    const alpha =
      lifeFrac < 0.1
        ? lifeFrac / 0.1
        : lifeFrac > 0.85
          ? (1 - lifeFrac) / 0.15
          : 1.0;
    leafDummy.position.set(s.x, s.y, s.z);
    leafDummy.rotation.set(s.rotX, s.rotY, s.rotZ);
    leafDummy.scale.setScalar(s.scale * alpha);
    leafDummy.updateMatrix();
    fallingLeaves.setMatrixAt(i, leafDummy.matrix);
  }
  fallingLeaves.instanceMatrix.needsUpdate = true;
  if (!fallingLeaves.instanceColor) {
    for (let i = 0; i < fallingLeafCount; i++) {
      const c = new THREE.Color(
        curPalette[Math.floor(Math.random() * curPalette.length)],
      );
      fallingLeaves.setColorAt(i, c);
    }
    if (fallingLeaves.instanceColor)
      fallingLeaves.instanceColor.needsUpdate = true;
  }
}

// === MOUSE REPULSION ===
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2(9999, 9999);
const repulsionRadius = 10.0,
  repulsionStrength = 18.0,
  returnSpeed = 2.5;
let lastMouseMoveTime = 0;
const mouseIdleTimeout = 0.08;
let mouseActive = false;
const _smoothHitPoint = new THREE.Vector3(9999, 9999, 9999);
let _hasSmoothedHit = false;
const hitSmoothSpeed = 12.0;
const _bboxCenter = new THREE.Vector3();
_islandBBox.getCenter(_bboxCenter);
const _rayPlane = new THREE.Plane(),
  _planeIntersect = new THREE.Vector3();

// Mouse relativo ao sceneContainer
window.addEventListener(
  "mousemove",
  (e) => {
    const rect = sceneContainer.getBoundingClientRect();
    // só ativa repulsão se o mouse estiver dentro do hero
    if (e.clientY < rect.top || e.clientY > rect.bottom) {
      mouse.x = 9999;
      mouse.y = 9999;
      mouseActive = false;
      return;
    }
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    lastMouseMoveTime = performance.now();
    mouseActive = true;
    registerActivity();
  },
  { passive: true },
);
window.addEventListener("mouseleave", () => {
  mouse.x = 9999;
  mouse.y = 9999;
  mouseActive = false;
});

// === MODO OCIOSO ===========================================================
// Depois de IDLE_TIMEOUT segundos sem interação dentro do hero, o loop do
// Three.js é pausado. O canvas preserva o último quadro renderizado, então a
// árvore continua visível sem depender de vídeo e sem consumir GPU desenhando
// quadros que o usuário não está observando. Qualquer nova interação retoma o
// loop imediatamente.
const IDLE_TIMEOUT = 9;
let idleModeActive = false;
let renderLoopPaused = false;
let lastUserActivityTime = performance.now();

function enterIdleMode() {
  if (idleModeActive) return;
  idleModeActive = true;
  pauseRenderLoop();
}

function exitIdleMode() {
  if (!idleModeActive) return;
  idleModeActive = false;
  resumeRenderLoop();
}

function registerActivity() {
  lastUserActivityTime = performance.now();
  if (idleModeActive) exitIdleMode();
}

// Cliques e toques só reativam a cena quando acontecem dentro do hero.
// O movimento do mouse já é tratado pelo listener da repulsão acima, evitando
// calcular getBoundingClientRect() duas vezes para cada evento de mousemove.
function registerActivityIfInsideHero(e) {
  const rect = sceneContainer.getBoundingClientRect();
  if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
    registerActivity();
  }
}
window.addEventListener("pointerdown", registerActivityIfInsideHero, {
  passive: true,
});
window.addEventListener("touchstart", registerActivityIfInsideHero, {
  passive: true,
});
document.querySelectorAll(".morph-btn").forEach((btn) => {
  btn.addEventListener("pointerenter", registerActivity);
});

function updateIdleWatcher() {
  if (idleModeActive) return;
  const idleFor = (performance.now() - lastUserActivityTime) / 1000;
  if (idleFor >= IDLE_TIMEOUT) enterIdleMode();
}

const _hitPoint = new THREE.Vector3(),
  _dir = new THREE.Vector3(),
  _pos = new THREE.Vector3();
const _dummy = new THREE.Object3D(),
  _mat4 = new THREE.Matrix4();
let hasHit = false;

function updateRepulsion(dt) {
  const now = performance.now();
  const mouseIdle = (now - lastMouseMoveTime) / 1000 > mouseIdleTimeout;
  raycaster.setFromCamera(mouse, camera);
  const camDir = raycaster.ray.direction;
  _rayPlane.setFromNormalAndCoplanarPoint(camDir.clone().negate(), _bboxCenter);
  const rawHit =
    raycaster.ray.intersectPlane(_rayPlane, _planeIntersect) !== null;
  const distToCenter = _planeIntersect.distanceTo(_bboxCenter);
  const maxProxyDist = Math.max(
    _islandBBox.getSize(new THREE.Vector3()).length() * 0.55,
    15,
  );
  const validHit = rawHit && distToCenter < maxProxyDist;
  if (validHit) {
    _hitPoint.copy(_planeIntersect);
    if (!_hasSmoothedHit) {
      _smoothHitPoint.copy(_hitPoint);
      _hasSmoothedHit = true;
    } else if (!mouseIdle) {
      const smoothFactor = 1.0 - Math.exp(-hitSmoothSpeed * Math.min(dt, 0.05));
      _smoothHitPoint.lerp(_hitPoint, smoothFactor);
    }
  } else {
    _hasSmoothedHit = false;
  }
  hasHit = validHit;
  const dtClamped = Math.min(dt, 0.05);
  voxels.forEach((im) => {
    const data = instanceData.get(im);
    if (!data) return;
    const { origPositions, offsets, randDirs, count } = data;
    let needsUpdate = false;
    for (let i = 0; i < count; i++) {
      const ox = origPositions[i * 3],
        oy = origPositions[i * 3 + 1],
        oz = origPositions[i * 3 + 2];
      let targetOffX = 0,
        targetOffY = 0,
        targetOffZ = 0;
      if (hasHit) {
        _dir.set(
          ox - _smoothHitPoint.x,
          oy - _smoothHitPoint.y,
          oz - _smoothHitPoint.z,
        );
        const dist = _dir.length();
        if (dist < repulsionRadius && dist > 0.01) {
          const falloff = 1.0 - dist / repulsionRadius;
          const strength = falloff * falloff * falloff * repulsionStrength;
          _dir.normalize();
          const pulsePhase = ox * 1.3 + oy * 0.7 + oz * 1.1;
          const pulseTime = performance.now();
          const pulseAmount =
            Math.sin(pulseTime * 0.003 + pulsePhase) * 0.15 +
            Math.sin(pulseTime * 0.0017 + pulsePhase * 0.6) * 0.1;
          const breathScale = 1.0 + pulseAmount * falloff;
          const rx = randDirs[i * 3],
            ry = randDirs[i * 3 + 1],
            rz = randDirs[i * 3 + 2];
          const radialMix = 0.6;
          const mx = _dir.x * radialMix + rx * (1.0 - radialMix);
          const my = _dir.y * radialMix + ry * (1.0 - radialMix);
          const mz = _dir.z * radialMix + rz * (1.0 - radialMix);
          const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
          targetOffX = (mx / ml) * strength * breathScale;
          targetOffY = (my / ml) * strength * breathScale;
          targetOffZ = (mz / ml) * strength * breathScale;
        }
      }
      const activeSpeed = hasHit ? 8.0 : returnSpeed;
      const lerpFactor = 1.0 - Math.exp(-activeSpeed * dtClamped);
      const curX = offsets[i * 3],
        curY = offsets[i * 3 + 1],
        curZ = offsets[i * 3 + 2];
      const newX = curX + (targetOffX - curX) * lerpFactor;
      const newY = curY + (targetOffY - curY) * lerpFactor;
      const newZ = curZ + (targetOffZ - curZ) * lerpFactor;
      if (
        Math.abs(newX - curX) > 0.0001 ||
        Math.abs(newY - curY) > 0.0001 ||
        Math.abs(newZ - curZ) > 0.0001 ||
        Math.abs(curX) > 0.0001 ||
        Math.abs(curY) > 0.0001 ||
        Math.abs(curZ) > 0.0001
      ) {
        offsets[i * 3] = newX;
        offsets[i * 3 + 1] = newY;
        offsets[i * 3 + 2] = newZ;
        im.getMatrixAt(i, _mat4);
        _mat4.decompose(_dummy.position, _dummy.quaternion, _dummy.scale);
        _dummy.position.set(ox + newX, oy + newY, oz + newZ);
        _dummy.updateMatrix();
        im.setMatrixAt(i, _dummy.matrix);
        needsUpdate = true;
      }
    }
    if (needsUpdate) im.instanceMatrix.needsUpdate = true;
  });
}

const voxelMat = voxelMats[0];

// Lighting
const ambientLight = new THREE.AmbientLight(0xffeedd, 0.5);
scene.add(ambientLight);
const mainLight = new THREE.DirectionalLight(0xfff5e0, 2.5);
mainLight.position.set(6, 14, 5);
mainLight.castShadow = !isMobile;
mainLight.shadow.mapSize.width = isMobile ? 1024 : 2048;
mainLight.shadow.mapSize.height = isMobile ? 1024 : 2048;
mainLight.shadow.camera.near = 0.5;
mainLight.shadow.camera.far = 40;
mainLight.shadow.camera.left = -32;
mainLight.shadow.camera.right = 32;
mainLight.shadow.camera.top = 32;
mainLight.shadow.camera.bottom = -32;
mainLight.shadow.bias = 0.0001;
mainLight.shadow.normalBias = 0.05;
mainLight.shadow.radius = 5.0;
mainLight.shadow.blurSamples = 16;
scene.add(mainLight);
const softShadowLight = new THREE.DirectionalLight(0xffeedd, 0.6);
softShadowLight.position.set(-3, 8, 6);
softShadowLight.castShadow = !isMobile;
softShadowLight.shadow.mapSize.width = isMobile ? 256 : 512;
softShadowLight.shadow.mapSize.height = isMobile ? 256 : 512;
softShadowLight.shadow.camera.near = 0.5;
softShadowLight.shadow.camera.far = 30;
softShadowLight.shadow.camera.left = -24;
softShadowLight.shadow.camera.right = 24;
softShadowLight.shadow.camera.top = 24;
softShadowLight.shadow.camera.bottom = -24;
softShadowLight.shadow.bias = 0.0001;
softShadowLight.shadow.normalBias = 0.05;
softShadowLight.shadow.radius = 3.75;
softShadowLight.shadow.blurSamples = 16;
scene.add(softShadowLight);
const fillLight = new THREE.DirectionalLight(0x88bbff, 1.0);
fillLight.position.set(-5, 8, -3);
scene.add(fillLight);
const rimLight = new THREE.PointLight(0xffaa66, 1.5, 30);
rimLight.position.set(-4, 12, -5);
scene.add(rimLight);
const accentLight = new THREE.PointLight(0xff8844, 1.2, 25);
accentLight.position.set(4, 10, 4);
scene.add(accentLight);

const controls = new OrbitControls(camera, renderer.domElement);

controls.enableZoom = false;
controls.enableRotate = false;
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 6, 0);

if (isMobile) {
  controls.enabled = false;
  renderer.domElement.style.touchAction = "pan-y";
}

// Post-processing
let postProcessing = null,
  aoPass = null,
  ssrPass = null,
  bloomPass = null;
try {
  postProcessing = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: normalView, metalness, roughness }));
  const scenePassColor = scenePass.getTextureNode("output");
  const scenePassNormal = scenePass.getTextureNode("normal");
  const scenePassDepth = scenePass.getTextureNode("depth");
  const scenePassMetalness = scenePass.getTextureNode("metalness");
  const scenePassRoughness = scenePass.getTextureNode("roughness");
  let currentOutput = scenePassColor;
  if (ao && !isMobile) {
    try {
      aoPass = ao(scenePassDepth, scenePassNormal, camera);
      aoPass.resolutionScale = 1.0;
      aoPass.samples.value = 16;
      aoPass.radius.value = 0.6;
      aoPass.distanceExponent.value = 1.0;
      aoPass.thickness.value = 1.6;
      const aoTexture = aoPass.getTextureNode();
      if (denoise) {
        try {
          const denoisePass = denoise(
            aoTexture,
            scenePassDepth,
            scenePassNormal,
            camera,
          );
          denoisePass.sigma.value = 30.0;
          denoisePass.kSigma.value = 5.0;
          denoisePass.threshold.value = 0.05;
          currentOutput = vec3(currentOutput.rgb.mul(denoisePass.r)).toVec4(
            currentOutput.a,
          );
        } catch (de) {
          currentOutput = vec3(currentOutput.rgb.mul(aoTexture.r)).toVec4(
            currentOutput.a,
          );
        }
      } else {
        currentOutput = vec3(currentOutput.rgb.mul(aoTexture.r)).toVec4(
          currentOutput.a,
        );
      }
    } catch (e) {
      console.warn("GTAO setup failed:", e);
    }
  }
  if (ssrModule && ssrModule.ssr && !isMobile) {
    try {
      ssrPass = ssrModule.ssr(
        scenePassColor,
        scenePassDepth,
        scenePassNormal,
        scenePassMetalness,
        scenePassRoughness,
        camera,
      );
      ssrPass.resolutionScale = 0.25;
      ssrPass.thickness.value = 0.2;
      ssrPass.maxDistance.value = 4.0;
      ssrPass.samples = 4;
      const ssrStrengthUniform = uniform(0.25);
      window._ssrStrength = ssrStrengthUniform;
      currentOutput = vec3(
        currentOutput.rgb.add(
          ssrPass.getTextureNode().rgb.mul(ssrStrengthUniform),
        ),
      ).toVec4(currentOutput.a);
    } catch (e) {
      console.warn("SSR setup failed:", e);
    }
  }
  const bloomFn = bloomModule && bloomModule.bloom;
  if (bloomFn) {
    try {
      bloomPass = bloomFn(currentOutput, 0.5, 0.2, 0.8);
      currentOutput = currentOutput.add(bloomPass);
    } catch (e) {
      console.warn("Bloom setup failed:", e);
    }
  }
  postProcessing.outputNode = currentOutput;
} catch (e) {
  console.warn("Post-processing setup failed entirely:", e);
  postProcessing = null;
}

// No celular renderiza diretamente, sem pós-processamento pesado.
if (isMobile) {
  postProcessing = null;
  aoPass = null;
  ssrPass = null;
  bloomPass = null;
}
const aoBaseSettings = { samples: 16, radius: 0.6 };
const AO_NEAR_DIST = 3,
  AO_FAR_DIST = 8;
let lastAdaptiveDist = -1;
let aoEnabled = !isMobile,
  ssrEnabled = !isMobile,
  bloomEnabled = true;
let aoSavedThickness = 1.6,
  ssrSavedStrength = 0.25,
  bloomSavedStrength = 0.5;

function updateAdaptiveQuality() {
  const dist = camera.position.length();
  if (Math.abs(dist - lastAdaptiveDist) < 0.15) return;
  lastAdaptiveDist = dist;
  const t = Math.min(
    Math.max((dist - AO_NEAR_DIST) / (AO_FAR_DIST - AO_NEAR_DIST), 0),
    1,
  );
  const s = t * t * (3 - 2 * t);
  if (aoPass && aoEnabled) {
    aoPass.samples.value = Math.round(4 + (aoBaseSettings.samples - 4) * s);
    aoPass.radius.value = aoBaseSettings.radius * (1 + (1 - s) * 0.3);
    aoPass.resolutionScale = 0.75 + 0.25 * s;
  }
  if (ssrPass && ssrEnabled) ssrPass.resolutionScale = 0.15 + 0.1 * s;
  renderer.setPixelRatio(
    isMobile
      ? 1
      : Math.max(1, Math.min(window.devicePixelRatio, 1.5) * (0.75 + 0.25 * s)),
  );
}

const fpsEl = document.getElementById("fps-counter");
let frameCount = 0,
  lastFpsTime = performance.now(),
  lastTime = performance.now();

let firstFramePresented = false;
function dismissLoadingScreen() {
  const loadingScreen = document.getElementById("loading-screen");

  if (!loadingScreen || loadingScreen.classList.contains("is-hidden")) {
    return;
  }

  window.clearTimeout(window.loadingSafetyTimer);
  loadingScreen.classList.add("is-complete");

  window.setTimeout(() => {
    loadingScreen.classList.add("is-hidden");
    document.documentElement.classList.remove("is-loading");
    document.body.classList.remove("is-loading");

    loadingScreen.addEventListener(
      "transitionend",
      () => loadingScreen.remove(),
      { once: true },
    );
  }, 400);
}

// Controle de pausa do render loop. Quando pausado (modo ocioso,
// aba em segundo plano, ou hero fora da viewport), o WebGPU/WebGL renderer
// para de desenhar frames — o maior consumidor de GPU/CPU do site — sem
// destruir a cena, então a volta é instantânea e sem flicker.
let tabVisible = document.visibilityState === "visible";
let heroInView = true;

function shouldRender() {
  return tabVisible && heroInView && !idleModeActive;
}

function pauseRenderLoop() {
  if (renderLoopPaused) return;
  renderLoopPaused = true;
  renderer.setAnimationLoop(null);
}

function resumeRenderLoop() {
  if (!renderLoopPaused) return;
  if (!shouldRender()) return; // ainda há outro motivo para ficar pausado
  renderLoopPaused = false;
  lastTime = performance.now();
  renderer.setAnimationLoop(animate);
}

function animate() {
  const now2 = performance.now();
  const dt = (now2 - lastTime) / 1000;
  lastTime = now2;
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 500) {
    if (fpsEl)
      fpsEl.textContent =
        Math.round(frameCount / ((now - lastFpsTime) / 1000)) + " FPS";
    frameCount = 0;
    lastFpsTime = now;
  }
  updateIdleWatcher();
  controls.update();
  updateAdaptiveQuality();
  updateMorph();
  updateRepulsion(dt);
  updateParticles(dt);
  if (postProcessing) postProcessing.render();
  else renderer.render(scene, camera);

  if (!firstFramePresented) {
    firstFramePresented = true;
    // Espera o navegador apresentar o quadro antes de revelar a cena.
    requestAnimationFrame(dismissLoadingScreen);
  }
}
renderer.setAnimationLoop(animate);
if (!tabVisible) pauseRenderLoop();

// Pausa tudo quando a aba não está visível (troca de aba, minimizado etc.).
document.addEventListener("visibilitychange", () => {
  tabVisible = document.visibilityState === "visible";
  if (!tabVisible) {
    pauseRenderLoop();
  } else if (heroInView) {
    resumeRenderLoop();
  }
});

// Também cobre o congelamento/restauração da página pelo navegador (bfcache).
window.addEventListener("pagehide", pauseRenderLoop);
window.addEventListener("pageshow", () => {
  tabVisible = document.visibilityState === "visible";
  resumeRenderLoop();
});

// Pausa quando o hero saiu da viewport (usuário rolou a página para baixo);
// volta a renderizar só quando o hero estiver visível de novo.
if ("IntersectionObserver" in window) {
  const heroObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        heroInView = entry.isIntersecting;
        if (!heroInView) {
          pauseRenderLoop();
        } else if (tabVisible) {
          resumeRenderLoop();
        }
      });
    },
    { threshold: 0.01 },
  );
  heroObserver.observe(document.getElementById("hero"));
}

//  CORRIGIDO: resize usa sceneContainer
// Agrupa chamadas de resize num único requestAnimationFrame — evita recalcular
// câmera/renderer dezenas de vezes por segundo durante o arraste da janela.
let resizeRAF = null;
window.addEventListener("resize", () => {
  if (resizeRAF) return;
  resizeRAF = requestAnimationFrame(() => {
    resizeRAF = null;
    camera.aspect = containerW() / containerH();
    camera.updateProjectionMatrix();
    applyViewOffset();
    renderer.setSize(containerW(), containerH());
    renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 1.5));
    lastAdaptiveDist = -1;
  });
});

// Morph buttons
document.querySelectorAll(".morph-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = parseInt(btn.dataset.variation);
    startMorph(target);
    document
      .querySelectorAll(".morph-btn")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

// Title letters
const title = document.getElementById("title");
const letterColors = [
  "#ffadad",
  "#ffd6a5",
  "#fdffb6",
  "#caffbf",
  "#9bf6ff",
  "#a0c4ff",
  "#bdb2ff",
  "#ffc6ff",
];

function splitLetters() {
  const label = title.textContent.trim();
  const fragment = document.createDocumentFragment();

  title.textContent = "";
  title.setAttribute("aria-label", label);

  [...label].forEach((char) => {
    if (char === " ") {
      fragment.append(document.createTextNode(" "));
      return;
    }

    const span = document.createElement("span");
    span.className = "letter";
    span.textContent = char;
    span.setAttribute("aria-hidden", "true");
    fragment.append(span);
  });

  title.append(fragment);
}

splitLetters();

const titleLetters = [...title.querySelectorAll(".letter")];
const reduceTitleMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const letterResetTimers = new Map();
let colorOffset = 0;

function colorizeLetter(letter, colorIndex, delay = 0) {
  window.setTimeout(() => {
    const previousReset = letterResetTimers.get(letter);
    window.clearTimeout(previousReset);

    letter.style.setProperty(
      "--letter-color",
      letterColors[colorIndex % letterColors.length],
    );
    letter.classList.add("is-colorized");

    // Remover e recolocar a classe reinicia o salto mesmo em passagens rápidas.
    letter.classList.remove("is-popping");
    void letter.offsetWidth;
    letter.classList.add("is-popping");

    const resetTimer = window.setTimeout(() => {
      letter.classList.remove("is-colorized", "is-popping");
      letter.style.removeProperty("--letter-color");
      letterResetTimers.delete(letter);
    }, 900);

    letterResetTimers.set(letter, resetTimer);
  }, delay);
}

function animateTitleIntro() {
  if (document.hidden || reduceTitleMotion.matches) return;

  // Cada letra conclui o salto antes de a seguinte começar.
  titleLetters.forEach((letter, index) => {
    colorizeLetter(
      letter,
      colorOffset + index,
      index * 210,
    );
  });

  colorOffset = (colorOffset + 2) % letterColors.length;
}

titleLetters.forEach((letter, index) => {
  letter.addEventListener("pointerenter", () => {
    if (reduceTitleMotion.matches) return;

    // No mouse, somente a letra realmente tocada reage.
    colorizeLetter(letter, colorOffset + index);
    colorOffset = (colorOffset + 1) % letterColors.length;
  });
});

let titleIntroStarted = false;

function startTitleIntroWhenReady() {
  if (titleIntroStarted) return;

  titleIntroStarted = true;
  window.setTimeout(animateTitleIntro, 180);
}

const titleLoadingScreen = document.getElementById("loading-screen");

if (!titleLoadingScreen || titleLoadingScreen.classList.contains("is-hidden")) {
  startTitleIntroWhenReady();
} else {
  const handleLoadingTransitionEnd = (event) => {
    if (
      event.target !== titleLoadingScreen ||
      event.propertyName !== "opacity"
    ) {
      return;
    }

    titleLoadingScreen.removeEventListener(
      "transitionend",
      handleLoadingTransitionEnd
    );

    startTitleIntroWhenReady();
  };

  titleLoadingScreen.addEventListener(
    "transitionend",
    handleLoadingTransitionEnd
  );
}