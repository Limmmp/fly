"""Шаг 2: проверка LIF на эталоне Шиу — сахар заставляет MN9 разряжаться."""
import json
import time
from pathlib import Path

import numpy as np

import flydata
import lif

T_MS = 1000.0
io = json.loads((Path(__file__).resolve().parent.parent / 'data' / 'inputs.json').read_text())
c = flydata.load()
w = lif.synaptic_weights(c)

# тишина без стимула
_, idx = lif.run(c, w, stim=[], t_ms=50.0)
print(f'без стимула, 50 мс: спайков {idx.size}')

for name in ('sugar', 'bitter', 'water'):
    t0 = time.time()
    steps, idx = lif.run(c, w, io['inputs'][name], t_ms=T_MS, seed=1)
    r = lif.rates_hz(c, idx, T_MS)
    stim = np.zeros(c.n, bool); stim[io['inputs'][name]] = True
    active = (r > 0) & ~stim
    mn9 = r[io['outputs']['mn9']]
    prob = r[io['outputs']['proboscis']]
    print(f'\n{name}: {time.time() - t0:.1f} с счёта, спайков {idx.size:,}, '
          f'активных (кроме сенсоров) {active.sum()}, сенсоры {r[stim].mean():.0f} Гц')
    print(f'  MN9 {np.round(mn9, 1)} Гц, хоботок всего {np.round(prob, 1)}')
    first = steps[np.isin(idx, io['outputs']['mn9'])]
    if first.size:
        print(f'  первый спайк MN9 через {first.min() * lif.DT:.1f} мс')
    top = np.argsort(-np.where(stim, 0, r))[:8]
    print('  самые активные:', ', '.join(f"{c.label('cell_type', i) or '?'}#{i} {r[i]:.0f}" for i in top))
