"""Шаг 5: время реакции мухи для аркады — по нашей модели, а не "на глаз".

Стимулируем детекторы приближения LPLC2 (все 210) и меряем, через сколько
разряжается гигантское волокно DNp01. Чем слабее разряд LPLC2 (сумерки,
низкий контраст тени), тем дольше копится потенциал в DNp01 — так муха
"замедляется" честно, внутри модели.

Время мухи в аркаде = задержка LPLC2 -> DNp01 (модель) + взлёт после
спайка DNp01, короткий режим < 7 мс (von Reyn et al. 2014; Chai et al. 2025).
Не входит: путь фоторецептор -> LPLC2 (в коннектоме центрального мозга
его нет), поэтому это время "мозга и ног", а не всей мухи.

Результат: arcade/escape_data.js (window.ESCAPE)
"""
import json
from multiprocessing import Pool
from pathlib import Path

import numpy as np

import flydata
import lif

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'arcade' / 'escape_data.js'
TAKEOFF_MS = 7.0
MODES = [  # (ключ, подпись, частота LPLC2, Гц)
    ('day', 'Яркий день', 150.0),
    ('dusk', 'Сумерки', 40.0),
    ('night', 'Почти темно', 20.0),
]
SEEDS = range(1, 9)
T_MS = 200.0

_c = _w = _lplc2 = None
GF = None


def _init():
    global _c, _w, _lplc2, GF
    _c = flydata.load()
    _w = lif.synaptic_weights(_c)
    _lplc2 = _c.where('cell_type', 'LPLC2')
    GF = _c.where('cell_type', 'DNp01')


def _latency(args):
    rate, seed = args
    steps, idx = lif.run(_c, _w, _lplc2, t_ms=T_MS, rate=rate, seed=seed)
    first = steps[np.isin(idx, GF)]
    return rate, seed, float(first.min() * lif.DT) if first.size else None


def main():
    with Pool(4, initializer=_init) as pool:
        res = pool.map(_latency, [(r, s) for _, _, r in MODES for s in SEEDS])
    modes = []
    for key, title, rate in MODES:
        lat = [x for r, _, x in res if r == rate and x is not None]
        missed = sum(1 for r, _, x in res if r == rate and x is None)
        med = float(np.median(lat))
        modes.append({'key': key, 'title': title, 'lplc2_hz': rate,
                      'brain_ms': round(med, 1), 'takeoff_ms': TAKEOFF_MS,
                      'total_ms': round(med + TAKEOFF_MS, 1),
                      'brain_ms_all': lat, 'missed': missed})
        print(f'{title:<12} LPLC2 {rate:>5.0f} Гц: DNp01 через {np.round(lat, 1)} мс, '
              f'медиана {med:.1f} мс (+{TAKEOFF_MS:.0f} мс взлёт = {med + TAKEOFF_MS:.1f} мс), промахов {missed}')
    data = {'source': 'LIF-модель (Shiu et al. 2024) на FlyWire 783, src/escape.py',
            'n_lplc2': 210, 'seeds': len(SEEDS), 'modes': modes}
    OUT.write_text('// Сгенерировано src/escape.py\nwindow.ESCAPE = '
                   + json.dumps(data, ensure_ascii=False, indent=1) + ';\n')
    print(f'записано {OUT}')


if __name__ == '__main__':
    main()
