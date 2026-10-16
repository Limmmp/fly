"""Шаг 1: найти сенсорные входы (вкус, тень, запах, касание) и выходы.

Списки рецепторных нейронов взяты из Shiu et al. 2024 (Nature),
github.com/philshiu/Drosophila_brain_model, figures.ipynb — это root_id
версии FlyWire 630. Часть id в 783 сменилась; такие просто пропускаем
и печатаем, сколько нашли.

Замечание про стороны: Шиу пишет "right hemisphere", а в метках FlyWire
эти же нейроны помечены side=left — это разные соглашения, не ошибка.

Результат: data/inputs.json
"""
import json
from collections import Counter
from pathlib import Path

import numpy as np

import flydata

# лабеллярные GRN правого полушария (по Шиу), FlyWire 630
SHIU_GRN = {
    'sugar': [
        720575940624963786, 720575940630233916, 720575940637568838, 720575940638202345, 720575940617000768,
        720575940630797113, 720575940632889389, 720575940621754367, 720575940621502051, 720575940640649691,
        720575940639332736, 720575940616885538, 720575940639198653, 720575940620900446, 720575940617937543,
        720575940632425919, 720575940633143833, 720575940612670570, 720575940628853239, 720575940629176663,
        720575940611875570,
    ],
    'bitter': [
        720575940621778381, 720575940602353632, 720575940617094208, 720575940619197093, 720575940626287336,
        720575940618600651, 720575940627692048, 720575940630195909, 720575940646212996, 720575940610483162,
        720575940645743412, 720575940627578156, 720575940622298631, 720575940621008895, 720575940629146711,
        720575940610259370, 720575940610481370, 720575940619028208, 720575940614281266, 720575940613061118,
        720575940604027168,
    ],
    'water': [
        720575940612950568, 720575940631898285, 720575940606002609, 720575940612579053, 720575940622902535,
        720575940616177458, 720575940660292225, 720575940622486922, 720575940613786774, 720575940629852866,
        720575940625861168, 720575940613996959, 720575940617857694, 720575940644965399, 720575940625203504,
        720575940630553415, 720575940635172191, 720575940634796536,
    ],
}
# MN9 — главный выход в статье Шиу; в метках 783 он подписан как CB0701
MN9_ROOT = 720575940660219265

OUT = Path(__file__).resolve().parent.parent / 'data' / 'inputs.json'


def describe(c, idx):
    return dict(Counter(f"{c.label('cell_type', i)}/{c.label('side', i)}" for i in idx))


def main():
    c = flydata.load()
    ch = flydata.load_channels()
    by_root = {int(r): i for i, r in enumerate(c.root_ids)}

    inputs = {}
    for name, roots in SHIU_GRN.items():
        idx = sorted(by_root[r] for r in roots if r in by_root)
        inputs[name] = idx
        print(f'{name:<7} найдено {len(idx)}/{len(roots)}  типы {describe(c, idx)}')

    # перекрытие между группами недопустимо
    for a in inputs:
        for b in inputs:
            if a < b:
                assert not set(inputs[a]) & set(inputs[b]), f'{a} и {b} пересекаются'

    # другие чувства (типы клеток FlyWire; проверено в эксперименте, см. scenarios.py)
    by_type = lambda *ts: sorted(int(i) for t in ts for i in c.where('cell_type', t))
    inputs['loom'] = by_type('LPLC2')                  # детекторы приближения — тень
    inputs['smell'] = by_type('ORN_DM1', 'ORN_DM2')    # обонятельные нейроны запаха фруктов/уксуса
    inputs['touch'] = by_type('BM_InOm')               # щетинки между фасетками глаз: касание -> чистка головы
    for name in ('loom', 'smell', 'touch'):
        print(f'{name:<7} {len(inputs[name])} нейронов  типы {describe(c, inputs[name])}')

    mn9 = sorted(c.where('cell_type', 'CB0701').tolist())
    assert by_root[MN9_ROOT] in mn9
    proboscis = sorted(set(ch['channels']['proboscis']['all']) | set(mn9))
    print(f'MN9 = CB0701: {mn9}')
    print(f'proboscis (channels.json + MN9): {len(proboscis)} нейронов  {describe(c, proboscis)}')

    out = {
        'source': 'Shiu et al. 2024, github.com/philshiu/Drosophila_brain_model (FlyWire 630 root_id -> 783 index)',
        'inputs': inputs,
        'outputs': {
            'proboscis': proboscis,
            'mn9': mn9,
            'escape': ch['channels']['escape']['all'],
            'walk': sorted(set(ch['channels']['walk']['all']) | set(ch['channels']['turn']['all'])),
            # нисходящие, которые сильнее всего отвечают на касание щетинок;
            # что это команды чистки — интерпретация, не проверено
            'groom': by_type('DNg84', 'DNg35'),
        },
    }
    OUT.write_text(json.dumps(out, indent=1))
    print(f'записано {OUT}')


if __name__ == '__main__':
    main()
