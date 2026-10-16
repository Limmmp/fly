"""Шаг 4: экспорт для стенда в data/export/fly_data.js.

Формат — обычный JS-файл `window.FLY_DATA = {...}`: стенд открывается
двойным кликом (file://), а fetch() JSON там браузер не разрешит.
Большие массивы — base64 от типизированных массивов (little-endian).

Что внутри:
  background   все 138 639 нейронов: Uint16 [x, y, z] в сетке 0..GRID
  web          "клубок": для каждого нейрона его WEB_K самых сильных выходных
               связей, Uint32 [цель] (0xFFFFFFFF — нет), и Uint16 тип клетки
               для цвета. Это связи из коннектома, а не форма отростков.
  neurons      нейроны, разрядившиеся хоть в одном сценарии: координаты,
               группа, тип клетки, роль
  edges        связи между ними от EDGE_MIN_SYN синапсов: [пре, пост, синапсы, знак]
  scenarios    растр (t — Uint16 шаги по 0.1 мс, n — Uint16 локальный индекс),
               счёт спайков по группам в окнах по 100 мс, итог
"""
import base64
import json
from pathlib import Path

import numpy as np

import flydata

ROOT = Path(__file__).resolve().parent.parent
SIM = ROOT / 'data' / 'sim'
OUT = ROOT / 'data' / 'export'
GRID = 4095          # разрешение сетки координат
WINDOW_MS = 100.0    # окно квантования для сонификации
WEB_K = 2            # сколько связей на нейрон в "клубке"
EDGE_MIN_SYN = 15    # связи цепи на карте — только толстые
EDGE_MIN_SYN_WIDE = 40  # ...а в огромной цепи запаха — только самые толстые

# super_class -> группа (цвет и инструмент)
GROUPS = ('sensory', 'central', 'descending', 'motor')
GROUP_OF = {'sensory': 0, 'sensory_ascending': 0, 'descending': 2, 'motor': 3}  # остальное -> central


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode('ascii')


def strongest_targets(c, k):
    """Для каждого нейрона k самых сильных выходных связей (по числу синапсов)."""
    out = np.full((c.n, k), 0xFFFFFFFF, np.uint32)
    for i in range(c.n):
        a, b = c.indptr[i], c.indptr[i + 1]
        if a == b:
            continue
        top = np.argsort(-c.nsyn[a:b], kind='stable')[:k]
        out[i, :len(top)] = c.targets[a:b][top]
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    c = flydata.load()
    io = json.loads((ROOT / 'data' / 'inputs.json').read_text())
    summary = json.loads((SIM / 'summary.json').read_text())
    dt = summary['dt_ms']
    n_win = int(round(summary['t_ms'] / WINDOW_MS))

    # общий масштаб по всем трём осям
    xyz = c.pos.astype(np.float64)
    lo = xyz.min(0)
    scale = GRID / (xyz.max(0) - lo).max()
    q = np.clip(np.round((xyz - lo) * scale), 0, GRID).astype('<u2')
    size = (np.ceil((xyz.max(0) - lo) * scale)).astype(int).tolist()

    names = list(summary['scenarios'])
    sims = {s: np.load(SIM / f'{s}.npz') for s in names}
    active = np.unique(np.concatenate([d['spike_idx'] for d in sims.values()]
                                      + [d['stim'] for d in sims.values()]))
    assert len(active) < 65535
    local = {int(g): k for k, g in enumerate(active)}
    lut = np.full(c.n, -1, np.int64); lut[active] = np.arange(len(active))
    group = np.array([GROUP_OF.get(c.label('super_class', i), 1) for i in active])

    role = ['' for _ in active]
    for name, ids in io['inputs'].items():
        for i in ids:
            if i in local:
                role[local[i]] = name
    for name, ids in io['outputs'].items():
        if name == 'mn9':
            continue
        for i in ids:
            if i in local:
                role[local[i]] = name

    neurons = {
        'x': q[active, 0].tolist(), 'y': q[active, 1].tolist(), 'z': q[active, 2].tolist(),
        'group': group.tolist(),
        'type': [c.label('cell_type', i) for i in active],
        'role': role,
    }

    # толстые связи между активными нейронами — нити цепи
    is_act = np.zeros(c.n, bool); is_act[active] = True
    src = np.repeat(np.arange(c.n), np.diff(c.indptr))
    # запах разбегается по ~8000 нейронам; его нити — только самые толстые
    small = np.zeros(c.n, bool)
    for name, d in sims.items():
        if summary['scenarios'][name]['stimulus'] != 'smell':
            small[d['spike_idx']] = True; small[d['stim']] = True
    thick = np.where(small[src] & small[c.targets], EDGE_MIN_SYN, EDGE_MIN_SYN_WIDE)
    em = is_act[src] & is_act[c.targets] & (c.nsyn >= thick)
    edges = np.stack([lut[src[em]], lut[c.targets[em]], c.nsyn[em],
                      np.where(c.excitatory[src[em]], 1, -1)], 1).tolist()

    # итог: доля выхода от того же стимула без поломки
    scen = {}
    for name in names:
        d, s = sims[name], summary['scenarios'][name]
        t, idx = d['spike_step'], d['spike_idx']
        li = lut[idx]
        win = np.minimum((t * dt // WINDOW_MS).astype(int), n_win - 1)
        counts = np.zeros((len(GROUPS), n_win), int)
        np.add.at(counts, (group[li], win), 1)
        out_ids = io['outputs'][s['output']]
        is_out = np.isin(idx, out_ids)
        base = summary['scenarios'][s['stimulus']]['output_spikes']
        n_out = int(is_out.sum())
        level = 'full' if base and n_out >= 0.5 * base else ('weak' if n_out > 0 else 'none')
        # тень без гигантского волокна: DNp01 молчит, но параллельные нейроны тревоги
        # (DNp04, DNp103) работают — муха взлетает медленным "длинным" способом
        if s['stimulus'] == 'loom' and level == 'none':
            parallel = np.isin(idx, [int(i) for t in ('DNp04', 'DNp103') for i in c.where('cell_type', t)])
            if parallel.sum() > 0:
                level = 'slow'
        scen[name] = {
            'stimulus': s['stimulus'], 'output': s['output'], 'lesion': s['lesion'],
            't': b64(t.astype('<u2')), 'n': b64(li.astype('<u2')), 'count': int(t.size),
            'stim': [local[int(i)] for i in d['stim']],
            'silenced': [local[int(i)] for i in d['silenced']],
            'output_local': [local[i] for i in out_ids if i in local],
            'group_counts': counts.tolist(),
            'output_counts': np.bincount(win[is_out], minlength=n_win).tolist(),
            'output_spikes': n_out, 'output_first_ms': s['output_first_ms'],
            'active': s['active'], 'spikes': s['spikes'],
            'level': level,
        }

    lesions = {k: [{**x, 'local': local.get(x['idx'])} for x in v] for k, v in summary['lesions'].items()}

    web = strongest_targets(c, WEB_K)
    types = np.asarray(c.label_codes['cell_type'], '<u2')
    attribution = (ROOT / 'data' / 'raw' / 'ATTRIBUTION.md').read_text()
    data = {
        'version': c.meta['version'], 'n_neurons': c.n, 'n_edges': c.meta['n_edges'],
        't_ms': summary['t_ms'], 'dt_ms': dt, 'window_ms': WINDOW_MS, 'rate_hz': summary['rate_hz'],
        'grid': GRID, 'size': size, 'groups': list(GROUPS),
        'background': b64(q),
        'web': {'k': WEB_K, 'targets': b64(web.astype('<u4')), 'types': b64(types),
                'unknown_type': c.meta['dicts']['cell_type'].index('unknown')},
        'neurons': neurons,
        'edges': edges,
        'lesions': lesions,
        'scenarios': scen,
        'attribution': attribution,
    }
    path = OUT / 'fly_data.js'
    path.write_text('// Сгенерировано src/export.py. Данные: FlyWire 783, CC-BY 4.0.\n'
                    'window.FLY_DATA = ' + json.dumps(data, separators=(',', ':'), ensure_ascii=False) + ';\n')

    print(f'активных нейронов: {len(active)}, нитей цепи: {len(edges)}, '
          f'нитей клубка: {int((web != 0xFFFFFFFF).sum()):,}, поле {size[0]}x{size[1]}x{size[2]}')
    print(f'{path.name}: {path.stat().st_size / 1e6:.2f} МБ')
    for name, s in scen.items():
        print(f"{name:<15} спайков {s['count']:>7,}  выход[{s['output']}] {s['output_spikes']:>5}  итог {s['level']}")


if __name__ == '__main__':
    main()
