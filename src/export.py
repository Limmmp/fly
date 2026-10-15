"""Шаг 4: экспорт растров для стенда в data/export/fly_data.js.

Формат — обычный JS-файл `window.FLY_DATA = {...}`: стенд открывается
двойным кликом (file://), а fetch() JSON там браузер не разрешит.

Что внутри:
  background   — все 138 639 нейронов в 3D (x вправо, y вниз, z вглубь),
                 base64 от Uint16Array [x0, y0, z0, x1, ...] в сетке 0..GRID
  neurons      — нейроны, разрядившиеся хоть в одном сценарии:
                 координаты, группа-инструмент, тип клетки, роль
  edges        — все связи между ними: [пре, пост, синапсы, знак +1/-1]
  scenarios    — для каждого: точный растр (t в шагах 0.1 мс, локальный индекс),
                 счёт спайков по группам в окнах по 100 мс (для звука)
                 и спайки хоботка по окнам, итог outcome
"""
import base64
import json
from pathlib import Path

import numpy as np

import flydata

ROOT = Path(__file__).resolve().parent.parent
SIM = ROOT / 'data' / 'sim'
OUT = ROOT / 'data' / 'export'
SCENARIOS = ('sugar', 'bitter', 'water', 'sugar_lesion', 'bitter_lesion', 'water_lesion')
GRID = 4095          # разрешение сетки координат
WINDOW_MS = 100.0    # окно квантования для сонификации

# super_class -> инструмент
GROUPS = ('sensory', 'central', 'descending', 'motor')
GROUP_OF = {'sensory': 0, 'sensory_ascending': 0, 'descending': 2, 'motor': 3}  # остальное -> central


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    c = flydata.load()
    io = json.loads((ROOT / 'data' / 'inputs.json').read_text())
    summary = json.loads((SIM / 'summary.json').read_text())
    dt = summary['dt_ms']
    n_win = int(round(summary['t_ms'] / WINDOW_MS))

    # общий масштаб по всем трём осям
    xy = c.pos.astype(np.float64)
    lo = xy.min(0)
    scale = GRID / (xy.max(0) - lo).max()
    q = np.clip(np.round((xy - lo) * scale), 0, GRID).astype('<u2')
    size = (np.ceil((xy.max(0) - lo) * scale)).astype(int).tolist()

    sims = {s: np.load(SIM / f'{s}.npz') for s in SCENARIOS}
    active = np.unique(np.concatenate([d['spike_idx'] for d in sims.values()]
                                      + [d['stim'] for d in sims.values()]))
    local = {int(g): k for k, g in enumerate(active)}
    group = np.array([GROUP_OF.get(c.label('super_class', i), 1) for i in active])

    role = ['' for _ in active]
    for name, ids in io['inputs'].items():
        for i in ids:
            if i in local:
                role[local[i]] = name
    for i in io['outputs']['proboscis']:
        if i in local:
            role[local[i]] = 'proboscis'
    lesion = summary['lesion']['idx']
    role[local[lesion]] = 'lesion'

    neurons = {
        'id': active.tolist(),
        'root_id': [str(r) for r in c.root_ids[active]],
        'x': q[active, 0].tolist(), 'y': q[active, 1].tolist(), 'z': q[active, 2].tolist(),
        'group': group.tolist(),
        'type': [c.label('cell_type', i) for i in active],
        'side': [c.label('side', i) for i in active],
        'role': role,
    }

    # связи между активными нейронами — "провода" на карте
    is_act = np.zeros(c.n, bool); is_act[active] = True
    src = np.repeat(np.arange(c.n), np.diff(c.indptr))
    em = is_act[src] & is_act[c.targets]
    edges = [[local[int(a)], local[int(b)], int(k), 1 if c.excitatory[a] else -1]
             for a, b, k in zip(src[em], c.targets[em], c.nsyn[em])]

    prob_local = np.array([local[i] for i in io['outputs']['proboscis'] if i in local])
    sugar_prob = summary['scenarios']['sugar']['proboscis_spikes']
    scen = {}
    for name, d in sims.items():
        t, idx = d['spike_step'], d['spike_idx']
        li = np.array([local[int(i)] for i in idx], np.int32)
        win = np.minimum((t * dt // WINDOW_MS).astype(int), n_win - 1)
        counts = np.zeros((len(GROUPS), n_win), int)
        np.add.at(counts, (group[li], win), 1)
        is_prob = np.isin(li, prob_local)
        prob_win = np.bincount(win[is_prob], minlength=n_win)
        n_prob = int(is_prob.sum())
        # итог для табло: относительно чистого сахара
        outcome = 'eat' if n_prob >= 0.5 * sugar_prob else ('weak' if n_prob > 0 else 'no')
        s = summary['scenarios'][name]
        scen[name] = {
            't': t.astype(int).tolist(), 'n': li.tolist(),
            'stim': [local[int(i)] for i in d['stim']],
            'silenced': [local[int(i)] for i in d['silenced']],
            'group_counts': counts.tolist(),
            'proboscis_counts': prob_win.tolist(),
            'proboscis_spikes': n_prob,
            'proboscis_first_ms': s['proboscis_first_ms'],
            'active': s['active'], 'spikes': s['spikes'],
            'outcome': outcome,
        }

    attribution = (ROOT / 'data' / 'raw' / 'ATTRIBUTION.md').read_text()
    data = {
        'version': c.meta['version'], 'n_neurons': c.n, 'n_edges': c.meta['n_edges'],
        't_ms': summary['t_ms'], 'dt_ms': dt, 'window_ms': WINDOW_MS, 'rate_hz': summary['rate_hz'],
        'grid': GRID, 'size': size,
        'groups': list(GROUPS),
        'background': base64.b64encode(q.tobytes()).decode('ascii'),
        'neurons': neurons,
        'edges': edges,
        'lesion': {**summary['lesion'], 'local': local[lesion]},
        'scenarios': scen,
        'attribution': attribution,
    }
    path = OUT / 'fly_data.js'
    path.write_text('// Сгенерировано src/export.py. Данные: FlyWire 783, CC-BY 4.0.\n'
                    'window.FLY_DATA = ' + json.dumps(data, separators=(',', ':'), ensure_ascii=False) + ';\n')

    print(f'активных нейронов на карте: {len(active)}, связей между ними {len(edges)}, '
          f'фон: {c.n:,}, поле {size[0]}x{size[1]}x{size[2]}')
    print(f'{path.name}: {path.stat().st_size / 1e6:.2f} МБ')
    print(f"{'сценарий':<13} {'спайков':>7}  " + '  '.join(f'{g:>10}' for g in GROUPS) + '   хоботок по окнам 100 мс        итог')
    for name, s in scen.items():
        tot = np.array(s['group_counts']).sum(1)
        print(f"{name:<13} {len(s['t']):>7}  " + '  '.join(f'{x:>10}' for x in tot)
              + f"   {s['proboscis_counts']}  {s['outcome']}")


if __name__ == '__main__':
    main()
