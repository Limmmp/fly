"""LIF-модель мозга дрозофилы по Shiu et al. 2024, на NumPy.

Каждый нейрон — две переменные:
    dv/dt = (g - (v - V0)) / TMBR      мембранный потенциал, мВ
    dg/dt = -g / TAU                   синаптический ток (в мВ)
Между спайками система линейна, поэтому шаг считаем точно (замкнутая форма):
    v' = V0 + (v - V0)·e^(-dt/TMBR) + g·K,   K = TAU/(TAU-TMBR)·(e^(-dt/TAU) - e^(-dt/TMBR))
    g' = g·e^(-dt/TAU)
Результат не зависит от шага интегрирования, кроме дискретизации времени спайков.

Спайк: v > VTH -> v = VRST, g = 0, рефрактерность TRFC (v и g заморожены).
Через TDLY спайк добавляет к g каждого постсинаптического нейрона
WSYN · число_синапсов · знак(пресинаптический).
Сенсоры: пуассоновский поток RPOI, каждый удар добавляет к v WSYN·FPOI
(68.75 мВ — гарантированный спайк, если нейрон не в рефрактерности).
Базовой активности нет: без стимула сеть молчит.
"""
import numpy as np

V0 = VRST = -52.0
VTH = -45.0
TMBR, TAU = 20.0, 5.0
TRFC, TDLY = 2.2, 1.8
WSYN = 0.275
DT = 0.1
RPOI, FPOI = 150.0, 250.0

DECAY_V = np.exp(-DT / TMBR)
DECAY_G = np.exp(-DT / TAU)
COUPLE = TAU / (TAU - TMBR) * (DECAY_G - DECAY_V)
REFRACT_STEPS = int(round(TRFC / DT))
DELAY_STEPS = int(round(TDLY / DT))


def synaptic_weights(conn):
    """Вес ребра в мВ: WSYN · синапсы · (+1 / -1 по знаку пресинаптического нейрона)."""
    sign = np.where(conn.excitatory, 1.0, -1.0)
    row_of_edge = np.repeat(np.arange(conn.n), np.diff(conn.indptr))
    return (WSYN * conn.nsyn * sign[row_of_edge]).astype(np.float32)


def run(conn, weights, stim, t_ms=1000.0, rate=RPOI, silenced=(), seed=0):
    """Прогон сети. Возвращает (spike_step, spike_idx) — растр всех спайков.

    stim     — индексы сенсорных нейронов под пуассоновой стимуляцией
    silenced — индексы "сломанных" нейронов: никогда не разряжаются
    """
    n = conn.n
    indptr, targets = conn.indptr, conn.targets
    rng = np.random.default_rng(seed)
    steps = int(round(t_ms / DT))
    stim = np.asarray(stim, np.int64)
    p_kick = rate * DT / 1000.0
    kick = WSYN * FPOI

    v = np.full(n, V0, np.float32)
    g = np.zeros(n, np.float32)
    refract = np.zeros(n, np.int16)
    alive = np.ones(n, bool)
    alive[list(silenced)] = False
    # кольцевой буфер задержки: какие нейроны разрядились DELAY_STEPS шагов назад
    pending = [np.empty(0, np.int64) for _ in range(DELAY_STEPS)]
    out_steps, out_idx = [], []

    for s in range(steps):
        slot = s % DELAY_STEPS
        arrived = pending[slot]
        if arrived.size:
            lo, hi = indptr[arrived], indptr[arrived + 1]
            edges = np.concatenate([np.arange(a, b) for a, b in zip(lo, hi)])
            if edges.size:
                g += np.bincount(targets[edges], weights=weights[edges], minlength=n).astype(np.float32)

        if stim.size:
            hit = stim[rng.random(stim.size) < p_kick]
            v[hit] += kick

        free = refract <= 0
        v = np.where(free, V0 + (v - V0) * DECAY_V + COUPLE * g, v)
        g = np.where(free, g * DECAY_G, g)
        refract[~free] -= 1

        fired = np.flatnonzero((v > VTH) & free & alive)
        if fired.size:
            v[fired] = VRST
            g[fired] = 0.0
            refract[fired] = REFRACT_STEPS
            out_steps.append(np.full(fired.size, s, np.int32))
            out_idx.append(fired.astype(np.int32))
        # у сломанного нейрона потенциал не копится бесконечно
        v[~alive] = np.minimum(v[~alive], VTH)
        pending[slot] = fired

    if not out_idx:
        return np.empty(0, np.int32), np.empty(0, np.int32)
    return np.concatenate(out_steps), np.concatenate(out_idx)


def rates_hz(conn, spike_idx, t_ms):
    return np.bincount(spike_idx, minlength=conn.n) / (t_ms / 1000.0)
