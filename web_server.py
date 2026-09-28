#
# web_server.py - Дашборд для ippon_ups.py + мониторинг ПК.
#
# Раздаёт сайт из папки web, забирает данные ИБП по сети у ippon_ups.py
# и сам собирает параметры этого ПК (ippon_ups.py их не трогает):
#   GET /api/ups/...                                     - Прокси на сервер данных ИБП (/api/ups/status -> /api/status).
#   GET /api/pc/status                                   - Текущие параметры ПК и все датчики.
#   GET /api/pc/data?start=&end=&max_points=|&bucket=    - История загрузки ПК.
#   GET /api/pc/sensors?start=&end=&max_points=|&bucket= - История температур и вентиляторов.
#   GET /login, POST /api/login, POST /api/logout, GET /api/auth - Вход по паролю.
#
# Настройки - в sysdeck.json рядом со скриптом (порт, вход по паролю, срок сессии и т.д.).
# Если auth_enabled = true, весь сайт и API доступны только после входа: сессия хранится
# в cookie (подписанный токен) и живёт session_days дней. Пароль хранится только хешем (PBKDF2).
# Изменения sysdeck.json, касающиеся входа, применяются на лету, без перезапуска.
#   python web_server.py --set-password          - Задать пароль (и включить вход по паролю)
#   python web_server.py --auth on|off           - Включить / выключить вход по паролю
#   python web_server.py --config session_days=7 - Поменять параметр sysdeck.json.
#
# Температуры CPU/материнки/VRM/чипсета и обороты вентиляторов Windows сама не отдаёт,
# их берём из LibreHardwareMonitor: Options -> Remote Web Server -> Run (порт 8085).
# Без него работает всё остальное, а температура GPU берётся из nvidia-smi.
#
# Запуск: python web_server.py [--host 0.0.0.0] [--port 8080] [--ups http://127.0.0.1:8765]
#                              [--lhm http://127.0.0.1:8085/data.json].
#


# Подключаем:
import os
import re
import sys
import hmac
import json
import time
import shutil
import psutil
import getpass
import hashlib
import secrets
import ipaddress
import sqlite3
import argparse
import platform
import threading
import subprocess
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime
from http.cookies import SimpleCookie
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


# Глобальные переменные:
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
DATA_DIR = os.path.join(BASE_DIR, "data")  # Базы лежат отдельно, чтобы не дёргать проводник в папке со скриптами.
PC_DB_PATH = os.path.join(DATA_DIR, "sysdeck.db")  # Общая база с ippon_ups.py (у каждого свои таблицы).
PC_POLL_SEC = 1.0          # Период сбора загрузки ПК.
SENSOR_POLL_SEC = 2.0      # Период опроса датчиков (LibreHardwareMonitor).
PROCS_POLL_SEC = 5.0       # Период обновления списка процессов.
GPU_POLL_SEC = 5.0         # Период опроса nvidia-smi (каждый запуск - отдельный процесс).
DISKS_POLL_SEC = 30.0      # Период проверки свободного места.
FLUSH_SEC = 20.0           # Как часто сбрасывать историю на диск (реже - меньше обращений к диску).
PC_RETENTION_DAYS = 14     # Сколько дней хранить историю загрузки ПК.
SENSOR_RETENTION_DAYS = 3  # Сколько дней хранить историю температур и вентиляторов.
CORES_HISTORY = 60         # Сколько секунд истории по каждому потоку CPU отдавать сайту.
SENSOR_HIST_SEC = 5.0      # Как часто писать датчики в историю (на сайте они обновляются чаще).
# Пороги SSD («Warning/Critical Temperature») - это не измерения, в историю и графики их не пускаем:
THRESHOLD_RE = re.compile(r"warning|critical|threshold|limit", re.I)
# Частота ядра в LHM: AMD - «Core #1», Intel - «CPU Core #1», гибридные Intel - «P-Core #1» / «E-Core #1»:
CORE_CLOCK_RE = re.compile(r"(?:CPU |[PE]-)?Core #\d+", re.I)


# Какие датчики LibreHardwareMonitor писать в историю:
def history_keep(s: dict) -> bool:
    t, hw, name = s["type"], s["hw_type"], s["name"]
    if t == "Temperature": return not THRESHOLD_RE.search(name)
    if t == "Fan": return True
    if t == "Voltage": return hw == "superio" or (hw == "cpu" and not re.search(r"#\d", name))  # Шины материнки, Vcore/SoC.
    if t == "Clock": return (hw == "cpu" and CORE_CLOCK_RE.fullmatch(name) is not None) or hw == "gpu"
    if t == "Power": return hw in ("cpu", "gpu") and not re.search(r"#\d", name)  # Пакет целиком, не каждое ядро.
    return False
UPS_URL = "http://127.0.0.1:8765"
LHM_URL = "http://127.0.0.1:8085/data.json"

# Без системного прокси, чтобы локальные запросы не уходили наружу:
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


#
# Настройки (sysdeck.json).
#

CONFIG_PATH = os.path.join(DATA_DIR, "sysdeck.json")
DEFAULT_CONFIG = {
    "web_host": "0.0.0.0",          # Адрес сайта (0.0.0.0 = вся локальная сеть).
    "web_port": 8080,               # Порт сайта.
    "auth_enabled": False,          # Вход по паролю (нужен, если сайт открыт через туннель).
    "password": "",                 # Можно вписать пароль сюда - при запуске он заменится хешем.
    "password_hash": "",
    "session_days": 3,              # Сколько дней помнить вход.
    "trust_lan": False,             # true - из домашней сети без пароля (через туннель пароль нужен всегда).
    "ups_url": "http://127.0.0.1:8765",
    "ups": True,                    # Запускать ippon_ups.py (false - если ИБП нет).
    "lhm": True,                    # Запускать LibreHardwareMonitor из папки проекта.
    "lhm_port": 8085,
}
_config_lock = threading.Lock()


# Загрузить настройки (нет файла или он испорчен - настройки по умолчанию):
def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    for attempt in range(20):
        try:
            with open(CONFIG_PATH, encoding="utf-8-sig") as f: data = json.load(f)
            if not isinstance(data, dict): raise ValueError("ожидался объект JSON")
            cfg.update(data)
        except FileNotFoundError:
            save_config(cfg)
            print("[I] data/sysdeck.json не найден - созданы настройки по умолчанию.")
        except PermissionError:
            # Файл как раз заменяют (сохраняет лаунчер) - это не порча, читаем ещё раз. Иначе сбросили бы пароль:
            if attempt == 19: raise
            time.sleep(0.05)
            continue
        except (ValueError, OSError) as e:
            # Испорченный файл откладываем рядом (.broken) и начинаем с настроек по умолчанию:
            try: os.replace(CONFIG_PATH, CONFIG_PATH + ".broken")
            except OSError: pass
            save_config(cfg)
            print(f"[W] data/sysdeck.json испорчен ({e}) - восстановлены настройки по умолчанию, старый файл: sysdeck.json.broken")
        break
    # Открытый пароль из файла заменяем хешем, чтобы он не лежал на диске (и включаем вход):
    if cfg.get("password"):
        cfg["password_hash"], cfg["password"], cfg["auth_enabled"] = hash_password(str(cfg["password"])), "", True
        save_config(cfg)
        print("[I] Пароль из sysdeck.json заменён хешем, вход по паролю включён.")
    return cfg


# Сохранить настройки (атомарно, через временный файл):
def save_config(cfg: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with _config_lock:
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f: json.dump(cfg, f, ensure_ascii=False, indent=4)
        # Пока файл читает другой процесс, Windows не даёт его заменить - ждём и пробуем снова:
        for attempt in range(40):
            try:
                os.replace(tmp, CONFIG_PATH)
                break
            except PermissionError:
                if attempt == 39: raise
                time.sleep(0.05)


#
# Пароль и сессии.
#


# Хеш пароля (PBKDF2-SHA256 с солью):
def hash_password(pw: str, iterations: int = 240_000) -> str:
    salt = os.urandom(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${h.hex()}"


# Проверить пароль по хешу:
def check_password(pw: str, stored: str) -> bool:
    try:
        algo, n, salt, h = stored.split("$")
        if algo != "pbkdf2_sha256": return False
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), int(n)).hex()
        return hmac.compare_digest(calc, h)
    except (ValueError, TypeError):
        return False


# Вход по паролю и сессии сайта:
class Auth:
    COOKIE = "sysdeck_session"
    FAIL_WINDOW = 600           # Окно подсчёта неудачных попыток, с.
    FAIL_PER_IP = 5             # Столько ошибок с одного адреса - и пауза на FAIL_WINDOW.
    FAIL_TOTAL = 30             # Столько ошибок со всех адресов - пауза для всех (перебор с разных IP).

    # Инициализация:
    def __init__(self, cfg: dict) -> None:
        self.key_path = os.path.join(DATA_DIR, "session.key")
        self.secret = self._load_key()
        self.lock = threading.Lock()
        self.fails = {}         # ip -> [время ошибки, ...].
        self._checked = time.time()
        try: self._mtime = os.path.getmtime(CONFIG_PATH)
        except OSError: self._mtime = 0
        self._key_mtime = self._key_stamp()
        self.apply(cfg)

    # Время изменения файла ключа сессий:
    def _key_stamp(self) -> float:
        try: return os.path.getmtime(self.key_path)
        except OSError: return 0

    # Применить настройки входа:
    def apply(self, cfg: dict) -> None:
        self.on = bool(cfg.get("auth_enabled"))
        self.hash = str(cfg.get("password_hash") or "")
        self.days = max(0.05, float(cfg.get("session_days") or 3))
        self.trust_lan = bool(cfg.get("trust_lan"))

    # sysdeck.json поменяли (SysDeck.pyw) - подхватываем без перезапуска (проверка не чаще раза в 2 с):
    def refresh(self) -> None:
        now = time.time()
        if now - self._checked < 2: return
        self._checked = now
        k = self._key_stamp()
        if k != self._key_mtime:  # Ключ сменили или удалили - все старые сессии недействительны.
            self.secret = self._load_key()
            self._key_mtime = self._key_stamp()
            print("[I] Ключ сессий обновлён - все входы на сайт сброшены.")
        try: m = os.path.getmtime(CONFIG_PATH)
        except OSError: m = -1  # Файл удалили - load_config() создаст его заново.
        if m != self._mtime:
            try: self.apply(load_config())
            except OSError as e:
                print(f"[W] Не удалось прочитать sysdeck.json ({e}) - вход работает по прежним настройкам.")
                return
            try: self._mtime = os.path.getmtime(CONFIG_PATH)
            except OSError: self._mtime = 0
            print(f"[I] Настройки входа обновлены: {'по паролю' if self.on else 'без пароля'}.")

    # Вход по паролю включён. Включён, а пароль не задан - не пускаем никого (так безопаснее):
    @property
    def enabled(self) -> bool:
        return self.on

    # Секрет подписи сессий. Новый секрет = все выданные сессии недействительны («выйти везде»):
    def _load_key(self, rotate: bool = False) -> bytes:
        os.makedirs(DATA_DIR, exist_ok=True)
        if not rotate:
            try:
                with open(self.key_path, "rb") as f:
                    key = f.read()
                if len(key) >= 32: return key
            except FileNotFoundError: pass
        key = secrets.token_bytes(32)
        with open(self.key_path, "wb") as f: f.write(key)
        return key

    # Новый ключ сессий (все входы сбрасываются):
    def rotate(self) -> None:
        self.secret = self._load_key(rotate=True)
        self._key_mtime = self._key_stamp()

    # Токен: срок.случайное.подпись. В подпись входит хеш пароля - смена пароля тоже завершает все сессии.
    def _sign(self, payload: str) -> str:
        return hmac.new(self.secret + self.hash.encode(), payload.encode(), hashlib.sha256).hexdigest()

    # Выдать токен сессии на ttl секунд:
    def make_token(self, ttl: float) -> str:
        payload = f"{int(time.time() + ttl)}.{secrets.token_hex(8)}"
        return payload + "." + self._sign(payload)

    # Проверить токен сессии:
    def check_token(self, token: str) -> bool:
        try:
            exp, nonce, sig = token.split(".")
            return int(exp) > time.time() and hmac.compare_digest(sig, self._sign(f"{exp}.{nonce}"))
        except (ValueError, AttributeError):
            return False

    # Защита от перебора: сколько секунд ещё ждать этому адресу (0 - можно пробовать):
    def blocked(self, ip: str) -> int:
        now = time.time()
        with self.lock:
            for k in list(self.fails):
                self.fails[k] = [t for t in self.fails[k] if now - t < self.FAIL_WINDOW]
                if not self.fails[k]: del self.fails[k]
            mine = self.fails.get(ip, [])
            if len(mine) >= self.FAIL_PER_IP: return int(mine[-1] + self.FAIL_WINDOW - now) + 1
            total = sorted(t for v in self.fails.values() for t in v)
            if len(total) >= self.FAIL_TOTAL: return int(total[-1] + self.FAIL_WINDOW - now) + 1
        return 0

    # Отметить неудачную попытку входа, вернуть сколько попыток осталось:
    def failed(self, ip: str) -> int:
        with self.lock:
            self.fails.setdefault(ip, []).append(time.time())
            return max(0, self.FAIL_PER_IP - len(self.fails[ip]))

    # Успешный вход - сбросить счётчик ошибок:
    def succeeded(self, ip: str) -> None:
        with self.lock: self.fails.pop(ip, None)


# Время из запроса: unix-секунды, unix-миллисекунды или ISO (локальное время):
def parse_time(s: str) -> float:
    s = s.strip()
    try:
        v = float(s)
        return v / 1000 if v > 1e11 else v
    except ValueError:
        return datetime.fromisoformat(s).timestamp()


# Название процессора (на Windows берём из реестра, platform.processor() там малоинформативен):
def cpu_name() -> str:
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
            return winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
    except Exception:
        return platform.processor() or platform.machine()


# Название Windows. platform.release() и даже ProductName в реестре у Windows 11 пишут «10»,
# поэтому смотрим на номер сборки: с 22000 - это Windows 11.
def os_name() -> str:
    if platform.system() != "Windows":
        return f"{platform.system()} {platform.release()}"
    build, ubr, disp = 0, None, ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") as k:
            # Прочитать значение из реестра:
            def q(name, default=None):
                try: return winreg.QueryValueEx(k, name)[0]
                except OSError: return default
            build, ubr, disp = int(q("CurrentBuild", 0) or 0), q("UBR"), q("DisplayVersion", "") or ""
    except Exception: pass
    if not build:
        try: build = int(platform.version().split(".")[2])
        except (IndexError, ValueError): pass
    name = "Windows 11" if build >= 22000 else f"Windows {platform.release()}"
    edition = platform.win32_edition() if hasattr(platform, "win32_edition") else ""
    edition = {"Professional": "Pro", "Core": "Home", "CoreSingleLanguage": "Home", "ProfessionalWorkstation": "Pro for Workstations",
               "ProfessionalEducation": "Pro Education"}.get(edition or "", edition or "")
    parts = [name, edition, disp]
    return " ".join(x for x in parts if x) + (f" (сборка {build}.{ubr})" if ubr is not None else f" (сборка {build})")


#
# LibreHardwareMonitor.
#

# Группы датчиков в дереве LHM -> тип датчика:
LHM_GROUPS = {
    "Voltages": "Voltage", "Currents": "Current", "Powers": "Power", "Clocks": "Clock",
    "Temperatures": "Temperature", "Load": "Load", "Frequencies": "Frequency", "Fans": "Fan",
    "Flows": "Flow", "Controls": "Control", "Levels": "Level", "Factors": "Factor",
    "Data": "Data", "Throughput": "Throughput", "Energy": "Energy", "Times": "Time",
}
# Иконка узла -> тип железа. Ненадёжно: «amd» - это процессор AMD (у видеокарт AMD - «ati»), а «intel» -
# и процессор, и встроенная графика Intel. Поэтому главное - SensorId (LHM_ID_TYPES), иконка - запасной вариант:
LHM_HW_ICONS = {
    "cpu": "cpu", "amd": "cpu", "mainboard": "mainboard", "chip": "superio", "ram": "ram",
    "nvidia": "gpu", "ati": "gpu", "hdd": "storage", "nic": "network", "battery": "battery",
}
# Тип железа по началу SensorId («/amdcpu/0/clock/1», «/gpu-nvidia/0/...», «/lpc/it8689e/0/...»):
LHM_ID_TYPES = (
    (re.compile(r"^/(amdcpu|intelcpu|cpu)/"), "cpu"), (re.compile(r"^/gpu"), "gpu"), (re.compile(r"^/lpc/"), "superio"),
    (re.compile(r"^/mainboard"), "mainboard"), (re.compile(r"^/(ram|memory)"), "ram"),
    (re.compile(r"^/(nvme|hdd|ssd|ata|scsi|storage)"), "storage"), (re.compile(r"^/nic"), "network"), (re.compile(r"^/battery"), "battery"),
)
# Последний вариант - по названию устройства (графика проверяется раньше процессора: «Intel UHD Graphics»):
LHM_NAME_TYPES = (
    (re.compile(r"nvidia|geforce|radeon|rtx|gtx|arc|graphics", re.I), "gpu"),
    (re.compile(r"ITE|IT8\d|Nuvoton|NCT\d|Fintek", re.I), "superio"),
    (re.compile(r"ryzen|athlon|epyc|threadripper|intel|core\(tm\)|xeon|pentium|celeron|cpu", re.I), "cpu"),
)


# Тип железа датчика: по SensorId, иначе по иконке узла, иначе по названию устройства:
def lhm_hw_type(sensor_id: str, icon_type: str, hw: str) -> str:
    for rx, t in LHM_ID_TYPES:
        if rx.match(sensor_id or ""): return t
    if icon_type: return icon_type
    for rx, t in LHM_NAME_TYPES:
        if rx.search(hw or ""): return t
    return ""
_NUM_RE = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


# Число из строки LHM ("1,250 V" -> 1.25):
def _num(s):
    if s is None: return None
    if isinstance(s, (int, float)): return float(s)
    m = _NUM_RE.search(str(s))
    return float(m.group(0).replace(",", ".")) if m else None


# Дерево data.json -> плоский список датчиков:
def parse_lhm(tree: dict) -> list:
    out = []

    # Обойти узел дерева датчиков:
    def walk(node: dict, hw: str, hw_type: str, group) -> None:
        text = str(node.get("Text", "")).strip()
        kids = node.get("Children") or []
        if not kids:
            if group is None: return
            raw = str(node.get("Value", "")).strip()
            m = _NUM_RE.search(raw)
            if not m: return
            sid = node.get("SensorId") or ""
            out.append({
                "id": sid or f"{hw}/{group}/{text}", "hw": hw, "hw_type": lhm_hw_type(sid, hw_type, hw),
                "type": node.get("Type") or group, "name": text, "value": float(m.group(0).replace(",", ".")),
                "min": _num(node.get("Min")), "max": _num(node.get("Max")), "unit": raw[m.end():].strip(),
            })
            return
        if text in LHM_GROUPS:
            for k in kids: walk(k, hw, hw_type, LHM_GROUPS[text])
            return
        icon = os.path.splitext(os.path.basename(str(node.get("ImageURL", ""))))[0].lower()
        # Узел железа: знакомая иконка или внутри - группы датчиков («Clocks», «Temperatures»...):
        if icon in LHM_HW_ICONS or any(str(k.get("Text", "")).strip() in LHM_GROUPS for k in kids):
            hw, hw_type = text, LHM_HW_ICONS.get(icon, "")
        for k in kids: walk(k, hw, hw_type, None)

    walk(tree, "", "", None)
    return out


#
# История.
#


# История ПК и датчиков (SQLite):
class PcStorage:
    COLUMNS = [
        "t", "cpu_avg", "cpu_max", "freq_avg", "ram_avg", "swap_avg",
        "disk_r_avg", "disk_r_max", "disk_w_avg", "disk_w_max",
        "net_rx_avg", "net_rx_max", "net_tx_avg", "net_tx_max",
        "gpu_avg", "gpu_max", "gpu_mem_avg", "gpu_temp_avg", "cpu_temp_avg", "samples",
    ]

    # Одно постоянное соединение на запись и запись пачками: если открывать и закрывать базу
    # каждую секунду, SQLite создаёт/удаляет файлы -wal/-shm, и проводник постоянно перечитывает папку.
    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.pending_pc, self.pending_sens = [], []
        self._sids = {}
        self.db = sqlite3.connect(path, timeout=10, check_same_thread=False)
        c = self.db
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")  # В WAL это безопасно, а fsync нужен намного реже.
        c.execute("""CREATE TABLE IF NOT EXISTS pc (
            ts REAL PRIMARY KEY, cpu REAL, freq REAL, ram REAL, swap REAL,
            disk_r REAL, disk_w REAL, net_rx REAL, net_tx REAL,
            gpu REAL, gpu_mem REAL, gpu_temp REAL, cpu_temp REAL)""")
        # Старая версия таблицы была без cpu_temp:
        if "cpu_temp" not in [r[1] for r in c.execute("PRAGMA table_info(pc)")]:
            c.execute("ALTER TABLE pc ADD COLUMN cpu_temp REAL")
        c.execute("""CREATE TABLE IF NOT EXISTS sensor_ids (
            sid INTEGER PRIMARY KEY, key TEXT UNIQUE, name TEXT, hw TEXT, type TEXT, unit TEXT, hw_type TEXT)""")
        if "hw_type" not in [r[1] for r in c.execute("PRAGMA table_info(sensor_ids)")]:
            c.execute("ALTER TABLE sensor_ids ADD COLUMN hw_type TEXT")
        c.execute("CREATE TABLE IF NOT EXISTS sensor_hist (ts REAL, sid INTEGER, v REAL)")
        c.execute("CREATE INDEX IF NOT EXISTS sensor_hist_ts ON sensor_hist (ts)")
        c.commit()
        self._sids = {k: s for s, k in c.execute("SELECT sid, key FROM sensor_ids")}
        self._typed = set()  # Датчики, у которых в этом запуске уже проставлен тип железа.

    # Чтение - отдельным соединением (запросы сайта идут из других потоков):
    def _reader(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=10)

    # Добавить замер ПК в очередь на запись:
    def add(self, row: tuple) -> None:
        with self.lock: self.pending_pc.append(row)

    # Добавить замеры датчиков в очередь на запись:
    def add_sensors(self, ts: float, sensors: list) -> None:
        with self.lock: self.pending_sens.append((ts, sensors))

    # Записать всё накопленное одной транзакцией:
    def flush(self) -> None:
        with self.lock:
            if not self.pending_pc and not self.pending_sens: return
            pc, sens = self.pending_pc, self.pending_sens
            self.pending_pc, self.pending_sens = [], []
            with self.db:
                self.db.executemany("""INSERT OR REPLACE INTO pc
                    (ts, cpu, freq, ram, swap, disk_r, disk_w, net_rx, net_tx, gpu, gpu_mem, gpu_temp, cpu_temp)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", pc)
                rows = []
                for ts, sensors in sens:
                    for s in sensors:
                        sid = self._sids.get(s["id"])
                        if sid is None:
                            self.db.execute("INSERT OR IGNORE INTO sensor_ids (key, name, hw, type, unit, hw_type) VALUES (?,?,?,?,?,?)",
                                            (s["id"], s["name"], s["hw"], s["type"], s["unit"], s["hw_type"]))
                            sid = self.db.execute("SELECT sid FROM sensor_ids WHERE key = ?", (s["id"],)).fetchone()[0]
                            self._sids[s["id"]] = sid
                        if sid not in self._typed:  # У датчиков из прошлых версий типа железа не было.
                            self.db.execute("UPDATE sensor_ids SET hw_type = ? WHERE sid = ?", (s["hw_type"], sid))
                            self._typed.add(sid)
                        rows.append((ts, sid, s["value"]))
                self.db.executemany("INSERT INTO sensor_hist VALUES (?,?,?)", rows)

    # Удалить старую историю:
    def cleanup(self) -> None:
        now = time.time()
        with self.lock, self.db:
            self.db.execute("DELETE FROM pc WHERE ts < ?", (now - PC_RETENTION_DAYS * 86400,))
            self.db.execute("DELETE FROM sensor_hist WHERE ts < ?", (now - SENSOR_RETENTION_DAYS * 86400,))

    # Дописать накопленное перед чтением (ошибка записи не должна ломать ответ сайту):
    def _flush_for_read(self) -> None:
        try: self.flush()
        except sqlite3.Error as e: print(f"[W] Не удалось записать историю ПК: {e}")

    # История загрузки, сгруппированная по интервалам bucket секунд (avg и max):
    def query(self, start: float, end: float, bucket: float) -> dict:
        self._flush_for_read()  # Сайт должен видеть и то, что ещё не успело записаться.
        bucket = max(bucket, (end - start) / 50000, 1e-3)
        c = self._reader()
        try:
            rows = c.execute("""
                SELECT MIN(ts), ROUND(AVG(cpu), 1), MAX(cpu), ROUND(AVG(freq), 0),
                       ROUND(AVG(ram), 1), ROUND(AVG(swap), 1),
                       ROUND(AVG(disk_r), 0), MAX(disk_r), ROUND(AVG(disk_w), 0), MAX(disk_w),
                       ROUND(AVG(net_rx), 0), MAX(net_rx), ROUND(AVG(net_tx), 0), MAX(net_tx),
                       ROUND(AVG(gpu), 1), MAX(gpu), ROUND(AVG(gpu_mem), 1), ROUND(AVG(gpu_temp), 1),
                       ROUND(AVG(cpu_temp), 1), COUNT(*)
                FROM pc WHERE ts >= :s AND ts <= :e
                GROUP BY CAST(ts / :b AS INTEGER) ORDER BY 1""",
                {"s": start, "e": end, "b": bucket}).fetchall()
        finally: c.close()
        out = {name: [r[i] for r in rows] for i, name in enumerate(self.COLUMNS)}
        out.update({"start": start, "end": end, "bucket_sec": bucket, "points": len(rows)})
        return out

    # История датчиков: {t: [...], series: {key: [...]}, meta: {key: {name, hw, type, unit}}}:
    def query_sensors(self, start: float, end: float, bucket: float) -> dict:
        self._flush_for_read()
        bucket = max(bucket, (end - start) / 50000, 1e-3)
        c = self._reader()
        try:
            rows = c.execute("""
                SELECT CAST(ts / :b AS INTEGER) AS k, sid, MIN(ts), ROUND(AVG(v), 2)
                FROM sensor_hist WHERE ts >= :s AND ts <= :e
                GROUP BY k, sid ORDER BY k""", {"s": start, "e": end, "b": bucket}).fetchall()
            meta = {sid: {"key": key, "name": n, "hw": hw, "type": t, "unit": u, "hw_type": ht}
                    for sid, key, n, hw, t, u, ht in c.execute("SELECT sid, key, name, hw, type, unit, hw_type FROM sensor_ids")}
        finally: c.close()
        index, t = {}, []
        for k, _, ts, _ in rows:
            if k not in index:
                index[k] = len(t)
                t.append(ts)
            else:
                t[index[k]] = min(t[index[k]], ts)
        series = {}
        for k, sid, _, v in rows:
            m = meta.get(sid)
            if m is None: continue
            arr = series.setdefault(m["key"], [None] * len(t))
            arr[index[k]] = v
        return {
            "t": t, "series": series, "start": start, "end": end, "bucket_sec": bucket, "points": len(t),
            "meta": {m["key"]: {"name": m["name"], "hw": m["hw"], "type": m["type"], "unit": m["unit"], "hw_type": m["hw_type"]}
                     for m in meta.values() if m["key"] in series},
        }


#
# Сбор параметров ПК.
#


# Сбор параметров ПК:
class PcMonitor:
    # Инициализация:
    def __init__(self, storage: PcStorage) -> None:
        self.storage = storage
        self.lock = threading.Lock()
        self.snapshot = {}
        self.static = {
            "hostname": platform.node(),
            "os": os_name(),
            "python": platform.python_version(),
            "cpu_name": cpu_name(),
            "cores_physical": psutil.cpu_count(logical=False),
            "cores_logical": psutil.cpu_count(logical=True),
            "boot_time": psutil.boot_time(),
        }
        self.nvidia_smi = shutil.which("nvidia-smi")
        self.cores_hist = deque(maxlen=CORES_HISTORY)
        self.sensors = []
        self.lhm = {"ok": False, "url": LHM_URL, "error": "ещё не опрашивался"}
        self._lhm_retry = 0.0
        self._lhm_url = LHM_URL   # Адрес data.json, который отвечает (может смениться на localhost).
        self._lhm_logged = None   # Что последним писали в журнал про LHM: True - подключён, False - не отвечает.
        self._sens_fresh = False  # Поток датчиков принёс новые значения (для истории).
        self._t0 = time.time()
        self._disks, self._procs, self._gpus = [], [], []
        self._proc_count, self._procs_time = 0, 0.0
        self._users = {}  # pid -> имя пользователя (узнавать имя дорого, поэтому кэшируем).
        psutil.cpu_percent(percpu=True)  # Первый вызов всегда 0, «прогреваем».

    # Свободное место на дисках:
    def _read_disks(self) -> None:
        disks = []
        for part in psutil.disk_partitions(all=False):
            if "cdrom" in part.opts or not part.fstype: continue
            try: u = psutil.disk_usage(part.mountpoint)
            except OSError: continue
            disks.append({"mount": part.mountpoint, "fstype": part.fstype, "total": u.total,
                          "used": u.used, "free": u.free, "percent": u.percent})
        self._disks = disks

    # Список процессов:
    def _read_procs(self) -> None:
        ncpu = psutil.cpu_count() or 1
        procs, alive = [], set()
        for p in psutil.process_iter(["pid", "name", "memory_info", "num_threads"]):
            pid = p.info["pid"]
            alive.add(pid)
            try: cpu = p.cpu_percent(None) / ncpu
            except (psutil.NoSuchProcess, psutil.AccessDenied): continue
            if pid == 0: continue  # System Idle Process.
            if pid not in self._users:
                try: self._users[pid] = (p.username() or "").split("\\")[-1]
                except (psutil.NoSuchProcess, psutil.AccessDenied, OSError): self._users[pid] = ""
            mem = p.info["memory_info"].rss if p.info["memory_info"] else 0
            procs.append({"pid": pid, "name": p.info["name"], "cpu": round(cpu, 1), "mem": mem,
                          "threads": p.info.get("num_threads"), "user": self._users[pid]})
        self._users = {k: v for k, v in self._users.items() if k in alive}
        self._proc_count = len(procs)
        procs.sort(key=lambda x: (x["cpu"], x["mem"]), reverse=True)
        self._procs = procs[:60]
        self._procs_time = time.time()

    # Видеокарты NVIDIA (nvidia-smi):
    def _read_gpus(self) -> list:
        if not self.nvidia_smi: return []
        fields = ["name", "utilization.gpu", "utilization.memory", "memory.used", "memory.total", "temperature.gpu",
                  "power.draw", "power.limit", "fan.speed", "clocks.gr", "clocks.mem", "clocks.max.gr", "pstate", "driver_version"]
        try:
            out = subprocess.run(
                [self.nvidia_smi, "--query-gpu=" + ",".join(fields), "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        except Exception: return self._gpus
        gpus = []
        for line in out.strip().splitlines():
            f = [x.strip() for x in line.split(",")]
            if len(f) < len(fields): continue
            g = {"name": f[0], "pstate": f[12], "driver": f[13]}
            for key, val in zip(["util", "mem_util", "mem_used", "mem_total", "temp", "power", "power_limit",
                                 "fan", "clock", "mem_clock", "clock_max"], f[1:12]):
                g[key] = _num(val) if _NUM_RE.fullmatch(val.replace(" ", "")) else None
            # Часть драйверов (особенно RTX 40) не отдаёт потребление ([N/A]). Грубая оценка:
            # ~10% лимита в простое + остальное пропорционально загрузке.
            g["power_est"] = False
            if g["power"] is None and g["power_limit"] and g["util"] is not None:
                g["power"] = round(g["power_limit"] * (0.1 + 0.9 * g["util"] / 100), 1)
                g["power_est"] = True
            gpus.append(g)
        return gpus

    # Видеокарты по датчикам LHM - когда nvidia-smi нет (AMD, Intel). Поля - как у _read_gpus:
    @staticmethod
    def _gpus_from_lhm(sensors: list) -> list:
        by = {}
        for s in sensors:
            if s["hw_type"] == "gpu" and not THRESHOLD_RE.search(s["name"]): by.setdefault(s["hw"], []).append(s)
        gpus = []
        for name, ss in by.items():
            # Значение первого датчика этого типа, в названии которого есть одно из слов (по порядку):
            def pick(stype: str, *words: str):
                for w in words:
                    for s in ss:
                        if s["type"] == stype and w.lower() in s["name"].lower(): return s
                return None

            # Объём в МБ (LHM отдаёт МБ или ГБ):
            def mb(s):
                if s is None: return None
                return s["value"] * 1024 if str(s["unit"]).upper().startswith("G") else s["value"]
            util, mem_util = pick("Load", "GPU Core", "D3D 3D", "Core"), pick("Load", "Memory Controller", "GPU Memory")
            used, total = pick("SmallData", "Memory Used", "Dedicated Memory Used"), pick("SmallData", "Memory Total")
            temp, power, fan = pick("Temperature", "GPU Core", "Core", ""), pick("Power", "Package", "Total", "Core", ""), pick("Control", "Fan")
            clock, mem_clock = pick("Clock", "GPU Core", "Core"), pick("Clock", "GPU Memory", "Memory")
            gpus.append({
                "name": name, "pstate": "—", "driver": "—", "util": util and util["value"], "mem_util": mem_util and mem_util["value"],
                "mem_used": mb(used), "mem_total": mb(total), "temp": temp and temp["value"], "power": power and power["value"],
                "power_limit": None, "fan": fan and fan["value"], "clock": clock and clock["value"],
                "mem_clock": mem_clock and mem_clock["value"], "clock_max": None, "power_est": False,
            })
        # Сначала дискретная (у неё больше своей памяти), встроенная - после:
        gpus.sort(key=lambda g: -(g["mem_total"] or 0))
        return gpus

    # Датчики из LibreHardwareMonitor (+ GPU из nvidia-smi, если LHM нет):
    def _read_sensors(self) -> list:
        sensors = []
        if time.time() >= self._lhm_retry:
            # Сначала адрес, который отвечал; нет ответа по 127.0.0.1 - пробуем localhost (и наоборот):
            cur = self._lhm_url
            alt = cur.replace("127.0.0.1", "localhost") if "127.0.0.1" in cur else cur.replace("localhost", "127.0.0.1")
            err = None
            for url in dict.fromkeys([cur, alt]):
                try:
                    # На медленном ПК (много дисков, S.M.A.R.T.) LHM отвечает секундами - ждём до 8 с (это отдельный поток):
                    with _opener.open(url, timeout=8) as r:
                        sensors = parse_lhm(json.loads(r.read().decode("utf-8", "replace")))
                    if url != cur: print(f"[I] LibreHardwareMonitor отвечает по адресу {url} - дальше опрашиваем его.")
                    self._lhm_url, err = url, None
                    break
                except Exception as e:
                    err = err or f"{type(e).__name__}: {e}"
            if err is None:
                self.lhm = {"ok": True, "url": self._lhm_url, "error": "", "count": len(sensors)}
                if self._lhm_logged is not True:
                    print(f"[I] LibreHardwareMonitor подключён: {len(sensors)} датчиков ({self._lhm_url}).")
                    self._lhm_logged = True
            else:
                self.lhm = {"ok": False, "url": self._lhm_url, "error": err}
                self._lhm_retry = time.time() + 10.0  # Не долбим, если LHM не запущен.
                # В журнал - один раз на каждую потерю связи (первые 30 с LHM ещё запускается - молчим):
                if self._lhm_logged is not False and (self._lhm_logged or time.time() - self._t0 > 30):
                    print(f"[W] LibreHardwareMonitor не отвечает ({self._lhm_url}): {err}")
                    self._lhm_logged = False
        if not self.lhm["ok"]:
            for i, g in enumerate(self._gpus):
                if g.get("temp") is not None:
                    sensors.append({"id": f"nvidia-smi/{i}/temperature", "hw": g["name"], "hw_type": "gpu",
                                    "type": "Temperature", "name": "GPU Core", "value": g["temp"],
                                    "min": None, "max": None, "unit": "°C"})
        return sensors

    # Поток датчиков: LHM может отвечать секундами, а сбор загрузки ПК раз в секунду его не ждёт:
    def sensor_loop(self) -> None:
        while True:
            t0 = time.time()
            try:
                self.sensors = self._read_sensors()
                self._sens_fresh = True
            except Exception as e: print(f"[W] Sensors error: {e}")
            time.sleep(max(0.2, SENSOR_POLL_SEC - (time.time() - t0)))

    @staticmethod

    # Выбрать датчик по типу и приоритету названий:
    def _pick(sensors: list, hw_type: str, stype: str, prefer: tuple):
        cands = [s for s in sensors if s["hw_type"] == hw_type and s["type"] == stype]
        for name in prefer:
            for s in cands:
                if name.lower() in s["name"].lower(): return s["value"]
        return max((s["value"] for s in cands), default=None)

    # Основной цикл сбора:
    def run(self) -> None:
        last_disk, last_net = psutil.disk_io_counters(), psutil.net_io_counters(pernic=True)
        last_t = time.time()
        t_disks = t_procs = t_gpu = t_hist = t_cleanup = 0.0
        t_flush = time.time()
        while True:
            time.sleep(max(0.05, PC_POLL_SEC - (time.time() - last_t)))
            try:
                now = time.time()
                dt = max(now - last_t, 1e-3)
                if now - t_disks >= DISKS_POLL_SEC: self._read_disks(); t_disks = now
                if now - t_procs >= PROCS_POLL_SEC: self._read_procs(); t_procs = now
                if now - t_gpu >= GPU_POLL_SEC: self._gpus = self._read_gpus(); t_gpu = now
                new_sensors = None
                if self._sens_fresh:  # Свежие датчики принёс sensor_loop.
                    self._sens_fresh = False
                    new_sensors = self.sensors

                cores = psutil.cpu_percent(percpu=True)
                self.cores_hist.append(cores)
                cpu = sum(cores) / len(cores) if cores else 0.0
                freq = psutil.cpu_freq()
                vm, sw = psutil.virtual_memory(), psutil.swap_memory()

                disk = psutil.disk_io_counters()
                disk_r = max(0.0, (disk.read_bytes - last_disk.read_bytes) / dt) if disk and last_disk else 0.0
                disk_w = max(0.0, (disk.write_bytes - last_disk.write_bytes) / dt) if disk and last_disk else 0.0

                net = psutil.net_io_counters(pernic=True)
                stats, addrs = psutil.net_if_stats(), psutil.net_if_addrs()
                nics, rx_sum, tx_sum = [], 0.0, 0.0
                for name, n in net.items():
                    old = last_net.get(name)
                    rx = max(0.0, (n.bytes_recv - old.bytes_recv) / dt) if old else 0.0
                    tx = max(0.0, (n.bytes_sent - old.bytes_sent) / dt) if old else 0.0
                    st = stats.get(name)
                    if "loopback" in name.lower(): continue
                    if st and not st.isup and not rx and not tx: continue
                    rx_sum += rx
                    tx_sum += tx
                    nics.append({"name": name, "rx": rx, "tx": tx, "up": bool(st and st.isup),
                                 "speed": st.speed if st else 0,
                                 "ipv4": [a.address for a in addrs.get(name, []) if a.family == 2],
                                 "total_rx": n.bytes_recv, "total_tx": n.bytes_sent})
                nics.sort(key=lambda x: x["rx"] + x["tx"], reverse=True)
                last_disk, last_net, last_t = disk, net, now

                sensors = self.sensors
                gpus = self._gpus or self._gpus_from_lhm(sensors)  # Нет NVIDIA - видеокарта по данным LHM.
                gpu0 = gpus[0] if gpus else {}
                gpu_mem = (gpu0["mem_used"] / gpu0["mem_total"] * 100) if gpu0.get("mem_total") else None
                cpu_temp = self._pick(sensors, "cpu", "Temperature", ("Tctl/Tdie", "Package", "Tctl", "Tdie", "Core (Tctl"))
                cpu_power = self._pick(sensors, "cpu", "Power", ("Package",))
                # На Windows psutil отдаёт базовую частоту (3401 МГц), реальную - только LHM:
                core_clk = [s["value"] for s in sensors if s["hw_type"] == "cpu" and s["type"] == "Clock"
                            and CORE_CLOCK_RE.fullmatch(s["name"]) and s["value"] > 0]
                cpu_freq = round(sum(core_clk) / len(core_clk)) if core_clk else (round(freq.current) if freq else None)
                # Мощность видеокарты от LHM, если он её видит (надёжнее оценки по загрузке):
                gpu_power = self._pick(sensors, "gpu", "Power", ("Package", "Power", "Total"))
                if self._gpus and gpu_power is not None:
                    gpu0["power"], gpu0["power_est"] = gpu_power, False
                batt = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None

                snap = {
                    **self.static, "time": now, "uptime": now - self.static["boot_time"],
                    "cpu": round(cpu, 1), "cores": cores, "cores_hist": list(self.cores_hist),
                    "cpu_temp": cpu_temp, "cpu_power": cpu_power,
                    "freq": cpu_freq, "freq_max": round(max(core_clk)) if core_clk else (round(freq.max) if freq else None),
                    "freq_lhm": bool(core_clk),
                    "ram": {"total": vm.total, "used": vm.used, "available": vm.available, "percent": vm.percent},
                    "swap": {"total": sw.total, "used": sw.used, "percent": sw.percent},
                    "disk_io": {"read": disk_r, "write": disk_w}, "disks": self._disks,
                    "net": {"rx": rx_sum, "tx": tx_sum}, "nics": nics[:10],
                    "gpus": gpus, "procs": self._procs, "procs_time": self._procs_time,
                    "process_count": self._proc_count, "sensors": sensors, "lhm": self.lhm,
                    "battery": {"percent": batt.percent, "plugged": batt.power_plugged} if batt else None,
                }
                with self.lock: self.snapshot = snap

                self.storage.add((now, cpu, snap["freq"], vm.percent, sw.percent, disk_r, disk_w, rx_sum, tx_sum,
                                  gpu0.get("util"), gpu_mem, gpu0.get("temp"), cpu_temp))
                if new_sensors is not None and now - t_hist >= SENSOR_HIST_SEC:
                    self.storage.add_sensors(now, [s for s in new_sensors if history_keep(s)])
                    t_hist = now
                if now - t_flush >= FLUSH_SEC:
                    self.storage.flush()
                    t_flush = now
                if now - t_cleanup >= 3600:
                    self.storage.cleanup()
                    t_cleanup = now
            except Exception as e:
                print(f"[W] PC monitor error: {e}")

    # Последний снимок параметров:
    def get(self) -> dict:
        with self.lock: return self.snapshot


#
# HTTP.
#


# Обработчик запросов сайта:
class Handler(SimpleHTTPRequestHandler):
    monitor: PcMonitor = None
    storage: PcStorage = None
    auth: Auth = None
    server_version, sys_version = "SysDeck", ""
    PUBLIC = {"/login", "/login.html", "/style.css", "/i18n.js"}  # Доступно без входа (страница входа, её стили и переводы).
    diag, diag_err, diag_lock = {}, {}, threading.Lock()           # Диагностика страниц на телефонах.
    # На Windows типы файлов берутся из реестра и бывают неверными, задаём явно:
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
    }

    # Инициализация (файлы сайта - из папки web):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    # Не писать каждый запрос в консоль:
    def log_message(self, *args) -> None: pass

    # Общие заголовки каждого ответа:
    def end_headers(self) -> None:
        # private - чтобы Cloudflare не закэшировал страницы и данные и не отдал их без пароля:
        self.send_header("Cache-Control", "no-cache, private")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    #
    # Вход.
    #

    # Через туннель cloudflared подключается с 127.0.0.1, настоящий адрес - в заголовке Cloudflare:
    def via_tunnel(self) -> bool:
        return bool(self.headers.get("CF-Connecting-IP") or self.headers.get("CF-Ray"))

    # Адрес клиента (через туннель - из заголовка Cloudflare):
    def client_ip(self) -> str:
        ip = self.client_address[0]
        cf = self.headers.get("CF-Connecting-IP")
        return cf.strip() if cf and ip in ("127.0.0.1", "::1") else ip

    # Запрос пришёл по HTTPS (через Cloudflare):
    def is_https(self) -> bool:
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https" or '"https"' in self.headers.get("CF-Visitor", "")

    # Есть ли у запроса право доступа:
    def authorized(self) -> bool:
        a = self.auth
        if a: a.refresh()
        if not a or not a.enabled: return True
        if a.trust_lan and not self.via_tunnel():
            try:
                if ipaddress.ip_address(self.client_address[0]).is_private: return True
            except ValueError: pass
        c = SimpleCookie()
        try: c.load(self.headers.get("Cookie", ""))
        except Exception: return False
        return Auth.COOKIE in c and a.check_token(c[Auth.COOKIE].value)

    # Строка cookie сессии:
    def _cookie(self, token: str, max_age) -> str:
        parts = [f"{Auth.COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax"]
        if max_age is not None: parts.append(f"Max-Age={int(max_age)}")
        if self.is_https(): parts.append("Secure")
        return "; ".join(parts)

    # Нет входа: страницы -> на форму входа, остальное -> 401:
    def _deny(self, path: str) -> None:
        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/login")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self._json({"error": "auth"}, 401)

    # Прочитать JSON из тела запроса:
    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > 4096: raise ValueError("bad request size")  # Отрицательная длина - чтение до обрыва соединения.
        try: return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError): raise ValueError("bad json")

    # Запрос со страницы этого же сайта (защита от отправки формы с чужого сайта):
    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        return not origin or urlparse(origin).netloc == self.headers.get("Host", "")

    # Обработать POST-запрос:
    def do_POST(self) -> None:
        u = urlparse(self.path)
        try:
            if not self._same_origin(): self._json({"error": "forbidden"}, 403); return
            if u.path == "/api/login": self._login(self._read_json())
            elif u.path == "/api/logout": self._logout(self._read_json())
            elif u.path == "/api/client-log":
                if not self.authorized(): self._json({"error": "auth"}, 401); return
                self._client_log(self._read_json())
            else: self._json({"error": "not found"}, 404)
        except ValueError as e:
            self._json({"error": str(e)}, 400)

    # Диагностика с телефонов: ошибки страницы и её последнее состояние перед перезагрузкой (падением):
    def _client_log(self, body: dict) -> None:
        ua = self.headers.get("User-Agent", "")
        dev = ("iPhone" if "iPhone" in ua else "iPad" if "iPad" in ua else "Android" if "Android" in ua else "Windows" if "Windows" in ua else "?")
        browser = next((b for b, k in (("Chrome", "CriOS"), ("Firefox", "FxiOS"), ("Edge", "Edg"), ("Chrome", "Chrome"), ("Safari", "Safari")) if k in ua), "?")
        who = f"{self.client_ip()} {dev}/{browser}"
        now, kind, sid = time.time(), str(body.get("kind", "")), str(body.get("sid", ""))[:16]
        with Handler.diag_lock:
            prev = Handler.diag.get(who)
            if kind == "state":
                data = {k: body.get(k) for k in ("up", "dom", "canvases", "canvasMP", "heapMB", "onscreen", "scrollY", "docH", "vw", "dpr", "errors")}
                if prev and prev["sid"] != sid and now - prev["t"] < 90 and prev["data"].get("up", 0) > 20:
                    print(f"[C] {who}: страница открылась заново через {now - prev['t']:.0f} с после последнего сигнала "
                          f"(возможно, упала). Последнее состояние: {json.dumps(prev['data'], ensure_ascii=False)}")
                Handler.diag[who] = {"sid": sid, "t": now, "data": data}
            elif kind == "crash":
                prev = body.get("prev") if isinstance(body.get("prev"), dict) else {}
                ago = (now - float(prev.get("at", now * 1000)) / 1000) if prev.get("at") else 0
                print(f"[C] {who}: прошлый сеанс страницы оборвался (вылет), за {ago:.0f} с до этого было: "
                      f"{json.dumps(prev, ensure_ascii=False)[:600]}")
            elif kind == "error":
                cnt = Handler.diag_err.get(who, [])
                cnt = [t for t in cnt if now - t < 60]
                if len(cnt) < 20: print(f"[C] {who}: ошибка на странице: {str(body.get('msg', ''))[:300]}")
                Handler.diag_err[who] = cnt + [now]
        self._json({"ok": True})

    # Вход по паролю:
    def _login(self, body: dict) -> None:
        a, ip = self.auth, self.client_ip()
        a.refresh()
        if not a.enabled: self._json({"ok": True}); return
        if not a.hash: self._json({"error": "Пароль ещё не задан: запустите SysDeck.pyw на компьютере с SysDeck", "code": "no_password"}, 401); return
        wait = a.blocked(ip)
        if wait: self._json({"error": "Слишком много попыток", "code": "too_many", "retry": wait}, 429); return
        if not check_password(str(body.get("password", "")), a.hash):
            left = a.failed(ip)
            print(f"[W] Неверный пароль с {ip}")
            time.sleep(1.0)  # Замедляет перебор.
            wait = a.blocked(ip)
            if wait: self._json({"error": "Слишком много попыток", "code": "too_many", "retry": wait}, 429)
            else: self._json({"error": f"Неверный пароль (осталось попыток: {left})", "code": "bad_password", "left": left}, 401)
            return
        a.succeeded(ip)
        remember = bool(body.get("remember", True))
        ttl = a.days * 86400 if remember else 12 * 3600  # Без «запомнить» - до закрытия браузера, но не дольше 12 ч.
        self.send_response(200)
        self.send_header("Set-Cookie", self._cookie(a.make_token(ttl), ttl if remember else None))
        body = b'{"ok":true}'
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        print(f"[I] Вход с {ip}")

    # Выход (all - на всех устройствах):
    def _logout(self, body: dict) -> None:
        if body.get("all") and self.authorized() and self.auth.enabled:
            self.auth.rotate()
            print(f"[I] Выход на всех устройствах ({self.client_ip()})")
        self.send_response(200)
        self.send_header("Set-Cookie", self._cookie("", 0))
        data = b'{"ok":true}'
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # Обработать HEAD-запрос:
    def do_HEAD(self) -> None:
        path = urlparse(self.path).path
        if path not in self.PUBLIC and not self.authorized(): self._deny(path); return
        super().do_HEAD()

    # Отправить ответ:
    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Отправить ответ в JSON:
    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    # Диапазон и шаг группировки из запроса:
    def _range(self, q: dict) -> tuple:
        end = parse_time(q["end"][0]) if "end" in q else time.time()
        start = parse_time(q["start"][0]) if "start" in q else end - 3600
        if end <= start: raise ValueError("end must be greater than start")
        if "bucket" in q: bucket = float(q["bucket"][0])
        else: bucket = (end - start) / max(10, min(int(q.get("max_points", ["3000"])[0]), 30000))
        return start, end, bucket

    # Обработать GET-запрос:
    def do_GET(self) -> None:
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/api/auth":
                a = self.auth
                ok = self.authorized()  # Заодно подхватывает изменения sysdeck.json.
                self._json({"enabled": bool(a and a.enabled), "authorized": ok, "days": a.days if a else 0, "has_password": bool(a and a.hash)})
                return
            if u.path in ("/login", "/login.html"):
                self.path = "/login.html"
                super().do_GET()
                return
            if u.path not in self.PUBLIC and not self.authorized():
                self._deny(u.path)
                return
            if u.path.startswith("/api/ups/"): self._proxy_ups()
            elif u.path == "/api/pc/status": self._json(self.monitor.get())
            elif u.path == "/api/pc/data": self._json(self.storage.query(*self._range(q)))
            elif u.path == "/api/pc/sensors": self._json(self.storage.query_sensors(*self._range(q)))
            elif u.path.startswith("/api/"): self._json({"error": "not found"}, 404)
            else: super().do_GET()
        except (ValueError, KeyError) as e:
            self._json({"error": str(e)}, 400)

    # Переслать запрос серверу данных ИБП:
    def _proxy_ups(self) -> None:
        url = UPS_URL + "/api/" + self.path[len("/api/ups/"):]
        try:
            with _opener.open(url, timeout=10) as r: code, data = r.status, r.read()
        except urllib.error.HTTPError as e: code, data = e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            code, data = 502, json.dumps({"error": f"UPS server unavailable: {e}"}, ensure_ascii=False).encode("utf-8")
        self._send(code, data)


# HTTP-сервер без трассировок в журнале, когда браузер сам оборвал соединение (перезагрузка страницы):
class QuietServer(ThreadingHTTPServer):
    # На Windows SO_REUSEADDR позволяет второму процессу занять уже занятый порт и перехватывать запросы - запрещаем:
    allow_reuse_address = False

    # Ошибка обработки запроса (обрыв соединения клиентом - не ошибка):
    def handle_error(self, request, client_address) -> None:
        if isinstance(sys.exc_info()[1], (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)): return
        super().handle_error(request, client_address)


# Поднять сайт (не блокирует): возвращает сервер и хранилище. Используется и main(), и лаунчером SysDeck.pyw.
def build_server(host: str = None, port: int = None, ups: str = None, lhm: str = None):
    global UPS_URL, LHM_URL
    cfg = load_config()
    host = host or cfg["web_host"]
    port = int(port or cfg["web_port"])
    UPS_URL = (ups or cfg["ups_url"]).rstrip("/")
    LHM_URL = lhm or f"http://127.0.0.1:{int(cfg['lhm_port'])}/data.json"
    if not os.path.isfile(os.path.join(WEB_DIR, "index.html")):
        raise FileNotFoundError(f"Не найден {os.path.join(WEB_DIR, 'index.html')} - папка web должна лежать рядом со скриптом.")
    os.makedirs(DATA_DIR, exist_ok=True)
    storage = PcStorage(PC_DB_PATH)
    monitor = PcMonitor(storage)
    threading.Thread(target=monitor.run, name="pc", daemon=True).start()
    threading.Thread(target=monitor.sensor_loop, name="pc", daemon=True).start()
    Handler.monitor, Handler.storage, Handler.auth = monitor, storage, Auth(cfg)
    srv = QuietServer((host, port), Handler)
    print(f"[I] Сайт: http://127.0.0.1:{port}/  (ИБП -> {UPS_URL}, LHM -> {LHM_URL})")
    if Handler.auth.enabled and Handler.auth.hash: print(f"[I] Вход по паролю включён, сессия {Handler.auth.days:g} дн.")
    elif Handler.auth.enabled: print("[W] Вход по паролю включён, но пароль не задан - на сайт не войти. Задайте его в SysDeck.pyw")
    else: print("[I] Вход без пароля.")
    return srv, storage


# Задать пароль сайта из консоли (хеш пишется в sysdeck.json, вход по паролю включается):
def set_password() -> None:
    cfg = load_config()
    pw = getpass.getpass("Новый пароль для сайта: ")
    if not pw:
        print("Пустой пароль - ничего не изменено.")
        sys.exit(1)
    if pw != getpass.getpass("Повторите пароль: "):
        print("Пароли не совпали - ничего не изменено.")
        sys.exit(1)
    if len(pw) < 10: print("Совет: для доступа из интернета лучше пароль от 12 символов.")
    cfg["password"], cfg["password_hash"], cfg["auth_enabled"] = "", hash_password(pw), True
    save_config(cfg)
    print("Пароль сохранён, вход по паролю включён. Старые сессии больше не действуют.")


# Поменять параметры sysdeck.json: --config key=value (значение - JSON: true, 7, "text"; иначе строка):
def set_config(items: list) -> None:
    cfg = load_config()
    for item in items:
        key, sep, raw = item.partition("=")
        if not sep or key not in DEFAULT_CONFIG or key in ("password", "password_hash"):
            print(f"Неизвестный или недоступный параметр: {key}")
            sys.exit(1)
        try: value = json.loads(raw)
        except ValueError: value = raw
        cfg[key] = value
    if cfg.get("auth_enabled") and not cfg.get("password_hash"):
        print("Вход по паролю включён, но пароль не задан - задайте его, иначе на сайт не войти.")
    save_config(cfg)
    print("Сохранено.")


# Основная функция:
def main() -> None:
    global UPS_URL, LHM_URL
    if sys.stdout: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if sys.stderr: sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    cfg = load_config()
    ap = argparse.ArgumentParser(description="UPS dashboard + PC monitor")
    ap.add_argument("--host", default=cfg["web_host"], help="адрес сайта (0.0.0.0 = вся локальная сеть)")
    ap.add_argument("--port", type=int, default=int(cfg["web_port"]), help="порт сайта")
    ap.add_argument("--ups", default=cfg["ups_url"], help="адрес сервера данных ippon_ups.py")
    ap.add_argument("--lhm", default=f"http://127.0.0.1:{int(cfg['lhm_port'])}/data.json", help="адрес data.json LibreHardwareMonitor")
    ap.add_argument("--set-password", action="store_true", help="задать пароль сайта (включает вход по паролю) и выйти")
    ap.add_argument("--auth", choices=["on", "off"], help="включить / выключить вход по паролю и выйти")
    ap.add_argument("--config", nargs="+", metavar="KEY=VALUE", help="поменять параметры sysdeck.json и выйти")
    args = ap.parse_args()
    if args.set_password:
        set_password()
        return
    if args.auth:
        set_config(["auth_enabled=" + ("true" if args.auth == "on" else "false")])
        return
    if args.config:
        set_config(args.config)
        return
    try: srv, storage = build_server(args.host, args.port, args.ups, args.lhm)
    except FileNotFoundError as e:
        print(f"[E] {e}")
        return
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        storage.flush()
        print("[I] Остановлен, история сохранена.")


# Если скрипт запускают:
if __name__ == "__main__":
    main()
