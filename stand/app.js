// Стенд "Муха в проводах": проигрывание заранее посчитанных растров спайков.
// Данные — window.FLY_DATA из data/export/fly_data.js (src/export.py).
'use strict';

const D = window.FLY_DATA;
const SLOW = 6;              // 1 с модели показываем за 6 с
const FLASH_MS = 350;        // сколько светится нейрон после спайка (реальное время)
const IDLE_RESET_MS = 12000; // через сколько после результата вернуться к целому мозгу
const GROUP_COLORS = ['#ffc83c', '#4fc3ff', '#ff5ad2', '#7dff7a']; // сенсорные, центральные, нисходящие, моторные

const N = D.neurons.id.length;
const nx = Float32Array.from(D.neurons.x);
const ny = Float32Array.from(D.neurons.y);
const ngroup = Uint8Array.from(D.neurons.group);
const role = D.neurons.role;
const PROBOSCIS = role.map((r, i) => (r === 'proboscis' ? i : -1)).filter(i => i >= 0);
const isProb = new Uint8Array(N);
PROBOSCIS.forEach(i => { isProb[i] = 1; });

const $ = id => document.getElementById(id);
const brain = $('brain');
const bctx = brain.getContext('2d');
const flyCanvas = $('fly');
const fctx = flyCanvas.getContext('2d');

// ---------- камера: целый мозг <-> подглоточная зона ----------
const FULL = { x: 0, y: 0, w: D.size[0], h: D.size[1] };
const ZOOM = (() => {
  // рамка по нейронам, разрядившимся при сахаре; одиночные дальние выбросы отбрасываем
  const used = new Uint8Array(N);
  for (const i of D.scenarios.sugar.n) used[i] = 1;
  const xs = [], ys = [];
  for (let i = 0; i < N; i++) if (used[i]) { xs.push(nx[i]); ys.push(ny[i]); }
  const q = (a, p) => a.sort((u, v) => u - v)[Math.floor(p * (a.length - 1))];
  const x0 = q(xs, 0.02), x1 = q(xs, 0.98), y0 = q(ys, 0.02), y1 = q(ys, 0.98);
  const mx = 0.15 * (x1 - x0), my = 0.35 * (y1 - y0);
  // снизу запас побольше — там счётчики
  return { x: x0 - mx, y: y0 - my, w: x1 - x0 + 2 * mx, h: y1 - y0 + 2.6 * my };
})();
const cam = { ...FULL };
let camTarget = FULL;

// ---------- фон: все 138 639 нейронов, рисуется один раз ----------
const bgBytes = Uint8Array.from(atob(D.background), ch => ch.charCodeAt(0));
const bgXY = new Uint16Array(bgBytes.buffer);
const BG_SCALE = 0.5; // фон в половине разрешения сетки — хватает для зума
const bgCanvas = document.createElement('canvas');
bgCanvas.width = Math.ceil(D.size[0] * BG_SCALE) + 1;
bgCanvas.height = Math.ceil(D.size[1] * BG_SCALE) + 1;
(() => {
  const c = bgCanvas.getContext('2d');
  const img = c.createImageData(bgCanvas.width, bgCanvas.height);
  const acc = new Uint16Array(bgCanvas.width * bgCanvas.height);
  for (let k = 0; k < bgXY.length; k += 2) {
    acc[Math.floor(bgXY[k + 1] * BG_SCALE) * bgCanvas.width + Math.floor(bgXY[k] * BG_SCALE)]++;
  }
  for (let p = 0; p < acc.length; p++) {
    if (!acc[p]) continue;
    const a = Math.min(255, 70 + acc[p] * 25);
    img.data[4 * p] = 90; img.data[4 * p + 1] = 100; img.data[4 * p + 2] = 160; img.data[4 * p + 3] = a;
  }
  c.putImageData(img, 0, 0);
})();

// ---------- состояние проигрывания ----------
const flash = new Float32Array(N);   // яркость вспышки 0..1
const seen = new Uint8Array(N);
let play = null;    // { key, stim, data, t0, ptr, done }
let lesionOn = false;
let probLevel = 0;  // сглаженная активность хоботка 0..1
let lastFrame = performance.now();
let idleTimer = null;

function scenarioKey(stim) { return lesionOn ? `${stim}_lesion` : stim; }

function start(stim) {
  const key = scenarioKey(stim);
  const data = D.scenarios[key];
  flash.fill(0); seen.fill(0);
  play = { key, stim, data, t0: performance.now(), ptr: 0, nSeen: 0, nSpikes: 0, done: false };
  camTarget = ZOOM;
  clearTimeout(idleTimer);
  $('result').classList.add('hidden');
  document.querySelectorAll('.stim').forEach(b => b.classList.toggle('active', b.dataset.stim === stim));
  $('status').textContent = { sugar: '🍬 Сладкое! Сигнал бежит по мозгу…', bitter: '🍋 Горькое! Сигнал бежит по мозгу…', water: '💧 Вода! Сигнал бежит по мозгу…' }[stim];
  if (window.FlySound) window.FlySound.play(data, D, SLOW);
}

function finish() {
  play.done = true;
  showResult(play.stim, play.data);
  idleTimer = setTimeout(() => {
    camTarget = FULL;
    $('result').classList.add('hidden');
    $('status').textContent = 'Выбери, чем угостить муху 👇';
    document.querySelectorAll('.stim').forEach(b => b.classList.remove('active'));
    play = null;
  }, IDLE_RESET_MS);
}

function showResult(stim, s) {
  const n = s.active.toLocaleString('ru-RU');
  let icon, title, text;
  if (s.outcome === 'eat') {
    icon = '😋'; title = 'Муха ест!'; text = `Сахар → ${n} нейронов → хоботок`;
  } else if (s.outcome === 'weak') {
    icon = '🤕'; title = 'Почти не ест'; text = 'Сломан всего один нейрон из 138 639';
  } else if (stim === 'bitter') {
    icon = '🤢'; title = 'Фу! Не буду'; text = 'Горький сигнал не дошёл до хоботка';
  } else if (stim === 'water') {
    icon = '🙂'; title = 'Пить не хочет'; text = 'Вода для мухи слабее, чем сахар';
  } else {
    icon = '😐'; title = 'Не ест'; text = 'Сигнал не дошёл до хоботка';
  }
  $('result-icon').textContent = icon;
  $('result-title').textContent = title;
  $('result-text').textContent = text;
  $('result').classList.remove('hidden');
  $('status').textContent = '';
}

// ---------- кадр ----------
function step(now) {
  const dtReal = Math.min(100, now - lastFrame);
  lastFrame = now;
  const decay = Math.exp(-dtReal / FLASH_MS);
  for (let i = 0; i < N; i++) flash[i] *= decay;
  probLevel *= Math.exp(-dtReal / 600);

  if (play && !play.done) {
    const s = play.data;
    const tModelSteps = (now - play.t0) / SLOW / D.dt_ms;
    let probHits = 0;
    while (play.ptr < s.t.length && s.t[play.ptr] <= tModelSteps) {
      const i = s.n[play.ptr++];
      flash[i] = 1;
      if (!seen[i]) { seen[i] = 1; play.nSeen++; }
      if (isProb[i]) probHits++;
    }
    play.nSpikes = play.ptr;
    // уровень хоботка: ~100 спайков за 100 мс модели = полный выход
    probLevel = Math.min(1, probLevel + probHits * 0.012 * SLOW / 6);
    $('cnt-neurons').textContent = play.nSeen.toLocaleString('ru-RU');
    $('cnt-spikes').textContent = play.nSpikes.toLocaleString('ru-RU');
    if (tModelSteps * D.dt_ms >= D.t_ms) finish();
  }

  // камера плавно едет к цели
  const k = 1 - Math.exp(-dtReal / 500);
  for (const f of ['x', 'y', 'w', 'h']) cam[f] += (camTarget[f] - cam[f]) * k;

  drawBrain();
  drawFly(now);
  $('meter-fill').style.width = `${Math.round(probLevel * 100)}%`;
  requestAnimationFrame(step);
}

function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}

function drawBrain() {
  const dpr = fitCanvas(brain);
  const W = brain.width, H = brain.height;
  // вписываем камеру в холст с сохранением пропорций
  const sc = Math.min(W / cam.w, H / cam.h) * 0.94;
  const ox = (W - cam.w * sc) / 2 - cam.x * sc;
  const oy = (H - cam.h * sc) / 2 - cam.y * sc;
  const X = x => ox + x * sc, Y = y => oy + y * sc;

  bctx.globalCompositeOperation = 'source-over';
  bctx.fillStyle = '#070914';
  bctx.fillRect(0, 0, W, H);
  bctx.imageSmoothingEnabled = true;
  bctx.drawImage(bgCanvas, ox, oy, bgCanvas.width / BG_SCALE * sc, bgCanvas.height / BG_SCALE * sc);

  const base = Math.max(2, 5 * dpr * Math.sqrt(sc / (W / FULL.w)) * 0.6);
  // тусклые точки всех нейронов цепи
  bctx.fillStyle = 'rgba(160,170,230,0.25)';
  for (let i = 0; i < N; i++) {
    bctx.beginPath(); bctx.arc(X(nx[i]), Y(ny[i]), base * 0.5, 0, 6.283); bctx.fill();
  }
  // вспышки
  bctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < N; i++) {
    const f = flash[i];
    if (f < 0.02) continue;
    const r = base * (1 + 2.5 * f);
    bctx.globalAlpha = Math.min(1, f * 1.2);
    bctx.fillStyle = GROUP_COLORS[ngroup[i]];
    bctx.beginPath(); bctx.arc(X(nx[i]), Y(ny[i]), r, 0, 6.283); bctx.fill();
  }
  bctx.globalAlpha = 1;
  bctx.globalCompositeOperation = 'source-over';

  // подписи: где вкус, где хоботок
  if (play) {
    label(meanXY(play.data.stim), 'вкус', X, Y, dpr, '#ffffff', 60);
    label(meanXY(PROBOSCIS), 'хоботок', X, Y, dpr, GROUP_COLORS[3], -40);
  }
  // сломанный нейрон — красный крестик
  if (lesionOn) {
    const i = D.lesion.local, cx = X(nx[i]), cy = Y(ny[i]), r = base * 2.2;
    bctx.strokeStyle = '#ff4d5e'; bctx.lineWidth = 4 * dpr;
    bctx.beginPath();
    bctx.moveTo(cx - r, cy - r); bctx.lineTo(cx + r, cy + r);
    bctx.moveTo(cx + r, cy - r); bctx.lineTo(cx - r, cy + r);
    bctx.stroke();
    bctx.beginPath(); bctx.arc(cx, cy, r * 1.6, 0, 6.283); bctx.stroke();
  }
}

function meanXY(list) {
  let x = 0, y = 0;
  for (const i of list) { x += nx[i]; y += ny[i]; }
  return [x / list.length, y / list.length];
}

function label([x, y], text, X, Y, dpr, color, dy) {
  bctx.font = `600 ${Math.round(26 * dpr)}px sans-serif`;
  bctx.textAlign = 'center';
  bctx.lineWidth = 6 * dpr;
  bctx.strokeStyle = 'rgba(0,0,0,0.8)';
  bctx.strokeText(text, X(x), Y(y) + dy * dpr);
  bctx.fillStyle = color;
  bctx.fillText(text, X(x), Y(y) + dy * dpr);
}

// ---------- мультяшная муха: хоботок выдвигается по активности мотонейронов ----------
function drawFly(now) {
  const dpr = fitCanvas(flyCanvas);
  const W = flyCanvas.width, H = flyCanvas.height;
  const c = fctx;
  c.clearRect(0, 0, W, H);
  const s = Math.min(W, H) / 400;
  c.save();
  c.translate(W / 2, H * 0.42);
  c.scale(s, s);

  const wing = Math.sin(now / 60) * 4;
  // крылья
  c.fillStyle = 'rgba(200,230,255,0.35)'; c.strokeStyle = 'rgba(200,230,255,0.7)'; c.lineWidth = 3;
  c.beginPath(); c.ellipse(40, -60 + wing, 110, 38, -0.35, 0, 6.283); c.fill(); c.stroke();
  // ноги
  c.strokeStyle = '#2a2a2a'; c.lineWidth = 6; c.lineCap = 'round';
  for (const lx of [-10, 30, 70]) {
    c.beginPath(); c.moveTo(lx, 20); c.lineTo(lx - 15, 70); c.lineTo(lx - 30, 95); c.stroke();
  }
  // брюшко и грудь
  c.fillStyle = '#6b5a3a';
  c.beginPath(); c.ellipse(90, 0, 85, 45, 0.1, 0, 6.283); c.fill();
  c.fillStyle = '#4a3f2a';
  for (const bx of [70, 100, 130]) { c.fillRect(bx, -38, 10, 76); }
  c.fillStyle = '#5a4a30';
  c.beginPath(); c.ellipse(-5, -5, 50, 42, 0, 0, 6.283); c.fill();
  // голова
  const hx = -75, hy = -5;
  c.fillStyle = '#5a4a30';
  c.beginPath(); c.arc(hx, hy, 38, 0, 6.283); c.fill();
  // хоботок
  const len = 10 + probLevel * 95;
  c.strokeStyle = '#c98f5a'; c.lineWidth = 14;
  c.beginPath(); c.moveTo(hx - 10, hy + 30); c.lineTo(hx - 20, hy + 30 + len); c.stroke();
  c.fillStyle = '#e0a56d';
  c.beginPath(); c.ellipse(hx - 20, hy + 34 + len, 18, 10, 0, 0, 6.283); c.fill();
  // глаз
  c.fillStyle = '#d0202c';
  c.beginPath(); c.ellipse(hx - 8, hy - 8, 26, 30, 0.2, 0, 6.283); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.6)';
  c.beginPath(); c.arc(hx - 16, hy - 20, 7, 0, 6.283); c.fill();
  // угощение под хоботком
  if (play) {
    c.font = '64px sans-serif'; c.textAlign = 'center';
    c.fillText({ sugar: '🍬', bitter: '🍋', water: '💧' }[play.stim], hx - 20, hy + 200);
  }
  c.restore();
}

// ---------- управление ----------
function setLesion(on) {
  lesionOn = on;
  const b = $('lesion');
  b.setAttribute('aria-pressed', String(on));
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
  '\nКод стенда — команда стенда ВВГУ. Упаковка данных: github.com/RaphaelSR/fly-brain-bench (CC-BY 4.0).';
$('info-btn').addEventListener('click', () => $('info').classList.remove('hidden'));
$('info-close').addEventListener('click', () => $('info').classList.add('hidden'));
window.addEventListener('contextmenu', e => e.preventDefault());

requestAnimationFrame(step);
