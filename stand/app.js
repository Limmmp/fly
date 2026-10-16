// Стенд "Муха в проводах": проигрывание заранее посчитанных растров спайков в 3D.
// Данные — window.FLY_DATA из data/export/fly_data.js (src/export.py).
// 3D — three.js r149 (stand/vendor/three.min.js, MIT), без сборки и сервера.
'use strict';

const D = window.FLY_DATA;
const SLOW = 6;              // 1 с модели показываем за 6 с
const FLASH_MS = 350;        // сколько светится нейрон после спайка (реальное время)
const PULSE_MS = 280;        // сколько импульс бежит по нити (для глаза, не физиология)
const PULSE_MIN_SYN = 25;    // импульсы — только по толстым связям
const WEB_SEG = 3;           // отрезков на одну нить "клубка" (меньше — быстрее на слабой видеокарте)
const IDLE_RESET_MS = 12000; // через сколько после результата вернуться к целому мозгу
const GROUP_COLORS = ['#ffc83c', '#4fc3ff', '#ff5ad2', '#7dff7a']; // сенсорные, центральные, нисходящие, моторные
const INHIB_COLOR = '#8a7dff';
const S = 1 / 1000;          // сетка 0..4095 -> единицы сцены
// облегчённый режим для слабой видеокарты: без цветного клубка (index.html?lite)
const LITE = /[?&]lite/.test(location.search) || !!(window.STAND_OPTS || {}).lite;

// стимулы: что делает муха, подписи входа и выхода на карте
const STIM = {
  sugar: { act: 'eat', meter: 'Хоботок', inTag: 'вкус', outTag: 'хоботок', status: 'Сладкое! Сигнал бежит по мозгу…' },
  bitter: { act: 'refuse', meter: 'Хоботок', inTag: 'вкус', outTag: 'хоботок', status: 'Горькое! Сигнал бежит по мозгу…' },
  water: { act: 'calm', meter: 'Хоботок', inTag: 'вкус', outTag: 'хоботок', status: 'Вода! Сигнал бежит по мозгу…' },
  loom: { act: 'fly', meter: 'Взлёт', inTag: 'глаза', outTag: 'гигантский нейрон', status: 'Тень! Кто-то летит сверху…' },
  smell: { act: 'walk', meter: 'Шаги', inTag: 'усики', outTag: 'команды ногам', status: 'Пахнет бананом! Сигнал бежит по мозгу…' },
  touch: { act: 'groom', meter: 'Чистка', inTag: 'щетинки', outTag: 'команды чистки', status: 'Пёрышко коснулось глаза…' },
};
const STIM_KEYS = Object.keys(STIM);

const $ = id => document.getElementById(id);
const fromB64 = (s, T) => { const b = Uint8Array.from(atob(s), ch => ch.charCodeAt(0)); return new T(b.buffer); };
const hash01 = x => { const h = Math.sin(x * 12.9898 + 78.233) * 43758.5453; return h - Math.floor(h); };

// ---------- нейроны цепи (разрядившиеся хоть в одном сценарии) ----------
const N = D.neurons.x.length;
const C0 = [D.size[0] / 2, D.size[1] / 2, D.size[2] / 2];
const toScene = (x, y, z) => [(x - C0[0]) * S, -(y - C0[1]) * S, -(z - C0[2]) * S];
const npos = new Float32Array(3 * N);
for (let i = 0; i < N; i++) npos.set(toScene(D.neurons.x[i], D.neurons.y[i], D.neurons.z[i]), 3 * i);

// растры декодируем по требованию
const rasterCache = {};
function raster(key) {
  if (!rasterCache[key]) {
    const s = D.scenarios[key];
    rasterCache[key] = { t: fromB64(s.t, Uint16Array), n: fromB64(s.n, Uint16Array) };
  }
  return rasterCache[key];
}

function glowTexture(size = 64) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}
const GLOW = glowTexture();

// =====================================================================
// Мозг
// =====================================================================
const brainCanvas = $('brain');
const brainR = new THREE.WebGLRenderer({ canvas: brainCanvas, antialias: true });
brainR.setClearColor(0x04050c, 1);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x04050c, 0.1);
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);

// координаты всех 138 639 нейронов
const allQ = fromB64(D.background, Uint16Array);
const NALL = allQ.length / 3;
const allPos = new Float32Array(3 * NALL);
for (let i = 0; i < NALL; i++) allPos.set(toScene(allQ[3 * i], allQ[3 * i + 1], allQ[3 * i + 2]), 3 * i);

// ---------- "клубок": от каждого нейрона нити к его самым сильным партнёрам ----------
// Как на снимках FlyWire, каждый нейрон своим цветом (по типу клетки).
// Важно: это связи из коннектома, а не форма отростков — её в данных нет.
// Обычное (не аддитивное) смешивание: в густых местах видна верхняя нить своего
// цвета, как у непрозрачных нейронов на снимках, а не белое пятно.
const webMat = new THREE.ShaderMaterial({
  uniforms: { uDim: { value: 1 } },
  vertexShader: `
    attribute vec4 color; varying vec4 vColor; uniform float uDim;
    void main() { vColor = vec4(color.rgb * (0.55 + 0.45 * uDim), color.a * uDim); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying vec4 vColor; void main() { gl_FragColor = vColor; }`,
  transparent: true, depthWrite: false, blending: THREE.NormalBlending,
});
if (!LITE) (() => {
  const K = D.web.k, tgt = fromB64(D.web.targets, Uint32Array), types = fromB64(D.web.types, Uint16Array);
  let n = 0;
  for (let i = 0; i < tgt.length; i++) if (tgt[i] !== 0xFFFFFFFF) n++;
  const pos = new Float32Array(n * WEB_SEG * 6), col = new Float32Array(n * WEB_SEG * 8);
  const c = new THREE.Color(), p0 = [0, 0, 0], p1 = [0, 0, 0], m = [0, 0, 0];
  let v = 0;
  for (let i = 0; i < NALL; i++) {
    // цвет нейрона: радуга по положению в мозге (области читаются цветом)
    // плюс разброс по типу клетки — соседние разные типы различимы
    const key = types[i] === D.web.unknown_type ? 100000 + i : types[i];
    const px = allQ[3 * i] / D.size[0], pz = allQ[3 * i + 2] / D.size[2];
    const hue = (0.78 - 0.62 * px + 0.18 * pz + 0.42 * (hash01(key) - 0.5) + 1) % 1;
    c.setHSL(hue, 0.9, 0.48 + 0.2 * hash01(key + 3));
    const bright = 0.1 + 0.14 * hash01(key + 7);   // непрозрачность нити
    for (let k = 0; k < K; k++) {
      const j = tgt[i * K + k];
      if (j === 0xFFFFFFFF) continue;
      // лёгкий изгиб в случайную сторону — нить, а не линейка
      let len2 = 0;
      for (let d = 0; d < 3; d++) { m[d] = (allPos[3 * i + d] + allPos[3 * j + d]) / 2; len2 += (allPos[3 * j + d] - allPos[3 * i + d]) ** 2; }
      const amp = 0.22 * Math.sqrt(len2);
      for (let d = 0; d < 3; d++) m[d] += (hash01(i * 3 + d + k * 0.37) - 0.5) * amp;
      for (let s = 0; s < WEB_SEG; s++) {
        for (const [u, out] of [[s / WEB_SEG, p0], [(s + 1) / WEB_SEG, p1]]) {
          const w = 1 - u;
          for (let d = 0; d < 3; d++) out[d] = w * w * allPos[3 * i + d] + 2 * w * u * m[d] + u * u * allPos[3 * j + d];
        }
        // плотнее у начала нити, к концу тает
        const f0 = bright * (1 - 0.6 * s / WEB_SEG), f1 = bright * (1 - 0.6 * (s + 1) / WEB_SEG);
        pos.set(p0, v * 3); col.set([c.r, c.g, c.b, f0], v * 4); v++;
        pos.set(p1, v * 3); col.set([c.r, c.g, c.b, f1], v * 4); v++;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  scene.add(new THREE.LineSegments(g, webMat));
})();

// ---------- активность нейронов цепи: текстура для шейдеров нитей ----------
const flash = new Float32Array(N);
const flashBytes = new Uint8Array(4 * N);
const flashTex = new THREE.DataTexture(flashBytes, N, 1, THREE.RGBAFormat);
const involved = new Float32Array(N).fill(0);   // 1 — нейрон участвует в выбранном сценарии

// ---------- нити цепи: тонкие кривые, собранные в пучки к центру цепи ----------
const WIRES = D.edges;
const E = WIRES.length;
const SEG = 10;
const CENTER = (() => {
  const v = [0, 0, 0];
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) v[k] += npos[3 * i + k] / N;
  return v;
})();
const ctrl = new Float32Array(3 * E);
const edgeBase = new Float32Array(3 * E);
const outEdges = Array.from({ length: N }, () => []);
const fPos = new Float32Array(E * SEG * 6), fCol = new Float32Array(E * SEG * 6);
const fT = new Float32Array(E * SEG * 2), fPre = new Float32Array(E * SEG * 2), fW = new Float32Array(E * SEG * 2);
function bez(e, a, b, u, out) {
  const w = 1 - u;
  for (let k = 0; k < 3; k++) out[k] = w * w * npos[3 * a + k] + 2 * w * u * ctrl[3 * e + k] + u * u * npos[3 * b + k];
  return out;
}
WIRES.forEach(([a, b, k, sign], e) => {
  const j = hash01(e) - 0.5;
  for (let d = 0; d < 3; d++) {
    const mid = (npos[3 * a + d] + npos[3 * b + d]) / 2;
    ctrl[3 * e + d] = mid + (CENTER[d] - mid) * 0.4 + j * 0.08 * (d === 1 ? 1 : 0.6);
  }
  const c = new THREE.Color(sign > 0 ? GROUP_COLORS[D.neurons.group[a]] : INHIB_COLOR);
  edgeBase.set([c.r, c.g, c.b], 3 * e);
  if (k >= PULSE_MIN_SYN) outEdges[a].push(e);
  const p0 = [0, 0, 0], p1 = [0, 0, 0];
  for (let s = 0; s < SEG; s++) {
    bez(e, a, b, s / SEG, p0); bez(e, a, b, (s + 1) / SEG, p1);
    const v = (e * SEG + s) * 2;
    fPos.set(p0, 3 * v); fPos.set(p1, 3 * v + 3);
    fCol.set([c.r, c.g, c.b], 3 * v); fCol.set([c.r, c.g, c.b], 3 * v + 3);
    fT[v] = s / SEG; fT[v + 1] = (s + 1) / SEG;
    fPre[v] = fPre[v + 1] = a;
    fW[v] = fW[v + 1] = Math.min(1, k / 40);
  }
});
const fiberGeo = new THREE.BufferGeometry();
fiberGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
fiberGeo.setAttribute('color', new THREE.BufferAttribute(fCol, 3));
fiberGeo.setAttribute('t', new THREE.BufferAttribute(fT, 1));
fiberGeo.setAttribute('pre', new THREE.BufferAttribute(fPre, 1));
fiberGeo.setAttribute('w', new THREE.BufferAttribute(fW, 1));
const fiberMat = new THREE.ShaderMaterial({
  uniforms: { uFlash: { value: flashTex }, uN: { value: N }, uGain: { value: 1 } },
  vertexShader: `
    attribute vec3 color; attribute float t, pre, w;
    uniform sampler2D uFlash; uniform float uN;
    varying vec3 vColor; varying float vA;
    void main() {
      vec4 tx = texture2D(uFlash, vec2((pre + 0.5) / uN, 0.5));
      float f = tx.r, inv = tx.g;
      float along = 1.0 - 0.55 * t;   // ярче у сомы, откуда выходит аксон
      vA = (0.07 * inv + 0.24 * f * (0.3 + 0.7 * w)) * along;
      vColor = mix(color, vec3(1.0), 0.15 * f);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    varying vec3 vColor; varying float vA; uniform float uGain;
    void main() { gl_FragColor = vec4(vColor, vA * uGain); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
scene.add(new THREE.LineSegments(fiberGeo, fiberMat));

// ---------- сомы цепи: чёткий диск с ободком, при спайке — расходящееся кольцо ----------
const ncol = new Float32Array(3 * N);
for (let i = 0; i < N; i++) {
  const c = new THREE.Color(GROUP_COLORS[D.neurons.group[i]]);
  ncol.set([c.r, c.g, c.b], 3 * i);
}
const nGeo = new THREE.BufferGeometry();
nGeo.setAttribute('position', new THREE.BufferAttribute(npos, 3));
nGeo.setAttribute('color', new THREE.BufferAttribute(ncol, 3));
nGeo.setAttribute('flash', new THREE.BufferAttribute(flash, 1));
nGeo.setAttribute('involved', new THREE.BufferAttribute(involved, 1));
const nMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 500 }, uSize: { value: 0.016 }, uGain: { value: 1 }, uDpr: { value: 1 } },
  vertexShader: `
    attribute vec3 color; attribute float flash, involved;
    uniform float uScale, uSize, uDpr;
    varying vec3 vColor; varying float vFlash, vInv;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float soma = clamp(uSize * uScale / -mv.z, 3.0 * uDpr, 12.0 * uDpr);
      gl_PointSize = soma * 3.0;   // спрайт в 3 раза больше сомы — место под кольцо
      vColor = color; vFlash = flash; vInv = involved;
    }`,
  fragmentShader: `
    varying vec3 vColor; varying float vFlash, vInv; uniform float uGain;
    void main() {
      float r = length(gl_PointCoord * 2.0 - 1.0);
      if (r > 1.0) discard;
      const float RS = 0.33;
      float body = 1.0 - smoothstep(RS - 0.05, RS, r);
      float rim = body * smoothstep(RS - 0.14, RS - 0.05, r);
      float ringR = RS + (1.0 - vFlash) * 0.6;
      float ring = (1.0 - smoothstep(0.0, 0.045, abs(r - ringR))) * vFlash * step(0.05, vFlash);
      vec3 col = mix(vColor * 0.6, vec3(1.0), 0.55 * vFlash) + rim * 0.35;
      float a = body * (0.55 + 0.45 * vFlash) + ring * 0.7 * uGain;
      gl_FragColor = vec4(mix(col, vColor, ring * (1.0 - body)), a * max(vInv, vFlash));
    }`,
  transparent: true, depthWrite: false, blending: THREE.NormalBlending,
});
scene.add(new THREE.Points(nGeo, nMat));

function setInvolved(list) {
  involved.fill(0);
  if (list) for (const i of list) involved[i] = 1;
  for (let i = 0; i < N; i++) flashBytes[4 * i + 1] = Math.round(involved[i] * 255);
  flashTex.needsUpdate = true;
  nGeo.attributes.involved.needsUpdate = true;
}
setInvolved(null);

// ---------- импульсы: острые точки, бегущие по нитям ----------
const MAX_PULSES = 1500;
const pulsePos = new Float32Array(3 * MAX_PULSES).fill(999);
const pulseCol = new Float32Array(3 * MAX_PULSES);
const pulses = [];
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pulsePos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pulseCol, 3));
const pulseMat = new THREE.ShaderMaterial({
  uniforms: { uPx: { value: 4 } },
  vertexShader: `
    attribute vec3 color; uniform float uPx; varying vec3 vColor;
    void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = uPx; vColor = color; }`,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      float r = length(gl_PointCoord * 2.0 - 1.0);
      if (r > 1.0) discard;
      float core = 1.0 - smoothstep(0.25, 0.45, r), glow = 1.0 - smoothstep(0.3, 1.0, r);
      gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.7), core + 0.35 * glow);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
scene.add(new THREE.Points(pGeo, pulseMat));

// ---------- сломанные нейроны: красный перечёркнутый круг постоянного экранного размера ----------
const lesionTex = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.strokeStyle = '#ff5468'; g.lineWidth = 12; g.lineCap = 'round';
  g.beginPath(); g.arc(64, 64, 50, 0, 6.283); g.stroke();
  g.beginPath(); g.moveTo(34, 34); g.lineTo(94, 94); g.moveTo(94, 34); g.lineTo(34, 94); g.stroke();
  return new THREE.CanvasTexture(cv);
})();
const lesionSprites = [0, 1].map(() => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: lesionTex, depthTest: false, transparent: true, sizeAttenuation: false }));
  sp.scale.set(0.05, 0.05, 1);
  sp.visible = false;
  scene.add(sp);
  return sp;
});

// ---------- камера: целый мозг <-> зона выбранного стимула ----------
const FULL_BOX = new THREE.Box3(new THREE.Vector3(...toScene(0, D.size[1], D.size[2])), new THREE.Vector3(...toScene(D.size[0], 0, 0)));
function viewFor(box, margin) {
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  return { target: c, w: s.x * margin, h: s.y * margin };
}
const VIEW_FULL = viewFor(FULL_BOX, 1.05);
// рамка по нейронам сценария: 2..98 перцентиль, одиночные дальние выбросы не раздувают зум
function zoomFor(key) {
  const used = [...new Set(raster(key).n)];
  const q = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))];
  const ax = k => used.map(i => npos[3 * i + k]);
  const lo = [0, 1, 2].map(k => q(ax(k), 0.02)), hi = [0, 1, 2].map(k => q(ax(k), 0.98));
  const v = viewFor(new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi)), 1.5);
  // не уже трети мозга — чтобы было видно, где мы
  v.w = Math.max(v.w, VIEW_FULL.w / 3); v.h = Math.max(v.h, VIEW_FULL.h / 3);
  return v;
}
const VIEWS = {};
const cam = { target: VIEW_FULL.target.clone(), w: VIEW_FULL.w, h: VIEW_FULL.h };
let camGoal = VIEW_FULL;

// =====================================================================
// 3D-муха: действия управляются активностью выходных нейронов из модели
// =====================================================================
const flyCanvas = $('fly');
const flyR = new THREE.WebGLRenderer({ canvas: flyCanvas, antialias: true, alpha: true });
const flyScene = new THREE.Scene();
const flyCam = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
const FLY_TARGET = new THREE.Vector3(0.1, -0.2, 0);
const FLY_DIR = new THREE.Vector3(-1.15, 1.2, 4.6).normalize();
const FLY_DIST = 4.85;
flyScene.add(new THREE.HemisphereLight(0xfff4e0, 0x202040, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(-2, 4, 3); flyScene.add(sun);
const rim = new THREE.DirectionalLight(0x6fa8ff, 0.8); rim.position.set(3, 1, -4); flyScene.add(rim);

const fly = new THREE.Group();
flyScene.add(fly);
const FLY_FLOOR = -0.95;

function stripeTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#7a5a34'; g.fillRect(0, 0, 64, 256);
  g.fillStyle = '#24170a';
  for (let k = 0; k < 6; k++) g.fillRect(0, 44 + k * 30, 64, 11);
  return new THREE.CanvasTexture(cv);
}
function veinTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#5a6070'; g.lineWidth = 3;
  for (const y of [70, 105, 140, 175]) { g.beginPath(); g.moveTo(10, 128); g.quadraticCurveTo(128, y, 250, y + (y - 128) * 0.3); g.stroke(); }
  g.beginPath(); g.moveTo(150, 90); g.lineTo(160, 160); g.stroke();
  return new THREE.CanvasTexture(cv);
}
const brown = new THREE.MeshStandardMaterial({ color: 0x7a5228, roughness: 0.5, metalness: 0.05 });
const dark = new THREE.MeshStandardMaterial({ color: 0x0a0705, roughness: 0.6 });
function ellipsoid(r, sx, sy, sz, mat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), mat);
  m.scale.set(sx, sy, sz);
  return m;
}
function rod(a, b, radius, mat) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.8, radius, va.distanceTo(vb), 10), mat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  return m;
}

const body = new THREE.Group(); fly.add(body);   // туловище: качается при ходьбе и чистке
const thorax = ellipsoid(0.5, 1.15, 0.92, 0.88, brown); thorax.position.set(0, 0.1, 0); body.add(thorax);
const abdGeo = new THREE.SphereGeometry(0.5, 48, 32); abdGeo.rotateZ(Math.PI / 2);
const abdomen = new THREE.Mesh(abdGeo, new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.5 }));
abdomen.scale.set(1.55, 0.82, 0.88); abdomen.position.set(1.15, -0.05, 0); abdomen.rotation.z = -0.15; body.add(abdomen);
const headG = new THREE.Group(); headG.position.set(-0.78, 0.12, 0); body.add(headG);
headG.add(ellipsoid(0.36, 0.8, 1.0, 1.18, brown));
const eyeMat = new THREE.MeshPhongMaterial({ color: 0xb0101c, shininess: 70, flatShading: true, specular: 0x441111 });
for (const s of [-1, 1]) {
  const eye = new THREE.Mesh(new THREE.IcosahedronGeometry(0.29, 3), eyeMat);
  eye.scale.set(0.72, 1.05, 0.62); eye.position.set(-0.08, 0.08, 0.27 * s); headG.add(eye);
  headG.add(rod([-0.24, 0.16, 0.08 * s], [-0.4, 0.24, 0.13 * s], 0.025, dark));   // усик
}
for (let k = 0; k < 14; k++) {   // щетинки на груди
  const a = -1.2 + 2.4 * (k / 13), x = -0.35 + 0.7 * ((k * 7) % 13) / 13;
  const base = [x, 0.1 + 0.42 * Math.cos(a * 0.6), 0.4 * Math.sin(a)];
  body.add(rod(base, [base[0] + 0.12, base[1] + 0.16, base[2] * 1.15], 0.008, dark));
}
// ноги: каждая — группа с шарниром в тазу, чтобы её можно было качать
const legs = [];
for (const s of [-1, 1]) {
  for (let k = 0; k < 3; k++) {
    const x = -0.28 + 0.28 * k, dx = (k - 1) * 0.35;
    const hip = [x, -0.18, 0.22 * s];
    const rel = p => [p[0] - hip[0], p[1] - hip[1], p[2] - hip[2]];
    const knee = [x + dx, 0.05, 0.62 * s], ankle = [x + dx * 1.6, FLY_FLOOR + 0.05, 0.85 * s], toe = [x + dx * 1.9, FLY_FLOOR, 0.98 * s];
    const g = new THREE.Group(); g.position.set(...hip);
    g.add(rod([0, 0, 0], rel(knee), 0.045, dark)); g.add(rod(rel(knee), rel(ankle), 0.035, dark)); g.add(rod(rel(ankle), rel(toe), 0.025, dark));
    // тройная походка: передняя и задняя одной стороны в фазе со средней другой
    g.userData = { side: s, pair: k, phase: (k % 2 === 0 ? 0 : Math.PI) + (s > 0 ? Math.PI : 0) };
    fly.add(g);
    legs.push(g);
  }
}
const wingShape = new THREE.Shape();
wingShape.absellipse(0.85, 0, 0.9, 0.28, 0, Math.PI * 2);
const wingGeo = new THREE.ShapeGeometry(wingShape, 48);
const wingMat = new THREE.MeshPhysicalMaterial({
  color: 0xc8d4e4, map: veinTexture(), transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  roughness: 0.15, iridescence: 1.0, iridescenceIOR: 1.3, depthWrite: false,
});
const wings = [-1, 1].map(s => {
  const w = new THREE.Mesh(wingGeo, wingMat);
  w.position.set(0.1, 0.5, 0.18 * s);
  w.userData.side = s;
  body.add(w);
  return w;
});
const probPivot = new THREE.Group(); probPivot.position.set(-0.08, -0.3, 0); headG.add(probPivot);
const probMat = new THREE.MeshStandardMaterial({ color: 0xc9925a, roughness: 0.6 });
const rostrum = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1, 16), probMat);
probPivot.add(rostrum);
const labellum = ellipsoid(0.13, 1.2, 0.6, 1.3, new THREE.MeshStandardMaterial({ color: 0xe0a56d, roughness: 0.5 }));
probPivot.add(labellum);
function setProboscis(e) {
  const len = 0.25 + 0.55 * e;
  rostrum.scale.y = len; rostrum.position.y = -len / 2;
  labellum.position.y = -len - 0.04;
  probPivot.rotation.z = 0.9 * (1 - e);   // свёрнут назад под голову -> вытянут вниз к еде
}
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.2),
  new THREE.MeshBasicMaterial({ map: GLOW, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
shadow.rotation.x = -Math.PI / 2; shadow.position.set(0.3, FLY_FLOOR - 0.01, 0); flyScene.add(shadow);

// предметы-стимулы
const props = {
  sugar: new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.9 })),
  bitter: ellipsoid(0.26, 1.3, 1, 1, new THREE.MeshStandardMaterial({ color: 0xf2d22a, roughness: 0.45 })),
  water: ellipsoid(0.22, 1.2, 0.75, 1.2, new THREE.MeshPhysicalMaterial({ color: 0x5ec8ff, roughness: 0.05, transparent: true, opacity: 0.7, clearcoat: 1 })),
  smell: new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.11, 16, 40, Math.PI * 0.75), new THREE.MeshStandardMaterial({ color: 0xffd43b, roughness: 0.5 })),
  loom: new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.8 })),
  touch: (() => {
    const g = new THREE.Group();
    g.add(ellipsoid(0.32, 0.35, 1.0, 0.08, new THREE.MeshStandardMaterial({ color: 0xf2f4ff, roughness: 0.8, side: THREE.DoubleSide })));
    g.add(rod([0, -0.5, 0], [0, 0.3, 0], 0.012, new THREE.MeshStandardMaterial({ color: 0xbfc4dd })));
    return g;
  })(),
};
props.sugar.position.set(-1.05, FLY_FLOOR + 0.18, 0);
props.bitter.position.set(-1.05, FLY_FLOOR + 0.18, 0);
props.water.position.set(-1.05, FLY_FLOOR + 0.15, 0);
props.smell.position.set(-1.5, FLY_FLOOR + 0.12, 1.0); props.smell.rotation.set(Math.PI / 2, 0, 0.6);
for (const m of Object.values(props)) { m.visible = false; flyScene.add(m); }

// состояние мухи
const flyState = { act: null, level: 0, takeoffAt: 0, slow: false, walk: 0, turn: 0 };
function resetFly() {
  fly.position.set(0, 0, 0); fly.rotation.set(0, 0, 0);
  body.position.set(0, 0, 0); body.rotation.set(0, 0, 0); headG.rotation.set(0, 0, 0);
  legs.forEach(g => g.rotation.set(0, 0, 0));
  Object.assign(flyState, { act: null, level: 0, takeoffAt: 0, slow: false, walk: 0, turn: 0 });
  for (const m of Object.values(props)) m.visible = false;
}

// =====================================================================
// Проигрывание
// =====================================================================
const seen = new Uint8Array(N);
const isOut = new Uint8Array(N);
let play = null;
let lesionOn = false;
let lastFrame = performance.now();
let idleTimer = null;

function lesionList(stim) { return (D.lesions[stim] || []).filter(l => l.local != null); }

function start(stim) {
  const key = lesionOn ? `${stim}_lesion` : stim;
  const s = D.scenarios[key], r = raster(key);
  const base = D.scenarios[stim].output_spikes || 1;
  flash.fill(0); seen.fill(0); pulses.length = 0; isOut.fill(0);
  for (const i of s.output_local) isOut[i] = 1;
  // прибавка к уровню выхода за спайк: полный выход без поломки ~ 1
  play = { key, stim, s, r, t0: performance.now(), ptr: 0, nSeen: 0, done: false, perSpike: 10 / base };
  setInvolved([...new Set(r.n)].concat(s.stim));
  VIEWS[key] = VIEWS[key] || zoomFor(key);
  camGoal = VIEWS[key];
  clearTimeout(idleTimer);
  $('result').classList.add('hidden');
  document.querySelectorAll('.stim').forEach(b => b.classList.toggle('active', b.dataset.stim === stim));
  setStatus(stim, STIM[stim].status);
  if ($('meter-label')) $('meter-label').textContent = STIM[stim].meter;
  resetFly();
  flyState.act = STIM[stim].act;
  flyState.slow = s.level === 'slow';
  if (props[stim]) props[stim].visible = true;
  if (window.FlySound) window.FlySound.play(s, D, SLOW);
}

function finish() {
  play.done = true;
  showResult(play.stim, play.s);
  idleTimer = setTimeout(() => {
    camGoal = VIEW_FULL;
    $('result').classList.add('hidden');
    setStatus('down', 'Выбери, что показать мухе');
    document.querySelectorAll('.stim').forEach(b => b.classList.remove('active'));
    setInvolved(null);
    resetFly();
    play = null;
  }, IDLE_RESET_MS);
}

function showResult(stim, s) {
  const n = s.active.toLocaleString('ru-RU');
  const les = lesionList(stim)[0];
  const lt = les ? les.cell_type : '';
  const lv = s.level;
  const otherPath = 'Сломанный нейрон — на сладком пути. Этот вкус идёт другим путём, поэтому ничего не изменилось';
  // поломка, которая почти не помешала: у поведения много запасных путей
  const robust = what => ['groom', `${what} — даже без нейрона ${lt}`, 'Сигнал обошёл поломку: у этого действия много запасных путей в мозге'];
  const R = {
    sugar: lv === 'full' ? ['eat', 'Муха ест!', `Сахар → ${n} нейронов → хоботок`]
      : ['hurt', 'Почти не ест', `Сломан всего один нейрон ${lt} из 138 639`],
    bitter: ['yuck', 'Фу! Не буду', s.lesion ? otherPath : 'Горький сигнал не дошёл до хоботка'],
    water: ['calm', 'Пить не хочет', s.lesion ? otherPath : 'Вода для мухи слабее, чем сахар'],
    loom: lv === 'slow' ? ['slow', 'Взлетает медленно', 'Без гигантского нейрона DNp01 муха взлетает другим, медленным способом']
      : ['away', 'Улетела!', `Тень → гигантский нейрон DNp01 за ${s.output_first_ms != null ? s.output_first_ms.toFixed(0) : '?'} мс → прыжок`],
    smell: s.lesion && lv === 'full' ? robust('Всё равно идёт')
      : lv === 'full' ? ['walk', 'Идёт к банану!', `Запах → ${n} нейронов → команды ногам`]
        : lv === 'weak' ? ['hurt', 'Еле плетётся', `Сломан один нейрон ${lt} — шагов стало меньше`]
          : ['none', 'Не идёт', 'Сигнал не дошёл до ног'],
    touch: s.lesion && lv === 'full' ? robust('Всё равно чистится')
      : lv === 'full' ? ['groom', 'Чистится!', 'Касание глаза → нейроны DNg84 и DNg35 → лапки']
        : lv === 'weak' ? ['hurt', 'Чистится вяло', `Сломан один нейрон ${lt}`]
          : ['none', 'Не чистится', 'Сигнал не дошёл до лапок'],
  }[stim];
  $('result-icon').innerHTML = ICONS[R[0]];
  $('result-title').textContent = R[1];
  $('result-text').textContent = R[2];
  $('result').classList.remove('hidden');
  setStatus(null, '');
}

function setStatus(icon, text) {
  const el = $('status');
  el.textContent = '';
  if (icon) {
    const i = document.createElement('span');
    i.className = 'status-icon'; i.innerHTML = ICONS[icon].trim();
    el.appendChild(i);
  }
  el.appendChild(document.createTextNode(text));
}

function spawnPulses(i, now) {
  for (const e of outEdges[i]) {
    if (pulses.length >= MAX_PULSES) pulses.shift();
    pulses.push({ e, t0: now });
  }
}

// =====================================================================
// Кадр
// =====================================================================
function resize(renderer, cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
  }
  return [w, h, dpr];
}

let gain = 1, webDim = 1;
const tmp3 = [0, 0, 0];
function step(now) {
  // затухание — по реальному времени, даже если кадры редкие
  const dtDecay = Math.min(1000, now - lastFrame);
  const dtReal = Math.min(100, dtDecay);
  lastFrame = now;
  const decay = Math.exp(-dtDecay / FLASH_MS);
  let lit = 0;
  for (let i = 0; i < N; i++) { flash[i] *= decay; lit += flash[i]; }
  flyState.level *= Math.exp(-dtDecay / 600);
  // автоэкспозиция: когда вспыхивает сразу много нейронов, каждый светит тише
  gain += (1 / (1 + lit / 60) - gain) * (1 - Math.exp(-dtReal / 250));
  nMat.uniforms.uGain.value = 0.35 + 0.65 * gain;
  fiberMat.uniforms.uGain.value = 0.3 + 0.7 * gain;
  // клубок приглушается, пока идёт сигнал, — цепь видна поверх
  webDim += ((play ? 0.25 : 1) - webDim) * (1 - Math.exp(-dtReal / 500));
  webMat.uniforms.uDim.value = webDim;

  if (play && !play.done) {
    const { r } = play;
    const tModelSteps = (now - play.t0) / SLOW / D.dt_ms;
    let outHits = 0;
    while (play.ptr < r.t.length && r.t[play.ptr] <= tModelSteps) {
      const i = r.n[play.ptr++];
      flash[i] = 1;
      spawnPulses(i, now);
      if (!seen[i]) { seen[i] = 1; play.nSeen++; }
      if (isOut[i]) outHits++;
    }
    flyState.level = Math.min(1, flyState.level + outHits * play.perSpike);
    // взлёт: при первом заметном выходе DNp01; без него — медленный и позже
    if (flyState.act === 'fly' && !flyState.takeoffAt) {
      if (flyState.level > 0.25) flyState.takeoffAt = now;
      else if (flyState.slow && tModelSteps * D.dt_ms > 450) flyState.takeoffAt = now;
    }
    $('cnt-neurons').textContent = play.nSeen.toLocaleString('ru-RU');
    $('cnt-spikes').textContent = play.ptr.toLocaleString('ru-RU');
    if (tModelSteps * D.dt_ms >= D.t_ms) finish();
  }
  for (let i = 0; i < N; i++) flashBytes[4 * i] = Math.min(255, Math.round(flash[i] * 255));
  flashTex.needsUpdate = true;
  nGeo.attributes.flash.needsUpdate = true;

  let alive = 0;
  for (let p = 0; p < pulses.length; p++) {
    const u = (now - pulses[p].t0) / PULSE_MS;
    if (u >= 1) continue;
    const e = pulses[p].e;
    bez(e, WIRES[e][0], WIRES[e][1], u, tmp3);
    for (let k = 0; k < 3; k++) {
      pulsePos[3 * alive + k] = tmp3[k];
      pulseCol[3 * alive + k] = edgeBase[3 * e + k] * (1 - u * 0.6);
    }
    pulses[alive++] = pulses[p];
  }
  pulses.length = alive;
  pulsePos.fill(999, 3 * alive);
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;

  const les = play && lesionOn ? lesionList(play.stim) : [];
  lesionSprites.forEach((sp, k) => {
    sp.visible = k < les.length;
    if (sp.visible) sp.position.fromArray(npos, 3 * les[k].local);
    sp.material.opacity = 0.7 + 0.3 * Math.sin(now / 200);
  });

  drawBrain(now, dtReal);
  drawFly(now, dtReal);
  $('meter-fill').style.width = `${Math.round(flyState.level * 100)}%`;
  requestAnimationFrame(step);
}

function drawBrain(now, dtReal) {
  const [w, h, dpr] = resize(brainR, brainCanvas);
  camera.aspect = w / h;
  const k = 1 - Math.exp(-dtReal / 600);
  cam.target.lerp(camGoal.target, k);
  cam.w += (camGoal.w - cam.w) * k; cam.h += (camGoal.h - cam.h) * k;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(cam.h / 2 / tanHalf, cam.w / 2 / tanHalf / camera.aspect) * 1.05;
  // камера слегка покачивается — видно, что мозг объёмный
  const yaw = 0.45 * Math.sin(now * 0.00018), pitch = 0.12 + 0.06 * Math.sin(now * 0.00011);
  camera.position.set(
    cam.target.x + dist * Math.sin(yaw) * Math.cos(pitch),
    cam.target.y + dist * Math.sin(pitch),
    cam.target.z + dist * Math.cos(yaw) * Math.cos(pitch));
  camera.lookAt(cam.target);
  // макет может сдвинуть кадр, чтобы мозг не прятался под панелями
  const o = window.STAND_OPTS || {};
  if (o.shiftX || o.shiftY) camera.setViewOffset(w, h, w * (o.shiftX || 0), h * (o.shiftY || 0), w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  nMat.uniforms.uScale.value = h * dpr / (2 * tanHalf);
  nMat.uniforms.uDpr.value = dpr;
  pulseMat.uniforms.uPx.value = 5 * dpr;
  brainR.render(scene, camera);
  drawTags(w, h);
}

// подписи входа и выхода поверх 3D
const tags = {
  in: Object.assign(document.createElement('div'), { className: 'tag' }),
  out: Object.assign(document.createElement('div'), { className: 'tag' }),
};
tags.out.style.color = GROUP_COLORS[3];
Object.values(tags).forEach(t => $('tags').appendChild(t));
function centroid(list) {
  const v = new THREE.Vector3();
  for (const i of list) v.add(new THREE.Vector3().fromArray(npos, 3 * i));
  return v.multiplyScalar(1 / Math.max(1, list.length));
}
function placeTag(el, p, w, h, dy) {
  const v = p.clone().project(camera);
  el.style.left = `${(v.x + 1) / 2 * w}px`;
  el.style.top = `${(1 - v.y) / 2 * h + dy}px`;
}
function drawTags(w, h) {
  const on = !!play;
  tags.in.style.opacity = tags.out.style.opacity = on ? 1 : 0;
  if (!on) return;
  if (!play.tagPos) {
    tags.in.textContent = STIM[play.stim].inTag;
    tags.out.textContent = STIM[play.stim].outTag;
    play.tagPos = [centroid(play.s.stim), centroid(play.s.output_local)];
  }
  placeTag(tags.in, play.tagPos[0], w, h, 44);
  placeTag(tags.out, play.tagPos[1], w, h, -44);
}

function drawFly(now, dtReal) {
  const [w, h] = resize(flyR, flyCanvas);
  flyCam.aspect = w / h;
  // в узкой панели отодвигаем камеру, чтобы муха влезла целиком
  const dist = FLY_DIST * Math.max(1.12, 1.7 / flyCam.aspect);
  flyCam.position.copy(FLY_TARGET).addScaledVector(FLY_DIR, dist);
  flyCam.lookAt(FLY_TARGET);
  flyCam.updateProjectionMatrix();

  const st = flyState, L = st.level;
  fly.rotation.y = -0.35 + 0.3 * Math.sin(now * 0.0004) + st.turn;
  let wingSpread = 0.18 + 0.05 * Math.sin(now / 300), wingFlap = 0, proboscis = 0;

  if (st.act === 'eat') proboscis = L;
  // горькое: муха трясёт головой
  if (st.act === 'refuse' && play && !play.done) headG.rotation.y = 0.25 * Math.sin(now / 90) * Math.min(1, (now - play.t0) / 800);
  else headG.rotation.y *= 0.9;

  if (st.act === 'fly' && st.takeoffAt) {
    // прыжок и полёт; медленный способ — сначала поднимает крылья, потом летит
    const T = (now - st.takeoffAt) / 1000 / (st.slow ? 1.8 : 1);
    const lift = st.slow ? Math.max(0, T - 0.5) : T;
    fly.position.set(-lift * 2.2, lift * lift * 3.5 + lift * 1.2, 0);
    fly.rotation.z = Math.min(0.5, lift * 0.8);
    wingSpread = 1.0; wingFlap = Math.sin(now / 9) * 0.9;
    legs.forEach(g => { g.rotation.z = Math.min(0.6, T * 2) * (g.userData.pair - 1) * 0.6; });
  }
  if (st.act === 'walk') {
    // тройная походка; скорость — по активности нисходящих ходьбы и поворота
    const a = Math.min(1, L * 2);
    st.walk += dtReal / 1000 * 9 * L;
    legs.forEach(g => {
      const ph = st.walk + g.userData.phase;
      g.rotation.y = Math.sin(ph) * 0.35 * a;
      g.rotation.x = Math.max(0, Math.cos(ph)) * 0.18 * g.userData.side * a;
    });
    // поворачивает к банану и идёт к нему, но не дальше края
    st.turn += ((L > 0.05 ? 0.55 : st.turn) - st.turn) * 0.02;
    fly.position.x = Math.max(-0.9, fly.position.x - dtReal / 1000 * 0.35 * L);
    body.position.y = 0.02 * Math.sin(st.walk * 2) * a;
  }
  if (st.act === 'groom') {
    // передние лапки поднимаются к голове и трут её
    const g = Math.min(1, L * 1.5);
    legs.forEach(leg => {
      if (leg.userData.pair !== 0) return;
      leg.rotation.z = -0.95 * g + 0.2 * g * Math.sin(now / 70 + leg.userData.side);
      leg.rotation.x = 0.55 * g * leg.userData.side;   // к середине — к глазам
    });
    headG.rotation.z = 0.12 * g * Math.sin(now / 140);
    body.rotation.z = -0.08 * g;
  }
  for (const wg of wings) {
    const s = wg.userData.side;
    wg.rotation.set(-Math.PI / 2 + 0.25 * s + s * wingFlap, s * wingSpread, 0);
  }
  setProboscis(proboscis);
  shadow.rotation.z = fly.rotation.y;
  shadow.material.opacity = 0.55 / (1 + Math.max(0, fly.position.y) * 2);

  // предметы
  if (props.loom.visible && play) {
    const u = Math.min(1, (now - play.t0) / 1500);   // тень надвигается сверху
    props.loom.position.set(-1.6 + u * 1.2, 4.0 - u * 2.4, 1.2);
    props.loom.scale.setScalar(0.3 + u * 1.2);
  }
  if (props.touch.visible && play) {
    const u = Math.min(1, (now - play.t0) / 1200);   // пёрышко подлетает к глазу
    props.touch.position.set(-1.9 + u * 0.75 + 0.05 * Math.sin(now / 80), 0.55, 0.45);
    props.touch.rotation.set(0.3, 0.4, 1.1 + 0.15 * Math.sin(now / 120));
  }
  if (props.water.visible) props.water.rotation.y += 0.005;
  if (props.sugar.visible) props.sugar.rotation.y += 0.005;
  flyR.render(flyScene, flyCam);
}

// =====================================================================
// Управление
// =====================================================================
function setLesion(on) {
  lesionOn = on;
  $('lesion').setAttribute('aria-pressed', String(on));
  $('lesion-text').textContent = on ? 'Нейрон сломан' : 'Сломать нейрон';
  if (play) start(play.stim);
}

document.querySelectorAll('.stim').forEach(b =>
  b.addEventListener('pointerdown', () => start(b.dataset.stim)));
$('lesion').addEventListener('pointerdown', () => setLesion(!lesionOn));
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  const k = STIM_KEYS[+e.key - 1];
  if (k && D.scenarios[k]) start(k);
  if (e.key === '0' || e.key === 'l' || e.key === 'д') setLesion(!lesionOn);
});
$('info-text').textContent = D.attribution +
  '\nУпаковка данных: github.com/RaphaelSR/fly-brain-bench (CC-BY 4.0). 3D: three.js (MIT). Шрифт: Manrope (SIL OFL).' +
  '\nЦветной "клубок" — связи из коннектома (по две самые сильные на нейрон), а не форма отростков.';
$('info-btn').addEventListener('click', () => $('info').classList.remove('hidden'));
$('info-close').addEventListener('click', () => $('info').classList.add('hidden'));
window.addEventListener('contextmenu', e => e.preventDefault());

fillIcons();
setStatus('down', 'Выбери, что показать мухе');
setProboscis(0);
requestAnimationFrame(step);
