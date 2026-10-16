"""Шаг 3: сценарии по 1 секунде на всём мозге, с поломкой и без.

Стимулы (все на одной частоте RPOI = 150 Гц — честное сравнение):
  sugar   сахар на хоботке          -> мотонейроны хоботка (ест)
  bitter  горькое                   -> хоботок молчит
  water   вода                      -> хоботок молчит
  loom    тень (детекторы LPLC2)    -> гигантское волокно DNp01 (взлёт)
  smell   запах фруктов (ORN DM1/2) -> нисходящие ходьбы и поворота (идёт к еде)
  touch   касание щетинок глаза     -> DNg84/DNg35 (чистится; интерпретация)

Для каждого стимула есть <стимул>_lesion — тот же прогон с одним
"сломанным" нейроном. Ключевой нейрон подбираем по данным: кандидаты —
активные нейроны на пути вход -> выход (не дальше 2 переходов от входа
и 2 переходов до выхода). Каждого выключаем на коротком прогоне;
побеждает тот, без которого выход затихает сильнее всего. Пуассонов поток
при одном seed одинаковый, так что сравнение парное.

Исключение — тень: выход и есть DNp01, поэтому ломаем само гигантское
волокно (оба нейрона). Без него муха взлетает медленным "длинным" способом
(von Reyn et al. 2014) — это видно по крыльям (DNp18 и др.).
Горькое и вода: выхода нет, ломаем тот же нейрон, что и для сахара, —
стенд объясняет, что он на другом пути.

Результат: data/sim/<сценарий>.npz и data/sim/summary.json
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

# стимул -> (вход, выход, на котором меряем поведение)
STIMULI = {
    'sugar': ('sugar', 'proboscis'),
    'bitter': ('bitter', 'proboscis'),
    'water': ('water', 'proboscis'),
    'loom': ('loom', 'escape'),
    'smell': ('smell', 'walk'),
    'touch': ('touch', 'groom'),
}
SCREENED = ('sugar', 'smell', 'touch')   # для них ключевой нейрон ищем перебором

_c = _w = None


def _init():
    global _c, _w
    _c = flydata.load()
    _w = lif.synaptic_weights(_c)


def _out_spikes(args):
    """Прогон с выключенными нейронами -> (выключенные, спайки выхода)."""
    silenced, stim, out, t_ms = args
    _, idx = lif.run(_c, _w, stim, t_ms=t_ms, silenced=silenced, seed=SEED)
    return silenced, int(np.isin(idx, out).sum())


def hops(c, start, reverse=False, max_hops=2):
    """Число переходов от множества start (или до него, если reverse)."""
    if reverse:
        src = np.repeat(np.arange(c.n), np.diff(c.indptr))
        order = np.argsort(c.targets, kind='stable')
        ptr = np.concatenate(([0], np.cumsum(np.bincount(c.targets, minlength=c.n))))
        nbr = src[order]
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


def screen_lesion(c, w, pool, name, stim, out):
    """Перебор кандидатов: чей выключение сильнее всего глушит выход."""
    _, idx = lif.run(c, w, stim, t_ms=T_MS, seed=SEED)
    rates = lif.rates_hz(c, idx, T_MS)
    d_in, d_out = hops(c, stim), hops(c, out, reverse=True)
    excluded = set(stim) | set(out)
    cand = [int(i) for i in np.flatnonzero((rates > 0) & (d_in >= 1) & (d_out >= 1)) if i not in excluded]
    cand = sorted(cand, key=lambda i: -rates[i])[:N_CANDIDATES]
    t0 = time.time()
    res = pool.map(_out_spikes, [([], stim, out, SCREEN_MS)] + [([i], stim, out, SCREEN_MS) for i in cand])
    base = res[0][1]
    ranked = sorted(((s[0], n) for s, n in res[1:]), key=lambda x: x[1])
    print(f'{name}: {len(cand)} кандидатов, {time.time() - t0:.0f} с; без поломки выход {base} спайков за {SCREEN_MS:.0f} мс')
    for i, n in ranked[:5]:
        print(f"    выключен {c.label('cell_type', i) or '?':<12} #{i:<6} {c.label('side', i):<6} "
              f"-> {n:>4} ({100 * (n - base) / max(base, 1):+.0f}%)")
    return [int(ranked[0][0])]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    io = json.loads((ROOT / 'data' / 'inputs.json').read_text())
    _init()
    c, w = _c, _w

    lesions = {}
    with Pool(4, initializer=_init) as pool:
        for name in SCREENED:
            inp, outk = STIMULI[name]
            lesions[name] = screen_lesion(c, w, pool, name, io['inputs'][inp], io['outputs'][outk])
    lesions['loom'] = io['outputs']['escape']          # гигантское волокно DNp01, оба
    lesions['bitter'] = lesions['water'] = lesions['sugar']

    summary = {'t_ms': T_MS, 'dt_ms': lif.DT, 'rate_hz': lif.RPOI, 'seed': SEED,
               'lesions': {}, 'scenarios': {}}
    for name, ids in lesions.items():
        summary['lesions'][name] = [{'idx': i, 'root_id': int(c.root_ids[i]),
                                     'cell_type': c.label('cell_type', i), 'side': c.label('side', i),
                                     'top_nt': c.label('top_nt', i)} for i in ids]
    print()
    for name, (inp, outk) in STIMULI.items():
        for les in (False, True):
            key = f'{name}_lesion' if les else name
            stim = io['inputs'][inp]
            silenced = lesions[name] if les else []
            steps, idx = lif.run(c, w, stim, t_ms=T_MS, silenced=silenced, seed=SEED)
            np.savez_compressed(OUT / f'{key}.npz', spike_step=steps, spike_idx=idx,
                                stim=np.asarray(stim, np.int32), silenced=np.asarray(silenced, np.int32))
            r = lif.rates_hz(c, idx, T_MS)
            out = io['outputs'][outk]
            is_out = np.isin(idx, out)
            s = summary['scenarios'][key] = {
                'stimulus': name, 'output': outk, 'lesion': les,
                'spikes': int(idx.size), 'active': int((r > 0).sum()),
                'output_spikes': int(is_out.sum()),
                'output_first_ms': float(steps[is_out].min() * lif.DT) if is_out.any() else None,
                # крылья — для тени: без DNp01 муха взлетает "длинным" способом
                'wing_hz': float(r[[35121, 85369]].mean()),
            }
            print(f"{key:<15} спайков {s['spikes']:>6,}  активных {s['active']:>5}  "
                  f"выход[{outk}] {s['output_spikes']:>5}  первый {s['output_first_ms']} мс  крылья(DNp18) {s['wing_hz']:.0f} Гц")
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f'\nзаписано в {OUT}')


if __name__ == '__main__':
    main()
