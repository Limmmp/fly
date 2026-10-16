// SVG-иконки стенда (свои, без эмодзи). Строки, чтобы работать через file://.
// Все в одной сетке 64x64, единая обводка.
'use strict';
(() => {
  const INK = '#22263d';
  const svg = body => `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" ` +
    `stroke="${INK}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
  const sparkle = (x, y, r, c) =>
    `<path d="M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r}Z" fill="${c}" stroke="none"/>`;

  // лицо для итога: фон + глаза + рот
  const face = (fill, inner) => svg(`<circle cx="32" cy="33" r="25" fill="${fill}"/>${inner}`);

  window.ICONS = {
    // кубик сахара
    sugar: svg(`
      <path d="M32 9 54 20 32 31 10 20Z" fill="#ffffff"/>
      <path d="M10 20 32 31 32 56 10 45Z" fill="#e4e8f3"/>
      <path d="M32 31 54 20 54 45 32 56Z" fill="#c9d0e4"/>
      <g fill="#c9d0e4" stroke="none"><circle cx="26" cy="19" r="1.6"/><circle cx="34" cy="16" r="1.6"/><circle cx="38" cy="22" r="1.6"/><circle cx="30" cy="24" r="1.6"/></g>
      ${sparkle(53, 9, 6, '#ffc83c')}`),
    // лимон
    bitter: svg(`
      <g transform="rotate(-28 32 36)">
        <ellipse cx="32" cy="36" rx="21" ry="15" fill="#ffd43b"/>
        <path d="M11 36a3 3 0 0 1-3-3" fill="none"/><circle cx="9" cy="36" r="2.6" fill="#ffd43b"/>
        <circle cx="55" cy="36" r="2.6" fill="#ffd43b"/>
        <path d="M22 29q8-6 18-3" fill="none" stroke="#fff6c2" stroke-width="3.2"/>
      </g>
      <path d="M43 15q9-8 15-2q-7 7-15 2Z" fill="#6fcf5a"/>
      <path d="M43 15q6-1 15-2" fill="none" stroke-width="1.8"/>`),
    // капля воды
    water: svg(`
      <path d="M32 6C32 6 13 28 13 40a19 19 0 0 0 38 0C51 28 32 6 32 6Z" fill="#4fc3ff"/>
      <path d="M22 41a10 10 0 0 0 7 9" fill="none" stroke="#e6f7ff" stroke-width="3.4"/>
      ${sparkle(46, 18, 5, '#e6f7ff')}`),
    // нейрон с трещиной
    lesion: svg(`
      <g fill="none" stroke="#b9a7ff" stroke-width="3.2">
        <path d="M26 26 12 14M12 14 6 16M12 14 11 7"/><path d="M24 33 8 36M8 36 4 31"/><path d="M28 40 17 54M17 54 10 55"/>
        <path d="M38 34 58 34"/>
      </g>
      <circle cx="30" cy="33" r="9.5" fill="#b9a7ff"/>
      <path d="M44 22 49 31 43 37 50 47" fill="none" stroke="#ff4d5e" stroke-width="4"/>
      ${sparkle(55, 22, 5, '#ff4d5e')}`),

    // тень: приближающийся тёмный круг с линиями движения
    loom: svg(`
      <circle cx="36" cy="30" r="20" fill="#8a90bd"/>
      <circle cx="36" cy="30" r="13" fill="#4a5080" stroke="none"/>
      <circle cx="36" cy="30" r="6" fill="#262a45" stroke="none"/>
      <path d="M9 50l8-6M6 40l8-3M14 58l7-8" fill="none" stroke="#9aa0c6" stroke-width="3"/>
      ${sparkle(55, 51, 5, '#ff5468')}`),
    // запах фруктов: банан и волны запаха
    smell: svg(`
      <path d="M12 44q16 14 36-2q6-6 6-14q-4 10-18 13q-14 3-24 3Z" fill="#ffd43b"/>
      <path d="M54 28l3-5" fill="none" stroke-width="3"/>
      <path d="M20 30q-3-5 0-9t0-9M31 27q-3-5 0-9t0-9" fill="none" stroke="#c39bff" stroke-width="3"/>`),
    // касание: пёрышко
    touch: svg(`
      <path d="M50 8C30 10 16 26 14 46l6 4C36 44 50 30 50 8Z" fill="#e8ecff"/>
      <path d="M48 11 12 54" fill="none" stroke-width="2.4"/>
      <path d="M38 22l-8-1M33 30l-9-1M28 38l-9 0M42 18l5 6M37 26l6 6M32 34l6 6" fill="none" stroke="#9aa0c6" stroke-width="1.8"/>`),

    // итоги
    eat: face('#ffc83c', `
      <path d="M20 29q4-5 8 0M36 29q4-5 8 0" fill="none"/>
      <path d="M20 39q12 12 24 0Z" fill="#7a2a1e"/>
      <path d="M28 44q4 6 9 2q-4-3-9-2Z" fill="#ff7a8a" stroke-width="2"/>`),
    yuck: face('#a6e36a', `
      <path d="M19 24l7 4-7 4M45 24l-7 4 7 4" fill="none"/>
      <path d="M19 44q3.3-4 6.5 0t6.5 0 6.5 0 6.5 0" fill="none"/>`),
    calm: face('#8fd3ff', `
      <circle cx="24" cy="29" r="2.8" fill="${INK}" stroke="none"/><circle cx="40" cy="29" r="2.8" fill="${INK}" stroke="none"/>
      <path d="M24 42q8 4 16 0" fill="none"/>`),
    hurt: face('#ffb4a2', `
      <circle cx="24" cy="31" r="2.8" fill="${INK}" stroke="none"/><circle cx="40" cy="31" r="2.8" fill="${INK}" stroke="none"/>
      <path d="M24 45q8-5 16 0" fill="none"/>
      <g transform="rotate(-20 40 15)"><rect x="29" y="11" width="22" height="8" rx="3" fill="#fff4e6"/>
      <path d="M37 13v4M40 13v4M43 13v4" stroke-width="1.6"/></g>`),
    // улетела: облачко и линии взлёта
    away: svg(`
      <path d="M14 48h32a10 10 0 0 0 0-20a14 14 0 0 0-27 3a9 9 0 0 0-5 17Z" fill="#dfe6ff"/>
      <path d="M40 20l10-12M48 26l12-6M32 16l2-12" fill="none" stroke="#52c7ff" stroke-width="3.4"/>`),
    // идёт: следы лапок
    walk: svg(`
      <g fill="#7dff9a"><circle cx="18" cy="46" r="5"/><circle cx="30" cy="34" r="5"/><circle cx="42" cy="44" r="5"/><circle cx="50" cy="20" r="5"/></g>
      <path d="M10 56 56 12" fill="none" stroke="#9aa0c6" stroke-width="2" stroke-dasharray="3 5"/>`),
    // чистится: блёстки
    groom: svg(`
      ${sparkle(30, 32, 18, '#fff4c2')}${sparkle(50, 14, 8, '#ffc24b')}${sparkle(50, 50, 6, '#52c7ff')}${sparkle(12, 14, 5, '#c39bff')}`),
    // медленно: черепашка-лицо
    slow: face('#c8cbe0', `
      <path d="M19 29h10M35 29h10" fill="none"/>
      <path d="M24 43q8 3 16 0" fill="none"/>
      <path d="M46 14q6-2 9 3" fill="none" stroke="#52c7ff" stroke-width="3"/>`),
    none: face('#c8cbe0', `
      <circle cx="24" cy="29" r="2.8" fill="${INK}" stroke="none"/><circle cx="40" cy="29" r="2.8" fill="${INK}" stroke="none"/>
      <path d="M24 43h16" fill="none"/>`),

    // служебные
    down: svg(`<path d="M18 24 32 40 46 24" fill="none" stroke="currentColor" stroke-width="5"/>`),
    info: svg(`<circle cx="32" cy="32" r="24" fill="none" stroke="currentColor" stroke-width="4"/>
      <path d="M32 29v16" stroke="currentColor" stroke-width="5"/><circle cx="32" cy="20" r="3" fill="currentColor" stroke="none"/>`),
  };

  // вставляем иконки во все элементы с data-icon
  window.fillIcons = (root = document) => {
    root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = window.ICONS[el.dataset.icon] || ''; });
  };
})();
