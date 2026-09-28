//
// app.js - Логика дашборда SysDeck: графики, виджеты, темы и опрос сервера.
//


'use strict';

//
// Утилиты.
//
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
    // Прочитать значение:
    get(k, d) { try { const v = localStorage.getItem('sysdeck.' + k); return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } },

    // Записать значение (null - удалить):
    set(k, v) {
        try { if (v == null) localStorage.removeItem('sysdeck.' + k); else localStorage.setItem('sysdeck.' + k, JSON.stringify(v)); }
        catch { /* приватный режим */ }
    },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const osName = s => LANG === 'ru' ? s : String(s || '').replace(/сборка/, 'build');
const TOUCH = matchMedia('(pointer: coarse)').matches;
const DPR_MAX = TOUCH ? 1.5 : 2;  // На телефоне холсты с плотностью 1.5x: заметно легче для памяти.
const fmt = (v, d = 1) => (v == null || Number.isNaN(+v)) ? '—' : Number(v).toFixed(d);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad2 = n => String(n).padStart(2, '0');
const nowSec = () => Date.now() / 1000;
const toInput = ts => { const d = new Date(ts * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 19); };
const fromInput = v => new Date(v).getTime() / 1000;
const easeOut = k => 1 - Math.pow(1 - k, 3);


// Время для подписей (дд.мм чч:мм:сс):
function timeLabel(ms, withMs) {
    const d = new Date(ms);
    let s = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    if (withMs) s += '.' + String(d.getMilliseconds()).padStart(3, '0');
    return s;
}


// Длительность (дни, часы, минуты, секунды):
function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (d ? d + i18n('д ') : '') + (d || h ? `${pad2(h)}:` : '') + `${pad2(m)}:${pad2(s)}`;
}


// Размер в байтах в читаемом виде:
function fmtBytes(v, suffix = '') {
    if (v == null || Number.isNaN(+v)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    v = +v;
    while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(Math.abs(v) >= 100 || i === 0 ? 0 : 1)} ${u[i]}${suffix}`;
}
const fmtRate = v => fmtBytes(v, '/s');
const splitUnit = s => { const i = String(s).lastIndexOf(' '); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };


// Подпись шага группировки:
function stepLabel(b) {
    if (b < 1) return (b * 1000).toFixed(0) + i18n(' мс');
    if (b < 120) return (+b.toFixed(1)) + i18n(' с');
    if (b < 7200) return (b / 60).toFixed(0) + i18n(' мин');
    return (b / 3600).toFixed(0) + i18n(' ч');
}


// Цвет #rrggbb с прозрачностью:
function hexA(c, a) {
    let m = /^#([0-9a-f]{3})$/i.exec(c);
    if (m) c = '#' + m[1].split('').map(x => x + x).join('');
    m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : c;
}


// Цвет #rrggbb -> [r, g, b]:
function hexRgb(c) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
}


// Бинарный поиск по отсортированному массиву чисел:
function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
}

const ICON = {
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    together: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16l5-6 4 4 4-6 5 5"/><path d="M3 19l5-3 4 2 4-4 5 2" opacity=".45"/></svg>',
    split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l4-3 4 2 5-4 5 3"/><path d="M3 20l4-3 4 2 5-4 5 3"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l20 20M8.5 8.5A6 6 0 0 0 6 12v0a6 6 0 0 0 9.5 4.9M18 12V8h-6M9 2v4M15 2v6M12 18v4"/></svg>',
};
const FL_ICON = {
    grid: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    ups: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M12.5 7 10 12h4l-2.5 5"/>',
    pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    bat: '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M21.5 10.5v3"/><rect class="lvl" x="4.5" y="9" width="13" height="6" rx="1" fill="currentColor" stroke="none"/>',
};

//
// Темы.
//
const THEMES = {
    graphite: { name: i18n('Графит'), prev: ['#0a0c10', '#4c8dff', '#5ed3f3', '#94a3b8'] },
    mono: { name: i18n('Чёрно-белая'), prev: ['#000000', '#ffffff', '#8a8a8a', '#3a3a3a'] },
    midnight: { name: i18n('Полночь'), prev: ['#080b16', '#7c8cff', '#56cfe1', '#c084fc'] },
    nord: { name: i18n('Норд'), prev: ['#1b1f27', '#88c0d0', '#81a1c1', '#b48ead'] },
    forest: { name: i18n('Лес'), prev: ['#07100c', '#3ecf8e', '#5eead4', '#a3e635'] },
    amber: { name: i18n('Янтарь'), prev: ['#0e0b08', '#f59e0b', '#fcd34d', '#fb923c'] },
    rose: { name: i18n('Роза'), prev: ['#0f0a0d', '#fb7185', '#f9a8d4', '#c084fc'] },
    violet: { name: i18n('Фиалка'), prev: ['#0b0912', '#a78bfa', '#f0abfc', '#67e8f9'] },
    teal: { name: i18n('Бирюза'), prev: ['#061012', '#2dd4bf', '#38bdf8', '#a78bfa'] },
    light: { name: i18n('Светлая'), prev: ['#f2f3f7', '#0a84ff', '#32ade6', '#af52de'] },
};
let T = {};


// Прочитать цвета текущей темы из CSS:
function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue('--' + n).trim();
    T = {
        bg: g('bg'), text: g('text'), text2: g('text-2'), text3: g('text-3'), grid: g('grid'), grid2: g('grid2'), axis: g('axis'),
        surface: g('surface'), surface2: g('surface-2'), surface3: g('surface-3'), accent: g('accent'), good: g('good'), warn: g('warn'), bad: g('bad'),
        pal: [1, 2, 3, 4, 5, 6, 7, 8].map(i => g('c' + i)),
        font: "Inter, -apple-system, 'Segoe UI', sans-serif",
    };
    // Шкала «нагрузка -> цвет» для тепловых карт (101 значение, 0..100%):
    const stops = [[0, hexRgb(T.surface3)], [15, hexRgb(T.accent)], [60, hexRgb(T.warn)], [90, hexRgb(T.bad)], [100, hexRgb(T.bad)]];
    T.heat = [...Array(101)].map((_, v) => {
        let i = 0;
        while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
        const [a0, c0] = stops[i], [a1, c1] = stops[i + 1], k = clamp((v - a0) / (a1 - a0 || 1), 0, 1);
        return `rgb(${c0.map((x, j) => Math.round(x + (c1[j] - x) * k)).join(',')})`;
    });
}
const level = p => p >= 85 ? T.bad : p >= 60 ? T.warn : T.accent;
const levelInv = p => p < 25 ? T.bad : p < 50 ? T.warn : T.good;
const lvlCls = p => p >= 85 ? 'bad' : p >= 60 ? 'warn' : '';

//
// Описание графиков. У каждой серии есть группа g: в режиме «Раздельно»
// каждая группа рисуется на своей панели внутри того же виджета.
//
const AX = {
    pct: { f: v => fmt(v, 1) + ' %', ax: v => fmt(v, 0) + '%', min0: true, cap: 100, ypad: 4 },
    rate: { f: v => fmtRate(Math.abs(v)), ax: v => fmtBytes(Math.abs(v)), ypad: 2048, min0: true },
    temp: { f: v => fmt(v, 1) + ' °C', ax: v => fmt(v, 0) + '°', ypad: 2 },
    rpm: { f: v => fmt(v, 0) + ' rpm', ax: v => fmt(v, 0), min0: true, ypad: 60 },
    volt: { f: v => fmt(v, 1) + i18n(' В'), ax: v => fmt(v, 0), ypad: 2 },
    hz: { f: v => fmt(v, 2) + i18n(' Гц'), ax: v => fmt(v, 1), ypad: 0.2 },
    bv: { f: v => fmt(v, 2) + i18n(' В'), ax: v => fmt(v, 1), ypad: 0.2 },
    flags: { flags: true, f: v => v ? i18n('вкл') : i18n('выкл') },
    v3: { f: v => fmt(v, 3) + i18n(' В'), ax: v => fmt(v, 2), ypad: 0.01 },
    mhz: { f: v => fmt(v, 0) + i18n(' МГц'), ax: v => fmt(v, 0), ypad: 50, min0: true },
    watt: { f: v => fmt(v, 1) + i18n(' Вт'), ax: v => fmt(v, 0), ypad: 4, min0: true },
};
const FLAGS = [
    { key: 'on_battery', name: i18n('От батареи'), short: 'BATT', c: 'bad', sev: 'bad' },
    { key: 'battery_low', name: i18n('Батарея разряжена'), short: 'LOW', c: 'bad', sev: 'bad' },
    { key: 'ups_fault', name: i18n('Неисправность'), short: 'FAULT', c: 'bad', sev: 'bad' },
    { key: 'shutdown_active', name: i18n('Выключение'), short: 'SHDN', c: 'bad', sev: 'bad' },
    { key: 'avr_active', name: i18n('Стабилизатор (AVR)'), short: 'AVR', c: 'warn', sev: 'warn' },
    { key: 'test_in_progress', name: i18n('Самотест'), short: 'TEST', c: 'warn', sev: 'warn' },
    { key: 'beeper_on', name: i18n('Звук'), short: 'BEEP', c: 2, sev: '' },
    { key: 'standby_type', name: i18n('Offline-тип'), short: 'STBY', c: 6, sev: '' },
];
const UPS_WATTS = 360;  // Ippon Back Basic 650: 650 ВА / 360 Вт - для оценки мощности по % нагрузки.
const LHM_HINT = TR`Температуру и мощность CPU, VRM, материнку и вентиляторы Windows сама не отдаёт.
    Запустите <b>LibreHardwareMonitor</b> от администратора и включите <b>Options → Remote Web Server → Run</b> (порт 8085).`;
const ser = (sk, name, c, g, o = {}) => ({ sk, name, c, g, ...o });
const TEMP_MAIN = /tctl|tdie|cpu package|gpu core|hot ?spot|vrm|chipset|pch|composite/i;

// Пороги SSD («Warning/Critical Temperature») - не измерения, на графики их не пускаем:
const THRESHOLD = /warning|critical|threshold|limit/i;
// Тип железа датчика. Новый сервер отдаёт hw_type, для старых записей в базе угадываем по названию:
const hwTypeOf = m => m.hw_type || (/\bITE\b|IT8\d|Nuvoton|NCT\d|Fintek/i.test(m.hw) ? 'superio'
    : /nvidia|geforce|radeon|\brtx\b|\bgtx\b|\barc\b|graphics/i.test(m.hw) ? 'gpu' : /ryzen|intel|core\(tm\)|\bcpu\b|athlon|xeon|epyc|pentium|celeron/i.test(m.hw) ? 'cpu' : '');
// Частота ядра: AMD - «Core #1», Intel - «CPU Core #1», гибридные Intel - «P-Core #1» / «E-Core #1»:
const CORE_CLOCK = /^(?:CPU |[PE]-)?Core #\d+$/i;
const isCoreClock = m => hwTypeOf(m) === 'cpu' && CORE_CLOCK.test(m.name);


// Номинал шины питания по её названию (для отклонения в %):
function railNominal(name) {
    const n = String(name).toLowerCase().replace(',', '.');
    if (/12\s*v|\+12|12v/.test(n)) return 12;
    if (/5\s*v|\+5|5vsb/.test(n)) return 5;
    if (/3\.3|3vsb|\+3v|3\.3v/.test(n)) return 3.3;
    if (/vbat|cmos|battery|vbatt/.test(n)) return 3.0;
    return null;
}
const RAIL_GROUPS = { 12: i18n('+12 В'), 5: i18n('+5 В'), 3.3: i18n('+3.3 В'), 3: i18n('Батарейка CMOS') };


// Группа шины питания для графика:
function railGroup(m, last) {
    const nom = railNominal(m.name);
    if (nom) return RAIL_GROUPS[nom];
    return last != null && last > 2.2 ? i18n('Прочие') : i18n('Ядро, SoC, память');
}

// Линии датчиков из истории. filter - какие брать, opt(m, k) - доп. свойства линии (группа, скрытие):
function sensSeries(type, filter, opt) {
    const keys = Object.keys(S.sensMeta).filter(k => { const m = S.sensMeta[k]; return m.type === type && !THRESHOLD.test(m.name) && (!filter || filter(m)); })
        .sort((a, b) => (S.sensMeta[a].hw + S.sensMeta[a].name).localeCompare(S.sensMeta[b].hw + S.sensMeta[b].name, 'ru', { numeric: true }));
    return keys.map((k, i) => {
        const m = S.sensMeta[k];
        const hidden = type === 'Temperature' ? !TEMP_MAIN.test(m.name + ' ' + m.hw) : !(S.sensLast[k] > 0);
        return ser('sens:' + k, m.name, i, m.hw || i18n('Датчики'), { hint: m.hw, hidden, ...(opt ? opt(m, k) : {}) });
    });
}
// Шины питания: материнка (Super I/O) + напряжения CPU (без VID каждого ядра):
const RAIL_ORDER = [i18n('+12 В'), i18n('+5 В'), i18n('+3.3 В'), i18n('Ядро, SoC, память'), i18n('Батарейка CMOS'), i18n('Прочие')];
const railSeries = () => sensSeries('Voltage', m => hwTypeOf(m) === 'superio' || (hwTypeOf(m) === 'cpu' && !/#\d/.test(m.name)),
    (m, k) => ({ g: railGroup(m, S.sensLast[k]), hidden: !/12|5v|3\.3|vcore|core \(svi|soc \(svi/i.test(m.name) }))
    .sort((a, b) => RAIL_ORDER.indexOf(a.g) - RAIL_ORDER.indexOf(b.g));


// Мощность GPU: датчик LHM, если есть; иначе оценка по загрузке из истории ПК (как на сервере):
function gpuPowerSeries(c) {
    const lhm = sensSeries('Power', m => hwTypeOf(m) === 'gpu' && !/#\d/.test(m.name), () => ({ g: i18n('Компоненты'), c }));
    if (lhm.length) return lhm.map(s => ({ ...s, name: 'GPU ' + s.name.replace(/^GPU\s*/i, '') }));
    const lim = () => (gpu0() && gpu0().power_limit) || 115;
    return [ser('pc:gpu_avg', i18n('GPU ≈ оценка'), c, i18n('Компоненты'), { fn: v => lim() * (0.1 + 0.009 * v), dash: true })];
}

const CHART_DEFS = {
    perf: { h: 250, ax: AX.pct, series: () => [
        ser('pc:cpu_avg', 'CPU', 0, i18n('Процессор'), { area: true }), ser('pc:cpu_max', i18n('CPU пик'), 0, i18n('Процессор'), { dash: true, hidden: true }),
        ser('pc:gpu_avg', 'GPU', 4, i18n('Видеокарта')), ser('pc:gpu_max', i18n('GPU пик'), 4, i18n('Видеокарта'), { dash: true, hidden: true }),
        ser('pc:gpu_mem_avg', 'VRAM', 7, i18n('Видеокарта'), { dash: true, hidden: true }),
        ser('pc:ram_avg', 'RAM', 2, i18n('Память'), { area: true }), ser('pc:swap_avg', 'Swap', 6, i18n('Память'), { hidden: true }),
    ] },
    temps: { h: 250, ax: AX.temp, dynamic: true, series: () => sensSeries('Temperature'), empty: i18n('Данных пока нет. ') + LHM_HINT },
    fans: { h: 210, ax: AX.rpm, dynamic: true, series: () => sensSeries('Fan'), empty: i18n('Обороты вентиляторов появятся с LibreHardwareMonitor. ') + LHM_HINT },
    rails: { h: 250, ax: AX.v3, dynamic: true, paneH: 84, series: railSeries, empty: i18n('Напряжения блока питания и материнской платы появятся с LibreHardwareMonitor. ') + LHM_HINT },
    clocks: { h: 230, ax: AX.mhz, dynamic: true, series: () => [
        ...sensSeries('Clock', isCoreClock, () => ({ g: i18n('Процессор'), hidden: false })),
        ...sensSeries('Clock', m => hwTypeOf(m) === 'gpu', m => ({ g: i18n('Видеокарта'), hidden: !/core/i.test(m.name) })),
    ], empty: i18n('Реальные частоты ядер Windows не отдаёт - их показывает LibreHardwareMonitor. ') + LHM_HINT },
    powerhist: { h: 250, ax: AX.watt, dynamic: true, series: () => {
        const cpu = sensSeries('Power', m => hwTypeOf(m) === 'cpu' && /package|cpu|total/i.test(m.name) && !/#\d/.test(m.name),
            () => ({ g: i18n('Компоненты'), c: 0, area: true })).map(s => ({ ...s, name: 'CPU ' + s.name }));
        // Линии ИБП - только если ИБП есть:
        const ups = S.upsShown ? [
            ser('ups:load_avg', i18n('Весь ПК (по ИБП)'), 3, i18n('От розетки'), { fn: v => v * UPS_WATTS / 100, area: true, hint: i18n('нагрузка ИБП × ') + UPS_WATTS + i18n(' Вт') }),
            ser('ups:load_max', i18n('Пик'), 3, i18n('От розетки'), { fn: v => v * UPS_WATTS / 100, dash: true, hidden: true }),
        ] : [];
        return [...ups, ...cpu, ...gpuPowerSeries(4)];
    } },
    nethist: { h: 210, ax: AX.rate, series: () => [
        ser('pc:net_rx_avg', i18n('Приём'), 1, i18n('Приём'), { area: true }), ser('pc:net_rx_max', i18n('Приём пик'), 1, i18n('Приём'), { dash: true, hidden: true }),
        ser('pc:net_tx_avg', i18n('Отдача'), 3, i18n('Отдача'), { area: true, neg: true }), ser('pc:net_tx_max', i18n('Отдача пик'), 3, i18n('Отдача'), { dash: true, hidden: true, neg: true }),
    ] },
    diskhist: { h: 210, ax: AX.rate, series: () => [
        ser('pc:disk_r_avg', i18n('Чтение'), 0, i18n('Чтение'), { area: true }), ser('pc:disk_r_max', i18n('Чтение пик'), 0, i18n('Чтение'), { dash: true, hidden: true }),
        ser('pc:disk_w_avg', i18n('Запись'), 2, i18n('Запись'), { area: true, neg: true }), ser('pc:disk_w_max', i18n('Запись пик'), 2, i18n('Запись'), { dash: true, hidden: true, neg: true }),
    ] },
    mains: { h: 250, ax: AX.volt, series: () => [
        ser('ups:vin_avg', i18n('Вход'), 0, i18n('Вход')), ser('ups:vin_min', i18n('Вход min'), 0, i18n('Вход'), { dash: true, hidden: true }), ser('ups:vin_max', i18n('Вход max'), 0, i18n('Вход'), { dash: true, hidden: true }),
        ser('ups:vout_avg', i18n('Выход'), 4, i18n('Выход')), ser('ups:vout_min', i18n('Выход min'), 4, i18n('Выход'), { dash: true, hidden: true }),
        ser('ups:vout_max', i18n('Выход max'), 4, i18n('Выход'), { dash: true, hidden: true }), ser('ups:vfault_min', 'Fault V', 3, 'Fault V', { dash: true, hidden: true }),
    ] },
    load: { h: 200, ax: AX.pct, series: () => [ser('ups:load_avg', i18n('Нагрузка'), 2, i18n('Нагрузка'), { area: true }), ser('ups:load_max', i18n('Пик'), 2, i18n('Нагрузка'), { dash: true })] },
    bat: { h: 200, ax: AX.bv, series: () => [
        ser('ups:vbat_avg', i18n('Напряжение'), 4, i18n('Напряжение')), ser('ups:vbat_min', i18n('Напряжение min'), 4, i18n('Напряжение'), { dash: true, hidden: true }),
        ser('ups:batt_pct', i18n('Заряд'), 1, i18n('Заряд'), { ax: AX.pct, area: true }),
    ] },
    freq: { h: 200, ax: AX.hz, series: () => [
        ser('ups:freq_avg', i18n('Частота'), 3, i18n('Частота')), ser('ups:freq_min', 'min', 3, i18n('Частота'), { dash: true, hidden: true }), ser('ups:freq_max', 'max', 3, i18n('Частота'), { dash: true, hidden: true }),
    ] },
    utemp: { h: 200, ax: AX.temp, series: () => [ser('ups:temp_avg', i18n('Температура'), 5, i18n('Температура')), ser('ups:temp_max', 'max', 5, i18n('Температура'), { dash: true, hidden: true })] },
    upsmix: { h: 250, ax: AX.pct, paneH: 78, series: () => [
        ser('ups:load_avg', i18n('Нагрузка'), 2, i18n('Нагрузка'), { ax: AX.pct, area: true }), ser('ups:load_max', i18n('Нагрузка пик'), 2, i18n('Нагрузка'), { ax: AX.pct, dash: true, hidden: true }),
        ser('ups:freq_avg', i18n('Частота'), 3, i18n('Частота сети'), { ax: AX.hz }), ser('ups:freq_min', i18n('Частота min'), 3, i18n('Частота сети'), { ax: AX.hz, dash: true, hidden: true }),
        ser('ups:freq_max', i18n('Частота max'), 3, i18n('Частота сети'), { ax: AX.hz, dash: true, hidden: true }),
        ser('ups:temp_avg', i18n('Температура'), 5, i18n('Температура ИБП'), { ax: AX.temp }), ser('ups:temp_max', i18n('Температура max'), 5, i18n('Температура ИБП'), { ax: AX.temp, dash: true, hidden: true }),
    ] },
    flags: { h: 200, ax: AX.flags, noSplit: true, noStyle: true, series: () => FLAGS.map((f, j) => ser('ups:' + f.key, f.name, f.c, i18n('Флаги'), { row: FLAGS.length - 1 - j })) },
};


// «Обзор»: несколько графиков в одном виджете (группа = исходный график):
function overviewDef(members, h, keep) {
    return {
        h, dynamic: members.some(([m]) => CHART_DEFS[m].dynamic),
        series: () => {
            const out = [];
            for (const [m, label] of members) {
                const d = CHART_DEFS[m];
                for (const s of d.series()) {
                    out.push({ ...s, ax: s.ax || d.ax, g: label, c: out.length, hint: s.hint ? label + ' · ' + s.hint : label,
                               hidden: s.hidden || !keep(m, s) });
                }
            }
            return out;
        },
    };
}
// В обзоре системы по умолчанию: загрузка CPU/GPU/RAM и температуры CPU и GPU (две оси - читается):
CHART_DEFS.pc_all = overviewDef([['perf', i18n('Загрузка')], ['temps', i18n('Температуры')], ['fans', i18n('Вентиляторы')], ['nethist', i18n('Сеть')], ['diskhist', i18n('Диски')]], 420,
    (m, s) => (m === 'perf' && /cpu_avg|gpu_avg|ram_avg/.test(s.sk)) || (m === 'temps' && /tctl|tdie|cpu package|gpu core/i.test(s.name)));
// В обзоре ИБП по умолчанию: вход, выход и нагрузка:
CHART_DEFS.ups_all = overviewDef([['mains', i18n('Сеть')], ['load', i18n('Нагрузка')], ['bat', i18n('АКБ')], ['freq', i18n('Частота')], ['utemp', i18n('Температура')]], 420,
    (m, s) => /ups:(vin_avg|vout_avg|load_avg)$/.test(s.sk));

const STYLES = { auto: i18n('Авто'), line: i18n('Линии'), area: i18n('Заливка'), smooth: i18n('Сглаженные'), step: i18n('Ступени'), bars: i18n('Столбцы') };

//
// Состояние.
//
const S = {
    view: { from: 0, to: 0 }, span: store.get('span', 900), live: true,
    split: store.get('split2', {}), cstyle: store.get('cstyle', {}), yzero: store.get('yzero', {}),
    sel: store.get('sel2', {}), heights: store.get('heights2', {}), y: {},
    data: {}, areas: [], sensMeta: {}, sensLast: {}, seq: 0, loading: false,
    charts: [], gesture: false, hooks: new Set(),
    pc: null, upsR: null, events: [], inst: {}, hist: {}, kpiMax: {}, ribbon: [],
    cpuMode: store.get('cpuMode', 'graph'), c3dMode: store.get('c3dMode2', 'bar'), cam3d: store.get('cam3d', null), nicHist: {}, tile: null,
    procSort: store.get('procSort', { key: 'cpu', dir: -1 }), procFilter: '', sensType: store.get('sensType', 'all'),
    edit: false,
};
const isVis = s => s && (S.sel[s.sk] ?? !s.hidden);
const srcOf = sk => sk.slice(0, sk.indexOf(':'));
const keyOf = sk => sk.slice(sk.indexOf(':') + 1);
const colorOf = s => typeof s.c === 'string' ? (T[s.c] || s.c) : T.pal[(s.c || 0) % T.pal.length];

// Запрос к серверу (401 - на страницу входа):
async function api(path) {
    // Нет ответа 15 с - обрываем: иначе один повисший запрос (плохая связь через туннель) навсегда останавливал подгрузку истории.
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
    try {
        const r = await fetch(path, { credentials: 'same-origin', signal: ctl.signal });
        if (r.status === 401) { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.hash)); throw new Error('auth'); }
        const j = await r.json().catch(() => ({ error: 'bad response' }));
        if (!r.ok && !j.error) j.error = 'HTTP ' + r.status;
        return j;
    } finally { clearTimeout(timer); }
}

//
// Всплывающая подсказка. У неё есть «владелец» (график, плитка, лента),
// чтобы обновление одного не закрывало подсказку другого.
//
let tipOwner = null;


// Показать подсказку:
function tipShow(html, cx, cy, owner) {
    const tip = $('#ctip');
    tip.innerHTML = html;
    tip.classList.add('show');
    tipOwner = owner;
    placeTip(tip, cx, cy);
}


// Спрятать подсказку (только свою):
function tipHide(owner) {
    if (owner && tipOwner !== owner) return;
    $('#ctip').classList.remove('show');
    tipOwner = null;
}


// Поставить подсказку рядом с курсором, не вылезая за экран:
function placeTip(tip, cx, cy) {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let l = cx + 18, t = cy + 14;
    if (l + w > innerWidth - 10) l = cx - w - 18;
    if (t + h > innerHeight - 10) t = cy - h - 14;
    tip.style.left = clamp(l, 10, Math.max(10, innerWidth - w - 10)) + 'px';
    tip.style.top = clamp(t, 10, Math.max(10, innerHeight - h - 10)) + 'px';
}

//
// Счётчик: цифры прокручиваются, как в механическом табло.
//
const isDigit = c => c.length === 1 && c >= '0' && c <= '9';
// Лента цифр - один текстовый узел (цифры в столбик): на телефоне элементов в разы меньше.
const ODO_STRIP = '<span class="od-s">' + '0123456789'.split('').join('\n') + '</span>';


// Показать значение счётчиком (все меняющиеся числа на странице показываются только так):
function odo(el, text) {
    if (!el) return;
    text = String(text ?? '');
    if (el._text === text) return;
    // Цифры крутятся по одной, всё остальное между ними - куски текста:
    const parts = text.match(/\d|\D+/g) || [], prev = el._parts;
    const same = prev && prev.length === parts.length && prev.every((c, i) => isDigit(c) === isDigit(parts[i]));
    if (!same) {
        el.innerHTML = parts.map(c => isDigit(c) ? `<span class="od-d">${ODO_STRIP}</span>` : `<span class="od-c"></span>`).join('');
        // Первый показ - сразу на месте; смена разрядности - цифры «выкатываются» с нуля.
        if (!prev || document.hidden) $$('.od-s', el).forEach(s => { s.style.transition = 'none'; });
        el.offsetHeight;  // Зафиксировать стартовое положение перед анимацией.
    }
    let di = 0, ci = 0;
    const strips = el.getElementsByClassName('od-s'), others = el.getElementsByClassName('od-c');
    for (const c of parts) {
        if (isDigit(c)) {
            const sd = strips[di++];
            if (sd._d === c) continue;  // Трогаем только сменившиеся цифры.
            sd._d = c;
            // На телефоне цифра едет через top: так ей не нужен отдельный слой видеокарты (их сотни, память iPhone кончается):
            if (TOUCH) sd.style.top = (-c * 1.15) + 'em'; else sd.style.transform = `translateY(${-c * 10}%)`;
        } else {
            const o = others[ci++];
            if (o.textContent !== c) o.textContent = c;
        }
    }
    if (!same && (!prev || document.hidden)) { el.offsetHeight; $$('.od-s', el).forEach(s => { s.style.transition = ''; }); }
    el._text = text;
    el._parts = parts;
}


// Счётчик внутри элемента (создаётся при первом вызове) - для подписей, где кроме числа ничего нет:
function odoIn(host, text) {
    if (!host) return;
    let el = host.firstElementChild;
    if (!el || !el.classList.contains('odo')) { host.innerHTML = '<span class="odo"></span>'; el = host.firstElementChild; }
    odo(el, text);
}

//
// Данные истории. Сначала грузится весь видимый диапазон, дальше в режиме
// Live раз в секунду догружается только «хвост» - новые интервалы.
//
const SRC_URL = { ups: '/api/ups/data', pc: '/api/pc/data', sens: '/api/pc/sensors' };
const SRC_GAP = { ups: 3, pc: 4, sens: 15 };  // Разрыв линии, если данных не было дольше (сек).
const BUCKETS = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
const maxPlotW = () => Math.max(300, ...S.charts.filter(c => !c.wrap.hidden).map(c => c.plotW()));
const wantedBucket = () => BUCKETS.find(b => b >= (S.view.to - S.view.from) / maxPlotW()) || BUCKETS[BUCKETS.length - 1];

// Какие источники данных нужны видимым графикам:
function neededSources() {
    const need = new Set();
    for (const c of S.charts) { c.sl.forEach(s => need.add(srcOf(s.sk))); if (c.def.dynamic) need.add('sens'); }
    if (need.size || S.inst.vdist) need.add('ups');  // Полосы «от батареи» и распределение напряжения.
    return need;
}


// Разобрать ответ сервера в колонки:
function parseResp(src, d) {
    const cols = {};
    if (src === 'sens') {
        Object.assign(S.sensMeta, d.meta || {});
        for (const [k, v] of Object.entries(d.series || {})) cols[k] = v;
    } else for (const [k, v] of Object.entries(d)) if (k !== 't' && Array.isArray(v)) cols[k] = v;
    return { t: d.t || [], cols };
}


// Нужна ли полная загрузка диапазона:
function needFull() {
    const b = wantedBucket();
    return [...neededSources()].some(src => {
        const d = S.data[src];
        return !d || d.b !== b || S.view.from < d.from || (!S.live && S.view.to > d.to + b);
    });
}


// Загрузить весь видимый диапазон:
async function loadFull() {
    const need = neededSources();
    if (!need.size) return;
    const span = S.view.to - S.view.from, b = wantedBucket(), now = nowSec();
    const from = S.view.from - span * 0.6, to = S.live ? now + b : Math.min(now + b, S.view.to + span * 0.6);
    const my = ++S.seq;
    S.loading = true;
    const res = await Promise.all([...need].map(src =>
        api(`${SRC_URL[src]}?start=${from}&end=${to}&bucket=${b}`).then(d => [src, d]).catch(() => [src, { error: 'offline' }])));
    S.loading = false;
    if (my !== S.seq) return;  // Пока грузили, пользователь ушёл в другое место.
    for (const [src, d] of res) {
        if (d.error) continue;
        S.data[src] = { b, from, to, ...parseResp(src, d) };
    }
    afterData();
}


// Догрузить новые данные (хвост):
async function loadTail() {
    const my = S.seq, now = nowSec();
    await Promise.all(Object.entries(S.data).map(async ([src, d]) => {
        const last = d.t.length ? d.t[d.t.length - 1] : d.from;
        const start = Math.floor(last / d.b) * d.b;
        const r = await api(`${SRC_URL[src]}?start=${start}&end=${now + d.b}&bucket=${d.b}`).catch(() => ({ error: 1 }));
        if (r.error || my !== S.seq || S.data[src] !== d) return;
        mergeTail(d, parseResp(src, r));
    }));
    if (my === S.seq) afterData();
}


// Новые интервалы заменяют последний (он мог быть неполным) и добавляются в конец:
function mergeTail(d, nd) {
    if (!nd.t.length) return;
    const firstIdx = Math.floor(nd.t[0] / d.b);
    let cut = d.t.length;
    while (cut > 0 && Math.floor(d.t[cut - 1] / d.b) >= firstIdx) cut--;
    d.t.length = cut;
    for (const t of nd.t) d.t.push(t);
    for (const k of new Set([...Object.keys(d.cols), ...Object.keys(nd.cols)])) {
        let a = d.cols[k];
        if (!a) a = d.cols[k] = new Array(cut).fill(null);
        else a.length = cut;
        const b = nd.cols[k];
        for (let i = 0; i < nd.t.length; i++) a.push(b ? b[i] : null);
    }
    d.to = Math.max(d.to, nd.t[nd.t.length - 1] + d.b);
    // Память не растёт бесконечно: слишком старое (левее окна на 2 ширины) выкидываем.
    const drop = lowerBound(d.t, S.view.from - (S.view.to - S.view.from) * 2);
    if (drop > 1000) {
        d.t.splice(0, drop);
        for (const k in d.cols) d.cols[k].splice(0, drop);
        d.from = d.t[0];
    }
}


// После загрузки: полосы работы от батареи и перерисовка:
function afterData() {
    // Периоды работы от батареи:
    S.areas = [];
    const d = S.data.ups;
    if (d && d.cols.on_battery) {
        let st = null, prev = null;
        const gap = Math.max(d.b * 2.5, SRC_GAP.ups);
        d.t.forEach((t, i) => {
            const v = d.cols.on_battery[i];
            // Разрыв в данных (скрипт не работал) - полосу обрываем, а не тянем через всё простой:
            if (st !== null && prev !== null && t - prev > gap) { S.areas.push([st, prev + d.b]); st = null; }
            if (v && st === null) st = t;
            if (!v && st !== null) { S.areas.push([st, t]); st = null; }
            prev = t;
        });
        if (st !== null) S.areas.push([st, d.t[d.t.length - 1] + d.b]);
    }
    for (const c of [...S.charts]) {
        if (c.def.dynamic && c.def.series().map(s => s.sk).join('|') !== c.sig) c.build();
        else { c.dirty = true; c.renderLegend(); }
    }
    const bs = Object.values(S.data).map(x => x.b);
    odoIn($('#info'), bs.length ? TR`шаг ${stepLabel(Math.min(...bs))}` : i18n('нет данных'));
    if (S.inst.vdist) runUpdate(S.inst.vdist);
}
let loadTimer = null;


// Загрузить данные чуть позже (после навигации):
function scheduleLoad() { clearTimeout(loadTimer); loadTimer = setTimeout(() => { if (!S.gesture && needFull()) loadFull(); }, 200); }

//
// Графики: свой лёгкий движок на canvas. Рисуются только видимые графики;
// в режиме Live время плавно едет каждый кадр (для длинных окон - реже).
//
const GRID = { l: 56, r: 16, t: 10, b: 26, title: 22, gap: 12 };
const MIN_SPAN = 10, MAX_SPAN = 400 * 86400;
const TSTEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000];

// Круглый шаг сетки:
function niceStep(range, n = 4) {
    const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}


// Круглые пределы шкалы:
function niceRange(r, ax, zero) {
    const st = niceStep(Math.max(r.max - r.min, 1e-6));
    let min = Math.floor(r.min / st) * st, max = Math.ceil(r.max / st) * st;
    if ((ax.min0 || zero) && r.min >= 0) min = Math.max(0, zero ? 0 : min);
    if (ax.cap && r.max <= ax.cap) max = Math.min(max, ax.cap);
    if (max - min < 1e-9) max = min + st;
    return { min, max };
}


// Метки времени на оси:
function timeTicks(v0, v1, pw) {
    const span = v1 - v0, step = TSTEPS.find(s => s >= span / Math.max(2, pw / 95)) || TSTEPS[TSTEPS.length - 1];
    const tz = -new Date(v0 * 1000).getTimezoneOffset() * 60;  // Метки по местному времени.
    const ticks = [];
    for (let t = Math.ceil((v0 + tz) / step) * step - tz; t <= v1 && ticks.length < 300; t += step) ticks.push(t);
    const minor = step >= 86400 ? 0 : step % 5 === 0 && step >= 5 ? step / 5 : step / 2;
    return { step, ticks, minor, tz };
}


// Подпись метки времени:
function tickLabel(t, step) {
    const d = new Date(t * 1000);
    if (step >= 86400 || (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0)) return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
    if (step < 60) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const chartIO = new IntersectionObserver(entries => entries.forEach(e => {
    const c = e.target._chart;
    if (!c) return;
    c.visible = e.isIntersecting;
    if (c.visible) { c.cw = 0; c.resize(); c.dirty = true; } else c.release();
}), { rootMargin: '120px' });

// График на canvas: время по X, панели, масштаб колесом и пальцами, подсказки:
class TimeChart {
    // Создать график:
    constructor(w, def) {
        this.w = w; this.id = w.id; this.def = def;
        this.visible = true; this.dirty = true; this.lastDraw = 0; this.lastFrom = 0; this.lastTo = 0;
        S.charts.push(this);
        this.build();
    }

    // Группы линий:
    groups() { return [...new Set(this.sl.map(s => s.g || s.name))]; }

    // Можно ли показывать раздельно:
    get canSplit() { return !this.def.noSplit && this.groups().length > 1; }

    // Показан ли раздельно:
    get split() { const v = S.split[this.id]; return this.canSplit && (v === undefined ? !!this.def.defaultSplit : !!v); }

    // Ключ сохранённой высоты:
    get hkey() { return this.id + (this.split ? ':s' : ''); }

    // Правый отступ (есть вторая ось - шире):
    get right() { return this.twoAx ? GRID.l : GRID.r; }

    // Стиль линий:
    get style() { return this.def.noStyle ? 'auto' : (S.cstyle[this.id] || 'auto'); }

    // Ширина области графика:
    plotW() { return Math.max(40, (this.cw || this.wrap.clientWidth) - GRID.l - this.right); }

    // Построить график заново:
    build() {
        const rebuild = !!this.el;
        if (this.ro) this.ro.disconnect();
        if (this.wrap) chartIO.unobserve(this.wrap);
        this.sl = this.def.series().map(s => ({ ...s, ax: s.ax || this.def.ax }));
        this.sig = this.sl.map(s => s.sk).join('|');
        this.yCur = {}; this.yAnim = {}; this.legendSig = ''; this.manualShown = null;
        this.cw = this.ch = this.dpr = 0;  // Новый canvas - размеры и панели пересчитать заново.
        this.layoutPanes();
        const body = this.w.body;
        if (this.el) { this.el.width = 0; this.el.height = 0; }  // Старый холст - сразу освободить память.
        body.innerHTML = TR`<div class="legend"></div>
            <div class="cwrap"><canvas class="chart"></canvas><div class="xline"></div><div class="dots"></div></div>
            <div class="grabber" title="Потяните, чтобы изменить высоту"></div>`;
        this.legendEl = $('.legend', body);
        this.wrap = $('.cwrap', body);
        this.el = $('canvas', body);
        this.ctx = this.el.getContext('2d');
        this.xl = $('.xline', body);
        this.dotsEl = $('.dots', body);
        const grab = $('.grabber', body);
        this.wrap.hidden = grab.hidden = !this.sl.length;  // Нет данных - только подсказка, без пустого графика.
        this.wrap.style.height = (S.heights[this.hkey] || this.defaultH()) + 'px';
        this.legendEl.onclick = e => {
            const b = e.target.closest('.lg');
            if (!b) return;
            const s = this.sl.find(x => x.sk === b.dataset.sk);
            S.sel[s.sk] = !isVis(s);
            store.set('sel2', S.sel);
            if (this.split) this.relayout();
            this.renderLegend();
            this.dirty = true;
        };
        bindChart(this);
        bindGrabber(this, grab);
        this.ro = new ResizeObserver(() => this.resize());
        this.ro.observe(this.wrap);
        this.wrap._chart = this;
        chartIO.observe(this.wrap);
        this.resize();
        this.renderLegend();
        if (this.w.chart === this) chartTools(this.w);
        if (rebuild) this.wrap.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'ease-out' });
    }

    // Отдать память холста (график ушёл с экрана; resize() создаст холст заново):
    release() {
        if (this.el) { this.el.width = 0; this.el.height = 0; }
        this.cw = this.ch = 0;
    }

    // Уничтожить график:
    dispose() {
        if (this.ro) this.ro.disconnect();
        if (this.wrap) chartIO.unobserve(this.wrap);
        if (this.el) { this.el.width = 0; this.el.height = 0; }
        this.ctx = null;
        if (hover && hover.c === this) hideHover();
        S.charts = S.charts.filter(c => c !== this);
    }

    // Панели пересчитываются без пересоздания графика (включили/выключили линию в раздельном режиме):
    relayout() {
        this.layoutPanes();
        this.yCur = {}; this.yAnim = {};
        if (!S.heights[this.hkey]) this.wrap.style.height = this.defaultH() + 'px';
        this.cw = 0;
        this.resize();
    }

    // Разложить линии по панелям:
    layoutPanes() {
        const split = this.split;
        // В раздельном режиме пустые (все линии выключены) группы не занимают место:
        let groups = split ? this.groups().filter(g => this.sl.some(s => (s.g || s.name) === g && isVis(s))) : [null];
        if (!groups.length) groups = this.groups().slice(0, 1);
        this.panes = groups.map(g => {
            const series = split ? this.sl.filter(s => (s.g || s.name) === g) : this.sl;
            const axes = [...new Set(series.map(s => s.ax))];
            return { title: g, series, axes: axes.length ? axes : [this.def.ax || AX.pct] };
        });
        this.yAxes = [];
        this.sl.forEach(s => { s.pane = 0; s.yi = 0; });  // Линии скрытых групп - на первую панель (они не рисуются).
        this.panes.forEach((p, pi) => {
            p.y0 = this.yAxes.length;
            p.axes.forEach((ax, k) => this.yAxes.push({ pane: pi, ax, k }));
            p.series.forEach(s => { s.pane = pi; s.yi = p.y0 + p.axes.indexOf(s.ax); });
        });
        this.twoAx = this.panes.some(p => p.axes.length > 1);
    }

    // Высота по умолчанию:
    defaultH() { return this.split ? Math.max(this.def.h, 44 + this.panes.length * (this.def.paneH || 104)) : this.def.h; }

    // Подогнать холст под размер:
    resize() {
        if (!this.ctx) return;
        const w = Math.max(60, this.wrap.clientWidth), h = Math.max(60, this.wrap.clientHeight);
        const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
        if (w === this.cw && h === this.ch && dpr === this.dpr) return;
        this.cw = w; this.ch = h; this.dpr = dpr;
        this.el.width = Math.round(w * dpr);
        this.el.height = Math.round(h * dpr);
        this.el.style.width = w + 'px';
        this.el.style.height = h + 'px';
        const n = this.panes.length, title = this.split ? GRID.title : 0, gap = this.split ? GRID.gap : 0;
        const ph = Math.max(30, (h - GRID.t - GRID.b - (n - 1) * gap - n * title) / n);
        this.geo = this.panes.map((p, i) => ({ top: GRID.t + title + i * (ph + gap + title), h: ph, title }));
        this.dirty = true;
    }

    // Время -> координата X:
    X(t) { return GRID.l + (t - S.view.from) / (S.view.to - S.view.from) * this.plotW(); }

    // Значение -> координата Y:
    Y(yi, v) {
        const r = this.yCur[yi], g = this.geo[this.yAxes[yi].pane];
        return g.top + (1 - (v - r.min) / ((r.max - r.min) || 1)) * g.h;
    }

    // Преобразование значения линии для отрисовки:
    tf(s) {
        if (s.row != null) return v => s.row + (v ? 0.75 : 0);
        if (s.fn) return s.fn;
        if (s.neg && !this.split) return v => -v;
        return v => v;
    }

    // Панель под курсором:
    paneAt(py) {
        let best = 0, bd = Infinity;
        this.geo.forEach((g, i) => { const d = py < g.top ? g.top - py : py > g.top + g.h ? py - g.top - g.h : 0; if (d < bd) { bd = d; best = i; } });
        return best;
    }

    // Последнее значение линии:
    lastValue(s) {
        const d = S.data[srcOf(s.sk)], vs = d && d.cols[keyOf(s.sk)];
        if (!vs) return null;
        for (let i = vs.length - 1; i >= 0 && i >= vs.length - 8; i--) if (vs[i] != null) return this.tf(s)(vs[i]);
        return null;
    }

    // Значение линии для подписи:
    fmtValue(s, v) {
        if (v == null) return '—';
        if (s.ax.flags) return (v - s.row) > 0.4 ? i18n('вкл') : i18n('выкл');
        return s.ax.f(s.neg && !this.split ? -v : v);
    }

    // Легенда перерисовывается целиком только при смене набора линий, иначе меняются лишь значения:
    renderLegend() {
        if (!this.legendEl) return;
        if (!this.sl.length) { this.legendEl.innerHTML = `<div class="lg-empty">${this.def.empty || i18n('Нет данных')}</div>`; this.legendSig = ''; return; }
        const sig = this.sl.map(s => s.sk + (isVis(s) ? '1' : '0')).join('|') + (this.split ? 's' : '') + T.accent;
        if (sig !== this.legendSig) {
            this.legendEl.innerHTML = this.sl.map(s => `<button class="lg ${isVis(s) ? '' : 'off'}" data-sk="${esc(s.sk)}" title="${esc(s.name + (s.hint ? ' · ' + s.hint : ''))}">
                <i class="${s.dash ? 'dash' : ''}" style="background:${colorOf(s)}"></i><span>${esc(s.name)}</span>${s.hint && !this.split ? `<small>${esc(s.hint)}</small>` : ''}<b></b></button>`).join('');
            this.legendSig = sig;
        }
        this.sl.forEach((s, i) => {
            const b = this.legendEl.children[i] && this.legendEl.children[i].querySelector('b');
            odoIn(b, this.fmtValue(s, this.lastValue(s)));
        });
    }

    // Автодиапазон Y по видимым сейчас данным:
    autoY(yi) {
        const ax = this.yAxes[yi].ax, v0 = S.view.from, v1 = S.view.to;
        let lo = Infinity, hi = -Infinity;
        for (const s of this.sl) {
            if (s.yi !== yi || !isVis(s)) continue;
            const d = S.data[srcOf(s.sk)], vs = d && d.cols[keyOf(s.sk)];
            if (!vs) continue;
            const tf = this.tf(s);
            for (let i = Math.max(0, lowerBound(d.t, v0 - d.b)); i < d.t.length && d.t[i] <= v1; i++) {
                if (vs[i] == null) continue;
                const v = tf(vs[i]);
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        }
        if (lo === Infinity) return { min: 0, max: ax.cap || 1 };
        const pad = Math.max((hi - lo) * 0.08, ax.ypad || 0);
        let min = lo - pad, max = hi + pad;
        if (ax.min0 && lo >= 0) min = Math.max(0, min);
        if (ax.cap && hi <= ax.cap) max = Math.min(max, ax.cap);
        return { min, max };
    }
    // Шкала Y: круглые пределы, меняются только когда данные реально выходят за них, и плавно.
    updateY(now) {
        let anim = false;
        const manualAll = S.y[this.hkey] || {};
        this.yAxes.forEach((y, i) => {
            if (y.ax.flags) { this.yCur[i] = { min: -0.3, max: FLAGS.length - 0.1 }; return; }
            if (manualAll[i]) { this.yCur[i] = manualAll[i]; this.yAnim[i] = null; return; }
            const target = niceRange(this.autoY(i), y.ax, !!S.yzero[this.id]);
            const cur = this.yCur[i];
            if (!cur) { this.yCur[i] = target; return; }
            const a = this.yAnim[i], goal = a ? a.to : cur;
            const fits = target.min >= goal.min - 1e-9 && target.max <= goal.max + 1e-9 && (target.max - target.min) >= 0.5 * (goal.max - goal.min);
            if (!fits) this.yAnim[i] = { from: { ...cur }, to: target, t0: now };
            const an = this.yAnim[i];
            if (an) {
                const k = clamp((now - an.t0) / 420, 0, 1), e = easeOut(k);
                this.yCur[i] = { min: an.from.min + (an.to.min - an.from.min) * e, max: an.from.max + (an.to.max - an.from.max) * e };
                if (k >= 1) this.yAnim[i] = null; else anim = true;
            }
        });
        this.yAnimating = anim;
        const manual = Object.keys(manualAll).length > 0;
        if (manual !== this.manualShown) {
            this.manualShown = manual;
            const yb = $('.yauto-btn', this.w.tools);
            if (yb) yb.hidden = !manual;
        }
    }

    // Нарисовать график:
    draw() {
        const ctx = this.ctx;
        if (!ctx || !this.geo) return;
        const now = performance.now();
        this.updateY(now);
        const revealX = this.X(this.updateReveal(now));
        const W = this.cw, H = this.ch, dpr = this.dpr, L = GRID.l, R = W - this.right, pw = R - L;
        const v0 = S.view.from, v1 = S.view.to, span = v1 - v0;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.font = `11px ${T.font}`;
        ctx.textBaseline = 'middle';
        const last = this.geo[this.geo.length - 1];
        const top0 = this.geo[0].top, bottom = last.top + last.h;

        // Сетка времени (через все панели) и подписи под нижней панелью:
        const tt = timeTicks(v0, v1, pw);
        ctx.lineWidth = 1;
        if (tt.minor) {
            ctx.strokeStyle = T.grid2;
            ctx.beginPath();
            for (let t = Math.ceil((v0 + tt.tz) / tt.minor) * tt.minor - tt.tz; t <= v1; t += tt.minor) {
                const x = Math.round(this.X(t)) + 0.5;
                for (const g of this.geo) { ctx.moveTo(x, g.top); ctx.lineTo(x, g.top + g.h); }
            }
            ctx.stroke();
        }
        ctx.strokeStyle = T.grid;
        ctx.beginPath();
        for (const t of tt.ticks) {
            const x = Math.round(this.X(t)) + 0.5;
            for (const g of this.geo) { ctx.moveTo(x, g.top); ctx.lineTo(x, g.top + g.h); }
        }
        ctx.stroke();
        ctx.fillStyle = T.text3;
        ctx.textAlign = 'center';
        let lastRight = -1e9;
        for (const t of tt.ticks) {
            const x = this.X(t), label = tickLabel(t, tt.step), w = ctx.measureText(label).width;
            if (x - w / 2 < lastRight + 10 || x - w / 2 < L - 20 || x + w / 2 > W) continue;
            ctx.fillText(label, x, bottom + 14);
            lastRight = x + w / 2;
        }
        ctx.strokeStyle = T.axis;
        ctx.beginPath(); ctx.moveTo(L, bottom + 0.5); ctx.lineTo(R, bottom + 0.5); ctx.stroke();

        this.panes.forEach((p, pi) => {
            const g = this.geo[pi];
            // Горизонтальная сетка и подписи осей Y:
            p.axes.forEach((ax, k) => {
                const yi = p.y0 + k, r = this.yCur[yi];
                if (k > 1) return;
                ctx.textAlign = k === 0 ? 'right' : 'left';
                ctx.fillStyle = T.text3;
                if (ax.flags) {
                    FLAGS.forEach((f, j) => { ctx.fillText(f.short, L - 8, this.Y(yi, FLAGS.length - 1 - j + 0.37)); });
                    return;
                }
                const st = niceStep(r.max - r.min, Math.max(2, Math.round(g.h / 44)));
                ctx.strokeStyle = T.grid;
                ctx.beginPath();
                for (let v = Math.ceil(r.min / st) * st; v <= r.max + 1e-9; v += st) {
                    const y = Math.round(this.Y(yi, v)) + 0.5;
                    if (y < g.top + 6 || y > g.top + g.h - 4) continue;
                    if (k === 0) { ctx.moveTo(L, y); ctx.lineTo(R, y); }
                    ctx.fillText(ax.ax(Math.abs(v) < 1e-9 ? 0 : v), k === 0 ? L - 8 : R + 8, y);
                }
                ctx.stroke();
            });
            ctx.save();
            ctx.beginPath(); ctx.rect(L, g.top - 1, Math.max(0, Math.min(pw, revealX - L)), g.h + 2); ctx.clip();
            // Периоды работы от батареи:
            if (!p.axes[0].flags) {
                ctx.fillStyle = hexA(T.bad, 0.1);
                for (const [a, b] of S.areas) {
                    if (b < v0 || a > v1) continue;
                    const x0 = this.X(a), x1 = this.X(b);
                    ctx.fillRect(x0, g.top, Math.max(1, x1 - x0), g.h);
                }
            }
            // Сначала пунктиры (min/max), поверх - основные линии:
            const order = p.series.filter(isVis).sort((a, b) => (b.dash ? 1 : 0) - (a.dash ? 1 : 0));
            for (const s of order) this.drawSeries(ctx, s, g, v0, v1, pw);
            ctx.restore();
            if (this.split) {
                ctx.textAlign = 'left';
                ctx.fillStyle = T.text2;
                ctx.font = `600 12px ${T.font}`;
                ctx.fillText(p.title, L, g.top - 11);
                ctx.font = `11px ${T.font}`;
            }
        });
        this.lastDraw = now; this.lastFrom = v0; this.lastTo = v1; this.dirty = false;
    }

    // Правый край линий плавно догоняет последнюю точку (новые данные вырастают, а не появляются скачком):
    updateReveal(now) {
        let latest = -Infinity, step = 1;
        for (const s of this.sl) {
            if (!isVis(s)) continue;
            const d = S.data[srcOf(s.sk)];
            if (d && d.t.length) { latest = Math.max(latest, d.t[d.t.length - 1] + d.b); step = Math.max(step, d.b); }
        }
        if (latest === -Infinity) { this.revealT = null; this.revealing = false; return Infinity; }
        const dt = Math.min(0.1, (now - (this.revealAt || now)) / 1000);
        this.revealAt = now;
        // Первая отрисовка, откат назад или большой скачок (загрузили другой диапазон) - без анимации:
        if (this.revealT == null || latest < this.revealT - step || latest - this.revealT > Math.max(30, step * 4)) this.revealT = latest;
        else this.revealT += (latest - this.revealT) * Math.min(1, dt * 4);
        this.revealing = latest - this.revealT > step * 0.02;
        return this.revealing ? this.revealT : latest;
    }

    // Нарисовать одну линию:
    drawSeries(ctx, s, g, v0, v1, pw) {
        const src = srcOf(s.sk), d = S.data[src];
        if (!d) return;
        const ts = d.t, vs = d.cols[keyOf(s.sk)];
        if (!vs || !ts.length) return;
        const gap = Math.max(d.b * 2.5, SRC_GAP[src]), tf = this.tf(s), yi = s.yi;
        const i0 = Math.max(0, lowerBound(ts, v0 - d.b) - 1), i1 = Math.min(ts.length, lowerBound(ts, v1 + d.b) + 1);
        const col = colorOf(s), style = s.row != null ? 'step' : this.style;
        const r = this.yCur[yi];
        const base = this.Y(yi, clamp(0, r.min, r.max));
        const barW = d.b / (v1 - v0) * pw;
        // Столбцы (если они не тоньше пикселя):
        if (style === 'bars' && !s.dash && barW >= 1.5) {
            ctx.fillStyle = hexA(col, 0.8);
            const bw = barW > 4 ? barW - 1 : barW;
            for (let i = i0; i < i1; i++) {
                if (vs[i] == null) continue;
                const x = this.X(ts[i]), y = this.Y(yi, tf(vs[i]));
                ctx.fillRect(x, Math.min(y, base), bw, Math.max(1, Math.abs(base - y)));
            }
            return;
        }
        // Точки -> отрезки (разрыв там, где данных не было). Если точек больше, чем пикселей,
        // в каждом столбце пикселей оставляем первую/мин/макс/последнюю - пики не теряются.
        const segs = [];
        let seg = null, prevT = -Infinity;
        const decim = (i1 - i0) > pw * 1.5;
        let cx = null, fy, lo, hi, ly;
        const flushCol = () => {
            if (cx === null) return;
            seg.push(cx, fy);
            if (lo !== fy) seg.push(cx, lo);
            if (hi !== lo) seg.push(cx, hi);
            if (ly !== hi) seg.push(cx, ly);
            cx = null;
        };
        for (let i = i0; i < i1; i++) {
            const v = vs[i];
            if (v == null || ts[i] - prevT > gap) { if (decim) flushCol(); seg = null; }
            if (v == null) continue;
            if (!seg) { seg = []; segs.push(seg); }
            const x = this.X(ts[i]), y = this.Y(yi, tf(v));
            prevT = ts[i];
            if (!decim) { seg.push(x, y); continue; }
            const px = Math.round(x);
            if (px !== cx) { flushCol(); cx = px; fy = lo = hi = ly = y; }
            else { if (y < lo) lo = y; if (y > hi) hi = y; ly = y; }
        }
        if (decim) flushCol();
        if (!segs.length) return;
        const path = sg => {
            ctx.moveTo(sg[0], sg[1]);
            if (style === 'step') {
                for (let k = 2; k < sg.length; k += 2) { ctx.lineTo(sg[k], sg[k - 1]); ctx.lineTo(sg[k], sg[k + 1]); }
            } else if (style === 'smooth' && !decim && sg.length > 4) {
                for (let k = 2; k < sg.length - 2; k += 2) ctx.quadraticCurveTo(sg[k], sg[k + 1], (sg[k] + sg[k + 2]) / 2, (sg[k + 1] + sg[k + 3]) / 2);
                ctx.lineTo(sg[sg.length - 2], sg[sg.length - 1]);
            } else for (let k = 2; k < sg.length; k += 2) ctx.lineTo(sg[k], sg[k + 1]);
        };
        const fill = s.row == null && !s.dash && (style === 'area' || style === 'bars' || ((style === 'auto' || style === 'smooth') && s.area));
        if (fill) {
            const neg = s.neg && !this.split;
            const gr = ctx.createLinearGradient(0, g.top, 0, g.top + g.h);
            gr.addColorStop(neg ? 1 : 0, hexA(col, 0.3));
            gr.addColorStop(neg ? 0 : 1, hexA(col, 0.02));
            ctx.fillStyle = gr;
            for (const sg of segs) {
                if (sg.length < 4) continue;
                ctx.beginPath();
                path(sg);
                ctx.lineTo(sg[sg.length - 2], base);
                ctx.lineTo(sg[0], base);
                ctx.closePath();
                ctx.fill();
            }
        }
        ctx.strokeStyle = col;
        ctx.lineWidth = s.row != null ? 2 : s.dash ? 1.2 : 1.8;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = s.dash ? 0.75 : 1;
        ctx.setLineDash(s.dash ? [4, 3] : []);
        ctx.beginPath();
        for (const sg of segs) {
            if (sg.length === 2) { ctx.moveTo(sg[0] - 1, sg[1]); ctx.lineTo(sg[0] + 1, sg[1]); } else path(sg);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    }
}

// Текущий диапазон оси (ручной, показанный или авто) - от него считается масштабирование:
const yRange = (c, yi) => (S.y[c.hkey] && S.y[c.hkey][yi]) || c.yCur[yi] || c.autoY(yi);
const invalidate = () => S.charts.forEach(c => { c.dirty = true; });

//
// Подсказка при наведении: только на графике под курсором.
//
let hover = null;  // {c, px, cx, cy}.


// Ближайшая к времени точка с данными:
function nearestIdx(ts, vs, t) {
    const i = lowerBound(ts, t);
    let best = -1, bd = Infinity;
    for (let j = Math.max(0, i - 3); j < Math.min(ts.length, i + 3); j++) {
        if (vs[j] == null) continue;
        const d = Math.abs(ts[j] - t);
        if (d < bd) { bd = d; best = j; }
    }
    if (best < 0 && i >= ts.length) for (let j = ts.length - 1; j >= Math.max(0, ts.length - 8); j--) if (vs[j] != null) return j;
    return best;
}


// Подсказка и точки под курсором:
function renderHover() {
    if (!hover || !hover.c.ctx || !hover.c.geo) { if (tipOwner === 'chart') hideHover(); return; }
    const c = hover.c, span = S.view.to - S.view.from, pw = c.plotW();
    const t = S.view.from + clamp((hover.px - GRID.l) / pw, 0, 1) * span;
    let snap = null, dots = '', html = '', pane = -1, count = 0;
    for (const s of c.sl) {
        if (!isVis(s)) continue;
        const d = S.data[srcOf(s.sk)], vs = d && d.cols[keyOf(s.sk)];
        if (!vs) continue;
        const j = nearestIdx(d.t, vs, t);
        if (j < 0) continue;
        const tj = d.t[j], tol = Math.max(span / pw * 16, d.b * 1.5);
        const tail = j >= d.t.length - 8 && t > tj && t - tj < span * 0.2;
        if (Math.abs(tj - t) > tol && !tail) continue;
        if (snap == null) snap = tj;
        const v = c.tf(s)(vs[j]);
        if (count < 18) {
            if (c.split && s.pane !== pane) { pane = s.pane; html += `<div class="tt-grp">${esc(c.panes[pane].title)}</div>`; }
            html += `<div class="tt-row"><i style="background:${colorOf(s)}"></i><span>${esc(s.name)}</span><b>${c.fmtValue(s, v)}</b></div>`;
        }
        count++;
        const g = c.geo[s.pane], y = c.Y(s.yi, v);
        if (y >= g.top - 3 && y <= g.top + g.h + 3) dots += `<i style="left:${c.X(tj)}px;top:${y}px;background:${colorOf(s)}"></i>`;
    }
    if (snap == null) { tipHide('chart'); c.xl.style.opacity = 0; c.dotsEl.innerHTML = ''; return; }
    // Линия времени: заметная на текущем графике, едва видимая на остальных:
    for (const o of S.charts) {
        if (!o.geo || o.wrap.hidden) continue;
        const px = o.X(snap), g0 = o.geo[0], g1 = o.geo[o.geo.length - 1];
        o.xl.style.transform = `translateX(${px}px)`;
        o.xl.style.top = g0.top - g0.title + 'px';
        o.xl.style.height = g1.top + g1.h - g0.top + g0.title + 'px';
        o.xl.style.opacity = px < GRID.l || px > o.cw - o.right ? 0 : (o === c ? 0.5 : 0.12);
        if (o !== c) o.dotsEl.innerHTML = '';
    }
    c.dotsEl.innerHTML = dots;
    tipShow(`<div class="tt-time">${timeLabel(snap * 1000, span < 300)}</div>${html}${count > 18 ? TR`<div class="tt-grp">… ещё ${count - 18}</div>` : ''}`, hover.cx, hover.cy, 'chart');
}


// Убрать подсказку графиков:
function hideHover() {
    hover = null;
    tipHide('chart');
    for (const o of S.charts) { o.xl.style.opacity = 0; o.dotsEl.innerHTML = ''; }
}

//
// Колесо, мышь, тач.
//
function bindChart(c) {
    const el = c.wrap;
    const inPlot = (px, py) => {
        const g0 = c.geo[0], g1 = c.geo[c.geo.length - 1];
        return px >= GRID.l && px <= c.cw - c.right && py >= g0.top - g0.title && py <= g1.top + g1.h;
    };
    const fracX = px => clamp((px - GRID.l) / c.plotW(), 0, 1);

    el.addEventListener('wheel', e => {
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
        const delta = horizontal ? e.deltaX : e.deltaY;
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        // Shift+колесо или колесо над шкалами - обычная прокрутка страницы:
        if (e.shiftKey) { e.preventDefault(); window.scrollBy(0, delta * unit); return; }
        if (!inPlot(px, py) || !delta) return;
        e.preventDefault();
        const f = Math.exp(clamp(delta * unit, -300, 300) * 0.0015);
        const span = S.view.to - S.view.from;
        if (e.ctrlKey) {                 // Масштаб по высоте панели под курсором.
            const pi = c.paneAt(py), g = c.geo[pi], fy = clamp(1 - (py - g.top) / g.h, 0, 1);
            S.y[c.hkey] = S.y[c.hkey] || {};
            c.panes[pi].axes.forEach((ax, k) => {
                if (ax.flags) return;
                const yi = c.panes[pi].y0 + k, r = yRange(c, yi), v = r.min + fy * (r.max - r.min);
                S.y[c.hkey][yi] = { min: v - (v - r.min) * f, max: v + (r.max - v) * f };
            });
            c.dirty = true;
        } else if (e.altKey) {           // Влево / вправо.
            panBy(span * 0.08 * Math.sign(delta) * clamp(Math.abs(delta * unit) / 100, 0.3, 4));
        } else if (horizontal) {         // Горизонтальная прокрутка тачпада.
            panBy(delta * unit / c.plotW() * span);
        } else {                         // Масштаб времени вокруг курсора.
            zoomAt(S.view.from + fracX(px) * span, f);
        }
        hover = { c, px, cx: e.clientX, cy: e.clientY };
    }, { passive: false });

    el.addEventListener('dblclick', () => { delete S.y[c.hkey]; c.dirty = true; });

    // Два пальца на графике - жест наш, браузер не должен прокручивать страницу:
    const stopTwo = e => { if (e.touches.length >= 2) e.preventDefault(); };
    el.addEventListener('touchstart', stopTwo, { passive: false });
    el.addEventListener('touchmove', stopTwo, { passive: false });

    const ptrs = new Map();
    let g = null, lastTap = 0;
    const start = () => {
        const pts = [...ptrs.values()];
        g = { view: { ...S.view }, pts: pts.map(p => ({ ...p })), moved: false };
        if (pts.length === 2) {
            const rect = el.getBoundingClientRect();
            g.c0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            g.dx0 = Math.abs(pts[0].x - pts[1].x);
            g.dy0 = Math.abs(pts[0].y - pts[1].y);
            g.pane = c.paneAt(g.c0.y - rect.top);
            g.yr0 = c.panes[g.pane].axes.map((ax, k) => ax.flags ? null : { ...yRange(c, c.panes[g.pane].y0 + k) });
        }
        S.gesture = true;
        S.gestureChart = c;
    };
    el.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        start();
    });
    el.addEventListener('pointermove', e => {
        const rect = el.getBoundingClientRect();
        if (!ptrs.has(e.pointerId) || !g) {
            if (e.pointerType === 'mouse') { hover = { c, px: e.clientX - rect.left, cx: e.clientX, cy: e.clientY }; renderHover(); }
            return;
        }
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = [...ptrs.values()];
        const span0 = g.view.to - g.view.from;
        if (pts.length === 1 && g.pts.length === 1) {
            const dx = pts[0].x - g.pts[0].x;
            if (!g.moved && Math.abs(dx) < 4) return;
            if (!g.moved) { g.moved = true; try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ } el.classList.add('dragging'); }
            const dt = -dx / c.plotW() * span0;
            setView(g.view.from + dt, g.view.to + dt);
            hover = { c, px: e.clientX - rect.left, cx: e.clientX, cy: e.clientY };
        } else if (pts.length === 2 && g.c0) {
            // Как в картах: разводим по горизонтали - масштаб времени, по вертикали - масштаб по высоте,
            // двигаем двумя пальцами - листаем в обе стороны.
            g.moved = true;
            const c1 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            const dx1 = Math.abs(pts[0].x - pts[1].x), dy1 = Math.abs(pts[0].y - pts[1].y);
            const sx = g.dx0 > 40 ? g.dx0 / Math.max(dx1, 12) : 1;
            const ns = clamp(span0 * sx, MIN_SPAN, MAX_SPAN);
            const anchor = g.view.from + fracX(g.c0.x - rect.left) * span0;
            const nf = anchor - fracX(c1.x - rect.left) * ns;
            setView(nf, nf + ns);
            if (g.dy0 > 40 || Math.abs(c1.y - g.c0.y) > 12) {
                const geo = c.geo[g.pane], sy = g.dy0 > 40 ? g.dy0 / Math.max(dy1, 12) : 1;
                const f0 = 1 - (g.c0.y - rect.top - geo.top) / geo.h, f1 = 1 - (c1.y - rect.top - geo.top) / geo.h;
                S.y[c.hkey] = S.y[c.hkey] || {};
                g.yr0.forEach((r0, k) => {
                    if (!r0) return;
                    const h0 = r0.max - r0.min, nh = h0 * sy, v = r0.min + f0 * h0, mn = v - f1 * nh;
                    S.y[c.hkey][c.panes[g.pane].y0 + k] = { min: mn, max: mn + nh };
                });
                c.dirty = true;
            }
            hideHover();
        }
    });
    const end = e => {
        if (!ptrs.delete(e.pointerId)) return;
        el.classList.remove('dragging');
        if (ptrs.size) { start(); return; }
        const moved = g && g.moved;
        g = null;
        S.gesture = false;
        S.gestureChart = null;
        store.set('span', S.span);
        scheduleLoad();
        if (!moved && e.pointerType !== 'mouse' && e.type === 'pointerup') {
            const now = performance.now();
            if (now - lastTap < 320) { delete S.y[c.hkey]; c.dirty = true; hideHover(); lastTap = 0; return; }  // Двойной тап - сброс высоты.
            lastTap = now;
            const rect = el.getBoundingClientRect();
            hover = { c, px: e.clientX - rect.left, cx: e.clientX, cy: e.clientY - 90 };
            renderHover();
        }
        if (moved) maybeLive();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !g) hideHover(); });
}

// Ручка изменения высоты графика:
function bindGrabber(c, grab) {
    grab.addEventListener('pointerdown', e => {
        e.preventDefault();
        grab.setPointerCapture(e.pointerId);
        const y0 = e.clientY, h0 = c.wrap.offsetHeight;
        const move = ev => { c.wrap.style.height = clamp(h0 + ev.clientY - y0, 120, 1600) + 'px'; c.resize(); };
        const up = () => {
            grab.removeEventListener('pointermove', move);
            S.heights[c.hkey] = c.wrap.offsetHeight;
            store.set('heights2', S.heights);
        };
        grab.addEventListener('pointermove', move);
        grab.addEventListener('pointerup', up, { once: true });
        grab.addEventListener('pointercancel', up, { once: true });
    });
}

//
// Навигация по времени. Правая граница никогда не уходит дальше «сейчас».
//
function setView(from, to, keepLive = false) {
    const span = clamp(to - from, MIN_SPAN, MAX_SPAN);
    to = Math.min(to, nowSec());
    if (!keepLive && S.live) setLive(false);
    S.view = { from: to - span, to };
    S.span = span;
    if (!S.gesture) { store.set('span', S.span); scheduleLoad(); }
}


// Включить или выключить режим Live:
function setLive(v) {
    S.live = v;
    $('#live').classList.toggle('on', v);
    if (v) { const now = nowSec(); S.view = { from: now - S.span, to: now }; scheduleLoad(); }
}


// Если пользователь сам дошёл до «сейчас» - плавно включаем слежение, без скачка:
function maybeLive() {
    if (!S.live && nowSec() - S.view.to <= Math.max(1.5, (S.view.to - S.view.from) * 0.01)) setLive(true);
}


// Масштаб времени вокруг точки t:
function zoomAt(t, f) {
    const { from, to } = S.view, span = to - from;
    const ns = clamp(span * f, MIN_SPAN, MAX_SPAN);
    if (ns === span) return;
    if (S.live) { const now = nowSec(); setView(now - ns, now, true); return; }
    const nf = t - (t - from) * (ns / span);
    setView(nf, nf + ns);
    maybeLive();
}


// Сдвинуть окно времени:
function panBy(dt) {
    setView(S.view.from + dt, S.view.to + dt);
    if (dt > 0) maybeLive();
}

//
// Компоненты: кольца, плашки, спарклайны.
//
function ringSVG(size = 100, stroke = 9) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, m = size / 2;
    return `<svg viewBox="0 0 ${size} ${size}"><circle class="ring-bg" cx="${m}" cy="${m}" r="${r}" stroke-width="${stroke}"/>
        <circle class="ring-fg" cx="${m}" cy="${m}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 ${m} ${m})"/></svg>`;
}


// Заполнить кольцо:
function setRing(svg, pct, color) {
    const fg = svg.querySelector('.ring-fg');
    const c = +fg.getAttribute('stroke-dasharray'), off = String(c * (1 - clamp(pct || 0, 0, 100) / 100));
    if (fg.getAttribute('stroke-dashoffset') !== off) fg.setAttribute('stroke-dashoffset', off);
    if (fg.style.stroke !== color) fg.style.stroke = color;
}


// items: [{k, pct, val, label, sub, color, tip}] - значения в центре «прокручиваются»:
function renderRings(host, items) {
    const sig = items.map(i => i.k).join('|');
    if (host.dataset.sig !== sig) {
        host.innerHTML = items.map(i => `<div class="rc" data-k="${esc(i.k)}"><div class="rc-box">${ringSVG()}<div class="rc-c"><b><span class="odo"></span></b><span></span></div></div><div class="rc-sub"></div></div>`).join('');
        host.dataset.sig = sig;
    }
    items.forEach((it, n) => {
        const el = host.children[n];
        setRing($('svg', el), it.pct, it.color);
        odo($('.odo', el), it.val);
        $('.rc-c > span', el).textContent = it.label;
        odoIn($('.rc-sub', el), it.sub || '');
        el.title = it.tip || '';
    });
}


// items: [{k, label, val, unit, cls}] - плашки создаются один раз, дальше меняются только значения:
function renderStats(host, items) {
    const sig = items.map(i => i.k || i.label).join('|');
    if (host.dataset.sig !== sig) {
        host.innerHTML = items.map(() => `<div class="st"><span></span><b><span class="odo"></span><small></small></b></div>`).join('');
        host.dataset.sig = sig;
    }
    items.forEach((it, n) => {
        const el = host.children[n], cls = 'st ' + (it.cls || '');
        if (el.className !== cls) el.className = cls;
        const lab = el.firstElementChild;
        if (lab.textContent !== it.label) lab.textContent = it.label;
        odo($('.odo', el), it.val ?? '—');
        const sm = $('small', el), u = it.unit || '';
        if (sm.textContent !== u) sm.textContent = u;
    });
}
const kvHTML = rows => rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v ?? '—')}</span></div>`).join('');
const st = (k, label, val, unit = '', cls = '') => ({ k, label, val, unit, cls });

// Мини-графики едут плавно: новая точка въезжает справа за время между опросами,
// шкала по высоте тоже меняется плавно. Рисуются в общем цикле кадров, только видимые.
const SPARKS = new Set();
const sparkIO = window.IntersectionObserver ? new IntersectionObserver(es => es.forEach(e => {
    const cv = e.target;
    cv.spVis = e.isIntersecting;
    if (!cv.spVis) { cv.width = 0; cv.height = 0; } else if (cv.sp) paintSpark(cv, performance.now(), true);  // За экраном холст памяти не занимает.
}), { rootMargin: '200px' }) : null;


// Нарисовать мини-график (tick - метка новых данных: сменилась - значит, пришла новая точка):
function drawSpark(cv, series, n = 60, tick = null) {
    let sp = cv.sp;
    if (!sp) {
        sp = cv.sp = { lag: 0, lagAt: 0, dt: 1000, mx: [] };
        SPARKS.add(cv);
        if (sparkIO) sparkIO.observe(cv); else cv.spVis = true;
    }
    const now = performance.now();
    if (tick != null && tick !== sp.tick) {
        if (sp.tick != null) {
            sp.dt = sp.dt * 0.7 + clamp(now - sp.at, 250, 5000) * 0.3;  // Средний интервал между точками.
            const lag = sparkLag(sp, now);
            sp.lag = lag > 1.5 ? 1 : lag + 1;  // Отстали больше чем на точку - не догоняем, а перескакиваем.
            sp.lagAt = now;
        }
        sp.tick = tick;
        sp.at = now;
    }
    sp.series = series;
    sp.n = n;
    if (cv.spVis) paintSpark(cv, now, true);
}


// Сколько ещё точек графику осталось проехать влево:
const sparkLag = (sp, now) => Math.max(0, sp.lag - (now - sp.lagAt) / sp.dt);


// Отрисовать мини-график в текущем положении (force - даже если сдвиг незаметен):
function paintSpark(cv, now, force) {
    const sp = cv.sp, el = now - (sp.t || now);
    sp.t = now;
    const k = 1 - Math.exp(-el / 250), lag = sparkLag(sp, now);
    sp.busy = lag > 0;
    let scaling = false;
    sp.series.forEach((s, j) => {
        const target = s.max || 100;
        sp.mx[j] = sp.mx[j] == null ? target : sp.mx[j] + (target - sp.mx[j]) * k;
        if (Math.abs(target - sp.mx[j]) > target * 0.002) sp.busy = scaling = true; else sp.mx[j] = target;
    });
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX), w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    // Сдвиг меньше четверти пикселя глазом не виден - холст не трогаем:
    const shiftPx = lag * w / (sp.n - 2);
    if (!force && !scaling && Math.abs(shiftPx - (sp.shiftPx ?? -99)) < 0.25) return;
    sp.shiftPx = shiftPx;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // На экране n - 1 точек: самая левая уезжает за край, новая въезжает справа:
    const n = sp.n, step = w / (n - 2), shift = lag * step;
    sp.series.forEach((s, j) => {
        const vals = s.vals, max = sp.mx[j];
        if (!vals || !vals.length) return;
        const off = n - vals.length;
        const xy = vals.map((v, i) => [(off + i - 1) * step + shift, h - clamp((v || 0) / max, 0, 1) * (h - 3) - 1.5]);
        const path = () => { ctx.beginPath(); xy.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
        if (s.fill) {
            path();
            ctx.lineTo(xy[xy.length - 1][0], h);
            ctx.lineTo(xy[0][0], h);
            ctx.closePath();
            const gr = ctx.createLinearGradient(0, 0, 0, h);
            gr.addColorStop(0, hexA(s.color, 0.32));
            gr.addColorStop(1, hexA(s.color, 0.02));
            ctx.fillStyle = gr;
            ctx.fill();
        }
        path();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();
    });
}


// Кадр для мини-графиков: двигаются только видимые и только пока есть куда ехать:
function sparkFrame(ts) {
    if (TOUCH && S.gesture) return;
    for (const cv of SPARKS) {
        if (!cv.isConnected) { SPARKS.delete(cv); if (sparkIO) sparkIO.unobserve(cv); continue; }
        if (!cv.spVis || !cv.sp.busy) continue;
        if (ts - cv.sp.t < 32) continue;  // Не чаще ~30 раз в секунду.
        paintSpark(cv, ts, false);
    }
}


// Максимум шкалы спарклайна растёт сразу, а уменьшается плавно - без прыжков:
function smoothMax(key, target) {
    const cur = S.kpiMax[key];
    S.kpiMax[key] = cur == null || target > cur ? target : cur * 0.96 + target * 0.04;
    return S.kpiMax[key];
}


// Добавить значение в короткую историю:
function pushHist(key, v, n = 90) {
    const h = S.hist[key] = S.hist[key] || [];
    h.push(v == null ? null : +v);
    if (h.length > n) h.shift();
}

//
// 3D: загрузка потоков CPU за 60 секунд (three.js, подгружается только для этого виджета).
//
let threePromise = null;
const loadThree = () => threePromise || (threePromise = import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js'));

// Создать 3D-вид потоков CPU:
async function create3D(box, onCam) {
    const THREE = await loadThree();
    const M = 60, SX = 0.55, SZ = 1.0, HMAX = 7;
    const renderer = new THREE.WebGLRenderer({ antialias: !TOUCH, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_MAX));
    renderer.setClearColor(0x000000, 0);
    box.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
    scene.add(new THREE.HemisphereLight(0xffffff, new THREE.Color(T.bg), 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-20, 40, 25);
    scene.add(sun);

    let N = 0, mode = null, bars = null, surf = null, wire = null, floor = null;
    let cur = new Float32Array(0), tgt = new Float32Array(0), lastSample = 0;
    const cam = Object.assign({ theta: 0.7, phi: 1.05, radius: 42 }, S.cam3d || {});
    const vel = { t: 0, p: 0 };
    let idleSince = 0, raf = 0, active = false, prevTs = 0, dragging = false;
    const dummy = new THREE.Object3D(), color = new THREE.Color();
    const stops = [[0, new THREE.Color(T.surface3)], [15, new THREE.Color(T.accent)], [60, new THREE.Color(T.warn)], [90, new THREE.Color(T.bad)]];
    const heatColor = (v, out) => {
        let i = 0;
        while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
        const k = clamp((v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]), 0, 1);
        return out.copy(stops[i][1]).lerp(stops[i + 1][1], k);
    };

    function setup(n) {
        N = n;
        for (const o of [bars, surf, wire, floor]) if (o) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
        bars = surf = wire = null;
        cur = new Float32Array(M * N); tgt = new Float32Array(M * N);
        const W = M * SX, D = N * SZ;
        floor = new THREE.Mesh(new THREE.PlaneGeometry(W + 1.5, D + 1.5), new THREE.MeshStandardMaterial({ color: new THREE.Color(T.surface2), roughness: 0.9 }));
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -0.02;
        scene.add(floor);
        mode = null;
    }
    function setMode(m) {
        if (m === mode || !N) return;
        mode = m;
        for (const o of [bars, surf, wire]) if (o) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
        bars = surf = wire = null;
        if (m === 'bar') {
            const geo = new THREE.BoxGeometry(SX * 0.82, 1, SZ * 0.78);
            geo.translate(0, 0.5, 0);
            bars = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.08 }), M * N);
            bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            for (let i = 0; i < M * N; i++) bars.setColorAt(i, color.set(T.surface3));
            scene.add(bars);
        } else {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M * N * 3), 3).setUsage(THREE.DynamicDrawUsage));
            geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(M * N * 3), 3).setUsage(THREE.DynamicDrawUsage));
            const idx = [];
            for (let z = 0; z < N - 1; z++) for (let x = 0; x < M - 1; x++) {
                const a = z * M + x, b = a + 1, c = a + M, d = c + 1;
                idx.push(a, c, b, b, c, d);
            }
            geo.setIndex(idx);
            surf = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
            wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(T.text), wireframe: true, transparent: true, opacity: 0.08 }));
            scene.add(surf, wire);
        }
    }
    // Новый замер: всё поле сдвигается на столбец, свежий столбец «вырастает» справа.
    function push(hist) {
        const n = hist.length ? hist[hist.length - 1].length : 0;
        if (!n) return;
        if (n !== N) setup(n);
        if (!mode) setMode(S.c3dMode);
        const first = lastSample === 0;
        for (let z = 0; z < N; z++) for (let x = 0; x < M; x++) {
            const row = hist[hist.length - M + x];
            tgt[z * M + x] = row ? row[z] : 0;
            if (first) cur[z * M + x] = tgt[z * M + x];
            else cur[z * M + x] = x < M - 1 ? cur[z * M + x + 1] : 0;
        }
        lastSample = performance.now();
    }
    function frame(ts) {
        raf = active ? requestAnimationFrame(frame) : 0;
        if (!active || document.hidden) return;
        const dt = Math.min(0.05, (ts - (prevTs || ts)) / 1000);
        prevTs = ts;
        // Управление камерой: инерция после перетаскивания, медленное вращение, если никто не трогает.
        if (!dragging) {
            cam.theta += vel.t; cam.phi = clamp(cam.phi + vel.p, 0.25, 1.45);
            vel.t *= 0.92; vel.p *= 0.92;
            if (ts - idleSince > 2500) cam.theta += dt * 0.12;
        }
        const tx = 0, ty = 1.6, tz = 0;
        camera.position.set(tx + cam.radius * Math.sin(cam.phi) * Math.sin(cam.theta), ty + cam.radius * Math.cos(cam.phi), tz + cam.radius * Math.sin(cam.phi) * Math.cos(cam.theta));
        camera.lookAt(tx, ty, tz);
        if (N) {
            const k = 1 - Math.exp(-dt * 9), frac = clamp((ts - lastSample) / 1000, 0, 1);
            const W = M * SX, D = N * SZ;
            for (let i = 0; i < M * N; i++) cur[i] += (tgt[i] - cur[i]) * k;
            if (bars) {
                for (let z = 0; z < N; z++) for (let x = 0; x < M; x++) {
                    const i = z * M + x, v = cur[i] * (x === 0 ? 1 - frac : 1);  // Самый старый столбец плавно уходит.
                    dummy.position.set((x - M + 1 - frac) * SX + W / 2 - SX / 2, 0, z * SZ - D / 2 + SZ / 2);
                    dummy.scale.set(1, Math.max(0.03, v / 100 * HMAX), 1);
                    dummy.updateMatrix();
                    bars.setMatrixAt(i, dummy.matrix);
                    bars.setColorAt(i, heatColor(v, color));
                }
                bars.instanceMatrix.needsUpdate = true;
                bars.instanceColor.needsUpdate = true;
            } else if (surf) {
                const pos = surf.geometry.attributes.position, col = surf.geometry.attributes.color;
                for (let z = 0; z < N; z++) for (let x = 0; x < M; x++) {
                    const i = z * M + x, v = cur[i];
                    pos.setXYZ(i, (x - M + 1 - frac) * SX + W / 2, v / 100 * HMAX, z * SZ - D / 2 + SZ / 2);
                    heatColor(v, color);
                    col.setXYZ(i, color.r, color.g, color.b);
                }
                pos.needsUpdate = true; col.needsUpdate = true;
                surf.geometry.computeVertexNormals();
            }
        }
        renderer.render(scene, camera);
    }
    function setActive(v) {
        active = v;
        if (v && !raf) { prevTs = 0; raf = requestAnimationFrame(frame); }
    }
    function resize() {
        const w = box.clientWidth, h = box.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    // Вращение мышью/пальцем (по вертикали на телефоне - прокрутка страницы):
    const cv = renderer.domElement;
    let last = null, saveT = 0;
    cv.addEventListener('pointerdown', e => { dragging = true; last = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); vel.t = vel.p = 0; });
    cv.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - last.x, dy = e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        vel.t = -dx * 0.006; vel.p = e.pointerType === 'mouse' ? -dy * 0.006 : 0;
        cam.theta += vel.t; cam.phi = clamp(cam.phi + vel.p, 0.25, 1.45);
        idleSince = performance.now();
    });
    const release = () => {
        dragging = false; idleSince = performance.now();
        clearTimeout(saveT);
        saveT = setTimeout(() => onCam({ ...cam }), 400);
    };
    cv.addEventListener('pointerup', release);
    cv.addEventListener('pointercancel', release);
    resize();
    return {
        push, resize, setActive,

        // Сменить вид (столбцы / рельеф):
        setMode(m) { setMode(m); },

        // Освободить ресурсы:
        dispose() {
            active = false;
            cancelAnimationFrame(raf);
            for (const o of [bars, surf, wire, floor]) if (o) { o.geometry.dispose(); o.material.dispose(); }
            renderer.dispose();
            renderer.forceContextLoss();
            cv.remove();
        },
    };
}

//
// Виджеты.
//
const pcReady = () => S.pc && S.pc.cores;
const gpu0 = () => (pcReady() && S.pc.gpus[0]) || null;

const KPIS = [
    { k: 'cpu', label: i18n('Процессор'), go: 'cpu', src: 'pc', v: p => [fmt(p.cpu, 0), '%'],
        s: p => TR`${p.freq ?? '—'} МГц${p.cpu_temp != null ? ' · ' + fmt(p.cpu_temp, 0) + ' °C' : ''}`, cls: p => lvlCls(p.cpu), h: ['cpu'], max: 100 },
    { k: 'gpu', label: i18n('Видеокарта'), go: 'gpu', src: 'pc', v: () => gpu0() ? [fmt(gpu0().util, 0), '%'] : ['—', ''],
        s: () => { const g = gpu0(); return g ? `${fmt(g.temp, 0)} °C · VRAM ${fmt(g.mem_used / g.mem_total * 100, 0)}%` : i18n('нет данных'); },
        cls: () => gpu0() ? lvlCls(gpu0().util) : '', h: ['gpu'], max: 100 },
    { k: 'ram', label: i18n('Память'), go: 'mem', src: 'pc', v: p => [fmt(p.ram.percent, 0), '%'],
        s: p => TR`${fmtBytes(p.ram.used)} из ${fmtBytes(p.ram.total)}`, cls: p => lvlCls(p.ram.percent), h: ['ram'], max: 100 },
    { k: 'net', label: i18n('Сеть ↓'), go: 'net', src: 'pc', v: p => splitUnit(fmtRate(p.net.rx)), s: p => `↑ ${fmtRate(p.net.tx)}`, h: ['rx', 'tx'] },
    { k: 'disk', label: i18n('Диски'), go: 'mem', src: 'pc', v: p => splitUnit(fmtRate(p.disk_io.read + p.disk_io.write)),
        s: p => TR`чтение ${fmtRate(p.disk_io.read)} · запись ${fmtRate(p.disk_io.write)}`, h: ['dr', 'dw'] },
    { k: 'ups', label: i18n('Сеть 220 В'), go: 'ups', src: 'ups', v: u => [fmt(u.input_voltage, 0), i18n('В')],
        s: u => TR`нагрузка ${u.load_percent}% · АКБ ${u.battery_percent_est}%`, cls: u => u.on_battery ? 'bad' : 'good', h: ['vin'] },
];

// Подсказка по потоку CPU:
function renderTileTip() {
    const t = S.tile;
    if (!t || !pcReady()) return;
    const i = t.i, hist = S.pc.cores_hist.map(r => r[i]).filter(v => v != null);
    const avg = hist.reduce((a, b) => a + b, 0) / (hist.length || 1);
    const perCore = Math.max(1, Math.round(S.pc.cores_logical / S.pc.cores_physical)), core = Math.floor(i / perCore);
    const ci = coreInfo().find(c => c.n === core + 1);
    const row = (k, v) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`;
    tipShow(TR`<div class="tt-title">Поток ${i} · ядро ${core}</div>
        ${row(i18n('Сейчас'), fmt(S.pc.cores[i], 1) + ' %')}${row(TR`Среднее за ${hist.length} с`, fmt(avg, 1) + ' %')}${row(TR`Пик за ${hist.length} с`, fmt(Math.max(...hist, 0), 1) + ' %')}
        ${ci ? TR`<div class="tt-grp">Ядро ${core}</div>${row(i18n('Частота'), fmt(ci.clk, 0) + i18n(' МГц'))}${ci.eff != null ? row(i18n('Эффективная'), fmt(ci.eff, 0) + i18n(' МГц')) : ''}` +
            `${ci.pw != null ? row(i18n('Мощность'), fmt(ci.pw, 2) + i18n(' Вт')) : ''}${ci.vid != null ? row('VID', fmt(ci.vid, 3) + i18n(' В')) : ''}${ci.temp != null ? row(i18n('Температура'), fmt(ci.temp, 1) + ' °C') : ''}` : ''}`,
        t.cx, t.cy, 'tile');
}

// Подписи узлов схемы «Поток энергии»: [x, y, выравнивание] - название, под ним значение и подпись.
const FLOW_TXT = {
    h: { grid: [80, 166, 'middle'], ups: [300, 18, 'middle'], pc: [520, 166, 'middle'], bat: [350, 228, 'start'] },
    v: { grid: [222, 44, 'start'], ups: [222, 176, 'start'], pc: [222, 332, 'start'], bat: [14, 252, 'start'] },
};
const FLOW_VB = { h: [600, 290], v: [340, 400] };


// Схема «Поток энергии»: горизонтальная для широкого виджета, вертикальная для узкого (значения - svgLabels).
function flowSVG(lay) {
    const H = lay === 'h';
    const N = H ? { grid: [80, 110], ups: [300, 110], pc: [520, 110], bat: [300, 236] } : { grid: [170, 52], ups: [170, 196], pc: [170, 340], bat: [56, 196] };
    const L = H ? { grid: 'M116 110 H264', pc: 'M336 110 H484', bat: 'M300 200 V146' } : { grid: 'M170 88 V160', pc: 'M170 232 V304', bat: 'M92 196 H134' };
    const txt = FLOW_TXT[lay];
    const names = { grid: i18n('Сеть'), ups: i18n('ИБП'), pc: i18n('Компьютер'), bat: i18n('Аккумулятор') };
    const node = k => {
        const [x, y] = N[k], [tx, ty, anc] = txt[k];
        return `<g class="fl-node" id="fn-${k}">
            <circle class="halo" cx="${x}" cy="${y}" r="36"/><circle class="bg" cx="${x}" cy="${y}" r="34"/>
            <g class="ic" transform="translate(${x - 14} ${y - 14}) scale(1.1667)" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${FL_ICON[k]}</g>
            <text class="fl-name" x="${tx}" y="${ty}" text-anchor="${anc}">${names[k]}</text></g>`;
    };
    const link = k => `<path class="fl-link" d="${L[k]}"/><path class="fl-dash" id="fl-${k}" d="${L[k]}"/>`;
    return `<svg viewBox="${H ? '0 0 600 290' : '0 0 340 400'}">${link('grid')}${link('pc')}${link('bat')}${node('grid')}${node('ups')}${node('pc')}${node('bat')}</svg>`;
}

// Числа на SVG-схемах - HTML-подписи поверх рисунка: так они крутятся тем же счётчиком, что и везде.
// items: [{k, x, y, fs, a, cls, html}]: x, y (центр подписи) и fs (размер шрифта) - в единицах viewBox, a - 'middle' | 'start' | 'end'.
function svgLabels(host, vbW, vbH, items) {
    $$(':scope > .svl', host).forEach(e => e.remove());
    host.classList.add('svl-host');
    host.style.setProperty('--vbw', vbW);
    const out = {};
    for (const it of items) {
        const el = document.createElement('div');
        el.className = 'svl ' + (it.cls || '');
        el.dataset.a = it.a || 'middle';
        el.style.left = (it.x / vbW * 100).toFixed(3) + '%';
        el.style.top = (it.y / vbH * 100).toFixed(3) + '%';
        el.style.setProperty('--fs', it.fs);
        el.innerHTML = it.html || '<span class="odo"></span>';
        host.appendChild(el);
        out[it.k] = el;
    }
    return out;
}
const HUB_HTML = '<b><span class="odo"></span></b><small></small>';  // Обороты в центре вентилятора.

// Вентилятор кулера процессора (вид сверху): крутится по реальным оборотам, обороты - в центре (подписи - svgLabels).
function cpuFanSVG() {
    const blades = [...Array(7)].map((_, i) => `<use href="#cfan-blade" transform="rotate(${(i * 360 / 7).toFixed(2)})"/>`).join('');
    return `<svg viewBox="0 0 160 184" class="gv cfan">
        <defs><path id="cfan-blade" d="M3 -18 C 18 -23, 33 -35, 30 -55 C 21 -58, 9 -48, -6 -19 Z"/></defs>
        <circle class="cfan-frame" cx="80" cy="80" r="79"/>
        <g class="cfan-fan" transform="translate(80 80)"><title></title>
            <circle class="gv-hole" r="76"/><circle class="gv-ring" r="72"/><circle class="gv-blur cfan-blur" r="69"/>
            <g class="gv-blades cfan-blades"><g transform="scale(1.1)">${blades}</g></g>
            <circle class="gv-hub" r="25"/><circle class="gv-hub-in" r="21"/></g>
    </svg>`;
}

// Видеокарта «сбоку»: кожух с моделью, вентиляторы (крутятся по реальным оборотам),
// подсветка по температуре, разъём питания светится по потреблению. n - число вентиляторов (2 или 3).
function gpuCardSVG(n) {
    // Кожух 18..622 x 22..232, центр (320, 127). Два вентилятора - симметрично по центру кожуха,
    // между ними колонка: производитель, модель, панель GPU/TEMP/POWER и строка VRAM/частоты.
    // Три вентилятора - подписи в верхних углах, вентиляторы чуть меньше.
    const two = n !== 3;
    const cy = two ? 127 : 140, R = two ? 74 : 62, xs = two ? [146, 494] : [122, 320, 518], k = R / 70;
    const blades = [...Array(9)].map((_, i) => `<use href="#gv-blade" transform="rotate(${i * 40})"/>`).join('');
    const fans = xs.map(x => `<g class="gv-fan" transform="translate(${x} ${cy})"><title></title>
            <circle class="gv-hole" r="${R}"/><circle class="gv-ring" r="${R - 4}"/><circle class="gv-blur" r="${R - 7}"/>
            <g class="gv-blades"><g transform="scale(${(k * 1.04).toFixed(3)})">${blades}</g></g>
            <circle class="gv-hub" r="${Math.round(22 * k)}"/><circle class="gv-hub-in" r="${Math.round(18 * k)}"/></g>`).join('');
    const head = two
        ? `<text class="gv-brand" x="320" y="42" text-anchor="middle"></text><text class="gv-model gv-model-c" x="320" y="62" text-anchor="middle"></text>
              <g class="gv-panel" transform="translate(270 72)"><rect width="100" height="128" rx="12"/>
              ${['GPU', 'TEMP', 'POWER'].map((l, i) => `<text class="gv-pl" x="50" y="${22 + i * 38}">${l}</text>`).join('')}</g>`
        : `<text class="gv-brand" x="42" y="46"></text><text class="gv-model" x="42" y="66"></text>`;
    return `<svg viewBox="0 0 640 250" class="gv">
        <defs>
            <linearGradient id="gv-shroud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="gv-s1"/><stop offset="1" class="gv-s2"/></linearGradient>
            <path id="gv-blade" d="M3 -18 C 18 -23, 33 -35, 30 -55 C 21 -58, 9 -48, -6 -19 Z"/>
        </defs>
        <rect class="gv-bracket" x="4" y="12" width="14" height="226" rx="3"/>
        ${[0, 1, 2, 3, 4, 5].map(i => `<rect class="gv-vent" x="8.5" y="${38 + i * 30}" width="5" height="20" rx="2.5"/>`).join('')}
        <g class="gv-fingers">${[...Array(22)].map((_, i) => `<rect x="${110 + i * 10}" y="232" width="6.5" height="11" rx="1"/>`).join('')}</g>
        <rect class="gv-pwr" x="524" y="13" width="48" height="10" rx="3"/>
        <rect class="gv-body" x="18" y="22" width="604" height="210" rx="18"/>
        <rect class="gv-light" x="40" y="22" width="560" height="3" rx="1.5"/>
        ${fans}${head}
    </svg>`;
}

// ECharts для отдельных виджетов (тепловая карта, вольтметр, карта памяти, распределение):
function ecInit(w, el) {
    w.ec = echarts.init(el, null, TOUCH ? { renderer: 'svg' } : { devicePixelRatio: Math.min(window.devicePixelRatio || 1, DPR_MAX) });
    w.ecRO = new ResizeObserver(() => w.ec && w.ec.resize());
    w.ecRO.observe(el);
    return w.ec;
}


// Уничтожить график ECharts:
function ecDispose(w) { if (w.ecRO) w.ecRO.disconnect(); if (w.ec) w.ec.dispose(); w.ec = null; }
const ecText = () => ({ color: T.text3, fontSize: 11, fontFamily: T.font });
const ecTip = () => ({ backgroundColor: T.surface, borderColor: T.axis, textStyle: { color: T.text, fontFamily: T.font, fontSize: 12 }, extraCssText: 'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.35)' });


//
// Датчики LibreHardwareMonitor: поиск, единицы, сводки.
//
const lhmOk = () => !!(pcReady() && S.pc.lhm && S.pc.lhm.ok);
const sensAll = () => (pcReady() && S.pc.sensors) || [];


// Первый датчик по типу железа, типу и названию (re - строка или RegExp):
function sensFind(list, hwType, type, re) {
    const rx = re instanceof RegExp ? re : new RegExp(re, 'i');
    return list.find(x => (!hwType || hwTypeOf(x) === hwType) && (!type || x.type === type) && rx.test(x.name) && !THRESHOLD.test(x.name)) || null;
}
const sv = x => x ? x.value : null;


// Скорость в байтах/с из значения LHM с единицей («KB/s», «MB/s»...):
function toBps(v, unit) {
    if (v == null) return null;
    const u = String(unit || '').toUpperCase();
    return v * (u.startsWith('G') ? 1024 ** 3 : u.startsWith('M') ? 1024 ** 2 : u.startsWith('K') ? 1024 : 1);
}
// Объём в байтах («GB», «MB»):
const toBytes = (v, unit) => toBps(v, unit);
const SENS_TYPES = {
    Temperature: i18n('Температуры'), Voltage: i18n('Напряжения'), Clock: i18n('Частоты'), Power: i18n('Мощность'), Load: i18n('Загрузка'), Fan: i18n('Вентиляторы'),
    Control: i18n('Управление'), Current: i18n('Ток'), Data: i18n('Объём'), SmallData: i18n('Объём'), Throughput: i18n('Скорость'), Level: i18n('Уровни'), Factor: i18n('Прочее'),
    Frequency: i18n('Частоты'), Energy: i18n('Энергия'), Time: i18n('Прочее'), Flow: i18n('Прочее'),
};
const HW_NAMES = { cpu: i18n('процессор'), gpu: i18n('видеокарта'), superio: i18n('материнская плата'), mainboard: i18n('материнская плата'), ram: i18n('память'), storage: i18n('накопитель'), network: i18n('сеть'), battery: i18n('батарея') };
const HW_ORDER = ['cpu', 'gpu', 'superio', 'mainboard', 'ram', 'storage', 'network', 'battery'];


// Значение датчика с единицами:
function fmtSens(x) {
    const v = x.value, u = x.unit || '';
    if (v == null) return '—';
    switch (x.type) {
        case 'Voltage': return fmt(v, 3) + i18n(' В');
        case 'Current': return fmt(v, 2) + i18n(' А');
        case 'Clock': case 'Frequency': return fmt(v, 0) + i18n(' МГц');
        case 'Temperature': return fmt(v, 1) + ' °C';
        case 'Power': return fmt(v, 1) + i18n(' Вт');
        case 'Load': case 'Level': case 'Control': return fmt(v, 1) + ' %';
        case 'Fan': return fmt(v, 0) + ' rpm';
        case 'Throughput': return fmtRate(toBps(v, u));
        case 'Data': case 'SmallData': return fmtBytes(toBytes(v, u || (x.type === 'Data' ? 'GB' : 'MB')));
        default: return (Math.abs(v) >= 100 ? fmt(v, 0) : fmt(v, 2)) + (u ? ' ' + u : '');
    }
}
const fmtSensVal = (x, v) => v == null ? '—' : fmtSens({ ...x, value: v });

// Частоты, мощность и VID каждого ядра CPU (по названиям LHM «Core #N ...» / «CPU Core #N ...»):
function coreInfo() {
    const out = {};
    for (const x of sensAll()) {
        if (hwTypeOf(x) !== 'cpu') continue;
        const m = /Core #(\d+)/.exec(x.name);
        if (!m) continue;
        const c = out[m[1]] = out[m[1]] || { n: +m[1] };
        if (x.type === 'Clock') { if (/effective/i.test(x.name)) c.eff = x.value; else if (CORE_CLOCK.test(x.name)) { c.clk = x.value; c.max = x.max; } }
        else if (x.type === 'Power') c.pw = x.value;
        else if (x.type === 'Voltage') c.vid = x.value;
        else if (x.type === 'Temperature') c.temp = x.value;
        else if (x.type === 'Factor') c.mult = x.value;
    }
    return Object.values(out).filter(c => c.clk != null).sort((a, b) => a.n - b.n);
}

// Шины питания блока питания/материнки с номиналом и отклонением:
function railsInfo() {
    return sensAll().filter(x => x.type === 'Voltage' && (hwTypeOf(x) === 'superio' || (hwTypeOf(x) === 'cpu' && !/#\d/.test(x.name))))
        .map(x => {
            const nom = railNominal(x.name), dev = nom ? (x.value - nom) / nom * 100 : null;
            // Батарейка CMOS (CR2032) - не шина ATX: норма 2.8-3.4 В, садится - сбрасывается время/BIOS:
            const cls = nom === 3.0 ? (x.value < 2.6 ? 'bad' : x.value < 2.8 ? 'warn' : 'good') : devCls(dev);
            return { ...x, nom, dev, cls, sort: [12, 5, 3.3, 3.0].indexOf(nom) };
        })
        .sort((a, b) => (a.sort < 0 ? 9 : a.sort) - (b.sort < 0 ? 9 : b.sort));
}


// Цвет отклонения напряжения от номинала:
function devCls(d) { return d == null ? '' : Math.abs(d) >= 5 ? 'bad' : Math.abs(d) >= 3 ? 'warn' : 'good'; }

// Накопители: всё, что LHM знает о каждом диске:
function disksInfo() {
    const by = {};
    for (const x of sensAll()) if (hwTypeOf(x) === 'storage') (by[x.hw] = by[x.hw] || []).push(x);
    return Object.entries(by).map(([name, list]) => {
        const f = (type, re) => sensFind(list, '', type, re), any = re => list.find(x => re.test(x.name)) || null;
        const temps = list.filter(x => x.type === 'Temperature' && !THRESHOLD.test(x.name));
        const temp = temps.find(x => /composite|^temperature$/i.test(x.name)) || temps[0] || null;
        const warn = list.find(x => x.type === 'Temperature' && /warning/i.test(x.name));
        const crit = list.find(x => x.type === 'Temperature' && /critical/i.test(x.name));
        const lifeS = f('Level', /life/i), usedPct = f('Level', /percentage used/i);
        const life = lifeS ? lifeS.value : usedPct ? Math.max(0, 100 - usedPct.value) : null;
        const nvme = list.some(x => /nvme/i.test(x.id || ''));
        return {
            name, list, temp, temps, warn: warn ? warn.value : null, crit: crit ? crit.value : null, life,
            kind: nvme ? 'NVMe SSD' : life != null ? 'SSD' : 'HDD',
            spare: f('Level', /available spare$/i), spareThr: f('Level', /spare threshold/i),
            used: f('Load', /used space/i), act: f('Load', /total activity/i),
            rd: f('Data', /read/i), wr: f('Data', /writ/i), rrate: f('Throughput', /read/i), wrate: f('Throughput', /writ/i),
            hours: any(/power.?on hours|power.?on time/i), cycles: any(/power (on|cycle) count|power cycles/i),
            unsafe: any(/unsafe/i), waf: any(/write amplification/i), errors: any(/media error|error/i),
        };
    });
}

const WIDGETS = {
    //
    // СИСТЕМА.
    //
    summary: { sec: 'sys', title: i18n('Сводка'), w: 12,

        // Создать содержимое:
        init(w) {
            w.body.innerHTML = `<div class="kpis">${KPIS.map(k => TR`<button class="kpi" data-k="${k.k}" data-go="${k.go}" title="Перейти к виджету">
                <span class="k"><span>${esc(k.label)}</span></span><span class="v"><span class="odo"></span><small></small></span><span class="s">—</span><canvas></canvas></button>`).join('')}</div>`;
            w.body.onclick = e => {
                const b = e.target.closest('.kpi');
                const t = b && S.inst[b.dataset.go];
                if (t) t.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            };
        },

        // Обновить данные:
        update(w) {
            const u = S.upsR && S.upsR.status;
            for (const k of KPIS) {
                const el = $(`.kpi[data-k="${k.k}"]`, w.body);
                if (k.src === 'ups') { el.hidden = !S.upsShown; if (!S.upsShown) continue; }
                const d = k.src === 'ups' ? u : (pcReady() ? S.pc : null);
                if (!d) { odo($('.odo', el), '—'); $('.v small', el).textContent = ''; odoIn($('.s', el), k.src === 'ups' ? i18n('нет связи с ИБП') : i18n('нет данных')); continue; }
                const [val, unit] = k.v(d);
                odo($('.odo', el), val);
                $('.v small', el).textContent = unit;
                odoIn($('.s', el), k.s(d));
                el.className = 'kpi ' + (k.cls ? k.cls(d) : '');
                const hs = k.h.map(key => S.hist[key] || []);
                const vals = hs.flat().filter(v => v != null);
                const min = k.k === 'ups' ? Math.min(...vals.filter(v => v > 0), 200) - 5 : 0;
                const max = k.max || smoothMax(k.k, Math.max(1, ...vals) * 1.15);
                drawSpark($('canvas', el), hs.map((arr, i) => ({
                    vals: arr.map(v => v == null ? null : v - min), max: max - min, fill: i === 0,
                    color: i === 0 ? (k.cls && k.cls(d) === 'bad' ? T.bad : T.accent) : T.pal[3],
                })), 90, k.src === 'ups' ? S.upsTick : S.pc.time);
            }
        } },

    cpu: { sec: 'sys', title: i18n('Процессор'), w: 6,

        // Создать содержимое:
        init(w) {
            w.tools.innerHTML = TR`<div class="seg sm"><button data-m="graph" title="Графики потоков">Графики</button><button data-m="ring" title="Кольца потоков">Кольца</button></div>`;
            w.tools.onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; S.cpuMode = b.dataset.m; store.set('cpuMode', S.cpuMode); w.nThr = -1; this.update(w); };
            w.body.innerHTML = `<div class="cpu-layout">
                <div class="chip"><div class="pins t"></div><div class="pins b"></div><div class="pins l"></div><div class="pins r"></div>
                    <div class="pkg"><div class="die"><div class="die-label"><span class="cpu-n">CPU</span><span class="cpu-f"></span></div><div class="threads"></div></div></div></div>
                <div class="cpu-side"><div class="cpu-fan" hidden></div><div class="stats"></div><div class="note" hidden>${LHM_HINT}</div></div></div>`;
            const thr = $('.threads', w.body), chip = $('.chip', w.body);
            const showThr = e => {
                const t = e.target.closest('.thr');
                if (!t) return;
                S.tile = { i: +t.dataset.i, cx: e.clientX, cy: e.clientY };
                renderTileTip();
            };
            thr.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') showThr(e); });
            thr.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') showThr(e); });
            thr.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { S.tile = null; tipHide('tile'); } });
            chip.addEventListener('pointermove', e => {
                if (e.pointerType !== 'mouse') return;
                const r = chip.getBoundingClientRect(), dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5;
                chip.style.transform = `perspective(1100px) rotateX(${(-dy * 7).toFixed(2)}deg) rotateY(${(dx * 7).toFixed(2)}deg)`;
            });
            chip.addEventListener('pointerleave', () => { chip.style.transform = ''; });
            w.nThr = -1;
            // Вентилятор кулера крутится, только пока он на экране:
            if (w.hook) S.hooks.delete(w.hook);
            if (w.vio) w.vio.disconnect();
            const fan = $('.cpu-fan', w.body);
            fan.innerHTML = cpuFanSVG();
            w.fan = { blades: $('.cfan-blades', fan), blur: $('.cfan-blur', fan), st: { a: 0, v: 0, tv: 0 } };
            w.fanLbl = svgLabels(fan, 160, 184, [{ k: 'hub', x: 80, y: 80, fs: 13, cls: 'hub', html: HUB_HTML }, { k: 'name', x: 80, y: 174, fs: 9, cls: 'name' }]);
            w.vio = new IntersectionObserver(([e]) => { w.vizVisible = e.isIntersecting; });
            w.vio.observe(fan);
            w.hook = ts => this.anim(w, ts);
            S.hooks.add(w.hook);
        },

        // Освободить ресурсы:
        destroy(w) { if (w.hook) S.hooks.delete(w.hook); if (w.vio) w.vio.disconnect(); },

        // Скорость вентилятора плавно подтягивается к реальной (как у видеокарты):
        anim(w, ts) {
            const dt = Math.min(0.1, (ts - (w.animT || ts)) / 1000);
            w.animT = ts;
            if (!w.vizVisible || w.collapsed || !w.fan || w.fanOff) return;
            const f = w.fan, st = f.st;
            st.v += (st.tv - st.v) * Math.min(1, dt * 1.2);
            st.a = (st.a + st.v * dt) % 360;
            f.blades.setAttribute('transform', `rotate(${st.a.toFixed(2)})`);
            const q = clamp(st.v / 900, 0, 1);  // На высоких оборотах лопасти «размываются».
            f.blur.style.opacity = (q * 0.2).toFixed(3);
            f.blades.style.opacity = (1 - q * 0.45).toFixed(3);
        },

        // Обновить вентилятор кулера (обороты из LHM):
        fan(w) {
            const box = $('.cpu-fan', w.body), all = sensAll();
            const fs = sensFind(all, 'superio', 'Fan', /cpu/i) || sensFind(all, null, 'Fan', /cpu|pump|aio/i);
            const ctl = sensFind(all, 'superio', 'Control', /cpu/i);
            w.fanOff = !fs || fs.value == null;
            box.hidden = w.fanOff;
            if (w.fanOff) return;
            const rpm = fs.value, pct = ctl ? ctl.value : null;
            w.fan.st.tv = clamp(rpm * 0.3, 0, 1000);  // 1500 rpm -> 450°/с на экране.
            const txt = (sel, t) => { const el = $(sel, box); if (el.textContent !== t) el.textContent = t; };
            const hub = w.fanLbl.hub;
            odo($('.odo', hub), rpm < 1 ? i18n('стоп') : fmt(rpm, 0));
            $('small', hub).textContent = rpm < 1 ? '0 rpm' : 'rpm';
            odo($('.odo', w.fanLbl.name), fs.name + (pct != null ? ` · ${fmt(pct, 0)}%` : ''));
            const tip = TR`Кулер процессора: ${fmt(rpm, 0)} rpm${pct != null ? ` · ${fmt(pct, 0)}%` : ''}` + (rpm < 1 ? '\n' + i18n('Остановлен или не подключён к разъёму CPU_FAN') : '');
            txt('.cfan-fan title', tip);
        },

        // Обновить данные:
        update(w) {
            $$('[data-m]', w.tools).forEach(b => b.classList.toggle('on', b.dataset.m === S.cpuMode));
            if (!pcReady()) return;
            const p = S.pc, n = p.cores.length;
            odoIn(w.sub, p.cpu_name);
            const vcore = sv(sensFind(sensAll(), 'cpu', 'Voltage', /^core \(svi|^cpu core$|^core$/i) || sensFind(sensAll(), 'superio', 'Voltage', /^vcore$|cpu core/i));
            renderStats($('.stats', w.body), [
                st('l', i18n('Загрузка'), fmt(p.cpu, 1), '%', lvlCls(p.cpu)),
                p.freq_lhm ? st('f', i18n('Частота (средн.)'), p.freq ?? '—', i18n('МГц')) : st('f', i18n('Частота (базовая)'), p.freq ?? '—', i18n('МГц')),
                ...(p.freq_lhm ? [st('fm', i18n('Пик ядра'), p.freq_max ?? '—', i18n('МГц'))] : []),
                ...(vcore != null ? [st('v', 'Vcore', fmt(vcore, 3), i18n('В'))] : []),
                st('t', i18n('Температура'), p.cpu_temp != null ? fmt(p.cpu_temp, 1) : i18n('н/д'), p.cpu_temp != null ? '°C' : '', p.cpu_temp >= 85 ? 'bad' : p.cpu_temp >= 72 ? 'warn' : ''),
                st('p', i18n('Мощность'), p.cpu_power != null ? fmt(p.cpu_power, 1) : i18n('н/д'), p.cpu_power != null ? i18n('Вт') : ''),
                st('c', i18n('Ядра / потоки'), `${p.cores_physical} / ${p.cores_logical}`),
                st('n', i18n('Процессы'), p.process_count),
            ]);
            $('.note', w.body).hidden = !!(p.lhm && p.lhm.ok);
            this.fan(w);
            $('.cpu-n', w.body).textContent = p.cpu_name.replace(/\s+\d+-Core Processor/i, '');
            odoIn($('.cpu-f', w.body), `${fmt(p.cpu, 0)}%`);
            const thr = $('.threads', w.body);
            if (w.nThr !== n) {
                thr.style.setProperty('--cols', Math.ceil(Math.sqrt(n)));
                thr.innerHTML = p.cores.map((_, i) => S.cpuMode === 'ring'
                    ? `<div class="thr ring" data-i="${i}">${ringSVG(100, 11)}<span class="tl">${i}</span><span class="tv"></span></div>`
                    : `<div class="thr" data-i="${i}"><canvas></canvas><span class="tl">${i}</span><span class="tv"></span></div>`).join('');
                w.nThr = n;
            }
            p.cores.forEach((v, i) => {
                const el = thr.children[i], col = level(v), tv = $('.tv', el);
                odoIn(tv, Math.round(v) + '%');
                tv.style.color = col;
                if (S.cpuMode === 'ring') setRing($('svg', el), v, col);
                else drawSpark($('canvas', el), [{ vals: p.cores_hist.map(r => r[i]), color: col, fill: true }], 60, p.time);
            });
            if (S.tile) renderTileTip();  // Подсказка по потоку обновляется вместе с данными.
        } },

    coreclk: { sec: 'sys', title: i18n('Частоты ядер'), w: 6,

        // Создать содержимое:
        init(w) {
            w.body.innerHTML = TR`<div class="stats"></div><div class="cfs"></div>
                <div class="cf-legend"><span><i class="lg-cur"></i>частота сейчас</span><span><i class="lg-eff"></i>эффективная (с учётом простоя)</span></div>
                <div class="note" hidden></div>`;
            $('.cfs', w.body).title = i18n('Частота - на какой скорости ядро работает, пока оно активно.\n') +
                i18n('Эффективная - средняя с учётом времени, когда ядро спит (C-состояния): в простое она намного ниже.\n');
        },

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            const cores = coreInfo(), note = $('.note', w.body);
            $('.cf-legend', w.body).hidden = !cores.length;
            note.hidden = cores.length > 0;
            if (!cores.length) {
                note.innerHTML = i18n('Windows отдаёт только базовую частоту (') + (S.pc.freq ?? '—') + i18n(' МГц). Реальные частоты каждого ядра показывает LibreHardwareMonitor.<br>') + LHM_HINT;
                $('.cfs', w.body).innerHTML = ''; $('.stats', w.body).innerHTML = ''; $('.stats', w.body).dataset.sig = '';
                return;
            }
            const ss = sensAll(), avg = cores.reduce((a, c) => a + c.clk, 0) / cores.length;
            const effs = cores.filter(c => c.eff != null), top = cores.reduce((a, c) => c.clk > a.clk ? c : a, cores[0]);
            const pkg = sensFind(ss, 'cpu', 'Power', /package|cpu total/i), bus = sensFind(ss, 'cpu', 'Clock', /bus/i);
            odoIn(w.sub, TR`${cores.length} ядер · данные LibreHardwareMonitor`);
            renderStats($('.stats', w.body), [
                st('a', i18n('Средняя'), fmt(avg, 0), i18n('МГц')), st('m', i18n('Быстрейшее'), fmt(top.clk, 0), TR`МГц · #${top.n}`),
                ...(effs.length ? [st('e', i18n('Эффективная'), fmt(effs.reduce((a, c) => a + c.eff, 0) / effs.length, 0), i18n('МГц'))] : []),
                ...(pkg ? [st('p', i18n('Пакет'), fmt(pkg.value, 1), i18n('Вт'))] : []),
                ...(bus ? [st('b', i18n('Шина'), fmt(bus.value, 1), i18n('МГц'))] : []),
            ]);
            // Шкала от 0 до самой высокой частоты, которую ядра показывали за сеанс LHM (буст):
            const fmax = Math.ceil(Math.max(1000, ...cores.map(c => Math.max(c.clk, c.max || 0))) / 100) * 100;
            const box = $('.cfs', w.body), sig = cores.map(c => c.n).join('|');
            if (box.dataset.sig !== sig) {
                box.innerHTML = cores.map(c => TR`<div class="cf"><span class="cf-n">${c.n}</span><div class="cf-bar"><i></i><b></b></div>
                    <span class="cf-v"><span class="odo"></span><small>МГц</small></span><span class="cf-s"></span></div>`).join('');
                box.dataset.sig = sig;
            }
            cores.forEach((c, k) => {
                const el = box.children[k];
                $('.cf-bar i', el).style.width = clamp(c.clk / fmax * 100, 0, 100) + '%';
                $('.cf-bar b', el).style.width = c.eff != null ? clamp(c.eff / fmax * 100, 0, 100) + '%' : '0';
                odo($('.odo', el), fmt(c.clk, 0));
                const parts = [c.eff != null ? TR`эфф. ${fmt(c.eff, 0)}` : '', c.pw != null ? TR`${fmt(c.pw, 2)} Вт` : '', c.vid != null ? TR`VID ${fmt(c.vid, 3)} В` : '',
                    c.max ? TR`макс ${fmt(c.max, 0)}` : '', c.temp != null ? `${fmt(c.temp, 0)} °C` : ''].filter(Boolean).join(' · ');
                odoIn($('.cf-s', el), parts);
            });
        } },

    perf: { sec: 'sys', title: i18n('Загрузка'), w: 6, chart: 'perf' },

    cpu3d: { sec: 'sys', title: i18n('Потоки CPU · 3D'), w: 6, heavy: true,

        // Создать содержимое:
        init(w) {
            w.tools.innerHTML = TR`<div class="seg sm"><button data-m="bar">Столбцы</button><button data-m="surface">Рельеф</button></div>`;
            w.tools.onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; S.c3dMode = b.dataset.m; store.set('c3dMode2', S.c3dMode); this.update(w); };
            w.body.innerHTML = TR`<div class="c3d"></div><div class="scale"><span>0%</span><i></i><span>100%</span><span style="margin-left:auto">тяните — вращать</span></div>`;
            odoIn(w.sub, i18n('каждый поток за 60 секунд'));
            const box = $('.c3d', w.body);
            if (!TOUCH) { this.start(w, box); return; }
            // На телефоне 3D живёт, только пока виджет рядом с экраном: ушёл - видеопамять освобождается:
            w.lazy = new IntersectionObserver(([e]) => { w.near = e.isIntersecting; if (w.near) this.start(w, box); else this.stop(w); }, { rootMargin: '300px' });
            w.lazy.observe(box);
        },

        // Запустить 3D (при появлении на экране):
        start(w, box) {
            if (w.g3 || w.starting) return;
            w.starting = true;
            create3D(box, cam => { S.cam3d = cam; store.set('cam3d', cam); }).then(g3 => {
                w.starting = false;
                if (S.inst[w.id] !== w || (TOUCH && !w.near)) { g3.dispose(); return; }
                w.g3 = g3;
                w.ro = new ResizeObserver(() => g3.resize());
                w.ro.observe(box);
                // Рисуем только пока виджет на экране - иначе зря нагружаем видеокарту:
                w.io = new IntersectionObserver(([e]) => g3.setActive(e.isIntersecting));
                w.io.observe(box);
                w.lastT = null;
                this.update(w);
            }).catch(err => { w.starting = false; box.innerHTML = TR`<div class="empty">3D недоступно: ${esc(err.message || err)}</div>`; box.style.height = 'auto'; });
        },

        // Выгрузить 3D (виджет ушёл далеко с экрана):
        stop(w) { if (w.ro) w.ro.disconnect(); if (w.io) w.io.disconnect(); if (w.g3) w.g3.dispose(); w.g3 = null; },

        // Освободить ресурсы:
        destroy(w) { if (w.lazy) w.lazy.disconnect(); if (w.ro) w.ro.disconnect(); if (w.io) w.io.disconnect(); if (w.g3) w.g3.dispose(); w.g3 = null; },

        // Обновить данные:
        update(w) {
            $$('[data-m]', w.tools).forEach(b => b.classList.toggle('on', b.dataset.m === S.c3dMode));
            $('.scale i', w.body).style.background = `linear-gradient(90deg, ${T.heat[0]}, ${T.heat[30]}, ${T.heat[70]}, ${T.heat[100]})`;
            if (!w.g3 || !pcReady()) return;
            w.g3.setMode(S.c3dMode);
            if (w.lastT !== S.pc.time) { w.lastT = S.pc.time; w.g3.push(S.pc.cores_hist); }
        } },

    ribbon: { sec: 'sys', title: i18n('Лента потоков'), w: 6,

        // Создать содержимое:
        init(w) {
            odoIn(w.sub, i18n('загрузка каждого потока во времени'));
            w.body.innerHTML = TR`<div class="ribbon"><canvas></canvas></div><div class="scale"><span>0%</span><i></i><span>100%</span><span style="margin-left:auto">5 минут</span></div>`;
            w.cv = $('canvas', w.body);
            const box = $('.ribbon', w.body);
            w.ro = new ResizeObserver(() => { w.dirty = true; });
            w.ro.observe(box);
            w.io = new IntersectionObserver(([e]) => {
                w.visible = e.isIntersecting;
                if (!w.visible) { w.cv.width = 0; w.cv.height = 0; } else w.dirty = true;  // За экраном холст памяти не занимает.
            });
            w.io.observe(box);
            w.hook = ts => this.draw(w, ts);
            S.hooks.add(w.hook);
            box.addEventListener('pointermove', e => {
                const r = box.getBoundingClientRect(), hist = S.ribbon;
                if (!hist.length) return;
                const n = hist[hist.length - 1].v.length, rowH = (r.height - 4) / n;
                const zi = clamp(Math.floor((e.clientY - r.top - 2) / rowH), 0, n - 1);
                const secAgo = (r.width - (e.clientX - r.left)) / w.colW;
                const idx = clamp(hist.length - 1 - Math.floor(secAgo), 0, hist.length - 1);
                tipShow(TR`<div class="tt-title">Поток ${zi}</div><div class="tt-row"><span>${Math.round(nowSec() - hist[idx].t)} с назад</span><b>${fmt(hist[idx].v[zi], 0)} %</b></div>`, e.clientX, e.clientY, 'ribbon');
            });
            box.addEventListener('pointerleave', () => tipHide('ribbon'));
        },

        // Освободить ресурсы:
        destroy(w) { S.hooks.delete(w.hook); if (w.ro) w.ro.disconnect(); if (w.io) w.io.disconnect(); },

        // Обновить данные:
        update(w) { $('.scale i', w.body).style.background = `linear-gradient(90deg, ${T.heat[0]}, ${T.heat[30]}, ${T.heat[70]}, ${T.heat[100]})`; },

        // Каждый кадр лента плавно сдвигается влево, новые секунды появляются справа:
        draw(w, ts) {
            if (!w.visible || w.collapsed || (!w.dirty && ts - (w.lastDraw || 0) < 40)) return;
            const cv = w.cv, hist = S.ribbon;
            const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX), W = cv.clientWidth, H = cv.clientHeight;
            if (!W || !H) return;
            if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
            const ctx = cv.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);
            w.lastDraw = ts; w.dirty = false;
            if (!hist.length) return;
            const n = hist[hist.length - 1].v.length, rowH = (H - 4) / n;
            const colW = w.colW = W / 300;
            const frac = clamp((nowSec() - hist[hist.length - 1].t), 0, 1.5);
            for (let k = hist.length - 1; k >= 0; k--) {
                const x = W - (hist.length - k - 1 + frac + 1) * colW;
                if (x + colW < 0) break;
                const v = hist[k].v;
                for (let z = 0; z < n; z++) {
                    ctx.fillStyle = T.heat[clamp(Math.round(v[z]), 0, 100)];
                    ctx.fillRect(x, 2 + z * rowH, colW + 0.6, rowH - 1);
                }
            }
        } },

    gpu: { sec: 'sys', title: i18n('Видеокарта'), w: 6,

        // Создать содержимое:
        init(w) {
            if (w.hook) S.hooks.delete(w.hook);
            if (w.vio) w.vio.disconnect();
            w.vizN = 0; w.fanEls = null;
            w.body.innerHTML = TR`<div class="gpu-viz"></div><div class="rings"></div><div class="stats" style="margin-top:14px"></div>
                <div class="gpu-more" hidden><div class="subttl">Блоки видеокарты</div><div class="lbars"></div><div class="subttl">Подробно</div><div class="stats more"></div></div>`;
            const box = $('.gpu-viz', w.body);
            // Вентиляторы крутятся, только пока карта на экране:
            w.vio = new IntersectionObserver(([e]) => { w.vizVisible = e.isIntersecting; });
            w.vio.observe(box);
            w.hook = ts => this.anim(w, ts);
            S.hooks.add(w.hook);
            // Наклон за курсором, как у процессора:
            box.addEventListener('pointermove', e => {
                if (e.pointerType !== 'mouse') return;
                const r = box.getBoundingClientRect(), dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5;
                box.style.transform = `perspective(1400px) rotateX(${(-dy * 8).toFixed(2)}deg) rotateY(${(dx * 8).toFixed(2)}deg)`;
            });
            box.addEventListener('pointerleave', () => { box.style.transform = ''; });
        },

        // Освободить ресурсы:
        destroy(w) { if (w.hook) S.hooks.delete(w.hook); if (w.vio) w.vio.disconnect(); },

        // Скорость вентиляторов плавно подтягивается к реальной (разгон и остановка по инерции):
        anim(w, ts) {
            const dt = Math.min(0.1, (ts - (w.animT || ts)) / 1000);
            w.animT = ts;
            if (!w.vizVisible || w.collapsed || !w.fanEls) return;
            const k = Math.min(1, dt * 1.2);
            w.fanEls.forEach((f, i) => {
                const st = w.fanSt[i];
                st.v += (st.tv - st.v) * k;
                st.a = (st.a + st.v * dt) % 360;
                f.blades.setAttribute('transform', `rotate(${st.a.toFixed(2)})`);
                const q = clamp(st.v / 900, 0, 1);  // На высоких оборотах лопасти «размываются».
                f.blur.style.opacity = (q * 0.2).toFixed(3);
                f.blades.style.opacity = (1 - q * 0.45).toFixed(3);
            });
        },

        // Обновить вид видеокарты:
        viz(w, g) {
            const box = $('.gpu-viz', w.body);
            if (!box) return;
            const gs = lhmOk() ? sensAll().filter(x => hwTypeOf(x) === 'gpu') : [];
            const fans = gs.filter(x => x.type === 'Fan'), ctl = gs.filter(x => x.type === 'Control');
            const n = clamp(fans.length, 2, 3);
            if (w.vizN !== n) {
                box.innerHTML = gpuCardSVG(n);
                w.vizN = n;
                // Числа - подписями поверх рисунка (координаты - как у кожуха и вентиляторов в gpuCardSVG):
                const two = n !== 3, cy = two ? 127 : 140, xs = two ? [146, 494] : [122, 320, 518];
                w.lbl = svgLabels(box, 640, 250, [
                    ...xs.map((x, i) => ({ k: 'f' + i, x, y: cy, fs: 12, cls: 'hub', html: HUB_HTML })),
                    ...(two ? [0, 1, 2].map(i => ({ k: 'p' + i, x: 320, y: 106 + i * 38, fs: 17, cls: 'pv' })) : []),
                    ...(two ? [{ k: 'r1', x: 320, y: 215, fs: 11.5, cls: 'row' }]
                        : [{ k: 'r1', x: 598, y: 42, fs: 11.5, a: 'end', cls: 'row' }, { k: 'r2', x: 598, y: 60, fs: 11.5, a: 'end', cls: 'row' }]),
                ]);
                w.fanEls = $$('.gv-fan', box).map((el, i) => ({ el, blades: $('.gv-blades', el), blur: $('.gv-blur', el),
                    t: $('.odo', w.lbl['f' + i]), u: $('small', w.lbl['f' + i]), tip: $('title', el) }));
                w.fanSt = w.fanEls.map((_, i) => (w.fanSt && w.fanSt[i]) || { a: i * 23, v: 0, tv: 0 });
            }
            const txt = (sel, t) => { const el = $(sel, box); if (el && el.textContent !== t) el.textContent = t; };
            const m = /^(NVIDIA|AMD|ATI|Intel)\s+(.+)$/i.exec(g.name || '');
            txt('.gv-brand', (m ? m[1] : 'GPU').toUpperCase());
            txt('.gv-model', m ? m[2] : (g.name || i18n('Видеокарта')));
            const vram = `VRAM ${fmt(g.mem_used / 1024, 1)} / ${fmt(g.mem_total / 1024, 1)} GB`;
            const pwT = g.power != null ? (g.power_est ? '≈' : '') + fmt(g.power, 0) + ' W' : '—';
            const L = w.lbl, set = (k, t) => odo($('.odo', L[k]), t);
            if (n === 2) {
                set('r1', TR`${vram} · ${fmt(g.clock, 0)} МГц · ${g.pstate || ''}`);
                set('p0', fmt(g.util, 0) + '%');
                set('p1', fmt(g.temp, 0) + '°');
                set('p2', pwT.replace(' W', 'W'));
                L.p1.style.color = g.temp >= 83 ? T.bad : g.temp >= 70 ? T.warn : '';
            } else {
                set('r1', `${fmt(g.util, 0)}% · ${fmt(g.temp, 0)} °C · ${pwT}`);
                set('r2', vram);
            }
            // Вентиляторы: обороты из LHM (если датчик один - он общий для всех), иначе % из nvidia-smi:
            w.fanEls.forEach((f, i) => {
                const fs = fans[i] || fans[0], rpm = fs ? fs.value : null;
                const pct = (ctl[i] || ctl[0]) ? (ctl[i] || ctl[0]).value : g.fan;
                const vis = rpm != null ? rpm : pct != null ? pct / 100 * 3000 : 0;
                w.fanSt[i].tv = clamp(vis * 0.3, 0, 1000);  // 1500 rpm -> 450°/с на экране.
                odo(f.t, rpm != null ? (rpm < 1 ? i18n('стоп') : fmt(rpm, 0)) : pct != null ? fmt(pct, 0) + '%' : '—');
                const u = rpm != null ? (rpm < 1 ? '0 rpm' : 'rpm') : pct != null ? i18n('кулер') : '';
                if (f.u.textContent !== u) f.u.textContent = u;
                const tip = TR`Вентилятор ${i + 1}: ${rpm != null ? fmt(rpm, 0) + ' rpm' : '—'}${pct != null ? ` · ${fmt(pct, 0)}%` : ''}` +
                    (rpm != null && rpm < 1 ? i18n('\nОстановлен: карта холодная (режим тишины)') : '') + (fans.length === 1 && i > 0 ? i18n('\nLHM отдаёт один общий датчик') : '');
                if (f.tip.textContent !== tip) f.tip.textContent = tip;
            });
            // Подсветка: цвет по температуре, яркость по загрузке. Разъём питания - по мощности:
            const light = $('.gv-light', box), tc = g.temp >= 83 ? T.bad : g.temp >= 70 ? T.warn : g.temp >= 55 ? T.accent : T.good;
            light.style.fill = tc;
            light.style.opacity = (0.35 + 0.65 * clamp(g.util || 0, 0, 100) / 100).toFixed(2);
            light.style.filter = `drop-shadow(0 0 ${(3 + 9 * clamp(g.util || 0, 0, 100) / 100).toFixed(1)}px ${tc})`;
            const pp = g.power != null && g.power_limit ? g.power / g.power_limit * 100 : 0, pwr = $('.gv-pwr', box);
            const pc = pp >= 75 ? T.bad : pp >= 40 ? T.warn : pp >= 15 ? T.accent : '';
            pwr.style.fill = pc;
            pwr.style.filter = pc ? `drop-shadow(0 0 ${(2 + pp / 12).toFixed(1)}px ${pc})` : '';
        },

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            const g = gpu0();
            if (!g) { if (!w.none) { w.body.innerHTML = TR`<div class="empty">Нет данных о видеокарте: нужен <code>nvidia-smi</code> (драйвер NVIDIA) или LibreHardwareMonitor.</div>`; w.none = true; w.fanEls = null; } return; }
            if (w.none || !$('.rings', w.body)) { w.none = false; this.init(w); }
            odoIn(w.sub, g.name);
            this.viz(w, g);
            const vram = g.mem_total ? g.mem_used / g.mem_total * 100 : 0;
            const pw = g.power != null && g.power_limit ? g.power / g.power_limit * 100 : 0;
            renderRings($('.rings', w.body), [
                { k: 'u', pct: g.util, val: fmt(g.util, 0) + '%', label: i18n('Загрузка'), sub: TR`контроллер памяти ${fmt(g.mem_util, 0)}%`, color: level(g.util) },
                { k: 'v', pct: vram, val: fmt(vram, 0) + '%', label: 'VRAM', sub: `${fmt(g.mem_used / 1024, 1)} / ${fmt(g.mem_total / 1024, 1)} GB`, color: level(vram) },
                { k: 't', pct: g.temp, val: fmt(g.temp, 0) + '°', label: i18n('Температура'), sub: i18n('шкала 0–100 °C'), color: g.temp >= 83 ? T.bad : g.temp >= 70 ? T.warn : T.good },
                { k: 'p', pct: pw, val: g.power != null ? (g.power_est ? '≈' : '') + fmt(g.power, 0) + 'W' : i18n('н/д'), label: i18n('Мощность'),
                    sub: g.power_est ? TR`оценка · лимит ${fmt(g.power_limit, 0)} W` : TR`лимит ${fmt(g.power_limit, 0)} W`, color: level(pw),
                    tip: g.power_est ? i18n('Драйвер не отдаёт потребление - оценка: ~10% лимита в простое + загрузка × лимит') : '' },
                { k: 'f', pct: g.fan, val: g.fan != null ? fmt(g.fan, 0) + '%' : '—', label: i18n('Кулер'), sub: i18n('скорость'), color: T.pal[1] },
            ]);
            renderStats($('.stats', w.body), [
                st('c', i18n('Частота ядра'), fmt(g.clock, 0), TR`/ ${fmt(g.clock_max, 0)} МГц`), st('m', i18n('Частота памяти'), fmt(g.mem_clock, 0), i18n('МГц')),
                st('p', i18n('Режим'), g.pstate), st('d', i18n('Драйвер'), g.driver),
            ]);
            // Всё, что про видеокарту знает LibreHardwareMonitor:
            // (без LHM тут только температура из nvidia-smi - её уже показывает кольцо):
            const gs = lhmOk() ? sensAll().filter(x => hwTypeOf(x) === 'gpu' && !THRESHOLD.test(x.name)) : [], more = $('.gpu-more', w.body);
            more.hidden = !gs.length;
            if (!gs.length) return;
            const loads = gs.filter(x => x.type === 'Load');
            more.firstElementChild.hidden = !loads.length;
            const lb = $('.lbars', more), sig = loads.map(x => x.id).join('|');
            if (lb.dataset.sig !== sig) {
                lb.innerHTML = loads.map(x => `<div class="lb"><span title="${esc(x.name)}">${esc(x.name.replace(/^GPU\s+/i, ''))}</span><div class="bar"><i></i></div><b></b></div>`).join('');
                lb.dataset.sig = sig;
            }
            loads.forEach((x, k) => {
                const el = lb.children[k], i = $('i', el);
                i.style.width = clamp(x.value, 0, 100) + '%';
                i.style.background = level(x.value);
                odoIn($('b', el), fmt(x.value, 0) + '%');
            });
            const one = (type, re) => sensFind(gs, '', type, re);
            const hot = one('Temperature', /hot ?spot/i), mj = one('Temperature', /memory junction/i), fanR = one('Fan', /./), fanC = one('Control', /fan/i);
            const volt = one('Voltage', /./), memU = one('SmallData', /memory used$/i), memF = one('SmallData', /memory free$/i), memT = one('SmallData', /memory total$/i);
            const shared = one('SmallData', /shared/i), rx = one('Throughput', /rx|receive/i), tx = one('Throughput', /tx|transmit/i);
            const cClk = one('Clock', /core/i), mClk = one('Clock', /memory/i), vClk = one('Clock', /video/i), lpw = one('Power', /./);
            const items = [];
            if (hot) items.push(st('hs', 'Hot Spot', fmt(hot.value, 1), '°C', hot.value >= 95 ? 'bad' : hot.value >= 85 ? 'warn' : ''));
            if (mj) items.push(st('mj', i18n('Память (junction)'), fmt(mj.value, 1), '°C', mj.value >= 100 ? 'bad' : mj.value >= 90 ? 'warn' : ''));
            if (fanR) items.push(st('fr', i18n('Вентилятор'), fmt(fanR.value, 0), fanC ? `rpm · ${fmt(fanC.value, 0)}%` : 'rpm'));
            if (volt) items.push(st('gv', i18n('Напряжение ядра'), fmt(volt.value, 3), i18n('В')));
            if (lpw) items.push(st('gp', i18n('Мощность (LHM)'), fmt(lpw.value, 1), i18n('Вт')));
            if (cClk) items.push(st('cc', i18n('Ядро (LHM)'), fmt(cClk.value, 0), i18n('МГц')));
            if (mClk) items.push(st('mc', i18n('Память (LHM)'), fmt(mClk.value, 0), i18n('МГц')));
            if (vClk) items.push(st('vc', i18n('Видеоблок'), fmt(vClk.value, 0), i18n('МГц')));
            if (memU) items.push(st('mu', i18n('VRAM занято'), ...splitUnit(fmtBytes(toBytes(memU.value, memU.unit || 'MB')))));
            if (memF) items.push(st('mf', i18n('VRAM свободно'), ...splitUnit(fmtBytes(toBytes(memF.value, memF.unit || 'MB')))));
            if (memT) items.push(st('mt', i18n('VRAM всего'), ...splitUnit(fmtBytes(toBytes(memT.value, memT.unit || 'MB')))));
            if (shared) items.push(st('sh', i18n('Общая память (D3D)'), ...splitUnit(fmtBytes(toBytes(shared.value, shared.unit || 'MB')))));
            if (rx) items.push(st('rx', i18n('PCIe ↓ приём'), ...splitUnit(fmtRate(toBps(rx.value, rx.unit)))));
            if (tx) items.push(st('tx', i18n('PCIe ↑ отдача'), ...splitUnit(fmtRate(toBps(tx.value, tx.unit)))));
            renderStats($('.stats.more', more), items);
            $$('.subttl', more)[1].hidden = !items.length;
        } },

    temps: { sec: 'sys', title: i18n('Температуры'), w: 6, chart: 'temps' },

    fans: { sec: 'sys', title: i18n('Вентиляторы'), w: 6, chart: 'fans' },

    pcpower: { sec: 'sys', title: i18n('Питание ПК'), w: 6,

        // Создать содержимое:
        init(w) {
            w.body.innerHTML = TR`<div class="pwr"><div class="pwr-bar"></div><div class="pwr-leg"></div></div>
                <div class="subttl">Шины блока питания</div><div class="rails"></div>
                <div class="subttl lowttl">Ядро, SoC, память</div><div class="rails low"></div><div class="note" hidden>${LHM_HINT}</div>`;
        },

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            const ss = sensAll(), u = S.upsR && S.upsR.connected ? S.upsR.status : null, g = gpu0();
            // Мощность: всё на ИБП (нагрузка × 360 Вт) = CPU + GPU + остальное (материнка, память, диски, потери БП, монитор, если он на ИБП):
            const total = u ? u.load_percent * UPS_WATTS / 100 : null;
            const cpu = S.pc.cpu_power, gpu = g ? g.power : null;
            const parts = [
                { k: 'cpu', name: i18n('Процессор'), v: cpu, c: T.pal[0] },
                { k: 'gpu', name: (g && g.power_est ? i18n('Видеокарта ≈') : i18n('Видеокарта')), v: gpu, c: T.pal[4] },
            ];
            const known = parts.reduce((a, x) => a + (x.v || 0), 0);
            if (total != null) parts.push({ k: 'rest', name: i18n('Остальное'), v: Math.max(0, total - known), c: T.pal[2] });
            const sum = Math.max(total || 0, known, 1);
            const bar = $('.pwr-bar', w.body), leg = $('.pwr-leg', w.body);
            if (bar.children.length !== parts.length) {
                bar.innerHTML = parts.map(() => '<i></i>').join('');
                leg.innerHTML = parts.map(() => i18n('<span><i></i><em></em><b><span class="odo"></span><small>Вт</small></b></span>')).join('') +
                    i18n('<span class="tot"><em>Всего на ИБП</em><b><span class="odo"></span><small>Вт</small></b></span>');
            }
            parts.forEach((x, k) => {
                const bi = bar.children[k], li = leg.children[k];
                bi.style.width = (x.v || 0) / sum * 100 + '%';
                bi.style.background = x.c;
                $('i', li).style.background = x.c;
                $('em', li).textContent = x.name;
                odo($('.odo', li), x.v != null ? fmt(x.v, 0) : '—');
            });
            odo($('.tot .odo', leg), total != null ? '≈' + fmt(total, 0) : '—');
            leg.lastElementChild.hidden = !S.upsShown;
            leg.lastElementChild.title = TR`Нагрузка ИБП ${u ? u.load_percent : '—'}% × ${UPS_WATTS} Вт. Точность ИБП - единицы процентов, это оценка.`;
            odoIn(w.sub, total != null ? TR`≈ ${fmt(total, 0)} Вт от розетки` : '');

            const rails = railsInfo(), main = rails.filter(r => r.nom), low = rails.filter(r => !r.nom);
            $('.note', w.body).hidden = rails.length > 0;
            $('.lowttl', w.body).hidden = !low.length;
            $$('.subttl', w.body)[0].hidden = !main.length;
            this.rails($('.rails', w.body), main, true);
            this.rails($('.rails.low', w.body), low, false);
        },
        // Строка шины: значение, отклонение от номинала (ATX допускает ±5%), мин/макс за сеанс LHM.
        rails(box, list, dev) {
            const sig = list.map(r => r.id).join('|');
            if (box.dataset.sig !== sig) {
                box.innerHTML = list.map(r => TR`<div class="rail${dev ? '' : ' nodev'}"><span class="rn" title="${esc(r.hw)}">${esc(r.name)}</span>
                    ${dev ? TR`<div class="rdev" title="Шкала ±10%, зелёная зона - допуск ATX ±5%"><i></i><b></b></div>` : '<div class="rrng"><i></i><b></b></div>'}
                    <span class="rv"><span class="odo"></span><small>В</small></span><span class="rd"></span><span class="rm"></span></div>`).join('');
                box.dataset.sig = sig;
            }
            list.forEach((r, k) => {
                const el = box.children[k];
                odo($('.rv .odo', el), fmt(r.value, 3));
                const rd = $('.rd', el), rm = $('.rm', el);
                if (dev) {
                    $('.rdev b', el).style.left = clamp(50 + r.dev * 5, 0, 100) + '%';
                    $('.rdev b', el).className = r.cls;
                    const t = (r.dev >= 0 ? '+' : '') + fmt(r.dev, 1) + '%';
                    odoIn(rd, t);
                    if (rd.className !== 'rd ' + r.cls) rd.className = 'rd ' + r.cls;
                } else {
                    // Для шин без номинала - где сейчас значение между минимумом и максимумом за сеанс:
                    const lo = r.min ?? r.value, hi = r.max ?? r.value, span = hi - lo;
                    $('.rrng b', el).style.left = (span > 1e-6 ? (r.value - lo) / span * 100 : 50) + '%';
                    odoIn(rd, '');
                }
                const mm = r.min != null && r.max != null ? `${fmt(r.min, 3)} – ${fmt(r.max, 3)}` : '';
                odoIn(rm, mm);
            });
        } },

    rails: { sec: 'sys', title: i18n('Напряжения · история'), w: 6, chart: 'rails' },
    clocks: { sec: 'sys', title: i18n('Частоты · история'), w: 6, chart: 'clocks' },
    powerhist: { sec: 'sys', title: i18n('Потребление · история'), w: 6, chart: 'powerhist' },

    mem: { sec: 'sys', title: i18n('Память и диски'), w: 6,

        // Создать содержимое:
        init(w) { w.body.innerHTML = `<div class="rings"></div><div class="stats" style="margin-top:14px"></div>`; },

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            const p = S.pc;
            renderRings($('.rings', w.body), [
                { k: 'ram', pct: p.ram.percent, val: fmt(p.ram.percent, 0) + '%', label: 'RAM', sub: `${fmtBytes(p.ram.used)} / ${fmtBytes(p.ram.total)}`, color: level(p.ram.percent) },
                { k: 'swap', pct: p.swap.percent, val: fmt(p.swap.percent, 0) + '%', label: 'Swap', sub: `${fmtBytes(p.swap.used)} / ${fmtBytes(p.swap.total)}`, color: level(p.swap.percent) },
                ...p.disks.map(d => ({ k: d.mount, pct: d.percent, val: fmt(d.percent, 0) + '%', label: d.mount, sub: TR`свободно ${fmtBytes(d.free)}`,
                    color: d.percent >= 90 ? T.bad : d.percent >= 75 ? T.warn : T.pal[1], tip: TR`${d.mount} ${d.fstype}: ${fmtBytes(d.used)} из ${fmtBytes(d.total)}` })),
            ]);
            renderStats($('.stats', w.body), [
                st('r', i18n('Чтение'), ...splitUnit(fmtRate(p.disk_io.read))), st('w', i18n('Запись'), ...splitUnit(fmtRate(p.disk_io.write))),
                st('a', i18n('RAM доступно'), ...splitUnit(fmtBytes(p.ram.available))),
            ]);
        } },

    diskhealth: { sec: 'sys', title: i18n('Здоровье дисков'), w: 6,

        // Создать содержимое:
        init(w) { w.body.innerHTML = `<div class="dcards"></div><div class="note" hidden></div>`; },

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            const disks = disksInfo(), note = $('.note', w.body), box = $('.dcards', w.body);
            note.hidden = disks.length > 0;
            if (!disks.length) {
                note.innerHTML = i18n('Ресурс SSD, температура, наработка и объём записи берутся из S.M.A.R.T. через LibreHardwareMonitor ') +
                    i18n('(в нём должен быть включён пункт <b>Hardware → Storage</b>).<br>') + LHM_HINT;
                box.innerHTML = ''; box.dataset.sig = '';
                return;
            }
            odoIn(w.sub, `${disks.length} ${disks.length === 1 ? i18n('накопитель') : i18n('накопителя')} · S.M.A.R.T.`);
            const sig = disks.map(d => d.name).join('|');
            if (box.dataset.sig !== sig) {
                box.innerHTML = disks.map(() => `<div class="dcard"><div class="dh"><b></b><span></span></div><div class="rings"></div><div class="stats"></div></div>`).join('');
                box.dataset.sig = sig;
            }
            disks.forEach((d, k) => {
                const el = box.children[k];
                $('.dh b', el).textContent = d.name;
                const state = d.life != null ? (d.life >= 80 ? i18n('исправен') : d.life >= 50 ? i18n('износ заметен') : i18n('ресурс на исходе')) : '';
                $('.dh span', el).textContent = [d.kind, state].filter(Boolean).join(' · ');
                $('.dh span', el).className = d.life == null ? '' : d.life >= 80 ? 'good' : d.life >= 50 ? 'warn' : 'bad';
                const crit = d.crit || (d.kind === 'HDD' ? 60 : 80), warn = d.warn || crit - 10;
                const rings = [];
                if (d.life != null) rings.push({ k: 'life', pct: d.life, val: fmt(d.life, 0) + '%', label: i18n('Здоровье'), sub: i18n('остаток ресурса'),
                    color: d.life >= 80 ? T.good : d.life >= 50 ? T.warn : T.bad, tip: i18n('По S.M.A.R.T.: 100% - новый, 0% - заявленный ресурс записи исчерпан (диск может работать и дальше)') });
                if (d.spare) rings.push({ k: 'spare', pct: d.spare.value, val: fmt(d.spare.value, 0) + '%', label: i18n('Резерв'),
                    sub: d.spareThr ? TR`порог ${fmt(d.spareThr.value, 0)}%` : i18n('запасные блоки'), color: d.spareThr && d.spare.value <= d.spareThr.value * 2 ? T.bad : T.good,
                    tip: i18n('Сколько осталось запасных блоков для замены изношенных') });
                if (d.used) rings.push({ k: 'used', pct: d.used.value, val: fmt(d.used.value, 0) + '%', label: i18n('Занято'), sub: i18n('место на диске'),
                    color: d.used.value >= 90 ? T.bad : d.used.value >= 75 ? T.warn : T.pal[1] });
                if (d.temp) rings.push({ k: 'temp', pct: d.temp.value / crit * 100, val: fmt(d.temp.value, 0) + '°', label: i18n('Температура'),
                    sub: TR`предел ${fmt(crit, 0)} °C`, color: d.temp.value >= crit ? T.bad : d.temp.value >= warn ? T.warn : T.good,
                    tip: d.temps.map(x => `${x.name}: ${fmt(x.value, 1)} °C`).join('\n') + (d.warn ? TR`\nПредупреждение: ${d.warn} °C` : '') + (d.crit ? TR`\nКритическая: ${d.crit} °C` : '') });
                renderRings($('.rings', el), rings);
                const gb = x => x ? splitUnit(fmtBytes(toBytes(x.value, x.unit || 'GB'))) : ['—', ''];
                const items = [];
                if (d.wr) items.push(st('w', i18n('Записано всего'), ...gb(d.wr)));
                if (d.rd) items.push(st('r', i18n('Прочитано всего'), ...gb(d.rd)));
                if (d.rrate) items.push(st('rr', i18n('Чтение'), ...splitUnit(fmtRate(toBps(d.rrate.value, d.rrate.unit)))));
                if (d.wrate) items.push(st('wr', i18n('Запись'), ...splitUnit(fmtRate(toBps(d.wrate.value, d.wrate.unit)))));
                if (d.act) items.push(st('a', i18n('Активность'), fmt(d.act.value, 0), '%'));
                if (d.hours) items.push(st('h', i18n('Наработка'), fmt(d.hours.value, 0), TR`ч · ${fmt(d.hours.value / 24, 0)} дн`));
                if (d.cycles) items.push(st('c', i18n('Включений'), fmt(d.cycles.value, 0)));
                if (d.unsafe) items.push(st('u', i18n('Аварийные откл.'), fmt(d.unsafe.value, 0), '', d.unsafe.value > 100 ? 'warn' : ''));
                if (d.waf) items.push(st('waf', i18n('Усиление записи'), fmt(d.waf.value, 2), '×', d.waf.value > 3 ? 'warn' : ''));
                if (d.errors) items.push(st('e', d.errors.name, fmt(d.errors.value, 0), '', d.errors.value > 0 ? 'bad' : 'good'));
                renderStats($('.stats', el), items);
            });
        } },

    memmap: { sec: 'sys', title: i18n('Карта памяти'), w: 6,

        // Создать содержимое:
        init(w) {
            odoIn(w.sub, i18n('кто сколько занимает ОЗУ'));
            w.body.innerHTML = `<div class="ec tall"></div>`;
            ecInit(w, $('.ec', w.body));
        },

        // Освободить ресурсы:
        destroy(w) { ecDispose(w); },

        // Обновить данные:
        update(w) {
            if (!pcReady() || !w.ec || w.procsT === S.pc.procs_time) return;
            w.procsT = S.pc.procs_time;
            // Процессы с одинаковым именем (например, десятки chrome.exe) складываем:
            const agg = {};
            for (const p of S.pc.procs) {
                const a = agg[p.name] = agg[p.name] || { name: p.name, value: 0, cpu: 0, n: 0 };
                a.value += p.mem; a.cpu += p.cpu; a.n++;
            }
            const items = Object.values(agg).sort((a, b) => b.value - a.value).slice(0, 36);
            const max = items.length ? items[0].value : 1;
            w.ec.setOption({
                tooltip: { ...ecTip(), formatter: p => TR`<b>${esc(p.name)}</b><br>память ${fmtBytes(p.value)}<br>CPU ${fmt(p.data.cpu, 1)}%${p.data.n > 1 ? TR`<br>процессов: ${p.data.n}` : ''}` },
                series: [{
                    type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0,
                    animationDurationUpdate: 800, animationEasingUpdate: 'cubicOut',
                    label: { show: true, color: T.text, fontFamily: T.font, fontSize: 11, formatter: p => `${p.name}\n${fmtBytes(p.value)}`, overflow: 'truncate' },
                    itemStyle: { borderColor: T.surface, borderWidth: 2, gapWidth: 2, borderRadius: 6 },
                    data: items.map(a => ({ ...a, itemStyle: { color: hexA(a.cpu > 5 ? T.warn : T.accent, 0.22 + 0.6 * Math.sqrt(a.value / max)) } })),
                }],
            });
        } },


    net: { sec: 'sys', title: i18n('Сеть'), w: 6,

        // Создать содержимое:
        init(w) { w.body.innerHTML = `<div class="net-tot"></div><div class="nics"></div>`; },

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            const p = S.pc;
            renderStats($('.net-tot', w.body), [st('rx', i18n('↓ Приём'), ...splitUnit(fmtRate(p.net.rx))), st('tx', i18n('↑ Отдача'), ...splitUnit(fmtRate(p.net.tx)))]);
            const box = $('.nics', w.body), sig = p.nics.map(n => n.name).join('|');
            if (box.dataset.sig !== sig) {
                box.innerHTML = p.nics.map(() => `<div class="nic"><div class="nic-h"><b></b><span></span></div>
                    <div class="nic-r"><span class="rx"></span><span class="tx"></span><canvas></canvas></div><div class="nic-ip"></div></div>`).join('');
                box.dataset.sig = sig;
            }
            p.nics.forEach((n, i) => {
                const el = box.children[i], h = S.nicHist[n.name] || { rx: [], tx: [] };
                $('.nic-h b', el).textContent = n.name;
                odoIn($('.nic-h span', el), `${n.up ? i18n('подключён') : i18n('отключён')}${n.speed ? ' · ' + n.speed + i18n(' Мбит/с') : ''}`);
                odoIn($('.rx', el), '↓ ' + fmtRate(n.rx));
                odoIn($('.tx', el), '↑ ' + fmtRate(n.tx));
                odoIn($('.nic-ip', el), TR`${n.ipv4.join(', ') || i18n('нет IPv4')} · всего ↓ ${fmtBytes(n.total_rx)} ↑ ${fmtBytes(n.total_tx)}`);
                const max = smoothMax('nic:' + n.name, Math.max(1024, ...h.rx, ...h.tx) * 1.1);
                drawSpark($('canvas', el), [{ vals: h.rx, color: T.pal[1], fill: true, max }, { vals: h.tx, color: T.pal[3], max }], 60, p.time);
            });
        } },

    nethist: { sec: 'sys', title: i18n('Сеть · история'), w: 6, chart: 'nethist' },
    diskhist: { sec: 'sys', title: i18n('Диски · история'), w: 6, chart: 'diskhist' },

    procs: { sec: 'sys', title: i18n('Процессы'), w: 8,

        // Создать содержимое:
        init(w) {
            w.body.innerHTML = TR`<div class="tbar"><input type="search" placeholder="Фильтр по имени или PID"></div>
                <div class="tscroll"><table class="tbl"><thead></thead><tbody></tbody></table></div>`;
            $('input', w.body).name = 'procFilter';
            $('input', w.body).oninput = e => { S.procFilter = e.target.value.toLowerCase(); w.sig = null; this.update(w); };
            $('thead', w.body).onclick = e => {
                const th = e.target.closest('th');
                if (!th) return;
                const k = th.dataset.k;
                S.procSort = { key: k, dir: S.procSort.key === k ? -S.procSort.dir : (k === 'name' || k === 'user' ? 1 : -1) };
                store.set('procSort', S.procSort);
                w.sig = null;
                this.update(w);
            };
        },

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            // Список процессов на сервере обновляется раз в 5 секунд - перерисовываем только тогда:
            const sig = S.pc.procs_time + '|' + S.procFilter + '|' + S.procSort.key + S.procSort.dir;
            if (w.sig === sig) return;
            w.sig = sig;
            const cols = [['pid', 'PID', 'num'], ['name', i18n('Имя'), ''], ['cpu', 'CPU', 'num'], ['mem', i18n('Память'), 'num'], ['threads', i18n('Потоки'), 'num'], ['user', i18n('Пользователь'), '']];
            $('thead', w.body).innerHTML = '<tr>' + cols.map(([k, n, c]) =>
                `<th data-k="${k}" class="${c} ${S.procSort.key === k ? 'sorted' : ''}">${n}${S.procSort.key === k ? (S.procSort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('') + '</tr>';
            const { key, dir } = S.procSort, f = S.procFilter;
            const rows = S.pc.procs.filter(x => !f || String(x.name).toLowerCase().includes(f) || String(x.pid).includes(f))
                .sort((a, b) => { const x = a[key], y = b[key]; return (typeof x === 'string' ? x.localeCompare(y || '') : (x || 0) - (y || 0)) * dir; });
            $('tbody', w.body).innerHTML = rows.map(x => `<tr><td class="num">${x.pid}</td><td class="name" title="${esc(x.name)}">${esc(x.name)}</td>
                <td class="num"><span class="bar"><i style="width:${clamp(x.cpu, 0, 100)}%;background:${level(x.cpu)}"></i></span>${fmt(x.cpu, 1)}%</td>
                <td class="num">${fmtBytes(x.mem)}</td><td class="num">${x.threads ?? '—'}</td><td>${esc(x.user)}</td></tr>`).join('');
            odoIn(w.sub, TR`всего ${S.pc.process_count}, показаны самые нагруженные`);
        } },

    sensors: { sec: 'sys', title: i18n('Датчики'), w: 12,

        // Создать содержимое:
        init(w) {
            w.body.innerHTML = TR`<div class="tbar"><input type="search" placeholder="Поиск: датчик или устройство"></div><div class="chips"></div>
                <div class="tscroll"><table class="tbl sens"><thead><tr><th>Датчик</th><th class="num">Значение</th><th class="num">Мин</th><th class="num">Макс</th></tr></thead><tbody></tbody></table></div>
                <div class="note" hidden>${LHM_HINT}</div>`;
            w.q = '';
            $('input', w.body).name = 'sensorFilter';
            $('input', w.body).oninput = e => { w.q = e.target.value.toLowerCase(); w.sig = null; this.update(w); };
            $('.chips', w.body).onclick = e => {
                const b = e.target.closest('[data-t]');
                if (!b) return;
                S.sensType = b.dataset.t; store.set('sensType', S.sensType); w.sig = null; w.chipSig = null; this.update(w);
            };
        },

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            const all = sensAll();
            $('.note', w.body).hidden = lhmOk();
            odoIn(w.sub, lhmOk() ? TR`${all.length} датчиков · LibreHardwareMonitor` : i18n('LibreHardwareMonitor не подключён'));
            // Фильтр по типу (кнопки строятся из того, что реально есть):
            const labels = [...new Set(all.map(x => SENS_TYPES[x.type] || i18n('Прочее')))];
            const cur = S.sensType && (S.sensType === 'all' || labels.includes(S.sensType)) ? S.sensType : 'all';
            const chipSig = labels.join('|') + cur;
            if (w.chipSig !== chipSig) {
                $('.chips', w.body).innerHTML = [['all', i18n('Все')], ...labels.map(l => [l, l])].map(([k, n]) =>
                    `<button data-t="${esc(k)}" class="${k === cur ? 'on' : ''}">${esc(n)}</button>`).join('');
                w.chipSig = chipSig;
            }
            const q = w.q;
            const list = all.filter(x => (cur === 'all' || (SENS_TYPES[x.type] || i18n('Прочее')) === cur) && (!q || (x.name + ' ' + x.hw).toLowerCase().includes(q)))
                .sort((a, b) => {
                    const ha = HW_ORDER.indexOf(hwTypeOf(a)), hb = HW_ORDER.indexOf(hwTypeOf(b));
                    return (ha < 0 ? 99 : ha) - (hb < 0 ? 99 : hb) || a.hw.localeCompare(b.hw) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'ru', { numeric: true });
                });
            const sig = list.map(x => x.id).join('|');
            const tb = $('tbody', w.body);
            if (w.sig !== sig) {
                let html = '', hw = null;
                for (const x of list) {
                    if (x.hw !== hw) { hw = x.hw; html += `<tr class="grp"><td colspan="4">${esc(hw || i18n('Без устройства'))}<small>${esc(HW_NAMES[hwTypeOf(x)] || '')}</small></td></tr>`; }
                    html += `<tr data-id="${esc(x.id)}"><td class="name" title="${esc(x.name)}"><span class="stype">${esc(SENS_TYPES[x.type] || x.type)}</span>${esc(x.name)}</td>
                        <td class="num v"></td><td class="num mn"></td><td class="num mx"></td></tr>`;
                }
                tb.innerHTML = html || `<tr><td colspan="4" class="empty">${all.length ? i18n('Ничего не найдено') : i18n('Нет датчиков')}</td></tr>`;
                w.cells = [...tb.querySelectorAll('tr[data-id]')].map(tr => [tr.children[1], tr.children[2], tr.children[3]]);
                w.sig = sig;
            }
            list.forEach((x, i) => {
                const [v, mn, mx] = w.cells[i], tn = fmtSensVal(x, x.min), tx = fmtSensVal(x, x.max);
                odoIn(v, fmtSens(x));
                odoIn(mn, tn);
                odoIn(mx, tx);
            });
        } },

    host: { sec: 'sys', title: i18n('Компьютер'), w: 4,

        // Обновить данные:
        update(w) {
            if (!pcReady()) return;
            const p = S.pc;
            const rows = [
                [i18n('Имя'), p.hostname], [i18n('Система'), osName(p.os)], [i18n('Процессор'), p.cpu_name], [i18n('Ядра / потоки'), `${p.cores_physical} / ${p.cores_logical}`],
                [i18n('Память'), fmtBytes(p.ram.total)], [i18n('Видеокарта'), p.gpus.map(g => g.name).join(', ') || '—'],
                [i18n('Загружен'), timeLabel(p.boot_time * 1000)], [i18n('Работает'), fmtDur(p.uptime)], [i18n('Процессов'), p.process_count],
                ['Python', p.python], ['LibreHardwareMonitor', p.lhm && p.lhm.ok ? TR`подключён · ${p.lhm.count} датчиков` : i18n('не подключён') + (p.lhm && p.lhm.error ? ' · ' + p.lhm.error : '')],
                [i18n('Батарея ПК'), p.battery ? `${fmt(p.battery.percent, 0)}% ${p.battery.plugged ? i18n('(сеть)') : i18n('(батарея)')}` : i18n('нет')],
                [i18n('Адрес дашборда'), location.host],
            ];
            // Строки создаются один раз, значения меняются счётчиком (время работы, число процессов):
            const sig = rows.map(r => r[0]).join('|');
            if (w.sig !== sig) { w.body.innerHTML = kvHTML(rows.map(([k]) => [k, ''])); w.sig = sig; }
            rows.forEach(([, v], i) => odoIn(w.body.children[i].lastElementChild, v ?? '—'));
        } },

    pc_all: { sec: 'sys', title: i18n('Обзор системы'), w: 12, chart: 'pc_all' },

    //
    // ПИТАНИЕ.
    //
    ups: { sec: 'pow', title: i18n('Бесперебойник'), w: 12,

        // Создать содержимое:
        init(w) {
            w.body.innerHTML = `<div class="ups-hero">
                <div class="ups-state"><div class="ico">${ICON.plug}</div><div class="big">—</div><div class="sm st-sub">—</div></div>
                <div class="ups-rings"></div>
                <div><div class="stats"></div>
                    <div class="flags">${FLAGS.map(f => `<span class="flag" data-f="${f.key}" title="${esc(f.name)}">${esc(f.name)}</span>`).join('')}</div>
                    <div class="raw">Q1 → <b>…</b></div></div></div>`;
        },

        // Обновить данные:
        update(w) {
            const r = S.upsR, stEl = $('.ups-state', w.body), ico = $('.ico', stEl);
            const state = (cls, icon, big, sub) => {
                stEl.className = 'ups-state ' + cls;
                if (ico.dataset.i !== big) { ico.innerHTML = icon; ico.dataset.i = big; }
                $('.big', stEl).textContent = big;
                odoIn($('.st-sub', stEl), sub);
            };
            if (!r || r.error) { state('', ICON.off, i18n('Нет данных'), i18n('ippon_ups.py не отвечает')); return; }
            const u = r.status || {}, i = r.info || {};
            odoIn(w.sub, [i.company, i.model].filter(Boolean).join(' ') || 'Ippon Back Basic 650');
            if (!r.connected) state('', ICON.off, i18n('Нет связи с ИБП'), i18n('USB отключён или занят другой программой'));
            else if (u.on_battery) state('bad', ICON.bolt, i18n('Работа от батареи'), r.on_battery_since ? i18n('уже ') + fmtDur(r.server_time - r.on_battery_since) : '');
            else state('ok', ICON.plug, i18n('Сеть в норме'), TR`опрос ${fmt(r.rate_hz, 1)} раз/с`);
            if (!r.status) return;
            renderRings($('.ups-rings', w.body), [
                { k: 'l', pct: u.load_percent, val: u.load_percent + '%', label: i18n('Нагрузка'), sub: TR`≈ ${fmt(u.load_percent * UPS_WATTS / 100, 0)} Вт`, color: level(u.load_percent) },
                { k: 'b', pct: u.battery_percent_est, val: u.battery_percent_est + '%', label: i18n('Заряд'), sub: fmt(u.battery_voltage, 2) + i18n(' В'), color: levelInv(u.battery_percent_est) },
            ]);
            const age = r.server_time - u.timestamp;
            renderStats($('.stats', w.body), [
                st('in', i18n('Вход'), fmt(u.input_voltage), i18n('В'), u.on_battery ? 'bad' : ''), st('out', i18n('Выход'), fmt(u.output_voltage), i18n('В')),
                st('hz', i18n('Частота'), fmt(u.frequency, 1), i18n('Гц')), st('fv', 'Fault V', fmt(u.input_fault_voltage), i18n('В')),
                st('bv', i18n('АКБ'), fmt(u.battery_voltage, 2), i18n('В'), u.battery_low ? 'bad' : ''), st('t', i18n('Температура'), fmt(u.temperature, 1), '°C'),
                st('nom', i18n('Номинал'), i.rating_voltage != null ? TR`${i.rating_voltage} В · ${i.rating_current} А` : '—'),
                st('age', i18n('Данные'), fmt(age, 1), i18n('с назад'), age > 5 ? 'warn' : ''),
            ]);
            FLAGS.forEach(f => { const el = $(`[data-f="${f.key}"]`, w.body), cls = 'flag' + (u[f.key] ? ' on ' + f.sev : ''); if (el.className !== cls) el.className = cls; });
            odoIn($('.raw b', w.body), u.raw || '…');
        } },

    gauge: { sec: 'pow', title: i18n('Вольтметр'), w: 6,

        // Создать содержимое:
        init(w) {
            odoIn(w.sub, i18n('зелёная зона — норма по ГОСТ (230 В ±5%)'));
            // Показания - счётчиком поверх приборов (как все числа на странице), стрелки рисует ECharts:
            w.body.innerHTML = `<div class="gauge-box"><div class="ec"></div><div class="g-val"><span class="odo"></span></div><div class="g-val"><span class="odo"></span></div></div>`;
            ecInit(w, $('.ec', w.body));
            // На узком экране приборы встают друг под другом, на широком - рядом:
            w.lay = null;
            w.ro2 = new ResizeObserver(() => this.layout(w));
            w.ro2.observe(w.body);
            const MIN = 170, MAX = 270, z = v => (v - MIN) / (MAX - MIN);
            const band = [[z(207), T.bad], [z(218.5), T.warn], [z(241.5), T.good], [z(253), T.warn], [1, T.bad]];
            const gauge = (name, center) => ({
                type: 'gauge', name, center, radius: '82%', min: MIN, max: MAX, startAngle: 215, endAngle: -35, splitNumber: 5,
                animationDurationUpdate: 900, animationEasingUpdate: 'cubicOut',
                axisLine: { lineStyle: { width: 10, color: band } },
                pointer: { length: '62%', width: 4, itemStyle: { color: T.text } }, anchor: { show: true, size: 10, itemStyle: { color: T.text } },
                axisTick: { distance: -12, length: 5, lineStyle: { color: T.surface, width: 1 } },
                splitLine: { distance: -14, length: 12, lineStyle: { color: T.surface, width: 2 } },
                axisLabel: { distance: 16, color: T.text3, fontSize: 10, fontFamily: T.font },
                title: { offsetCenter: [0, '72%'], color: T.text3, fontSize: 12, fontFamily: T.font },
                detail: { show: false },
                data: [{ value: 230, name }],
            });
            w.ec.setOption({ series: [gauge(i18n('Вход'), ['27%', '55%']), gauge(i18n('Выход'), ['73%', '55%'])] });
            this.layout(w);
        },

        // Разложить приборы под ширину:
        layout(w) {
            const W = w.body.clientWidth;
            if (!W || !w.ec) return;
            const narrow = W < 460, lay = (narrow ? 'v' : 'h') + Math.round(W / 20);
            if (w.lay === lay) return;
            w.lay = lay;
            const box = $('.ec', w.body), H = narrow ? Math.round(Math.min(W, 340) * 1.55) : 280;
            box.style.height = H + 'px';
            const r = narrow ? Math.min(W * 0.4, H * 0.25) : Math.min(W * 0.21, H * 0.44);
            const centers = narrow ? [['50%', '27%'], ['50%', '76%']] : [['26%', '55%'], ['74%', '55%']];
            const fs = r < 90 ? 16 : 20;
            w.ec.setOption({ series: centers.map(center => ({ center, radius: Math.round(r), axisLabel: { distance: r < 90 ? 12 : 16 } })) });
            // Показание - под осью прибора, как было у ECharts (42% радиуса ниже центра):
            $$('.g-val', w.body).forEach((el, i) => {
                el.style.left = centers[i][0];
                el.style.top = (parseFloat(centers[i][1]) / 100 * H + Math.round(r) * 0.42) + 'px';
                el.style.fontSize = fs + 'px';
            });
            w.ec.resize();
            if (setRows(w.el)) queueFlip();  // Высота виджета изменилась - сразу сообщаем сетке.
        },

        // Освободить ресурсы:
        destroy(w) { if (w.ro2) w.ro2.disconnect(); ecDispose(w); },

        // Обновить данные:
        update(w) {
            this.layout(w);  // На случай, если при создании виджет ещё не был на странице.
            const u = S.upsR && S.upsR.connected && S.upsR.status;
            if (!w.ec || !u) return;
            w.ec.setOption({ series: [{ data: [{ value: u.input_voltage, name: i18n('Вход') }] }, { data: [{ value: u.output_voltage, name: i18n('Выход') }] }] });
            $$('.g-val .odo', w.body).forEach((el, i) => odo(el, TR`${fmt(i ? u.output_voltage : u.input_voltage, 1)} В`));
        } },

    flow: { sec: 'pow', title: i18n('Поток энергии'), w: 6,

        // Создать содержимое:
        init(w) {
            w.body.innerHTML = `<div class="flow"></div>`;
            odoIn(w.sub, i18n('мощность — оценка по % нагрузки'));
            w.ro = new ResizeObserver(() => this.update(w));
            w.ro.observe(w.body);
            // Скорость каждой линии плавно подтягивается к нужной, смещение копится - анимация не прыгает:
            w.links = { grid: { off: 0, v: 0, tv: 0 }, pc: { off: 0, v: 0, tv: 0 }, bat: { off: 0, v: 0, tv: 0 } };
            w.io = new IntersectionObserver(([e]) => { w.visible = e.isIntersecting; });
            w.io.observe(w.body);
            w.hook = ts => this.anim(w, ts);
            S.hooks.add(w.hook);
        },

        // Освободить ресурсы:
        destroy(w) { if (w.ro) w.ro.disconnect(); if (w.io) w.io.disconnect(); S.hooks.delete(w.hook); },

        // Кадр анимации:
        anim(w, ts) {
            const dt = Math.min(0.1, (ts - (w.animT || ts)) / 1000);
            w.animT = ts;
            if (!w.visible || w.collapsed || !w.els) return;
            const k = Math.min(1, dt * 2.5);
            for (const [key, l] of Object.entries(w.links)) {
                l.v += (l.tv - l.v) * k;
                l.off = (l.off - l.v * dt) % 14;
                const el = w.els[key];
                if (el) el.setAttribute('stroke-dashoffset', l.off.toFixed(2));
            }
        },

        // Обновить данные:
        update(w) {
            const box = $('.flow', w.body);
            const lay = (box.clientWidth || 500) < 440 ? 'v' : 'h';
            if (w.lay !== lay) {
                box.innerHTML = flowSVG(lay); w.lay = lay;
                w.els = { grid: $('#fl-grid', box), pc: $('#fl-pc', box), bat: $('#fl-bat', box) };
                // Значение и подпись под названием узла (центр строки - чуть выше базовой линии текста):
                const [vbW, vbH] = FLOW_VB[lay];
                w.lbl = svgLabels(box, vbW, vbH, Object.entries(FLOW_TXT[lay]).flatMap(([k, [x, y, a]]) => [
                    { k: 'v' + k, x, y: y + 14.5, fs: 16, a, cls: 'fv' }, { k: 's' + k, x, y: y + 33, fs: 12, a, cls: 'fs' }]));
            }
            const r = S.upsR, u = r && !r.error && r.connected ? r.status : null;
            const node = (k, cls, val, sub) => {
                const g = $(`#fn-${k}`, box), c = 'fl-node ' + cls;
                if (g.getAttribute('class') !== c) g.setAttribute('class', c);
                odo($('.odo', w.lbl['v' + k]), val);
                odo($('.odo', w.lbl['s' + k]), sub || '');
            };
            const link = (k, on, opts = {}) => {
                const el = $(`#fl-${k}`, box), c = `fl-dash${on ? ' on' : ''}${opts.warn ? ' warn' : ''}`;
                if (el.getAttribute('class') !== c) el.setAttribute('class', c);
                // Период пунктира 14px за dur секунд; выключенная линия просто гаснет, не останавливаясь рывком:
                if (on) w.links[k].tv = (opts.rev ? -1 : 1) * 14 / (opts.dur || 1.4);
            };
            if (!u) {
                ['grid', 'ups', 'pc', 'bat'].forEach(k => node(k, '', '—', k === 'ups' ? i18n('нет связи') : ''));
                ['grid', 'pc', 'bat'].forEach(k => link(k, false));
                return;
            }
            const watts = u.load_percent * UPS_WATTS / 100;
            const dur = clamp(2.2 - u.load_percent / 50, 0.5, 2.2);  // Быстрее при большей нагрузке.
            const charging = !u.on_battery && u.battery_percent_est < 97;
            node('grid', u.on_battery ? 'bad' : 'on', u.on_battery ? i18n('нет сети') : TR`${fmt(u.input_voltage, 0)} В`, u.on_battery ? '' : TR`${fmt(u.frequency, 1)} Гц`);
            node('ups', u.on_battery ? 'warn' : 'on', `${u.load_percent}%`, TR`≈ ${fmt(watts, 0)} Вт`);
            node('pc', 'on', TR`${fmt(u.output_voltage, 0)} В`, TR`≈ ${fmt(watts, 0)} Вт`);
            node('bat', u.on_battery ? 'warn' : u.battery_low ? 'bad' : 'on', `${u.battery_percent_est}%`,
                TR`${fmt(u.battery_voltage, 2)} В · ${u.on_battery ? i18n('разряд') : charging ? i18n('заряд') : i18n('заряжен')}`);
            const lvl = $('#fn-bat .lvl', box);
            if (lvl) lvl.setAttribute('width', (13 * clamp(u.battery_percent_est, 0, 100) / 100).toFixed(1));
            link('grid', !u.on_battery, { dur });
            link('pc', true, { dur, warn: u.on_battery });
            link('bat', u.on_battery || charging, { dur: u.on_battery ? dur : 2.2, rev: !u.on_battery, warn: u.on_battery });
        } },

    mains: { sec: 'pow', title: i18n('Напряжение сети'), w: 12, chart: 'mains' },

    vheat: { sec: 'pow', title: i18n('Напряжение по часам'), w: 6,

        // Создать содержимое:
        init(w) {
            w.body.innerHTML = `<div class="stats vh-stats"></div><div class="vh"></div>`;
            odoIn(w.sub, i18n('среднее за каждый час, 7 дней'));
            ecInit(w, $('.vh', w.body));
            this.load(w);
            w.timer = setInterval(() => this.load(w), 5 * 60 * 1000);
        },

        // Освободить ресурсы:
        destroy(w) { clearInterval(w.timer); ecDispose(w); },

        // Загрузить данные:
        async load(w) {
            const day0 = new Date(); day0.setHours(0, 0, 0, 0); day0.setDate(day0.getDate() - 6);
            const start = day0.getTime() / 1000, end = start + 7 * 86400;
            let d;
            try { d = await api(`/api/ups/data?start=${start}&end=${end}&bucket=3600`); } catch { d = { error: 'offline' }; }
            if (!w.ec) return;
            if (d.error || !d.t || !d.t.length) {
                const vs = $('.vh-stats', w.body);
                vs.innerHTML = TR`<div class="empty">Нет данных за неделю</div>`;
                vs.dataset.sig = '';  // Плашки заменены надписью - при следующей загрузке их нужно создать заново.
                return;
            }
            const days = [...Array(7)].map((_, i) => { const x = new Date(day0); x.setDate(x.getDate() + i); return x; });
            const data = [];
            let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
            d.t.forEach((t, i) => {
                const dt = new Date(t * 1000), dd = new Date(dt); dd.setHours(0, 0, 0, 0);
                const di = Math.round((dd - day0) / 864e5);
                if (di < 0 || di > 6 || d.vin_avg[i] == null) return;
                data.push([dt.getHours(), di, d.vin_avg[i], d.vin_min[i], d.vin_max[i]]);
                // Статистика без моментов отключения (0 В на входе - это не «минимум сети»):
                if (d.vin_min[i] > 50) mn = Math.min(mn, d.vin_min[i]);
                mx = Math.max(mx, d.vin_max[i]);
                if (d.vin_avg[i] > 50) { sum += d.vin_avg[i] * d.samples[i]; cnt += d.samples[i]; }
            });
            const outages = (S.events || []).filter(e => e.kind === 'power_lost' && e.ts >= start).length;
            renderStats($('.vh-stats', w.body), [
                st('mn', i18n('Минимум'), mn === Infinity ? '—' : fmt(mn, 0), i18n('В'), mn < 200 ? 'bad' : mn < 210 ? 'warn' : ''),
                st('mx', i18n('Максимум'), mx === -Infinity ? '—' : fmt(mx, 0), i18n('В'), mx > 253 ? 'bad' : mx > 245 ? 'warn' : ''),
                st('av', i18n('Среднее'), cnt ? fmt(sum / cnt, 1) : '—', i18n('В')),
                st('o', i18n('Отключений'), outages, '', outages ? 'warn' : ''),
            ]);
            const dayName = x => x.toLocaleDateString(LANG === 'ru' ? 'ru-RU' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' });
            w.ec.setOption({
                animation: false,
                tooltip: { ...ecTip(), formatter: p => TR`${dayName(days[p.value[1]])} · ${pad2(p.value[0])}:00–${pad2(p.value[0] + 1)}:00<br>среднее <b>${fmt(p.value[2], 1)} В</b><br>мин ${fmt(p.value[3], 0)} · макс ${fmt(p.value[4], 0)} В` },
                grid: { left: 70, right: 8, top: 4, bottom: 52 },
                xAxis: { type: 'category', data: [...Array(24)].map((_, h) => pad2(h)), axisLabel: { ...ecText(), interval: 2 }, axisLine: { show: false }, axisTick: { show: false } },
                yAxis: { type: 'category', data: days.map(dayName), axisLabel: ecText(), axisLine: { show: false }, axisTick: { show: false } },
                visualMap: { min: 200, max: 260, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 160, text: [i18n('260 В'), i18n('200 В')], textStyle: ecText(), dimension: 2,
                    inRange: { color: [T.bad, T.warn, T.good, T.warn, T.bad] } },
                series: [{ type: 'heatmap', data, itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 4 }, emphasis: { itemStyle: { borderColor: T.text, borderWidth: 1 } } }],
            }, true);
        } },

    vdist: { sec: 'pow', title: i18n('Распределение напряжения'), w: 6,

        // Создать содержимое:
        init(w) {
            odoIn(w.sub, i18n('сколько времени сеть была на каждом напряжении (видимый период)'));
            w.body.innerHTML = `<div class="stats"></div><div class="ec" style="margin-top:10px;height:230px"></div>`;
            ecInit(w, $('.ec', w.body));
        },

        // Освободить ресурсы:
        destroy(w) { ecDispose(w); },

        // Обновить данные:
        update(w) {
            const d = S.data.ups, now = performance.now();
            if (!w.ec || !d || !d.cols.vin_avg || now - (w.last || 0) < 4000) return;  // Гистограмме хватит обновления раз в 4 с.
            w.last = now;
            const i0 = lowerBound(d.t, S.view.from), i1 = lowerBound(d.t, S.view.to + d.b);
            const bins = {};
            let n = 0, low = 0, high = 0, sum = 0;
            for (let i = i0; i < i1; i++) {
                const v = d.cols.vin_avg[i];
                if (v == null || v < 50) continue;
                const k = Math.round(v);
                bins[k] = (bins[k] || 0) + 1;
                n++; sum += v;
                if (v < 218.5) low++; else if (v > 241.5) high++;
            }
            renderStats($('.stats', w.body), [
                st('ok', i18n('В норме'), n ? fmt((n - low - high) / n * 100, 0) : '—', '%', 'good'),
                st('lo', i18n('Ниже нормы'), n ? fmt(low / n * 100, 0) : '—', '%', low ? 'warn' : ''),
                st('hi', i18n('Выше нормы'), n ? fmt(high / n * 100, 0) : '—', '%', high ? 'warn' : ''),
                st('av', i18n('Среднее'), n ? fmt(sum / n, 1) : '—', i18n('В')),
            ]);
            const keys = Object.keys(bins).map(Number).sort((a, b) => a - b);
            if (!keys.length) return;
            const cats = [];
            for (let v = keys[0]; v <= keys[keys.length - 1]; v++) cats.push(v);
            w.ec.setOption({
                animationDurationUpdate: 600,
                tooltip: { ...ecTip(), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: p => TR`${p[0].name} В<br>${fmt(p[0].value / n * 100, 1)}% времени` },
                grid: { left: 40, right: 8, top: 8, bottom: 24 },
                xAxis: { type: 'category', data: cats, axisLabel: { ...ecText(), interval: Math.max(0, Math.round(cats.length / 8) - 1) }, axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false } },
                yAxis: { type: 'value', axisLabel: { ...ecText(), formatter: v => fmt(v / n * 100, 0) + '%' }, splitLine: { lineStyle: { color: T.grid } } },
                series: [{ type: 'bar', barCategoryGap: '12%', data: cats.map(v => ({ value: bins[v] || 0, itemStyle: { color: v < 218.5 || v > 241.5 ? T.warn : T.accent, borderRadius: [3, 3, 0, 0] } })) }],
            });
        } },

    upsmix: { sec: 'pow', title: i18n('Нагрузка · частота · температура'), w: 6, chart: 'upsmix' },
    bat: { sec: 'pow', title: i18n('Аккумулятор'), w: 6, chart: 'bat' },
    flags: { sec: 'pow', title: i18n('Флаги состояния'), w: 6, chart: 'flags' },
    events: { sec: 'pow', title: i18n('Журнал событий'), w: 6,

        // Обновить данные:
        update(w) {
            const ev = S.events || [];
            const sig = ev.length ? ev[0].ts + ':' + ev.length : '0';
            if (w.sig === sig) return;  // Перерисовываем только при новых событиях.
            w.sig = sig;
            odoIn(w.sub, ev.length ? TR`${ev.length} записей` : '');
            w.body.innerHTML = ev.length ? `<div class="events">${ev.map(e => `<div class="ev ${esc(e.kind)}"><i></i><time>${timeLabel(e.ts * 1000)}</time>
                <span>${esc(e.text).replace(/\n/g, ' · ')}</span></div>`).join('')}</div>` : i18n('<div class="empty">Событий пока нет</div>');
        } },
    ups_all: { sec: 'pow', title: i18n('Обзор ИБП'), w: 12, chart: 'ups_all' },
};

//
// Раскладка: порядок, ширина, скрытие, перетаскивание, «кирпичная» сетка.
//
const WIDTHS = { 3: '¼', 4: '⅓', 6: '½', 8: '⅔', 12: '1' };
const SECS = ['sys', 'pow'];
const ORDER = {
    sys: ['summary', 'cpu', 'gpu', 'coreclk', 'cpu3d', 'perf', 'ribbon', 'temps', 'fans', 'pcpower', 'rails', 'clocks', 'powerhist',
          'mem', 'diskhealth', 'memmap', 'net', 'nethist', 'diskhist', 'procs', 'host', 'sensors', 'pc_all'],
    pow: ['ups', 'gauge', 'flow', 'mains', 'vheat', 'vdist', 'upsmix', 'bat', 'flags', 'events', 'ups_all'],
};
const DEFAULT_ORDER = { sys: [], pow: [] };
for (const sec of Object.keys(ORDER)) DEFAULT_ORDER[sec] = ORDER[sec].filter(id => WIDGETS[id] && WIDGETS[id].sec === sec);
Object.entries(WIDGETS).forEach(([id, d]) => { if (!DEFAULT_ORDER[d.sec].includes(id)) DEFAULT_ORDER[d.sec].push(id); });
const DEFAULT_HIDDEN = Object.keys(WIDGETS).filter(id => WIDGETS[id].hiddenByDefault);

// Загрузить раскладку виджетов:
function loadLayout() {
    const saved = store.get('layout5', {});
    const out = {};
    for (const sec of SECS) {
        const list = (saved[sec] || []).filter(id => WIDGETS[id] && WIDGETS[id].sec === sec);
        // Новые виджеты встают сразу после своего соседа по умолчанию, а не в самый конец:
        DEFAULT_ORDER[sec].forEach((id, i) => {
            if (list.includes(id)) return;
            const prev = DEFAULT_ORDER[sec].slice(0, i).reverse().find(x => list.includes(x));
            list.splice(prev ? list.indexOf(prev) + 1 : 0, 0, id);
        });
        out[sec] = list;
    }
    return out;
}
S.layout = loadLayout();
S.widths = store.get('widths3', {});
S.whidden = new Set(store.get('whidden3', DEFAULT_HIDDEN));
S.collapsed = new Set(store.get('collapsed2', []));

//
// Плавные перемещения виджетов (FLIP).
//
const flipPos = new WeakMap();
let flipMuted = true, flipQueued = false;  // Первые секунды после загрузки всё раскладывается - без анимации.


// Плавно перенести виджеты на новые места:
function flip() {
    for (const el of $$('.w')) {
        if (el.classList.contains('dragging')) continue;
        const x = el.offsetLeft, y = el.offsetTop, prev = flipPos.get(el);
        flipPos.set(el, { x, y });
        if (flipMuted || !prev || document.hidden || TOUCH) continue;
        const dx = prev.x - x, dy = prev.y - y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
}
const queueFlip = () => { if (flipQueued) return; flipQueued = true; requestAnimationFrame(() => { flipQueued = false; flip(); }); };

// Высота виджета -> сколько 8-пиксельных строк сетки он занимает (+16px отступ):
function setRows(el) {
    const h = el.getBoundingClientRect().height;
    if (!h) return false;
    const rows = Math.ceil((h + 16) / 8), cur = +el.style.getPropertyValue('--rows') || 0;
    if (rows === cur) { el._shrinkAt = 0; return false; }
    // Уменьшиться на одну строку - только если это держится 2 с (иначе соседи дёргаются от колебаний высоты):
    if (rows === cur - 1) {
        const now = performance.now();
        if (!el._shrinkAt) el._shrinkAt = now;
        if (now - el._shrinkAt < 2000) return false;
    }
    el._shrinkAt = 0;
    el.style.setProperty('--rows', String(rows));
    return true;
}
// Виджеты далеко за экраном не обновляются (на телефоне это главная нагрузка), попавший на экран - обновляется сразу:
const widgetIO = new IntersectionObserver(entries => entries.forEach(e => {
    const w = S.inst[e.target.dataset.id];
    if (!w) return;
    const was = w.onscreen;
    w.onscreen = e.isIntersecting;
    if (w.onscreen && was === false) runUpdate(w);
}), { rootMargin: '600px 0px' });


const masonryQueue = new Set();
const masonry = new ResizeObserver(entries => {
    const first = !masonryQueue.size;
    entries.forEach(e => masonryQueue.add(e.target));
    if (!first) return;
    requestAnimationFrame(() => {
        let changed = false;
        masonryQueue.forEach(el => { if (setRows(el)) changed = true; });
        masonryQueue.clear();
        if (changed) queueFlip();
    });
});

// Кнопки графика в заголовке виджета:
function chartTools(w) {
    const c = w.chart;
    if (!c) return;
    const split = c.split;
    w.tools.innerHTML = TR`<button class="btn yauto-btn" hidden title="Сбросить масштаб по высоте">Авто Y</button>` +
        (c.canSplit ? TR`<div class="seg sm" title="Как показывать линии"><button data-split="0" class="${split ? '' : 'on'}" title="Все линии на одном графике">${ICON.together}<span class="t">Вместе</span></button>
            <button data-split="1" class="${split ? 'on' : ''}" title="Каждая величина на своём графике">${ICON.split}<span class="t">Раздельно</span></button></div>` : '') +
        (c.def.noStyle ? '' : TR`<button class="w-icon cmenu-btn" title="Стиль графика">${ICON.more}</button>`);
    c.manualShown = null;
}


// Раздельный режим для графиков:
function setSplit(ids, v) {
    for (const id of ids) S.split[id] = !!v;
    store.set('split2', S.split);
    for (const id of ids) { const w = S.inst[id]; if (w && w.chart) w.chart.build(); }
    markModeAll();
}


// Отметить общий переключатель режима:
function markModeAll() {
    const charts = S.charts.filter(c => c.canSplit);
    const all = charts.length && charts.every(c => c.split), none = charts.every(c => !c.split);
    $$('#modeAll button').forEach(b => b.classList.toggle('on', b.dataset.mode === '1' ? all : none));
}


// Меню «⋯» у графика: стиль линий и шкала Y:
function openChartMenu(w, btn) {
    const m = $('#chartMenu'), id = w.id, cur = S.cstyle[id] || 'auto';
    m.innerHTML = TR`<h4>Стиль</h4><div class="grp">${Object.entries(STYLES).map(([k, n]) => `<button data-style="${k}" class="${k === cur ? 'on' : ''}">${n}</button>`).join('')}</div>
        <h4>Шкала Y</h4><div class="grp"><button data-zero="0" class="${S.yzero[id] ? '' : 'on'}">По данным</button><button data-zero="1" class="${S.yzero[id] ? 'on' : ''}">От нуля</button></div>
        <div class="sep"></div><div class="item" data-reset="h">Сбросить высоту графика</div><div class="item" data-reset="y">Сбросить масштаб Y</div>`;
    m.onclick = e => {
        e.stopPropagation();
        const b = e.target.closest('[data-style],[data-zero],[data-reset]');
        if (!b) return;
        if (b.dataset.style) { if (b.dataset.style === 'auto') delete S.cstyle[id]; else S.cstyle[id] = b.dataset.style; store.set('cstyle', S.cstyle); }
        if (b.dataset.zero) { if (b.dataset.zero === '1') S.yzero[id] = true; else delete S.yzero[id]; store.set('yzero', S.yzero); w.chart.yCur = {}; }
        if (b.dataset.reset === 'h') { delete S.heights[w.chart.hkey]; store.set('heights2', S.heights); w.chart.wrap.style.height = w.chart.defaultH() + 'px'; w.chart.resize(); }
        if (b.dataset.reset === 'y') delete S.y[w.chart.hkey];
        w.chart.dirty = true;
        openChartMenu(w, btn);
    };
    openPop(m, btn);
}

const widgetVisible = id => !S.whidden.has(id);

// Создать виджет:
function createWidget(id) {
    const d = WIDGETS[id];
    const el = document.createElement('article');
    el.className = `w w-${S.widths[id] || d.w}`;
    el.dataset.id = id;
    el.innerHTML = TR`<header class="w-head">
            <button class="w-icon w-drag" title="Перетащить">${ICON.grip}</button>
            <h3>${esc(d.title)}</h3><span class="w-sub"></span>
            <span class="w-tools"></span>
            <span class="w-edit"><span class="seg sm">${Object.entries(WIDTHS).map(([n, l]) => TR`<button data-w="${n}" title="Ширина ${l}">${l}</button>`).join('')}</span>
                <button class="w-icon" data-hide title="Скрыть виджет">${ICON.close}</button></span>
            <button class="w-icon w-collapse" title="Свернуть / развернуть">${ICON.chevron}</button>
        </header><div class="w-body"></div>`;
    const w = { id, def: d, el, head: $('.w-head', el), body: $('.w-body', el), sub: $('.w-sub', el), tools: $('.w-tools', el) };
    S.inst[id] = w;
    if (S.collapsed.has(id)) { el.classList.add('collapsed'); w.collapsed = true; }
    $('.w-collapse', el).onclick = () => {
        w.collapsed = el.classList.toggle('collapsed');
        if (w.collapsed) S.collapsed.add(id); else S.collapsed.delete(id);
        store.set('collapsed2', [...S.collapsed]);
        if (w.chart) w.chart.dirty = true;
    };
    $('.w-edit', el).onclick = e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.hasAttribute('data-hide')) { hideWidget(id); return; }
        S.widths[id] = +b.dataset.w;
        store.set('widths3', S.widths);
        el.className = el.className.replace(/\bw-\d+\b/, 'w-' + b.dataset.w);
        markWidth(w);
        queueFlip();
    };
    markWidth(w);
    bindDrag(w);
    if (d.chart) {
        w.body.classList.add('flush');
        w.tools.onclick = e => {
            e.stopPropagation();
            if (e.target.closest('.yauto-btn')) { delete S.y[w.chart.hkey]; w.chart.dirty = true; return; }
            const mb = e.target.closest('.cmenu-btn');
            if (mb) { const m = $('#chartMenu'); if (!m.hidden && m._w === w) { m.hidden = true; return; } m._w = w; openChartMenu(w, mb); return; }
            const b = e.target.closest('[data-split]');
            if (b) setSplit([id], b.dataset.split === '1');
        };
        w.chart = new TimeChart(w, CHART_DEFS[d.chart]);
        chartTools(w);
    } else if (d.init) d.init.call(d, w);
    masonry.observe(el);
    widgetIO.observe(el);
    return w;
}


// Отметить выбранную ширину:
function markWidth(w) {
    const cur = S.widths[w.id] || w.def.w;
    $$('.w-edit [data-w]', w.el).forEach(b => b.classList.toggle('on', +b.dataset.w === cur));
}


// Удалить виджет:
function destroyWidget(id) {
    const w = S.inst[id];
    if (!w) return;
    masonry.unobserve(w.el);
    widgetIO.unobserve(w.el);
    if (w.chart) w.chart.dispose();
    if (w.def.destroy) { try { w.def.destroy.call(w.def, w); } catch (e) { console.error(id, e); } }
    w.el.remove();
    delete S.inst[id];
}
// Скрытие с анимацией: виджет тает, соседи плавно занимают место.
function hideWidget(id) {
    const w = S.inst[id];
    const done = () => { S.whidden.add(id); store.set('whidden3', [...S.whidden]); renderLayout(); };
    if (!w || document.hidden) { done(); return; }
    w.el.style.pointerEvents = 'none';
    w.el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' }).finished.then(done, done);
}

// Расставить виджеты по раскладке:
function renderLayout(first = false) {
    let chartsChanged = false;
    const created = [];
    for (const sec of SECS) {
        const grid = $('#grid-' + sec);
        const want = S.layout[sec].filter(widgetVisible);
        for (const id of Object.keys(S.inst)) {
            if (WIDGETS[id].sec === sec && !want.includes(id)) { if (S.inst[id].chart) chartsChanged = true; destroyWidget(id); }
        }
        for (const id of want) {
            let w = S.inst[id];
            if (!w) {
                try { w = createWidget(id); } catch (e) { console.error('widget', id, e); delete S.inst[id]; continue; }  // Один сломанный виджет не ломает остальные.
                created.push(w.el);
                if (w.chart) chartsChanged = true;
            }
            grid.appendChild(w.el);
        }
    }
    updateAllWidgets();
    markModeAll();
    $$('.w').forEach(setRows);
    flip();
    created.forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(10px) scale(.985)' }, { opacity: 1, transform: 'none' }],
        { duration: 380, delay: first ? i * 30 : 0, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
    if (chartsChanged) { invalidate(); scheduleLoad(); }
}


// Пересоздать все виджеты:
function rebuildAll() {
    hideHover();
    Object.keys(S.inst).forEach(destroyWidget);
    renderLayout();
}


// Обновить виджет (ошибка одного не ломает остальные):
function runUpdate(w) {
    if (!w || !w.def.update) return;
    try { w.def.update.call(w.def, w); } catch (e) { console.error(w.id, e); }
}
const updateAllWidgets = () => Object.values(S.inst).forEach(runUpdate);
const updateSec = sec => Object.values(S.inst).forEach(w => { if (w.def.sec === sec && !w.collapsed && w.onscreen !== false) runUpdate(w); });

// Перетаскивание виджетов за ⠿ (мышь и палец). Соседи расступаются плавно.
function bindDrag(w) {
    const handle = $('.w-drag', w.el);
    handle.addEventListener('pointerdown', e => {
        if (!S.edit) return;
        e.preventDefault();
        const el = w.el, grid = el.parentElement, rect = el.getBoundingClientRect();
        const ph = document.createElement('div');
        ph.className = 'w-ph ' + [...el.classList].find(c => /^w-\d+$/.test(c));
        ph.style.gridRowEnd = 'span ' + Math.ceil((rect.height + 16) / 8);
        ph.style.height = rect.height + 'px';
        grid.insertBefore(ph, el);
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        Object.assign(el.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', zIndex: 100, pointerEvents: 'none' });
        el.classList.add('dragging');
        handle.setPointerCapture(e.pointerId);
        let raf = null, lastY = e.clientY;
        const autoScroll = () => {
            const edge = 80;
            const v = lastY < edge ? -(edge - lastY) / 4 : lastY > innerHeight - edge ? (lastY - innerHeight + edge) / 4 : 0;
            if (v) window.scrollBy(0, v);
            raf = requestAnimationFrame(autoScroll);
        };
        raf = requestAnimationFrame(autoScroll);
        const move = ev => {
            lastY = ev.clientY;
            el.style.left = ev.clientX - dx + 'px';
            el.style.top = ev.clientY - dy + 'px';
            const over = document.elementFromPoint(ev.clientX, ev.clientY);
            const target = over && over.closest('.w');
            let ref = null;
            if (target && target !== el && target.parentElement === grid) {
                const r = target.getBoundingClientRect();
                ref = ev.clientX < r.left + r.width / 2 ? target : target.nextSibling;
            } else if (over === grid) ref = undefined;
            if (ref === null) return;
            if (ref === undefined) { if (grid.lastElementChild !== ph) { grid.appendChild(ph); flip(); } }
            else if (ref !== ph && ph.nextSibling !== ref) { grid.insertBefore(ph, ref); flip(); }
        };
        const up = () => {
            cancelAnimationFrame(raf);
            handle.removeEventListener('pointermove', move);
            const r = el.getBoundingClientRect();
            grid.insertBefore(el, ph);
            ph.remove();
            el.classList.remove('dragging');
            Object.assign(el.style, { position: '', left: '', top: '', width: '', zIndex: '', pointerEvents: '' });
            flipPos.set(el, { x: r.left + scrollX, y: r.top + scrollY });  // «приземление» из-под курсора.
            flip();
            const sec = w.def.sec, order = $$('.w', grid).map(x => x.dataset.id);
            S.layout[sec] = [...order, ...S.layout[sec].filter(id => !order.includes(id))];
            store.set('layout5', S.layout);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up, { once: true });
        handle.addEventListener('pointercancel', up, { once: true });
    });
}

//
// Меню: виджеты и темы.
//
function openPop(pop, btn) {
    const r = btn.getBoundingClientRect();
    pop.hidden = false;
    pop.style.top = r.bottom + 8 + 'px';
    pop.style.left = Math.max(12, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 12)) + 'px';
}


// Меню виджетов:
function renderWidgetsMenu() {
    const names = { sys: i18n('Система'), pow: i18n('Питание') };
    $('#widgetsMenu').innerHTML = SECS.map(sec => `<h4>${names[sec]}</h4>` + S.layout[sec].map(id => {
        const d = WIDGETS[id];
        return `<label><input type="checkbox" data-id="${id}" ${S.whidden.has(id) ? '' : 'checked'}>${esc(d.title)}<small>${d.chart ? i18n('график') : ''}</small></label>`;
    }).join('')).join('') + TR`<div class="sep"></div><div class="item" id="menuReset">Сбросить раскладку</div>`;
}


// Меню тем:
function renderThemeMenu() {
    const cur = document.documentElement.dataset.theme;
    $('#themeMenu').innerHTML = TR`<h4>Тема</h4>` + Object.entries(THEMES).map(([k, t]) =>
        `<div class="item ${k === cur ? 'on' : ''}" data-t="${k}">${esc(t.name)}<span class="prev">${t.prev.map(c => `<i style="background:${c}"></i>`).join('')}</span></div>`).join('');
}


// Применить тему:
function applyTheme(name) {
    if (!THEMES[name]) name = 'graphite';
    document.documentElement.dataset.theme = name;
    store.set('theme', name);
    $('#themeName').textContent = THEMES[name].name;
    readTheme();
    document.querySelector('meta[name=theme-color]').content = T.bg;
}

//
// Опрос текущих данных. Следующий запрос - только после ответа на предыдущий,
// чтобы при медленном сервере запросы не копились.
//
function loop(fn, ms) {
    let fails = 0;
    const run = async () => {
        // Нет сети - не отправляем запросы (иначе каждый падает с ошибкой в консоль), ждём:
        if (!navigator.onLine) { setTimeout(run, 2000); return; }
        // Сервер не отвечает - его проверяет только опрос ПК, остальные ждут (иначе в консоли ошибка от каждого запроса):
        if (S.down && fn !== pollPc) { setTimeout(run, ms * 2); return; }
        let ok = true;
        try { ok = (await fn()) !== false; } catch (e) { ok = false; console.error(e); }
        fails = ok ? 0 : Math.min(fails + 1, 3);  // При ошибках пауза растёт: 2, 4, 8 интервалов.
        setTimeout(run, (document.hidden ? ms * 3 : ms) * (1 << fails));
    };
    run();
}


// Опрос параметров ПК:
async function pollPc() {
    try { S.pc = await api('/api/pc/status'); } catch { S.pc = { error: 'offline' }; }
    S.down = S.pc.error === 'offline';
    if (S.down) { odoIn($('#sysSub'), i18n('нет связи с сервером')); updateSec('sys'); return false; }
    if (pcReady()) {
        const p = S.pc, g = p.gpus[0];
        S.sensLast = Object.fromEntries((p.sensors || []).map(s => [s.id, s.value]));
        pushHist('cpu', p.cpu); pushHist('gpu', g ? g.util : null); pushHist('ram', p.ram.percent);
        pushHist('rx', p.net.rx); pushHist('tx', p.net.tx); pushHist('dr', p.disk_io.read); pushHist('dw', p.disk_io.write);
        // Ленту сразу заполняем последней минутой, которую сервер уже помнит:
        if (!S.ribbon.length) p.cores_hist.slice(0, -1).forEach((v, i, a) => S.ribbon.push({ t: p.time - (a.length - i), v }));
        if (!S.ribbon.length || S.ribbon[S.ribbon.length - 1].t !== p.time) {
            S.ribbon.push({ t: p.time, v: p.cores });
            if (S.ribbon.length > 320) S.ribbon.shift();
        }
        for (const n of p.nics) {
            const h = S.nicHist[n.name] = S.nicHist[n.name] || { rx: [], tx: [] };
            h.rx.push(n.rx); h.tx.push(n.tx);
            if (h.rx.length > 60) { h.rx.shift(); h.tx.shift(); }
        }
        $('#host').textContent = p.hostname;
        const sub = TR`${p.cpu_name} · ${osName(p.os)} · работает ${fmtDur(p.uptime)}`;
        odoIn($('#sysSub'), sub);
    } else odoIn($('#sysSub'), i18n('web_server.py не отвечает'));
    updateSec('sys');
}
// Короткие сбои (переподключение USB) не должны мигать разделом - прячем, если связи нет дольше 20 с.
function setUpsShown(v) {
    if (S.upsShown === v) return;
    S.upsShown = v;
    $('#sec-pow').hidden = !v;
    $('#nav').hidden = !v;
    $('#upsBadge').hidden = !v;
    const kpi = S.inst.summary && $('.kpi[data-k="ups"]', S.inst.summary.body);
    if (kpi) kpi.hidden = !v;
    if (v) { invalidate(); $$('#sec-pow .w').forEach(setRows); queueFlip(); scheduleLoad(); }
}


// Опрос ИБП:
async function pollUps() {
    try { S.upsR = await api('/api/ups/status'); } catch { S.upsR = { error: 'offline', net: true }; }
    const b = $('#upsBadge'), r = S.upsR, u = r.status;
    if (!r.error && r.connected) S.upsOkAt = Date.now();
    // Сеть до сервера пропала - это не значит, что ИБП нет: раздел не прячем.
    if (!r.net) setUpsShown(!!S.upsOkAt && Date.now() - S.upsOkAt < 20000);
    if (u && r.connected) { pushHist('vin', u.input_voltage); S.upsTick = (S.upsTick || 0) + 1; }
    let text, cls;
    if (r.error) { text = i18n('ИБП: нет сервера'); cls = 'pill bad'; }
    else if (!r.connected) { text = i18n('ИБП: нет связи'); cls = 'pill warn'; }
    else if (u && u.on_battery) { text = i18n('От батареи'); cls = 'pill bad'; }
    else { text = TR`Сеть ${u ? fmt(u.input_voltage, 0) + i18n(' В') : ''}`; cls = 'pill ok'; }
    odoIn(b, text);
    if (b.className !== cls) b.className = cls;
    odoIn($('#powSub'), r.error ? i18n('ippon_ups.py не отвечает')
        : (u ? TR`вход ${fmt(u.input_voltage)} В · нагрузка ${u.load_percent}% · АКБ ${fmt(u.battery_voltage, 2)} В` : i18n('нет связи с ИБП')));
    updateSec('pow');
    runUpdate(S.inst.summary);
    if (r.net) return false;
}


// Опрос журнала событий:
async function pollEvents() {
    try { const r = await api('/api/ups/events?limit=200'); if (r.events) S.events = r.events; } catch { return false; }
    runUpdate(S.inst.events);
}
// История: в Live раз в секунду догружаем хвост, иначе - только при навигации.
async function pollHistory() {
    if (!S.live || S.gesture || S.loading) return;
    if (needFull()) await loadFull(); else await loadTail();
}

// Один общий цикл отрисовки: время в Live плавно едет, перерисовываются только
// видимые графики и только если картинка реально сдвинулась.
function frame(ts) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (S.live && !S.gesture) { const t = nowSec(); S.view = { from: t - S.span, to: t }; }
    const span = S.view.to - S.view.from;
    let drew = false;
    for (const c of S.charts) {
        if (!c.visible || !c.ctx || c.wrap.hidden || c.w.collapsed) continue;
        const shift = Math.max(Math.abs(S.view.to - c.lastTo), Math.abs(S.view.from - c.lastFrom)) / span * c.plotW();
        const urgent = c.dirty || c.yAnimating || c.revealing;
        if (!urgent && shift < 1) continue;  // Сдвиг меньше пикселя не виден - не перерисовываем.
        if (!urgent && ts - c.lastDraw < 32) continue;  // Чистая прокрутка - не чаще ~30 раз в секунду.
        if (TOUCH && S.gesture && c !== S.gestureChart && ts - c.lastDraw < 100) continue;
        c.draw();
        drew = true;
    }
    if (drew && hover) renderHover();
    for (const h of S.hooks) h(ts);
    sparkFrame(ts);
    if (ts - (frame.inputsT || 0) > 500) {
        frame.inputsT = ts;
        if (document.activeElement !== $('#from')) $('#from').value = toInput(S.view.from);
        if (document.activeElement !== $('#to')) $('#to').value = toInput(S.view.to);
    }
}

//
// Запуск.
//
function bindUi() {
    $$('#presets [data-span]').forEach(b => b.onclick = () => { S.span = +b.dataset.span; store.set('span', S.span); setLive(true); });
    $('#live').onclick = () => setLive(!S.live);
    $('#panL').onclick = () => panBy(-(S.view.to - S.view.from) / 2);
    $('#panR').onclick = () => panBy((S.view.to - S.view.from) / 2);
    $('#zoomIn').onclick = () => zoomAt((S.view.from + S.view.to) / 2, 0.5);
    $('#zoomOut').onclick = () => zoomAt(S.live ? S.view.to : (S.view.from + S.view.to) / 2, 2);
    $('#apply').onclick = () => { const f = fromInput($('#from').value), t = fromInput($('#to').value); if (t > f) { setView(f, t); maybeLive(); } };
    $$('#modeAll button').forEach(b => b.onclick = () => setSplit(S.charts.filter(c => c.canSplit).map(c => c.id), b.dataset.mode === '1'));
    $('#helpBtn').onclick = () => { $('#help').hidden = !$('#help').hidden; $('#helpBtn').classList.toggle('on', !$('#help').hidden); };
    $('#langName').textContent = LANG.toUpperCase();
    // Браузер без сети (или в DevTools включён Offline) - пишем это, а не показываем застывшие данные:
    const offline = () => odoIn($('#sysSub'), i18n('Нет сети: браузер в режиме офлайн'));
    addEventListener('offline', offline);
    if (!navigator.onLine) offline();
    $('#langBtn').onclick = () => setLang(LANG === 'en' ? 'ru' : 'en');

    // Выход (кнопка видна, только если на сервере задан пароль):
    fetch('/api/auth').then(r => r.json()).then(a => { if (a.enabled) $('#logoutBtn').hidden = false; }).catch(() => {});
    $('#logoutBtn').onclick = e => {
        e.stopPropagation();
        const m = $('#authMenu');
        if (!m.hidden) { m.hidden = true; return; }
        m.innerHTML = TR`<h4>Сессия</h4><div class="item" data-out="1">Выйти</div><div class="item" data-out="all">Выйти на всех устройствах</div>`;
        openPop(m, e.currentTarget);
    };
    $('#authMenu').onclick = async e => {
        const it = e.target.closest('[data-out]');
        if (!it) return;
        await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: it.dataset.out === 'all' }) }).catch(() => {});
        location.replace('/login');
    };

    const setEdit = v => { S.edit = v; document.body.classList.toggle('editing', v); $('#editbar').hidden = !v; $('#editBtn').classList.toggle('on', v); queueFlip(); };
    $('#editBtn').onclick = () => setEdit(!S.edit);
    $('#editDone').onclick = () => setEdit(false);
    const reset = () => {
        ['layout5', 'widths3', 'whidden3', 'collapsed2', 'heights2', 'split2', 'sel2', 'cstyle', 'yzero', 'c3dMode2'].forEach(k => store.set(k, null));
        S.layout = loadLayout(); S.widths = {}; S.whidden = new Set(DEFAULT_HIDDEN); S.collapsed = new Set(); S.heights = {}; S.split = {}; S.cstyle = {}; S.yzero = {};
        S.sel = {}; S.y = {};  // Выбор линий и ручной масштаб - тоже по умолчанию.
        S.c3dMode = 'bar';
        rebuildAll();
        renderWidgetsMenu();
    };
    $('#resetLayout').onclick = reset;

    const wm = $('#widgetsMenu'), tm = $('#themeMenu'), cm = $('#chartMenu');
    $('#widgetsBtn').onclick = e => { e.stopPropagation(); tm.hidden = cm.hidden = true; if (!wm.hidden) { wm.hidden = true; return; } renderWidgetsMenu(); openPop(wm, e.currentTarget); };
    $('#themeBtn').onclick = e => { e.stopPropagation(); wm.hidden = cm.hidden = true; if (!tm.hidden) { tm.hidden = true; return; } renderThemeMenu(); openPop(tm, e.currentTarget); };
    wm.onclick = e => { e.stopPropagation(); if (e.target.closest('#menuReset')) reset(); };
    wm.onchange = e => {
        const id = e.target.dataset.id;
        if (!id) return;
        if (e.target.checked) { S.whidden.delete(id); store.set('whidden3', [...S.whidden]); renderLayout(); }
        else hideWidget(id);
    };
    tm.onclick = e => {
        e.stopPropagation();
        const it = e.target.closest('[data-t]');
        if (!it) return;
        applyTheme(it.dataset.t);
        renderThemeMenu();
        rebuildAll();
    };
    document.addEventListener('click', () => { wm.hidden = true; tm.hidden = true; cm.hidden = true; $('#authMenu').hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { wm.hidden = tm.hidden = cm.hidden = true; setEdit(false); } });
    // Тап мимо графика или плитки закрывает подсказку (на телефоне нет «ухода курсора»):
    document.addEventListener('pointerdown', e => {
        if (tipOwner === 'tile' && !e.target.closest('.thr')) { S.tile = null; tipHide('tile'); }
        if (tipOwner === 'chart' && e.pointerType !== 'mouse' && !e.target.closest('.cwrap')) hideHover();
    });
    document.addEventListener('scroll', () => { if (hover) hideHover(); if (S.tile) { S.tile = null; tipHide('tile'); } tipHide('ribbon'); }, { passive: true });

    // Подсветка текущего раздела в навигации:
    const io = new IntersectionObserver(entries => entries.forEach(en => {
        if (en.isIntersecting) $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.sec === en.target.id));
    }), { rootMargin: '-40% 0px -55% 0px' });
    $$('.section').forEach(s => io.observe(s));

    // При изменении размера окна раскладка перестраивается без анимации:
    let rt = null;
    window.addEventListener('resize', () => {
        flipMuted = true;
        clearTimeout(rt);
        rt = setTimeout(() => { $$('.w').forEach(setRows); flip(); flipMuted = false; }, 250);
    });
    // Вкладку вернули - сразу догоняем данные:
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { invalidate(); if (S.live) scheduleLoad(); } });
}

//
// Диагностика: ошибки и состояние страницы на телефоне уходят в журнал сервера.
// Если страница упала и открылась заново, сервер запишет её последнее состояние перед падением.
//
const DIAG = { sid: Math.random().toString(36).slice(2, 10), t0: Date.now(), errors: 0 };


// Отправить запись диагностики:
function diagSend(kind, data) {
    try {
        fetch('/api/client-log', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, sid: DIAG.sid, ...data }) }).catch(() => {});
    } catch { /* Не мешаем странице. */ }
}


// Состояние страницы: элементы, холсты, память, видимые виджеты:
function diagState() {
    let px = 0, n = 0;
    for (const c of document.getElementsByTagName('canvas')) { px += c.width * c.height; n++; }
    return {
        up: Math.round((Date.now() - DIAG.t0) / 1000), dom: document.getElementsByTagName('*').length, canvases: n,
        canvasMP: +(px / 1e6).toFixed(1), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        onscreen: Object.values(S.inst).filter(w => w.onscreen !== false).map(w => w.id).join(','), scrollY: Math.round(scrollY),
        docH: document.documentElement.scrollHeight, vw: innerWidth, dpr: window.devicePixelRatio, errors: DIAG.errors,
    };
}

window.addEventListener('error', e => { if (/ResizeObserver loop/.test(e.message)) return; if (DIAG.errors++ < 20) diagSend('error', { msg: `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}` }); });
window.addEventListener('unhandledrejection', e => { if (DIAG.errors++ < 20) diagSend('error', { msg: 'promise: ' + String(e.reason && (e.reason.message || e.reason)) }); });
if (TOUCH) setInterval(() => { if (!document.hidden) diagSend('state', diagState()); }, 15000);


// Сохранить состояние в браузере (clean - страницу закрыли или свернули сами, это не вылет):
function diagSave(clean) {
    try {
        const pts = Object.values(S.data).reduce((a, d) => a + d.t.length * Object.keys(d.cols).length, 0);
        localStorage.setItem('sysdeck.diag', JSON.stringify({ ...diagState(), clean, at: Date.now(), gesture: !!S.gesture, span: S.span, points: pts }));
    } catch { /* Нет места или приватный режим. */ }
}

if (TOUCH) {
    try {
        const prev = JSON.parse(localStorage.getItem('sysdeck.diag') || 'null');
        if (prev && !prev.clean) diagSend('crash', { prev });
    } catch { /* Нет данных. */ }
    setInterval(() => { if (!document.hidden) diagSave(false); }, 3000);
    addEventListener('pagehide', () => diagSave(true));
    document.addEventListener('visibilitychange', () => diagSave(document.hidden));
}


// Запуск:
function init() {
    translateDom(document.body);
    applyTheme(document.documentElement.dataset.theme);
    bindUi();
    const now = nowSec();
    S.view = { from: now - S.span, to: now };
    $('#live').classList.add('on');
    renderLayout(true);
    setUpsShown(false);
    const clock = () => { odoIn($('#clock'), new Date().toLocaleTimeString(LANG === 'ru' ? 'ru-RU' : 'en-GB')); };
    clock();
    setInterval(clock, 1000);
    loop(pollPc, 1000);
    loop(pollUps, 1000);
    loop(pollEvents, 5000);
    loop(pollHistory, 1000);
    // Страховка для «кирпичной» сетки: ResizeObserver может пропускать изменения, пока вкладка неактивна.
    setInterval(() => { let ch = false; $$('.w').forEach(el => { if (setRows(el)) ch = true; }); if (ch) queueFlip(); }, 1000);
    requestAnimationFrame(frame);
    setTimeout(() => { flip(); flipMuted = false; }, 1500);
}

init();
