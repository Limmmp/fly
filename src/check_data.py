"""Шаг 0: распаковать данные и убедиться, что индексы сходятся с channels.json."""
import time
from collections import Counter

import numpy as np

import flydata

t0 = time.time()
c = flydata.load()
print(f'загружено за {time.time() - t0:.1f} с')
m = c.meta
print(f"версия {m['version']}, порог {m['threshold']} синапсов")
print(f'нейронов {c.n:,}, рёбер {c.targets.size:,} (meta: {m["n_edges"]:,})')

# инварианты графа
assert c.indptr[-1] == m['n_edges']
assert c.targets.min() >= 0 and c.targets.max() < c.n
for i in np.random.default_rng(0).choice(c.n, 2000):
    row = c.targets[c.indptr[i]:c.indptr[i + 1]]
    assert np.all(np.diff(row) > 0), f'строка {i} не отсортирована'
print(f'цели в диапазоне, строки строго возрастают; синапсов на ребро {c.nsyn.min()}..{c.nsyn.max()}, '
      f'всего {int(c.nsyn.sum()):,}')
has_out = np.diff(c.indptr) > 0
print(f'нейронов с выходами {has_out.sum():,}, возбуждающих {c.excitatory.sum():,}')

# знак против нейромедиатора (закон Дейла): ACh/моноамины +, GABA/Glu/His -
nt = c.labels['top_nt']
print('\nзнак по top_nt (только нейроны с выходами):')
for name in sorted(set(nt[has_out])):
    k = has_out & (nt == name)
    print(f'  {name:<15} {k.sum():>7,}  возбуждающих {100 * c.excitatory[k].mean():5.1f}%')

# сверка с channels.json
ch = flydata.load_channels()
print('\nканалы channels.json -> cell_type по нашим меткам:')
for name, d in ch['channels'].items():
    types = Counter(c.labels['cell_type'][d['all']])
    print(f"  {name:<10} {d['all']}  -> {dict(types)}  (заявлено {d['types']})")
bad = []
for t, idx in ch['features'].items():
    got = set(c.labels['cell_type'][idx])
    full = set(c.where('cell_type', t).tolist())
    if got != {t} or set(idx) != full:
        bad.append((t, idx, got, sorted(full)))
print(f"\nfeatures: {len(ch['features']) - len(bad)}/{len(ch['features'])} типов совпали полностью "
      f'(индексы = все нейроны этого cell_type)')
for b in bad:
    print('  расхождение:', b)

# DNp01 подробно
for i in ch['channels']['escape']['all']:
    print(f"\nDNp01 #{i}: root_id {c.root_ids[i]}, сторона {c.label('side', i)}, "
          f"{c.label('top_nt', i)}, выходов {c.indptr[i + 1] - c.indptr[i]}, "
          f'позиция {np.round(c.pos[i], 1)} мкм')
