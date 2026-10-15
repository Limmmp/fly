"""Шаг 3: четыре сценария по 1 секунде на всём мозге.

  sugar         — сахар на хоботке
  bitter        — горькое
  water         — вода
  sugar_lesion  — сахар, но один ключевой нейрон выключен
  bitter_lesion, water_lesion — то же для горького и воды (для тумблера на стенде)

Ключевой нейрон подбираем по данным: кандидаты — нейроны, активные при
сахаре и стоящие на пути сахар -> хоботок (не дальше 2 переходов от
сенсоров и с выходом на хоботок не дальше 2 переходов). Каждого по очереди
выключаем на коротком прогоне и смотрим, насколько упало число спайков
мотонейронов хоботка. Побеждает тот, без которого хоботок затихает сильнее.
Пуассонов поток у всех прогонов с одним seed одинаковый, так что сравнение
парное: разница только в выключенном нейроне.

Все стимулы на одной частоте RPOI = 150 Гц — честное сравнение.
Результат: data/sim/<сценарий>.npz (spike_step, spike_idx) и data/sim/summary.json
"""
import json
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np

import flydata
import lif

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'sim'
T_MS = 1000.0
SCREEN_MS = 400.0
SEED = 1
N_CANDIDATES = 40

_c = _w = None


def _init():
    global _c, _w
    _c = flydata.load()
    _w = lif.synaptic_weights(_c)


def _proboscis_spikes(args):
    """Прогон сахара с выключенным нейроном -> (нейрон, спайки хоботка)."""
    silenced, stim, prob, t_ms = args
    _, idx = lif.run(_c, _w, stim, t_ms=t_ms, silenced=silenced, seed=SEED)
    return silenced, int(np.isin(idx, prob).sum())


def hops(c, start, reverse=False, max_hops=2):
    """Число переходов от множества start (или до него, если reverse)."""
    if reverse:
        # обратный граф: для каждой цели — её источники
        src = np.repeat(np.arange(c.n), np.diff(c.indptr))
        order = np.argsort(c.targets, kind='stable')
        rptr = np.concatenate(([0], np.cumsum(np.bincount(c.targets, minlength=c.n))))
        nbr, ptr = src[order], rptr
    else:
        nbr, ptr = c.targets, c.indptr
    dist = np.full(c.n, -1)
    dist[start] = 0
    front = np.asarray(start)
    for h in range(1, max_hops + 1):
        nxt = np.unique(np.concatenate([nbr[ptr[i]:ptr[i + 1]] for i in front]))
        nxt = nxt[dist[nxt] < 0]
        dist[nxt] = h
        front = nxt
    return dist


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    io = json.loads((ROOT / 'data' / 'inputs.json').read_text())
    inputs, prob = io['inputs'], io['outputs']['proboscis']
    _init()
    c, w = _c, _w

    # базовый сахар
    t0 = time.time()
    steps, idx = lif.run(c, w, inputs['sugar'], t_ms=T_MS, seed=SEED)
    rates = lif.rates_hz(c, idx, T_MS)
    print(f'sugar: {idx.size:,} спайков, {time.time() - t0:.0f} с')

    # кандидаты на поломку
    d_in = hops(c, inputs['sugar'])
    d_out = hops(c, prob, reverse=True)
    excluded = set(inputs['sugar']) | set(prob)
    cand = [i for i in np.flatnonzero((rates > 0) & (d_in >= 1) & (d_out >= 1))
            if i not in excluded]
    cand = sorted(cand, key=lambda i: -rates[i])[:N_CANDIDATES]
    print(f'кандидатов на поломку: {len(cand)} (активны, на пути сахар -> хоботок)')

    # отбор: короткие прогоны параллельно
    t0 = time.time()
    jobs = [([], inputs['sugar'], prob, SCREEN_MS)] + [([i], inputs['sugar'], prob, SCREEN_MS) for i in cand]
    with Pool(4, initializer=_init) as pool:
        res = pool.map(_proboscis_spikes, jobs)
    base = res[0][1]
    screen = sorted(((s[0], n) for s, n in res[1:]), key=lambda x: x[1])
    print(f'отбор за {time.time() - t0:.0f} с; без поломки хоботок даёт {base} спайков за {SCREEN_MS:.0f} мс')
    for i, n in screen[:10]:
        print(f"  выключен {c.label('cell_type', i) or '?':<12} #{i:<6} {c.label('side', i):<6} "
              f"{c.label('top_nt', i):<14} -> {n:>4} спайков ({100 * (n - base) / max(base, 1):+.0f}%)")
    key = int(screen[0][0])

    # четыре сценария по секунде
    scen = {
        'sugar': (inputs['sugar'], []),
        'bitter': (inputs['bitter'], []),
        'water': (inputs['water'], []),
        'sugar_lesion': (inputs['sugar'], [key]),
        'bitter_lesion': (inputs['bitter'], [key]),
        'water_lesion': (inputs['water'], [key]),
    }
    summary = {'t_ms': T_MS, 'dt_ms': lif.DT, 'rate_hz': lif.RPOI, 'seed': SEED,
               'lesion': {'idx': key, 'root_id': int(c.root_ids[key]),
                          'cell_type': c.label('cell_type', key), 'side': c.label('side', key),
                          'top_nt': c.label('top_nt', key)},
               'scenarios': {}}
    print()
    for name, (stim, silenced) in scen.items():
        steps, idx = lif.run(c, w, stim, t_ms=T_MS, silenced=silenced, seed=SEED)
        np.savez_compressed(OUT / f'{name}.npz', spike_step=steps, spike_idx=idx,
                            stim=np.asarray(stim, np.int32), silenced=np.asarray(silenced, np.int32))
        r = lif.rates_hz(c, idx, T_MS)
        n_prob = int(np.isin(idx, prob).sum())
        first = steps[np.isin(idx, prob)]
        summary['scenarios'][name] = {
            'spikes': int(idx.size), 'active': int((r > 0).sum()),
            'proboscis_spikes': n_prob,
            'proboscis_first_ms': float(first.min() * lif.DT) if first.size else None,
            'mn9_hz': [float(x) for x in r[io['outputs']['mn9']]],
        }
        s = summary['scenarios'][name]
        print(f"{name:<13} спайков {s['spikes']:>6,}  активных {s['active']:>4}  "
              f"хоботок {n_prob:>4} спайков  MN9 {s['mn9_hz']} Гц  первый {s['proboscis_first_ms']} мс")
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f'\nзаписано в {OUT}')


if __name__ == '__main__':
    main()
