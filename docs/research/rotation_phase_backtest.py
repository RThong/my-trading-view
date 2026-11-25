# 高切低 → 通杀 → 见底 回测(规格见 docs/rotation-phase-handoff.md)。研究用,不是线上实现。
# 跑法: uv run --no-project --with matplotlib --with pandas python rotation_phase_backtest.py <数据目录> <输出.png>
# 数据目录需含:
#   QQQ.json / XLP.json   = GET localhost:3000/api/yahoo/history/<代码> 的原样响应({points:[{date,close}]})
#   HYOAS.json            = /api/regime 的 hyOas 序列,转成 {points:[{date,close}]}
#   VIX.csv / VIX3M.csv   = Cboe 官网 https://cdn.cboe.com/api/global/us_indices/daily_prices/{VIX,VIX3M}_History.csv
# 2026-11-26 semantic-garden 会话写成,验收表即该日的运行结果。
import json, sys, pandas as pd
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
D, OUT = sys.argv[1], sys.argv[2]
plt.rcParams['font.family'] = ['Heiti TC']; plt.rcParams['axes.unicode_minus'] = False

def px(t):
    p = json.load(open(f'{D}/{t}.json'))['points']
    s = pd.Series({x['date']: x['close'] for x in p}); s.index = pd.to_datetime(s.index); return s.sort_index()
def cboe(f):
    v = pd.read_csv(f'{D}/{f}'); v.index = pd.to_datetime(v['DATE']); return v['CLOSE']
df = pd.concat({'Q': px('QQQ'), 'X': px('XLP')}, axis=1, sort=True)
df['V'] = cboe('VIX.csv'); df['M'] = cboe('VIX3M.csv')
df['H'] = px('HYOAS')
df['H'] = df['H'].ffill()
df = df.dropna(subset=['Q', 'X', 'V'])
Q, X, V = df.Q, df.X, df.V
# 参数(与回复里的规则表一一对应)
P = dict(rot_q=-0.05, rot_x=-0.02, rot_xup=0.02, rot_rel=0.10, kill_x=-0.05, kill_v=25,
         bot_v=30, min_p1=20, hy_max=6.0, bot_vpk=0.90, end_up=0.10, end_v=25, reset_q=-0.03, hold=120)
def rsi(x, n=14):
    d = x.diff(); u = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + u / dn)
Wk = Q.resample('W-FRI').last(); Wr = rsi(Wk)
Wm = Wk.ewm(span=12, adjust=False).mean() - Wk.ewm(span=26, adjust=False).mean()
div_weeks = set()
piv = [t for i, t in enumerate(Wk.index[2:-2], 2) if Wk.iloc[i] == Wk.iloc[i - 2: i + 3].min()]
for k, t in enumerate(piv):
    prev = [u for u in piv[:k] if (t - u).days <= 365 and Wk[u] > Wk[t]]
    if prev and Wr[t] > Wr[prev[-1]] and Wm[t] > Wm[prev[-1]]: div_weeks.add(t)
def wk_div(day):   # 底候选所在周(±1 周)出现周线 RSI 与 MACD 线同时背离
    w = day + pd.offsets.Week(weekday=4) if day.weekday() != 4 else day
    return any(abs((w - x).days) <= 7 for x in div_weeks)
Dm = Q.ewm(span=12, adjust=False).mean() - Q.ewm(span=26, adjust=False).mean(); Dr = rsi(Q)
dpiv = [t for i, t in enumerate(Q.index[5:-5], 5) if Q.iloc[i] == Q.iloc[i - 5: i + 6].min()]
day_div = set()
for k, t in enumerate(dpiv):
    prev = [u for u in dpiv[:k] if (t - u).days <= 120 and Q[u] > Q[t]]
    if prev and (Dr[t] > Dr[prev[-1]] or Dm[t] > Dm[prev[-1]]): day_div.add(t)
qdd = Q / Q.rolling(250, min_periods=60).max() - 1
xdd60 = X / X.rolling(60).max() - 1
x60 = X / X.shift(60) - 1
rel60 = (X / Q) / (X / Q).shift(60) - 1

state, cur, eps, st = '正常', {}, [], []
cool_until = None
last_end = df.index[0]
for i, t in enumerate(df.index):
    if i >= 60:
        if state == '正常':
            if qdd[t] <= P['rot_q'] and xdd60[t] >= P['rot_x'] and x60[t] >= P['rot_xup'] and rel60[t] >= P['rot_rel']:
                if df.H[t] >= P['hy_max']:
                    eps.append({'L1': Q.iloc[max(0, i - 250): i + 1].idxmax(), 'L1确认': t, '熊市预警': [], '结局': '不算·信用危机型'}); state = '冷却'; cool_until = t + pd.Timedelta(days=180)
                else:
                    state = '高切低'; cur = {'L1': Q.iloc[max(0, i - 250): i + 1].idxmax(), 'L1确认': t, '熊市预警': []}
        elif state == '冷却':
            if t >= cool_until: state = '正常'
        elif state == '高切低':
            if V[t] >= 30: cur['熊市预警'].append(t)
            xpk = X.loc[max(cur['L1'], last_end): t].idxmax()
            if X[t] / X[xpk] - 1 <= P['kill_x'] and V[t] >= P['kill_v']:
                if len(df.loc[cur['L1']: xpk]) - 1 < P['min_p1']:   # 第一阶段太短 = 不是场内腾挪(2025 型)
                    eps.append({**cur, '结局': '不算·第一阶段太短'}); last_end = t; state, cur = '冷却', {}; cool_until = t + pd.Timedelta(days=60)
                else:
                    state = '通杀'; cur.update(L2=xpk, L2确认=t)
            elif qdd[t] > P['reset_q']:
                eps.append({**cur, '结局': '未通杀'}); state, cur = '正常', {}
        elif state == '通杀':
            if X[t] > X[cur['L2']]:
                state = '高切低'; cur.pop('L2'); cur.pop('L2确认')
            else:
                seg = df.loc[cur['L2']: t]
                # 底候选:VIX ≥30 且不低于通杀以来 VIX 最高的 90% 的那些天里,QQQ 最低的一天
                ok = seg[(seg.V >= P['bot_v']) & (seg.V >= P['bot_vpk'] * seg.V.cummax())]
                inv = (seg.V / seg.M).dropna()
                bear = len(inv) > 0 and (inv > 1).mean() < 0.25
                if bear: ok = ok[[wk_div(d) for d in ok.index]]
                if len(ok):
                    lo = ok.Q.idxmin()
                    if Q[t] / Q[lo] - 1 >= P['end_up'] and V[t] < P['end_v']:
                        state = '见底'; cur.update(L3=lo, L3确认=t)
        elif state == '见底':
            if Q[t] < Q[cur['L3']] and V[t] >= P['bot_v']:
                state = '通杀'; cur.pop('L3'); cur.pop('L3确认')
            elif qdd[t] > P['reset_q'] or (t - cur['L3确认']).days > P['hold']:
                eps.append({**cur, '结局': '走完'}); last_end = cur['L3']; state, cur = '正常', {}
    st.append(state)
if cur: eps.append({**cur, '结局': f'进行中·{state}'})
df['st'] = st

def kind(e):
    if 'L3' not in e: return ''
    r = (df.V / df.M).loc[e['L2']: e['L3']].dropna()
    return '' if r.empty else ('快速型' if (r > 1).mean() >= 0.25 else '熊市型')
def marks(e):
    a = e['L2']; b = e.get('L3', df.index[-1]) + pd.Timedelta(days=5)
    seg = df.loc[a:b]
    hold30 = list(seg.index[(seg.V >= 30) & (seg.V.shift() >= 30) & ~((seg.V.shift() >= 30) & (seg.V.shift(2) >= 30))])
    # A:VIX ≥30 的每一簇里 QQQ 最低那天,且该簇 VIX 峰 ≥ 通杀以来最高的 90%
    hi = seg[seg.V >= 30]; A = []
    if len(hi):
        grp = (hi.index.to_series().diff().dt.days > 7).cumsum()
        for _, g in hi.groupby(grp.values):
            if g.V.max() >= 0.9 * seg.V.loc[:g.index[-1]].max(): A.append(g.Q.idxmin())
    # B:日线 RSI 或 MACD 线底背离,且当周 VIX 最高 ≥30
    B = [t for t in sorted(day_div) if a <= t <= b and V.loc[t - pd.Timedelta(days=4): t].max() >= 30]
    return hold30, A, B
for e in eps:
    e['型'] = '磨底型' if e.get('熊市预警') else 'V形'
    if 'L2' in e: e['站稳30'], e['A'], e['B'] = marks(e)
rows = []
prev_pk = None
for e in eps:
    if e['结局'] in ('走完',) or e['结局'].startswith('进行中'):
        e['续段'] = prev_pk is not None and Q[e['L1']] < prev_pk[0] and (e['L1'] - prev_pk[1]).days < 730
        if not e['续段']: prev_pk = (Q[e['L1']], e.get('L3', e['L1']))
        else: prev_pk = (prev_pk[0], e.get('L3', e['L1']))
    rows.append(dict(QQQ高点=e['L1'].date(), 确认=e['L1确认'].date(),
        XLP高点=e['L2'].date() if 'L2' in e else '', 确认2=e['L2确认'].date() if 'L2' in e else '',
        底=e['L3'].date() if 'L3' in e else '', 确认3=e['L3确认'].date() if 'L3' in e else '',
        底日VIX=round(V[e['L3']], 1) if 'L3' in e else '', 类型=kind(e),
        一阶段VIX过30=len(e['熊市预警']), 分型=e['型'], A点=' '.join(str(x.date()) for x in e.get('A', [])), B点=' '.join(str(x.date()) for x in e.get('B', [])), 站稳30=' '.join(str(x.date()) for x in e.get('站稳30', [])), 续段='是' if e.get('续段') else '', 结局=e['结局']))
tab = pd.DataFrame(rows); pd.set_option('display.width', 250); print(tab.to_string(index=False))

# 作图:走完 / 进行中的每轮一列;上 = QQQ(右轴)+ XLP(左轴),下 = VIX
show = [e for e in eps if e['结局'] == '走完' or e['结局'].startswith('进行中')]
C = {'高切低': '#f59e0b', '通杀': '#ef4444', '见底': '#22c55e'}
import math
nc = 3; nr = math.ceil(len(show) / nc)
fig = plt.figure(figsize=(19, 6.2 * nr)); sfs = fig.subfigures(nr, nc).ravel()
for sf in sfs[len(show):]: sf.set_visible(False)
for k, e in enumerate(show):
    ax, vx = sfs[k].subplots(2, 1, gridspec_kw={'height_ratios': [3, 1.2]}, sharex=True)
    a = df.index.get_loc(e['L1']); end = e.get('L3', df.index[-1])
    b = min(len(df) - 1, df.index.get_loc(end) + 60)
    w = df.iloc[max(0, a - 30): b + 1]
    ax2 = ax.twinx()
    for x in (ax, vx):
        if 'L2' in e: x.axvspan(e['L1'], e['L2'], color=C['高切低'], alpha=0.15, lw=0)
        else: x.axvspan(e['L1'], df.index[-1], color=C['高切低'], alpha=0.15, lw=0)
        if 'L2' in e: x.axvspan(e['L2'], e.get('L3', df.index[-1]), color=C['通杀'], alpha=0.15, lw=0)
        for key in ('L1确认', 'L2确认', 'L3确认'):
            if key in e: x.axvline(e[key], color='#737373', lw=0.8, ls='--')
        for key, col in (('L1', '#2563eb'), ('L2', '#7c3aed'), ('L3', '#16a34a')):
            if key in e: x.axvline(e[key], color=col, lw=1.6)
    ax2.plot(w.index, w.Q, color='#2563eb', lw=1.3); ax.plot(w.index, w.X, color='#7c3aed', lw=1.3)
    ax2.tick_params(labelsize=7, colors='#2563eb'); ax.tick_params(labelsize=7, colors='#7c3aed')
    ax.grid(alpha=0.2)
    yr = f"{e['L1'].year}" + (f"–{str(end.year)[2:]}" if end.year != e['L1'].year else '')
    ax.set_title(f"{yr}{' 续段' if e.get('续段') else ''}  {e['型']}（一阶段 VIX{'过' if e['熊市预警'] else '未过'} 30）\n{e['结局']}", fontsize=10)
    for t in e.get('A', []): ax2.plot(t, Q[t], '^', color='#16a34a', ms=9, mec='k', mew=0.5)
    for t in e.get('B', []): ax2.plot(t, Q[t] * 0.97, '^', color='#f97316', ms=8, mec='k', mew=0.5)
    vx.plot(w.index, w.V, color='#404040', lw=1)
    for t in e.get('站稳30', []): vx.plot(t, V[t], 's', color='#b91c1c', ms=4)
    vx.axhline(30, color='#dc2626', lw=0.7, ls=':'); vx.axhline(25, color='#a3a3a3', lw=0.7, ls=':')
    for t in e['熊市预警']: vx.plot(t, V[t], 'v', color='#dc2626', ms=3)
    vx.tick_params(labelsize=7); vx.grid(alpha=0.2)
    for lab in vx.get_xticklabels(): lab.set_rotation(30)
fig.suptitle('高切低 → 通杀 → 见底（算法自动标注）  竖线：蓝 ① QQQ 高点 · 紫 ② XLP 高点 · 绿 ③ 底    底色：黄 高切低（①→②）· 红 通杀（②→③）   灰虚线 = 算法当天确认的日子\n▲绿 = A 阶段低点（VIX 冲顶）  ▲橙 = B 阶段低点（背离 + 当周 VIX≥30）  ■ = VIX 站稳 30  ▼ = 第一阶段 VIX ≥30', fontsize=13, y=1.0)
fig.savefig(OUT, dpi=90)
