"""Загрузка упакованного коннектома FlyWire 783 из data/raw/.

Данные: CC-BY 4.0, см. data/raw/ATTRIBUTION.md.
Формат файлов (все сжаты gzip):
  meta.json      — n_neurons, n_edges, bbox_lo, span, словари категорий
  conn.bin       — LEB128 varint подряд: N счётчиков исходящих рёбер,
                   E целей (дельта внутри строки, первая — абсолютная),
                   E весов (число синапсов, обрезано на 127)
  sign.bin       — 1 бит на нейрон (np.packbits, старший бит первым): 1 = возбуждающий
  labels.bin     — 5 массивов uint16 по N: super_class, cell_class, cell_type, top_nt, side
  pos.u16.bin    — N x 3 uint16, координата = bbox_lo + q/65535 * span (мкм)
  rootids.bin    — N x uint64, FlyWire root_id
"""
import gzip
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RAW_DIR = Path(__file__).resolve().parent.parent / 'data' / 'raw'
LABEL_FIELDS = ('super_class', 'cell_class', 'cell_type', 'top_nt', 'side')


def _read_gz(name, root=RAW_DIR):
    with gzip.open(Path(root) / name, 'rb') as f:
        return f.read()


def decode_leb128(buf):
    """Векторное декодирование потока беззнаковых LEB128 varint."""
    b = np.frombuffer(buf, dtype=np.uint8)
    is_last = (b & 0x80) == 0
    # первый байт каждого значения и номер значения для каждого байта
    starts = np.flatnonzero(np.concatenate(([True], is_last[:-1])))
    value_id = np.concatenate(([0], np.cumsum(is_last)[:-1]))
    byte_pos = np.arange(b.size) - starts[value_id]
    parts = (b & 0x7F).astype(np.int64) << (7 * byte_pos)
    return np.add.reduceat(parts, starts)


@dataclass
class Connectome:
    meta: dict
    indptr: np.ndarray     # (N+1,) int64 — начало строки CSR
    targets: np.ndarray    # (E,) int32 — постсинаптический индекс
    nsyn: np.ndarray       # (E,) int16 — число синапсов (1..127)
    excitatory: np.ndarray  # (N,) bool — знак пресинаптического нейрона
    labels: dict           # поле -> (N,) массив строк-категорий (через словарь)
    label_codes: dict      # поле -> (N,) uint16 коды
    pos: np.ndarray        # (N, 3) float32, мкм
    root_ids: np.ndarray   # (N,) uint64

    @property
    def n(self):
        return self.meta['n_neurons']

    def label(self, field, i):
        return self.meta['dicts'][field][self.label_codes[field][i]]

    def where(self, field, value):
        """Индексы нейронов, у которых поле равно значению."""
        names = self.meta['dicts'][field]
        if value not in names:
            return np.empty(0, np.int64)
        return np.flatnonzero(self.label_codes[field] == names.index(value))


def load(root=RAW_DIR):
    meta = json.loads(_read_gz('meta.json.gz', root))
    n, e = meta['n_neurons'], meta['n_edges']

    # граф
    vals = decode_leb128(_read_gz('conn.bin.gz', root))
    assert vals.size == n + 2 * e, f'ожидали {n + 2 * e} varint, получили {vals.size}'
    counts, delta, nsyn = vals[:n], vals[n:n + e], vals[n + e:]
    indptr = np.concatenate(([0], np.cumsum(counts)))
    # восстановление целей: накопленная сумма дельт, сбрасываемая в начале каждой строки
    csum = np.cumsum(delta)
    row_of_edge = np.repeat(np.arange(n), counts)
    first = indptr[:-1][counts > 0]
    row_base = np.zeros(n, np.int64)
    row_base[counts > 0] = csum[first] - delta[first]  # сумма дельт до начала строки
    targets = csum - row_base[row_of_edge]

    # знак
    bits = np.unpackbits(np.frombuffer(_read_gz('sign.bin.gz', root), np.uint8))[:n]

    # метки
    lab = np.frombuffer(_read_gz('labels.bin.gz', root), dtype='<u2').reshape(len(LABEL_FIELDS), n)
    label_codes = {f: lab[k] for k, f in enumerate(LABEL_FIELDS)}
    labels = {f: np.asarray(meta['dicts'][f], dtype=object)[label_codes[f]] for f in LABEL_FIELDS}

    # координаты
    q = np.frombuffer(_read_gz('pos.u16.bin.gz', root), dtype='<u2').reshape(n, 3)
    pos = (np.asarray(meta['bbox_lo']) + q / 65535.0 * meta['span']).astype(np.float32)

    root_ids = np.frombuffer(_read_gz('rootids.bin.gz', root), dtype='<u8')
    assert root_ids.size == n

    return Connectome(meta=meta, indptr=indptr, targets=targets.astype(np.int32),
                      nsyn=nsyn.astype(np.int16), excitatory=bits.astype(bool),
                      labels=labels, label_codes=label_codes, pos=pos, root_ids=root_ids)


def load_channels(root=RAW_DIR):
    return json.loads((Path(root) / 'channels.json').read_text())
