// Стенд "Муха в проводах": проигрывание заранее посчитанных растров спайков в 3D.
// Данные — window.FLY_DATA из data/export/fly_data.js (src/export.py).
// 3D — three.js r149 (stand/vendor/three.min.js, MIT), без сборки и сервера.
'use strict';

const D = window.FLY_DATA;
const SLOW = 6;              // 1 с модели показываем за 6 с
const FLASH_MS = 350;        // сколько светится нейрон после спайка (реальное время)
const PULSE_MS = 280;        // сколько импульс бежит по проводу (для глаза, не физиология)
const PULSE_MIN_SYN = 15;    // импульсы рисуем только по толстым связям
const WIRE_MIN_SYN = 10;     // провода — от 10 синапсов, иначе ядро сливается в белое пятно
const IDLE_RESET_MS = 12000; // через сколько после результата вернуться к целому мозгу
const GROUP_COLORS = ['#ffc83c', '#4fc3ff', '#ff5ad2', '#7dff7a']; // сенсорные, центральные, нисходящие, моторные
const INHIB_COLOR = '#8a7dff';
const S = 1 / 1000;          // сетка 0..4095 -> единицы сцены

const N = D.neurons.id.length;
const role = D.neurons.role;
const PROBOSCIS = role.map((r, i) => (r === 'proboscis' ? i : -1)).filter(i => i >= 0);
const isProb = new Uint8Array(N);
PROBOSCIS.forEach(i => { isProb[i] = 1; });

const $ = id => document.getElementById(id);

// координаты сетки -> сцена: x вправо, y вверх, центр мозга в нуле
const C0 = [D.size[0] / 2, D.size[1] / 2, D.size[2] / 2];
const toScene = (x, y, z) => [(x - C0[0]) * S, -(y - C0[1]) * S, -(z - C0[2]) * S];
const npos = new Float32Array(3 * N);
for (let i = 0; i < N; i++) {
  const p = toScene(D.neurons.x[i], D.neurons.y[i], D.neurons.z[i]);
  npos.set(p, 3 * i);
}

// мягкая круглая точка для спрайтов
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
brainR.setClearColor(0x05060f, 1);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05060f, 0.12);
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);

// фон: все 138 639 нейронов, оттенок по глубине
(() => {
  const bytes = Uint8Array.from(atob(D.background), ch => ch.charCodeAt(0));
  const q = new Uint16Array(bytes.buffer);
  const n = q.length / 3;
  const pos = new Float32Array(3 * n), col = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = toScene(q[3 * i], q[3 * i + 1], q[3 * i + 2]);
    pos.set(p, 3 * i);
    const t = q[3 * i + 2] / D.size[2]; // 0 спереди .. 1 сзади
    col[3 * i] = 0.20 - 0.08 * t; col[3 * i + 1] = 0.20 - 0.06 * t; col[3 * i + 2] = 0.42 - 0.10 * t;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    size: 0.022, map: GLOW, vertexColors: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55,
  });
  scene.add(new THREE.Points(g, m));
})();

// провода: связи между активными нейронами, яркость по активности пресинапса
const WIRES = D.edges.filter(e => e[2] >= WIRE_MIN_SYN);
const E = WIRES.length;
const edgePos = new Float32Array(6 * E), edgeCol = new Float32Array(6 * E);
const edgeBase = new Float32Array(3 * E);   // цвет связи без яркости
const edgeW = new Float32Array(E);
const outEdges = Array.from({ length: N }, () => []);
WIRES.forEach(([a, b, k, sign], e) => {
  edgePos.set(npos.subarray(3 * a, 3 * a + 3), 6 * e);
  edgePos.set(npos.subarray(3 * b, 3 * b + 3), 6 * e + 3);
  const c = new THREE.Color(sign > 0 ? GROUP_COLORS[D.neurons.group[a]] : INHIB_COLOR);
  edgeBase.set([c.r, c.g, c.b], 3 * e);
  edgeW[e] = Math.min(1, k / 40);
  if (k >= PULSE_MIN_SYN) outEdges[a].push(e);
});
const edgeGeo = new THREE.BufferGeometry();
edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
edgeGeo.setAttribute('color', new THREE.BufferAttribute(edgeCol, 3));
scene.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
})));

// нейроны цепи: свой шейдер — ядро + ореол, размер растёт при спайке
const flash = new Float32Array(N);
const ncol = new Float32Array(3 * N);
for (let i = 0; i < N; i++) {
  const c = new THREE.Color(GROUP_COLORS[D.neurons.group[i]]);
  ncol.set([c.r, c.g, c.b], 3 * i);
}
const nGeo = new THREE.BufferGeometry();
nGeo.setAttribute('position', new THREE.BufferAttribute(npos, 3));
nGeo.setAttribute('color', new THREE.BufferAttribute(ncol, 3));
nGeo.setAttribute('flash', new THREE.BufferAttribute(flash, 1));
const nMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 500 }, uSize: { value: 0.05 }, uGain: { value: 1 } },
  vertexShader: `
    attribute vec3 color; attribute float flash;
    uniform float uScale, uSize;
    varying vec3 vColor; varying float vFlash;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = uSize * (1.0 + 1.6 * flash) * uScale / -mv.z;
      vColor = color; vFlash = flash;
    }`,
  fragmentShader: `
    varying vec3 vColor; varying float vFlash;
    uniform float uGain;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      float core = exp(-r2 * 10.0), halo = exp(-r2 * 3.0);
      vec3 col = mix(vColor, vec3(1.0), core * vFlash * 0.8);
      float a = core * (0.3 + 0.35 * vFlash) + halo * (0.04 + 0.2 * vFlash);
      gl_FragColor = vec4(col, a * uGain);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
scene.add(new THREE.Points(nGeo, nMat));

// импульсы, бегущие по проводам
const MAX_PULSES = 1500;
const pulsePos = new Float32Array(3 * MAX_PULSES).fill(999);
const pulseCol = new Float32Array(3 * MAX_PULSES);
const pulses = [];   // { e, t0 }
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pulsePos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pulseCol, 3));
scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({
  size: 0.045, map: GLOW, vertexColors: true, transparent: true,
  depthWrite: false, blending: THREE.AdditiveBlending,
})));

// сломанный нейрон — красный перечёркнутый круг
const lesionSprite = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.strokeStyle = '#ff4d5e'; g.lineWidth = 12; g.lineCap = 'round';
  g.beginPath(); g.arc(64, 64, 50, 0, 6.283); g.stroke();
  g.beginPath(); g.moveTo(34, 34); g.lineTo(94, 94); g.moveTo(94, 34); g.lineTo(34, 94); g.stroke();
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  sp.position.fromArray(npos, 3 * D.lesion.local);
  sp.scale.set(0.16, 0.16, 1);
  sp.visible = false;
  scene.add(sp);
  return sp;
})();

// камера: целый мозг <-> зона вкуса (по нейронам, разрядившимся при сахаре)
function boxOf(list) {
  const b = new THREE.Box3();
  for (const i of list) b.expandByPoint(new THREE.Vector3().fromArray(npos, 3 * i));
  return b;
}
const FULL_BOX = new THREE.Box3(new THREE.Vector3(...toScene(0, D.size[1], D.size[2])), new THREE.Vector3(...toScene(D.size[0], 0, 0)));
const ZOOM_BOX = (() => {
  // отбрасываем одиночные дальние выбросы: 2..98 перцентиль по осям
  const used = [...new Set(D.scenarios.sugar.n)];
  const q = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))];
  const ax = k => used.map(i => npos[3 * i + k]);
  const lo = [0, 1, 2].map(k => q(ax(k), 0.02)), hi = [0, 1, 2].map(k => q(ax(k), 0.98));
  return new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
})();
function viewFor(box, margin) {
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  return { target: c, w: s.x * margin, h: s.y * margin };
}
const VIEW_FULL = viewFor(FULL_BOX, 1.05), VIEW_ZOOM = viewFor(ZOOM_BOX, 1.5);
const cam = { target: VIEW_FULL.target.clone(), w: VIEW_FULL.w, h: VIEW_FULL.h };
let camGoal = VIEW_FULL;

// =====================================================================
// 3D-муха: хоботок выдвигается по активности мотонейронов хоботка
// =====================================================================
const flyCanvas = $('fly');
const flyR = new THREE.WebGLRenderer({ canvas: flyCanvas, antialias: true, alpha: true });
const flyScene = new THREE.Scene();
const flyCam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
const FLY_TARGET = new THREE.Vector3(0.3, -0.3, 0);
const FLY_DIR = new THREE.Vector3(-1.0, 0.9, 4.6).sub(FLY_TARGET);
const FLY_DIST = FLY_DIR.length();
FLY_DIR.normalize();
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
// палочка между двумя точками
function rod(a, b, radius, mat) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.8, radius, len, 10), mat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  return m;
}

// грудь, брюшко, голова
const thorax = ellipsoid(0.5, 1.15, 0.92, 0.88, brown); thorax.position.set(0, 0.1, 0); fly.add(thorax);
const abdGeo = new THREE.SphereGeometry(0.5, 48, 32); abdGeo.rotateZ(Math.PI / 2);
const abdomen = new THREE.Mesh(abdGeo, new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.5 }));
abdomen.scale.set(1.55, 0.82, 0.88); abdomen.position.set(1.15, -0.05, 0); abdomen.rotation.z = -0.15; fly.add(abdomen);
const head = ellipsoid(0.36, 0.8, 1.0, 1.18, brown); head.position.set(-0.78, 0.12, 0); fly.add(head);
// фасеточные глаза: икосаэдр с плоскими гранями
const eyeMat = new THREE.MeshPhongMaterial({ color: 0xb0101c, shininess: 70, flatShading: true, specular: 0x441111 });
for (const s of [-1, 1]) {
  const eye = new THREE.Mesh(new THREE.IcosahedronGeometry(0.29, 3), eyeMat);
  eye.scale.set(0.72, 1.05, 0.62); eye.position.set(-0.86, 0.2, 0.27 * s); fly.add(eye);
  fly.add(rod([-1.02, 0.28, 0.08 * s], [-1.18, 0.36, 0.13 * s], 0.025, dark)); // антенна
}
// щетинки на груди
for (let k = 0; k < 14; k++) {
  const a = -1.2 + 2.4 * (k / 13), x = -0.35 + 0.7 * ((k * 7) % 13) / 13;
  const base = [x, 0.1 + 0.42 * Math.cos(a * 0.6), 0.4 * Math.sin(a)];
  fly.add(rod(base, [base[0] + 0.12, base[1] + 0.16, base[2] * 1.15], 0.008, dark));
}
// ноги: бедро вверх-наружу, голень вниз, лапка по полу
for (const s of [-1, 1]) {
  for (let k = 0; k < 3; k++) {
    const x = -0.28 + 0.28 * k, dx = (k - 1) * 0.35;
    const hip = [x, -0.18, 0.22 * s], knee = [x + dx, 0.05, 0.62 * s];
    const ankle = [x + dx * 1.6, FLY_FLOOR + 0.05, 0.85 * s], toe = [x + dx * 1.9, FLY_FLOOR, 0.98 * s];
    fly.add(rod(hip, knee, 0.045, dark)); fly.add(rod(knee, ankle, 0.035, dark)); fly.add(rod(ankle, toe, 0.025, dark));
  }
}
// крылья: прозрачные, с жилками и радужным отливом
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
  w.rotation.set(-Math.PI / 2 + 0.25 * s, 0, 0);
  w.userData.side = s;
  fly.add(w);
  return w;
});
// хоботок: шарнир под головой, хоботок + губки (лабеллум) на конце
const probPivot = new THREE.Group(); probPivot.position.set(-0.86, -0.18, 0); fly.add(probPivot);
const probMat = new THREE.MeshStandardMaterial({ color: 0xc9925a, roughness: 0.6 });
const rostrum = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1, 16), probMat);
probPivot.add(rostrum);
const labellum = ellipsoid(0.13, 1.2, 0.6, 1.3, new THREE.MeshStandardMaterial({ color: 0xe0a56d, roughness: 0.5 }));
probPivot.add(labellum);
function setProboscis(e) {
  const len = 0.25 + 0.55 * e;
  rostrum.scale.y = len; rostrum.position.y = -len / 2;
  labellum.position.y = -len - 0.04;
  probPivot.rotation.z = 0.9 * (1 - e);  // свёрнут назад под голову -> вытянут вниз к еде
}
// тень на полу
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.2),
  new THREE.MeshBasicMaterial({ map: GLOW, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
shadow.rotation.x = -Math.PI / 2; shadow.position.set(0.3, FLY_FLOOR - 0.01, 0); flyScene.add(shadow);
// угощение под хоботком
const foods = {
  sugar: new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.9 })),
  bitter: ellipsoid(0.26, 1.3, 1, 1, new THREE.MeshStandardMaterial({ color: 0xf2d22a, roughness: 0.45 })),
  water: ellipsoid(0.22, 1.2, 0.75, 1.2, new THREE.MeshPhysicalMaterial({ color: 0x5ec8ff, roughness: 0.05, transparent: true, opacity: 0.7, clearcoat: 1 })),
};
for (const [k, m] of Object.entries(foods)) {
  m.position.set(-1.05, FLY_FLOOR + (k === 'water' ? 0.15 : 0.18), 0);
  m.rotation.y = 0.5; m.visible = false; flyScene.add(m);
}

// =====================================================================
// Проигрывание
// =====================================================================
const seen = new Uint8Array(N);
let play = null;    // { key, stim, data, t0, ptr, done }
let lesionOn = false;
let probLevel = 0;  // сглаженная активность хоботка 0..1
let lastFrame = performance.now();
let idleTimer = null;

function start(stim) {
  const key = lesionOn ? `${stim}_lesion` : stim;
  const data = D.scenarios[key];
  flash.fill(0); seen.fill(0); pulses.length = 0;
  play = { key, stim, data, t0: performance.now(), ptr: 0, nSeen: 0, done: false };
  camGoal = VIEW_ZOOM;
  clearTimeout(idleTimer);
  $('result').classList.add('hidden');
  document.querySelectorAll('.stim').forEach(b => b.classList.toggle('active', b.dataset.stim === stim));
  setStatus(stim, { sugar: 'Сладкое! Сигнал бежит по мозгу…', bitter: 'Горькое! Сигнал бежит по мозгу…', water: 'Вода! Сигнал бежит по мозгу…' }[stim]);
  for (const [k, m] of Object.entries(foods)) m.visible = k === stim;
  if (window.FlySound) window.FlySound.play(data, D, SLOW);
}

function finish() {
  play.done = true;
  showResult(play.stim, play.data);
  idleTimer = setTimeout(() => {
    camGoal = VIEW_FULL;
    $('result').classList.add('hidden');
    setStatus('down', 'Выбери, чем угостить муху');
    document.querySelectorAll('.stim').forEach(b => b.classList.remove('active'));
    for (const m of Object.values(foods)) m.visible = false;
    play = null;
  }, IDLE_RESET_MS);
}

function showResult(stim, s) {
  const n = s.active.toLocaleString('ru-RU');
  let icon, title, text;
  if (s.outcome === 'eat') {
    icon = 'eat'; title = 'Муха ест!'; text = `Сахар → ${n} нейронов → хоботок`;
  } else if (s.outcome === 'weak') {
    icon = 'hurt'; title = 'Почти не ест'; text = 'Сломан всего один нейрон из 138 639';
  } else if (stim === 'bitter') {
    icon = 'yuck'; title = 'Фу! Не буду'; text = 'Горький сигнал не дошёл до хоботка';
  } else if (stim === 'water') {
    icon = 'calm'; title = 'Пить не хочет'; text = 'Вода для мухи слабее, чем сахар';
  } else {
    icon = 'none'; title = 'Не ест'; text = 'Сигнал не дошёл до хоботка';
  }
  $('result-icon').innerHTML = ICONS[icon];
  $('result-title').textContent = title;
  $('result-text').textContent = text;
  $('result').classList.remove('hidden');
  setStatus(null, '');
}

// строка статуса: иконка + текст
function setStatus(icon, text) {
  const el = $('status');
  el.textContent = '';
  if (icon) {
    const i = document.createElement('span');
    i.className = 'status-icon'; i.innerHTML = ICONS[icon];
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

let gain = 1;
function step(now) {
  // затухание — по реальному времени, даже если кадры редкие
  const dtDecay = Math.min(1000, now - lastFrame);
  const dtReal = Math.min(100, dtDecay);
  lastFrame = now;
  const decay = Math.exp(-dtDecay / FLASH_MS);
  let lit = 0;
  for (let i = 0; i < N; i++) { flash[i] *= decay; lit += flash[i]; }
  probLevel *= Math.exp(-dtDecay / 600);
  // автоэкспозиция: когда вспыхивает сразу много нейронов, каждый светит тише
  const gainGoal = 1 / (1 + lit / 60);
  gain += (gainGoal - gain) * (1 - Math.exp(-dtReal / 250));
  nMat.uniforms.uGain.value = 0.35 + 0.65 * gain;

  if (play && !play.done) {
    const s = play.data;
    const tModelSteps = (now - play.t0) / SLOW / D.dt_ms;
    let probHits = 0;
    while (play.ptr < s.t.length && s.t[play.ptr] <= tModelSteps) {
      const i = s.n[play.ptr++];
      flash[i] = 1;
      spawnPulses(i, now);
      if (!seen[i]) { seen[i] = 1; play.nSeen++; }
      if (isProb[i]) probHits++;
    }
    // уровень хоботка: ~100 спайков мотонейронов за 100 мс модели = полный выход
    probLevel = Math.min(1, probLevel + probHits * 0.012);
    $('cnt-neurons').textContent = play.nSeen.toLocaleString('ru-RU');
    $('cnt-spikes').textContent = play.ptr.toLocaleString('ru-RU');
    if (tModelSteps * D.dt_ms >= D.t_ms) finish();
  }
  nGeo.attributes.flash.needsUpdate = true;

  // провода
  for (let e = 0; e < E; e++) {
    const a = WIRES[e][0];
    const v = 0.008 + 0.3 * gain * flash[a] * edgeW[e];
    for (let k = 0; k < 3; k++) {
      edgeCol[6 * e + k] = edgeBase[3 * e + k] * v;
      edgeCol[6 * e + 3 + k] = edgeBase[3 * e + k] * v * 0.6;
    }
  }
  edgeGeo.attributes.color.needsUpdate = true;

  // импульсы
  let alive = 0;
  for (let p = 0; p < pulses.length; p++) {
    const u = (now - pulses[p].t0) / PULSE_MS;
    if (u >= 1) continue;
    const e = pulses[p].e;
    for (let k = 0; k < 3; k++) {
      pulsePos[3 * alive + k] = edgePos[6 * e + k] + (edgePos[6 * e + 3 + k] - edgePos[6 * e + k]) * u;
      pulseCol[3 * alive + k] = edgeBase[3 * e + k] * 0.45 * (1 - u * 0.5);
    }
    pulses[alive++] = pulses[p];
  }
  pulses.length = alive;
  pulsePos.fill(999, 3 * alive);
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;

  lesionSprite.visible = lesionOn;
  lesionSprite.material.opacity = 0.7 + 0.3 * Math.sin(now / 200);

  drawBrain(now, dtReal);
  drawFly(now);
  $('meter-fill').style.width = `${Math.round(probLevel * 100)}%`;
  requestAnimationFrame(step);
}

function drawBrain(now, dtReal) {
  const [w, h, dpr] = resize(brainR, brainCanvas);
  camera.aspect = w / h;
  // камера плавно едет к цели и слегка покачивается — видно, что мозг объёмный
  const k = 1 - Math.exp(-dtReal / 600);
  cam.target.lerp(camGoal.target, k);
  cam.w += (camGoal.w - cam.w) * k; cam.h += (camGoal.h - cam.h) * k;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(cam.h / 2 / tanHalf, cam.w / 2 / tanHalf / camera.aspect) * 1.05;
  const yaw = 0.45 * Math.sin(now * 0.00018), pitch = 0.12 + 0.06 * Math.sin(now * 0.00011);
  camera.position.set(
    cam.target.x + dist * Math.sin(yaw) * Math.cos(pitch),
    cam.target.y + dist * Math.sin(pitch),
    cam.target.z + dist * Math.cos(yaw) * Math.cos(pitch));
  camera.lookAt(cam.target);
  // макет может сдвинуть кадр, чтобы мозг не прятался под панелями
  const shift = (window.STAND_OPTS && window.STAND_OPTS.shiftX) || 0;
  if (shift) camera.setViewOffset(w, h, w * shift, 0, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  nMat.uniforms.uScale.value = h * dpr / (2 * tanHalf);
  brainR.render(scene, camera);
  drawTags(w, h);
}

// подписи "вкус" и "хоботок" поверх 3D
const tags = {
  taste: Object.assign(document.createElement('div'), { className: 'tag', textContent: 'вкус' }),
  prob: Object.assign(document.createElement('div'), { className: 'tag', textContent: 'хоботок' }),
};
tags.prob.style.color = GROUP_COLORS[3];
Object.values(tags).forEach(t => $('tags').appendChild(t));
function centroid(list) {
  const v = new THREE.Vector3();
  for (const i of list) v.add(new THREE.Vector3().fromArray(npos, 3 * i));
  return v.multiplyScalar(1 / list.length);
}
const PROB_CENTER = centroid(PROBOSCIS);
function placeTag(el, p, w, h, dy) {
  const v = p.clone().project(camera);
  el.style.left = `${(v.x + 1) / 2 * w}px`;
  el.style.top = `${(1 - v.y) / 2 * h + dy}px`;
}
function drawTags(w, h) {
  const on = !!play;
  tags.taste.style.opacity = tags.prob.style.opacity = on ? 1 : 0;
  if (!on) return;
  placeTag(tags.taste, centroid(play.data.stim), w, h, 44);
  placeTag(tags.prob, PROB_CENTER, w, h, -44);
}

function drawFly(now) {
  const [w, h] = resize(flyR, flyCanvas);
  flyCam.aspect = w / h;
  // в узкой панели отодвигаем камеру, чтобы муха влезла целиком
  const dist = FLY_DIST * Math.max(1.12, 1.7 / flyCam.aspect);
  flyCam.position.copy(FLY_TARGET).addScaledVector(FLY_DIR, dist);
  flyCam.lookAt(FLY_TARGET);
  flyCam.updateProjectionMatrix();
  fly.rotation.y = -0.35 + 0.3 * Math.sin(now * 0.0004);
  shadow.rotation.z = fly.rotation.y;
  // крылья чуть подрагивают, при горьком — нервно
  const nervous = play && play.stim === 'bitter' && !play.done ? 1 : 0;
  for (const wg of wings) {
    const s = wg.userData.side;
    wg.rotation.y = s * (0.18 + 0.05 * Math.sin(now / 300) + nervous * 0.12 * Math.sin(now / 25));
  }
  setProboscis(probLevel);
  for (const m of Object.values(foods)) m.rotation.y += 0.005;
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
  const k = { 1: 'sugar', 2: 'bitter', 3: 'water' }[e.key];
  if (k) start(k);
  if (e.key === '4' || e.key === 'l' || e.key === 'д') setLesion(!lesionOn);
});
$('info-text').textContent = D.attribution +
  '\nУпаковка данных: github.com/RaphaelSR/fly-brain-bench (CC-BY 4.0). 3D: three.js (MIT).';
$('info-btn').addEventListener('click', () => $('info').classList.remove('hidden'));
$('info-close').addEventListener('click', () => $('info').classList.add('hidden'));
window.addEventListener('contextmenu', e => e.preventDefault());

fillIcons();
setStatus('down', 'Выбери, чем угостить муху');
setProboscis(0);
requestAnimationFrame(step);
