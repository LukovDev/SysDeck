#
# SysDeck.pyw - Лаунчер SysDeck: окно управления и значок в трее (без окна консоли).
#
# Держит запущенными всего два процесса:
#   - Сервис SysDeck (этот же файл с ключом --worker): ippon_ups.py (ИБП) и web_server.py (сайт)
#     Работают в нём вместе, отдельными потоками;
#   - LibreHardwareMonitor из папки проекта - скрыто: ни окна, ни значка в трее.
# Упавший сервис или LHM перезапускается сам.
#
# Все сообщения пишутся в один журнал data/sysdeck.log. Настройки - data/sysdeck.json,
# Telegram - data/tgbot.json, история - data/sysdeck.db. Удалённые файлы создаются заново по умолчанию.
#
# Запуск: двойной щелчок по SysDeck.pyw (нужен только Python 3, библиотеки ставятся сами).
#   --tray  - сразу в трей, без окна (так стартует автозапуск).
#

# Импортируем:
import os
import re
import sys
import json
import time
import queue
import ctypes
import socket
import sqlite3
import threading
import subprocess
import webbrowser
import traceback
import urllib.request
from collections import deque
from datetime import datetime


# Глобальные переменные:
HERE = os.path.dirname(os.path.abspath(__file__))
SELF = os.path.abspath(__file__)
DATA = os.path.join(HERE, "data")
LOG_PATH = os.path.join(DATA, "sysdeck.log")
PORT_FILE = os.path.join(DATA, "launcher.port")
DB_PATH = os.path.join(DATA, "sysdeck.db")
TG_PATH = os.path.join(DATA, "tgbot.json")
LHM_DIR = os.path.join(HERE, "LibreHardwareMonitor")
LHM_EXE = os.path.join(LHM_DIR, "LibreHardwareMonitor.exe")
TASK = "SysDeck"
NO_WINDOW = 0x08000000                  # CREATE_NO_WINDOW: дочерние программы без окна консоли.
LOG_MAX = 2 * 1024 * 1024               # Журнал больше 2 МБ откладывается в sysdeck.old.log.
REQUIRED = {"hid": "hidapi", "psutil": "psutil", "requests": "requests", "pystray": "pystray", "PIL": "pillow"}
TAGS = {"ups": "ИБП", "pc": "ПК", "MainThread": "СЕРВИС"}  # Поток -> метка в журнале (остальные - «САЙТ»).

sys.path.insert(0, HERE)
sys.dont_write_bytecode = True  # Без папки __pycache__ рядом со скриптами.
os.makedirs(DATA, exist_ok=True)


# Строка журнала: время, метка, текст:
def stamp(tag: str, text: str) -> str:
    return f"{datetime.now():%Y-%m-%d %H:%M:%S}  {tag:<8} {text}"


# Путь к pythonw.exe (Python без окна консоли):
def pythonw() -> str:
    exe = sys.executable
    w = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return w if os.path.exists(w) else exe


# Запущены ли мы с правами администратора:
def is_admin() -> bool:
    try: return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception: return False


# Запустить программу без окна и дождаться её:
def run_hidden(args: list, timeout: float = 60) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)


# Выполнить команду PowerShell без окна и вернуть её вывод:
def powershell(script: str, timeout: float = 60) -> str:
    r = run_hidden(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + script], timeout)
    return r.stdout.decode("utf-8", "replace").strip()


#
# Сервисный процесс (--worker): ИБП и сайт в одном процессе.
#


# Вывод сервиса: каждая строка - с временем и меткой потока (ИБП / ПК / САЙТ):
class Stamper:
    # Инициализация:
    def __init__(self, stream) -> None:
        self.stream, self.lock, self.parts = stream, threading.Lock(), {}

    # Записать текст (по строкам):
    def write(self, s: str) -> int:
        th = threading.current_thread()
        with self.lock:
            buf = self.parts.get(th.ident, "") + s
            *lines, rest = buf.split("\n")
            # Хвост без перевода строки ждёт продолжения. Пустые не храним: у сайта на каждый запрос свой поток.
            if rest: self.parts[th.ident] = rest
            else: self.parts.pop(th.ident, None)
            for line in lines:
                if line.strip():
                    try:
                        self.stream.write(stamp(TAGS.get(th.name, "САЙТ"), line.rstrip("\r")) + "\n")
                        self.stream.flush()
                    except (OSError, ValueError): pass
        return len(s)

    # Сброс буфера (не нужен - пишем сразу):
    def flush(self) -> None: pass

    # Это не консоль:
    def isatty(self) -> bool: return False

    # ippon_ups.py настраивает вывод под эмодзи - здесь это уже учтено:
    def reconfigure(self, **kw) -> None: pass


# Сервисный процесс: ИБП и сайт в одном процессе:
def run_worker() -> None:
    raw = sys.stdout
    try: raw.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass
    sys.stdout = sys.stderr = Stamper(raw)
    import web_server
    import ippon_ups
    cfg = web_server.load_config()

    if cfg.get("ups", True):
        ippon_ups.load_settings()
        ippon_ups.load_tg()
        ippon_ups.start_server()

        # Основной цикл ippon_ups.py. Если он упадёт с ошибкой - пишем её в журнал и запускаем снова:
        def ups_loop() -> None:
            while True:
                try: ippon_ups.main()
                except Exception:
                    print("[E] ippon_ups.main упал:\n" + traceback.format_exc())
                    time.sleep(5)
        threading.Thread(target=ups_loop, name="ups", daemon=True).start()
    else:
        print("[I] ИБП выключен в настройках - ippon_ups.py не запускается.")

    try: srv, storage = web_server.build_server()
    except Exception as e:
        print(f"[E] Сайт не запустился: {e}")
        srv, storage = None, None
    if srv: threading.Thread(target=srv.serve_forever, name="web", daemon=True).start()
    print("[I] Сервис запущен.")

    # Команда «stop» от лаунчера (или лаунчер закрылся - stdin оборвался): дописываем историю и выходим.
    by_launcher = False
    try:
        for line in sys.stdin:
            if line.strip() == "stop":
                by_launcher = True
                break
    except Exception: pass
    if not by_launcher:
        # Лаунчер закрылся (некому читать вывод) - последние строки пишем в журнал сами:
        class FileOut:
            # Дописать текст в журнал:
            def write(self, t: str) -> None:
                with open(LOG_PATH, "a", encoding="utf-8") as f: f.write(t)

            # Сброс буфера (не нужен):
            def flush(self) -> None: pass
        sys.stdout = sys.stderr = Stamper(FileOut())
        print("[I] Лаунчер закрылся - останавливаю сервис.")
    print("[I] Остановка: сохраняю историю...")
    for st in (storage, getattr(ippon_ups, "storage", None) if cfg.get("ups", True) else None):
        try:
            if st: st.flush()
        except Exception as e: print(f"[W] Не удалось сохранить: {e}")
    print("[I] Сервис остановлен.")
    os._exit(0)


#
# Лаунчер: журнал, файлы данных, LHM, сервис.
#


# Единый журнал data/sysdeck.log:
class Log:
    # Загрузить хвост журнала для окна:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.tail = deque(maxlen=500)
        self.seq = 0
        try:
            with open(LOG_PATH, encoding="utf-8", errors="replace") as f:
                self.tail.extend(line.rstrip("\n") for line in deque(f, maxlen=200))
        except OSError: pass

    # Записать готовую строку:
    def line(self, text: str) -> None:
        with self.lock:
            self.tail.append(text)
            self.seq += 1
            try:
                if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX:
                    os.replace(LOG_PATH, os.path.join(DATA, "sysdeck.old.log"))
                with open(LOG_PATH, "a", encoding="utf-8") as f: f.write(text + "\n")
            except OSError: pass

    # Записать сообщение с временем и меткой:
    def info(self, text: str, tag: str = "ЛАУНЧЕР") -> None:
        self.line(stamp(tag, text))

    # Очистить журнал:
    def clear(self) -> None:
        with self.lock:
            self.tail.clear()
            self.seq += 1
            for p in (LOG_PATH, os.path.join(DATA, "sysdeck.old.log")):
                try: os.remove(p)
                except OSError: pass


LOG = Log()


# Прочитать настройки Telegram:
def load_tg() -> dict:
    try:
        with open(TG_PATH, encoding="utf-8-sig") as f: d = json.load(f)
        if isinstance(d, dict): return {"token": str(d.get("token") or ""), "chat": str(d.get("chat") or "")}
    except (OSError, ValueError): pass
    return {"token": "", "chat": ""}


# Сохранить настройки Telegram:
def save_tg(token: str, chat: str) -> None:
    with open(TG_PATH, "w", encoding="utf-8") as f:
        json.dump({"token": token.strip(), "chat": chat.strip()}, f, ensure_ascii=False, indent=4)


# Файлы данных: нет или испорчены - создаём заново по умолчанию.
def ensure_files() -> None:
    import web_server
    os.makedirs(DATA, exist_ok=True)
    web_server.load_config()
    import ippon_ups
    ippon_ups.load_settings()  # Нет ups.json - создаст с настройками по умолчанию.
    if not os.path.exists(TG_PATH):
        save_tg("", "")
        LOG.info("data/tgbot.json не найден - создан пустой (Telegram выключен, сообщения только в журнал).")
    else:
        try:
            with open(TG_PATH, encoding="utf-8-sig") as f:
                if not isinstance(json.load(f), dict): raise ValueError
        except (OSError, ValueError):
            try: os.replace(TG_PATH, TG_PATH + ".broken")
            except OSError: pass
            save_tg("", "")
            LOG.info("data/tgbot.json испорчен - создан заново (старый: tgbot.json.broken).")


# Переезд со старой раскладки: настройки из корня в data/, две базы в одну, старые логи - в общий журнал.
def migrate() -> None:
    for name in ("sysdeck.json", "tgbot.json"):
        old, new = os.path.join(HERE, name), os.path.join(DATA, name)
        if os.path.exists(old):
            if not os.path.exists(new):
                os.replace(old, new)
                LOG.info(f"{name} перенесён в data/.")
            else:
                os.replace(old, new + ".old")  # В data уже есть свой - старый не выбрасываем, а откладываем.
                LOG.info(f"{name}: в data/ уже есть свой, старый отложен как data/{name}.old.")
    olds = [os.path.join(DATA, n) for n in ("ups_data.sqlite3", "pc_data.sqlite3") if os.path.exists(os.path.join(DATA, n))]
    if olds:
        try:
            merge_dbs(olds)
        except Exception as e:
            LOG.info(f"Не удалось объединить старые базы: {e}")
    logs = os.path.join(DATA, "logs")
    if os.path.isdir(logs):
        for f in os.listdir(logs):
            try: os.remove(os.path.join(logs, f))
            except OSError: pass
        try: os.rmdir(logs)
        except OSError: pass
    run = os.path.join(DATA, "run")
    if os.path.isdir(run):
        for f in os.listdir(run):
            try: os.remove(os.path.join(run, f))
            except OSError: pass
        try: os.rmdir(run)
        except OSError: pass


# Перенести таблицы старых баз в sysdeck.db:
def merge_dbs(olds: list) -> None:
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    have = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for old in olds:
        con.execute("ATTACH DATABASE ? AS o", (old,))
        tables = con.execute("SELECT name, sql FROM o.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
        for name, sql in tables:
            if name not in have:
                con.execute(sql)
                have.add(name)
            con.execute(f'INSERT OR IGNORE INTO main."{name}" SELECT * FROM o."{name}"')
        for (sql,) in con.execute("SELECT sql FROM o.sqlite_master WHERE type='index' AND sql IS NOT NULL").fetchall():
            con.execute(sql.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ", 1))
        con.commit()
        # Проверяем, что всё перенеслось, и только тогда удаляем старую базу:
        ok = all(con.execute(f'SELECT COUNT(*) FROM main."{n}"').fetchone()[0] >= con.execute(f'SELECT COUNT(*) FROM o."{n}"').fetchone()[0]
                 for n, _ in tables)
        con.execute("DETACH DATABASE o")
        if ok:
            for suf in ("", "-wal", "-shm"):
                try: os.remove(old + suf)
                except OSError: pass
            LOG.info(f"{os.path.basename(old)} перенесена в sysdeck.db.")
        else:
            LOG.info(f"{os.path.basename(old)}: число строк не сошлось, старая база оставлена.")
    con.close()


#
# LibreHardwareMonitor: без окна и без значка.
#


# Запущенные процессы LibreHardwareMonitor:
def lhm_procs():
    import psutil
    out = []
    for p in psutil.process_iter(["name", "exe"]):
        if (p.info["name"] or "").lower() == "librehardwaremonitor.exe": out.append(p)
    return out


# Записать настройки LHM для работы в фоне:
def set_lhm_config(port: int) -> None:
    import xml.etree.ElementTree as ET
    path = os.path.join(LHM_DIR, "LibreHardwareMonitor.config")
    try: tree = ET.parse(path); root = tree.getroot()
    except (OSError, ET.ParseError):
        root = ET.Element("configuration"); tree = ET.ElementTree(root)
    app = root.find("appSettings")
    if app is None: app = ET.SubElement(root, "appSettings")
    # Свёрнут и без значка в трее (окно лаунчер прячет сам), веб-сервер только для этого ПК:
    want = {"startMinMenuItem": "true", "minTrayMenuItem": "false", "minCloseMenuItem": "false", "runWebServerMenuItem": "true",
            "listenerIp": "127.0.0.1", "listenerPort": str(port), "authenticationEnabled": "false"}
    for k, v in want.items():
        node = next((n for n in app.findall("add") if n.get("key") == k), None)
        if node is None: node = ET.SubElement(app, "add", key=k)
        node.set("value", v)
    tree.write(path, encoding="utf-8", xml_declaration=True)


# Спрятать все окна процесса (свёрнутое окно LHM иначе висит в панели задач):
_user32 = ctypes.windll.user32
_EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)


# Спрятать все видимые окна процесса, вернуть сколько спрятано:
def hide_windows(pid: int) -> int:
    hidden = []

    # Проверить одно окно:
    def cb(hwnd, _):
        wpid = ctypes.c_ulong()
        _user32.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(wpid))
        if wpid.value == pid and _user32.IsWindowVisible(ctypes.c_void_p(hwnd)):
            _user32.ShowWindow(ctypes.c_void_p(hwnd), 0)  # SW_HIDE.
            hidden.append(hwnd)
        return True
    _user32.EnumWindows(_EnumProc(cb), None)
    return len(hidden)


#
# Автозапуск (Планировщик, с правами администратора - без запроса UAC).
#


# Задача автозапуска в Планировщике (None - её нет):
def task_info():
    out = powershell(f"$t = Get-ScheduledTask -TaskName '{TASK}' -ErrorAction SilentlyContinue; "
                     "if ($t) { $t.Actions[0].Execute + '|' + $t.Actions[0].Arguments + '|' + $t.State }", 30)
    if not out or "|" not in out: return None
    exe, args, state = (out.split("|") + ["", ""])[:3]
    norm = lambda x: os.path.normcase(os.path.realpath(x))
    m = re.match(r'\s*"([^"]+)"', args) or re.match(r"\s*(\S+)", args)
    target = norm(m.group(1)) if m else ""
    return {"exe": exe, "args": args, "state": state, "ours": target == norm(SELF),
            "old": bool(re.search(r"sysdeck\.ps1|sysdeck_bg\.pyw", args, re.I)) and norm(HERE) in norm(args.strip('" '))}


# Включить автозапуск:
def autostart_on() -> None:
    # Задача уже наша - просто включаем. Пересоздание задачи Windows делает, завершая её запущенный экземпляр,
    # а это может быть сам лаунчер (при автозапуске).
    info = task_info()
    if info and info["ours"]:
        powershell(f"Enable-ScheduledTask -TaskName '{TASK}' | Out-Null")
        return
    q = lambda s: s.replace("'", "''")
    powershell(
        f"$a = New-ScheduledTaskAction -Execute '{q(pythonw())}' -Argument '\"{q(SELF)}\" --tray' -WorkingDirectory '{q(HERE)}'; "
        "$u = \"$env:USERDOMAIN\\$env:USERNAME\"; "
        "$t = New-ScheduledTaskTrigger -AtLogOn -User $u; $t.Delay = 'PT10S'; "
        "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable "
        "-ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; "
        "$p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Highest; "
        f"Register-ScheduledTask -TaskName '{TASK}' -Action $a -Trigger $t -Settings $s -Principal $p "
        f"-Description 'SysDeck: {q(HERE)}' -Force | Out-Null")


# Выключить автозапуск:
def autostart_off() -> None:
    # Отключаем, а не удаляем: удаление задачи завершило бы лаунчер, если он запущен из неё.
    powershell(f"Disable-ScheduledTask -TaskName '{TASK}' -ErrorAction SilentlyContinue | Out-Null")


#
# Адреса сайта с названиями сетевых адаптеров.
#

VIRT = re.compile(r"vpn|tailscale|radmin|zerotier|hamachi|wireguard|vethernet|virtual|\btun|\btap|wsl|hyper-v|vmware|virtualbox|loopback", re.I)


# Адреса сайта по сетевым адаптерам:
def site_addresses(port: int) -> list:
    import psutil
    out, extra = [("Этот ПК", f"http://127.0.0.1:{port}/")], []
    stats = psutil.net_if_stats()
    for name, addrs in psutil.net_if_addrs().items():
        if name in stats and not stats[name].isup: continue
        for a in addrs:
            if a.family == socket.AF_INET and not a.address.startswith(("127.", "169.254.")):
                virt = bool(VIRT.search(name))
                (extra if virt else out).append((f"{name} ({'VPN / виртуальный' if virt else 'сеть'})", f"http://{a.address}:{port}/"))
    return out + extra


#
# Сервис + LHM.
#


# Сервис и LHM: запуск, остановка, перезапуск упавшего:
class Services:
    # Инициализация:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.want = False              # Пользователь хочет, чтобы всё работало.
        self.worker = None             # subprocess.Popen сервиса.
        self.worker_t0 = 0.0
        self.next_try = 0.0
        self.lhm = None                # psutil.Process нашего LHM.
        self.lhm_note = "—"
        self.busy = ""                 # «запуск…» / «остановка…» для окна.
        threading.Thread(target=self._watch, name="watch", daemon=True).start()

    # Сервис:
    def _start_worker(self) -> None:
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1")
        self.worker = subprocess.Popen([pythonw(), SELF, "--worker"], cwd=HERE, env=env, creationflags=NO_WINDOW,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.worker_t0 = time.time()
        LOG.info(f"Сервис запущен (PID {self.worker.pid}).")
        p = self.worker

        # Переносить вывод сервиса в журнал:
        def reader() -> None:
            for raw in iter(p.stdout.readline, b""):
                LOG.line(raw.decode("utf-8", "replace").rstrip("\r\n"))
        threading.Thread(target=reader, name="reader", daemon=True).start()

    # Остановить сервис (он сам дописывает историю):
    def _stop_worker(self) -> None:
        p, self.worker = self.worker, None
        if not p or p.poll() is not None: return
        try:
            p.stdin.write(b"stop\n"); p.stdin.flush()
        except OSError: pass
        try: p.wait(15)
        except subprocess.TimeoutExpired:
            p.kill()
            LOG.info("Сервис не остановился за 15 с - завершён принудительно.")

    # LHM:
    def _start_lhm(self, cfg: dict) -> None:
        self.lhm = None
        if not cfg.get("lhm", True): self.lhm_note = "выключен в настройках"; return
        procs = lhm_procs()
        own = [p for p in procs if (p.info["exe"] or "").lower() == LHM_EXE.lower()]
        foreign = [p for p in procs if p not in own]
        if foreign:
            self.lhm_note = f"используется внешний: {foreign[0].info['exe'] or 'LibreHardwareMonitor'}"
            LOG.info(f"LibreHardwareMonitor уже запущен не из папки проекта - используем его ({foreign[0].info['exe']}).")
            return
        if own:
            self.lhm = own[0]; self.lhm_note = "работает (встроенный, скрыт)"; return
        if not os.path.exists(LHM_EXE): self.lhm_note = "нет в папке LibreHardwareMonitor"; return
        if not is_admin():
            self.lhm_note = "нужны права администратора"
            LOG.info("LibreHardwareMonitor не запущен: лаунчер работает без прав администратора.")
            return
        import psutil
        try: set_lhm_config(int(cfg.get("lhm_port", 8085)))
        except Exception as e: LOG.info(f"Не удалось записать настройки LHM: {e}")
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 7  # SW_SHOWMINNOACTIVE - не отбирает фокус, дальше окно прячется.
        p = subprocess.Popen([LHM_EXE], cwd=LHM_DIR, startupinfo=si)
        self.lhm = psutil.Process(p.pid)
        self.lhm_note = "работает (встроенный, скрыт)"
        LOG.info(f"LibreHardwareMonitor запущен (PID {p.pid}), окно скрыто.")

    # Остановить наш LHM:
    def _stop_lhm(self) -> None:
        p, self.lhm = self.lhm, None
        if p:
            try:
                p.kill()
                p.wait(5)
                LOG.info("LibreHardwareMonitor остановлен.")
            except Exception: pass
        self.lhm_note = "остановлен"

    # Управление:
    def start(self) -> None:
        with self.lock:
            if self.want: return
            self.busy = "запуск…"
            try:
                import web_server
                migrate()
                ensure_files()
                cfg = web_server.load_config()
                self.want = True
                self._start_lhm(cfg)
                self._start_worker()
            except Exception:
                LOG.info("Ошибка запуска:\n" + traceback.format_exc())
            finally:
                self.busy = ""

    # Остановить всё:
    def stop(self) -> None:
        with self.lock:
            self.busy = "остановка…"
            self.want = False
            self._stop_worker()
            self._stop_lhm()
            self.busy = ""
            LOG.info("Всё остановлено.")

    # Перезапустить всё:
    def restart(self) -> None:
        self.stop()
        self.start()

    # Сервис работает:
    def running(self) -> bool:
        return self.want and self.worker is not None and self.worker.poll() is None

    # Сторож: перезапуск упавшего, LHM всегда скрыт.
    def _watch(self) -> None:
        while True:
            time.sleep(2)
            try:
                with self.lock:
                    if not self.want: continue
                    p = self.worker
                    if p is not None and p.poll() is not None:
                        quick = time.time() - self.worker_t0 < 20
                        LOG.info(f"Сервис завершился (код {p.returncode}), перезапуск {'через 30 с' if quick else 'сейчас'}.")
                        self.worker = None
                        self.next_try = time.time() + (30 if quick else 0)
                    if self.worker is None and time.time() >= self.next_try:
                        self._start_worker()
                    if self.lhm is not None:
                        if not self.lhm.is_running():
                            LOG.info("LibreHardwareMonitor закрылся - запускаю снова.")
                            import web_server
                            self._start_lhm(web_server.load_config())
                        else:
                            hide_windows(self.lhm.pid)
            except Exception:
                LOG.info("Ошибка сторожа:\n" + traceback.format_exc())


#
# Один экземпляр: второй запуск просто показывает окно первого.
#


# Отправить команду уже запущенному лаунчеру (False - его нет):
def ping_instance(cmd: str = "show") -> bool:
    try:
        with open(PORT_FILE) as f: port = int(f.read().strip())
        with socket.create_connection(("127.0.0.1", port), timeout=1.5) as s:
            s.sendall((cmd + "\n").encode())
            return s.recv(16).startswith(b"ok")
    except (OSError, ValueError):
        return False


# Принимать команды от второго запуска (показать окно):
def serve_control(q: queue.Queue) -> None:
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(4)
    with open(PORT_FILE, "w") as f: f.write(str(srv.getsockname()[1]))

    # Цикл приёма команд:
    def loop() -> None:
        while True:
            try:
                c, _ = srv.accept()
                with c:
                    cmd = c.recv(64).decode(errors="ignore").strip()
                    c.sendall(b"ok\n")
                    if cmd == "show": q.put(("show",))
            except OSError: time.sleep(0.5)
    threading.Thread(target=loop, name="control", daemon=True).start()


#
# Установка библиотек при первом запуске.
#


# Каких библиотек Python не хватает:
def missing_libs() -> list:
    import importlib.util
    return [pkg for mod, pkg in REQUIRED.items() if importlib.util.find_spec(mod) is None]


# Поставить библиотеки через pip (с окном ожидания):
def install_libs(missing: list) -> bool:
    import tkinter as tk
    root = tk.Tk()
    root.title("SysDeck")
    root.configure(bg="#111418")
    root.geometry("420x120")
    tk.Label(root, text="Первый запуск: ставлю библиотеки Python\n" + ", ".join(missing),
             bg="#111418", fg="#e6e8eb", font=("Segoe UI", 11), justify="center").pack(expand=True)
    result = {}

    # Установка в фоне:
    def work() -> None:
        py = os.path.join(os.path.dirname(sys.executable), "python.exe")
        r = run_hidden([py if os.path.exists(py) else sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *missing], 600)
        result["ok"] = r.returncode == 0
        result["out"] = (r.stdout + r.stderr).decode("utf-8", "replace")[-1500:]
        root.after(0, root.destroy)
    threading.Thread(target=work, daemon=True).start()
    root.mainloop()
    if not result.get("ok"):
        LOG.info("pip не смог поставить библиотеки:\n" + result.get("out", ""))
        import tkinter.messagebox as mb
        mb.showerror("SysDeck", "Не удалось поставить библиотеки Python.\nПроверьте интернет. Подробности в data/sysdeck.log")
    return bool(result.get("ok"))


#
# Окно и трей.
#

C = {"bg": "#0e1116", "card": "#161b22", "card2": "#1d242d", "line": "#2a323d", "text": "#e6e8eb", "dim": "#8b949e",
     "accent": "#4c8dff", "good": "#34d399", "warn": "#f5b301", "bad": "#f87171"}


# Значок для трея:
def tray_image(color: str):
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((2, 2, 62, 62), radius=16, fill=color)
    d.polygon([(36, 8), (16, 36), (30, 36), (26, 56), (48, 26), (34, 26)], fill="white")
    return im


# Окно управления и значок в трее:
class App:
    # Создать окно и трей:
    def __init__(self, services: Services, show: bool) -> None:
        import tkinter as tk
        from tkinter import ttk
        import web_server
        self.tk, self.ttk, self.ws = tk, ttk, web_server
        self.sv = services
        self.q = queue.Queue()
        self.ups = None                 # Последний /api/status ИБП.
        self.tray = None
        self.hinted = False
        self.log_seq = -1

        self.root = root = tk.Tk()
        root.title("SysDeck")
        root.geometry("800x690")
        root.minsize(700, 640)
        root.configure(bg=C["bg"])
        root.protocol("WM_DELETE_WINDOW", self.hide)
        try:
            from PIL import ImageTk
            self._icon = ImageTk.PhotoImage(tray_image(C["accent"]))
            root.iconphoto(True, self._icon)
        except Exception: pass
        self._style()
        self._build()
        self._tray()
        threading.Thread(target=self._poll_ups, name="ups-poll", daemon=True).start()
        if show: root.after(50, self.show)
        else: root.withdraw()
        root.after(300, self._tick)
        root.after(100, self._pump)

    #
    # Оформление.
    #
    def _style(self) -> None:
        ttk = self.ttk
        s = ttk.Style(self.root)
        s.theme_use("clam")
        f = ("Segoe UI", 10)
        s.configure(".", background=C["bg"], foreground=C["text"], fieldbackground=C["card2"], bordercolor=C["line"],
                    lightcolor=C["line"], darkcolor=C["line"], troughcolor=C["card2"], font=f, focuscolor=C["accent"])
        s.configure("TFrame", background=C["bg"])
        s.configure("Card.TFrame", background=C["card"])
        s.configure("TLabel", background=C["bg"], foreground=C["text"])
        s.configure("Card.TLabel", background=C["card"])
        s.configure("Dim.TLabel", background=C["card"], foreground=C["dim"])
        s.configure("Title.TLabel", background=C["bg"], font=("Segoe UI Semibold", 16))
        s.configure("H.TLabel", background=C["card"], font=("Segoe UI Semibold", 11))
        s.configure("TNotebook", background=C["bg"], borderwidth=0, tabmargins=(0, 6, 0, 0))
        s.configure("TNotebook.Tab", background=C["bg"], foreground=C["dim"], padding=(14, 7), borderwidth=0,
                    bordercolor=C["bg"], lightcolor=C["bg"], focuscolor=C["bg"])
        s.map("TNotebook.Tab", background=[("selected", C["card"])], foreground=[("selected", C["text"])],
              bordercolor=[("selected", C["line"])], lightcolor=[("selected", C["card"])])
        # Кнопки без пунктирной рамки фокуса:
        s.layout("TButton", [("Button.border", {"sticky": "nswe", "border": "1", "children": [
            ("Button.padding", {"sticky": "nswe", "children": [("Button.label", {"sticky": "nswe"})]})]})])
        # Вкладки без пунктирной рамки фокуса:
        s.layout("TNotebook.Tab", [("Notebook.tab", {"sticky": "nswe", "children": [
            ("Notebook.padding", {"side": "top", "sticky": "nswe", "children": [("Notebook.label", {"side": "top", "sticky": ""})]})]})])
        s.configure("TButton", background=C["card2"], foreground=C["text"], padding=(12, 6), borderwidth=1)
        s.map("TButton", background=[("active", C["line"]), ("disabled", C["card"])], foreground=[("disabled", C["dim"])])
        s.configure("Accent.TButton", background=C["accent"], foreground="white")
        s.map("Accent.TButton", background=[("active", "#3b7af0")])
        s.configure("Danger.TButton", foreground=C["bad"])
        # Флажки - квадрат с галочкой (стандартный индикатор темы clam рисует крестик) и без пунктирной рамки фокуса:
        from PIL import Image, ImageDraw, ImageTk

        # Картинка флажка:
        def box(on: bool):
            im = Image.new("RGBA", (22, 18), (0, 0, 0, 0))
            d = ImageDraw.Draw(im)
            d.rounded_rectangle((1, 1, 16, 16), radius=4, fill=C["accent"] if on else C["card2"], outline=C["accent"] if on else "#4a5361")
            if on: d.line([(4.5, 9), (7.5, 12), (13, 5.5)], fill="white", width=2, joint="curve")
            return ImageTk.PhotoImage(im)
        self._ck = (box(False), box(True))
        s.element_create("Sd.check", "image", self._ck[0], ("selected", self._ck[1]))
        s.layout("TCheckbutton", [("Checkbutton.padding", {"sticky": "nswe", "children": [
            ("Sd.check", {"side": "left", "sticky": ""}), ("Checkbutton.label", {"side": "left", "sticky": "w"})]})])
        s.configure("TCheckbutton", background=C["card"], foreground=C["text"], padding=(0, 3))
        s.map("TCheckbutton", background=[("active", C["card"])])
        s.layout("Bar.TCheckbutton", s.layout("TCheckbutton"))
        s.configure("Bar.TCheckbutton", background=C["bg"], foreground=C["text"], padding=(0, 3))
        s.map("Bar.TCheckbutton", background=[("active", C["bg"])])
        s.configure("TEntry", fieldbackground=C["card2"], foreground=C["text"], insertcolor=C["text"], padding=5)
        s.configure("TSpinbox", fieldbackground=C["card2"], foreground=C["text"], arrowcolor=C["text"], padding=4)

    # Карточка с заголовком:
    def _card(self, parent, title: str = ""):
        fr = self.ttk.Frame(parent, style="Card.TFrame", padding=14)
        fr.pack(fill="x", padx=12, pady=(10, 0))
        if title: self.ttk.Label(fr, text=title, style="H.TLabel").pack(anchor="w", pady=(0, 8))
        return fr

    # Строка внутри карточки:
    def _row(self, parent):
        r = self.ttk.Frame(parent, style="Card.TFrame")
        r.pack(fill="x", pady=3)
        return r

    #
    # Окно.
    #
    def _build(self) -> None:
        tk, ttk = self.tk, self.ttk
        head = ttk.Frame(self.root, padding=(16, 12, 16, 0))
        head.pack(fill="x")
        ttk.Label(head, text="SysDeck", style="Title.TLabel").pack(side="left")
        self.state_lbl = tk.Label(head, text="", bg=C["bg"], fg=C["dim"], font=("Segoe UI", 10))
        self.state_lbl.pack(side="left", padx=12)
        self.btn_toggle = ttk.Button(head, text="Запустить", style="Accent.TButton", command=self.toggle)
        self.btn_toggle.pack(side="right")
        ttk.Button(head, text="Перезапустить", command=lambda: self.bg(self.sv.restart)).pack(side="right", padx=6)
        ttk.Button(head, text="Открыть сайт", command=self.open_site).pack(side="right")

        nb = ttk.Notebook(self.root, takefocus=False)
        nb.pack(fill="both", expand=True, padx=8, pady=8)
        self.nb = nb
        self._tab_main(self._tab(nb, "Обзор"))
        self._tab_access(self._tab(nb, "Доступ"))
        self._tab_parts(self._tab(nb, "Компоненты"))
        self._tab_ups(self._tab(nb, "ИБП"))
        self._tab_data(self._tab(nb, "Данные"))
        self._tab_log(self._tab(nb, "Журнал"))

    # Вкладка:
    def _tab(self, nb, title: str):
        fr = self.ttk.Frame(nb)
        nb.add(fr, text=title)
        return fr

    # Вкладка "Обзор":
    def _tab_main(self, t) -> None:
        tk, ttk = self.tk, self.ttk
        c = self._card(t, "Состояние")
        self.st = {}
        for key, name in (("svc", "Сервис (ИБП + сайт)"), ("ups", "ИБП"), ("lhm", "LibreHardwareMonitor"), ("web", "Сайт"), ("auth", "Вход на сайт")):
            r = self._row(c)
            ttk.Label(r, text=name, style="Dim.TLabel", width=24).pack(side="left")
            lbl = tk.Label(r, text="—", bg=C["card"], fg=C["text"], font=("Segoe UI", 10), anchor="w")
            lbl.pack(side="left", fill="x", expand=True)
            self.st[key] = lbl
        c = self._card(t, "Автозапуск")
        self.v_auto = tk.BooleanVar(value=False)
        self.auto_on = False  # То же значение для меню трея (оно работает в другом потоке).
        ttk.Checkbutton(c, text="Запускать SysDeck вместе с Windows (сразу в трей, без запроса UAC)", variable=self.v_auto,
                        command=self.toggle_autostart).pack(anchor="w")
        self.bg(self._load_autostart)
        c = self._card(t, "Адреса сайта (двойной щелчок - открыть)")
        self.addr = tk.Listbox(c, height=5, bg=C["card2"], fg=C["text"], selectbackground=C["accent"], highlightthickness=0,
                               borderwidth=0, font=("Consolas", 10), activestyle="none")
        self.addr.pack(fill="x")
        self.addr.bind("<Double-Button-1>", lambda e: self._open_addr())
        self._addr_sig = None
        c = self._card(t, "Последние события")
        self.mini = tk.Text(c, height=7, bg=C["card2"], fg=C["dim"], borderwidth=0, highlightthickness=0, font=("Consolas", 9), wrap="none")
        self.mini.pack(fill="both", expand=True)
        self.mini.configure(state="disabled")

    # Вкладка "Доступ":
    def _tab_access(self, t) -> None:
        tk, ttk = self.tk, self.ttk
        cfg = self.ws.load_config()
        c = self._card(t, "Вход на сайт")
        self.v_auth = tk.BooleanVar(value=bool(cfg.get("auth_enabled")))
        ttk.Checkbutton(c, text="Вход по паролю (нужен, если сайт открыт через интернет / туннель)", variable=self.v_auth,
                        command=self.save_access).pack(anchor="w")
        self.v_lan = tk.BooleanVar(value=bool(cfg.get("trust_lan")))
        ttk.Checkbutton(c, text="Из домашней сети без пароля (через туннель пароль спрашивается всегда)", variable=self.v_lan,
                        command=self.save_access).pack(anchor="w", pady=(4, 0))
        r = self._row(c)
        ttk.Label(r, text="Помнить вход, дней:", style="Card.TLabel").pack(side="left")
        self.v_days = tk.StringVar(value=f"{float(cfg.get('session_days') or 3):g}")
        sp = ttk.Spinbox(r, from_=1, to=365, width=6, textvariable=self.v_days, command=self.save_access)
        sp.pack(side="left", padx=8)
        sp.bind("<FocusOut>", lambda e: self.save_access())
        ttk.Button(r, text="Завершить все сессии", command=self.reset_sessions).pack(side="right")

        c = self._card(t, "Пароль")
        self.pw_state = ttk.Label(c, text="", style="Dim.TLabel")
        self.pw_state.pack(anchor="w")
        r = self._row(c)
        ttk.Label(r, text="Новый пароль", style="Card.TLabel", width=18).pack(side="left")
        self.v_pw1 = tk.StringVar()
        ttk.Entry(r, textvariable=self.v_pw1, show="•", width=30).pack(side="left")
        r = self._row(c)
        ttk.Label(r, text="Ещё раз", style="Card.TLabel", width=18).pack(side="left")
        self.v_pw2 = tk.StringVar()
        ttk.Entry(r, textvariable=self.v_pw2, show="•", width=30).pack(side="left")
        ttk.Button(r, text="Сохранить пароль", style="Accent.TButton", command=self.save_password).pack(side="left", padx=10)

        c = self._card(t, "Сеть")
        r = self._row(c)
        ttk.Label(r, text="Порт сайта", style="Card.TLabel", width=18).pack(side="left")
        self.v_port = tk.StringVar(value=str(cfg.get("web_port", 8080)))
        ttk.Entry(r, textvariable=self.v_port, width=8).pack(side="left")
        ttk.Button(r, text="Применить", command=self.save_port).pack(side="left", padx=10)
        ttk.Label(c, text="Туннель и проброс портов настраиваются отдельно - сайт просто слушает этот порт.", style="Dim.TLabel").pack(anchor="w", pady=(6, 0))
        self._refresh_pw_state()

    # Вкладка "Компоненты":
    def _tab_parts(self, t) -> None:
        tk, ttk = self.tk, self.ttk
        cfg = self.ws.load_config()
        c = self._card(t, "Что запускать")
        self.v_ups = tk.BooleanVar(value=bool(cfg.get("ups", True)))
        ttk.Checkbutton(c, text="ИБП (ippon_ups.py) - выключите, если ИБП не подключён", variable=self.v_ups,
                        command=lambda: self.save_cfg(ups=self.v_ups.get(), restart=True)).pack(anchor="w")
        self.v_lhm = tk.BooleanVar(value=bool(cfg.get("lhm", True)))
        ttk.Checkbutton(c, text="LibreHardwareMonitor (температуры, напряжения, частоты, SMART)", variable=self.v_lhm,
                        command=lambda: self.save_cfg(lhm=self.v_lhm.get(), restart=True)).pack(anchor="w", pady=(4, 0))
        r = self._row(c)
        self.lhm_lbl = ttk.Label(r, text="", style="Dim.TLabel")
        self.lhm_lbl.pack(side="left")
        self.btn_lhm = ttk.Button(r, text="Перейти на встроенный LHM", command=self.use_own_lhm)

        c = self._card(t, "Telegram")
        tg = load_tg()
        r = self._row(c)
        ttk.Label(r, text="Токен бота", style="Card.TLabel", width=14).pack(side="left")
        self.v_tok = tk.StringVar(value=tg["token"])
        self.e_tok = ttk.Entry(r, textvariable=self.v_tok, show="•", width=52)
        self.e_tok.pack(side="left")
        self.v_showtok = tk.BooleanVar(value=False)
        ttk.Checkbutton(r, text="показать", variable=self.v_showtok,
                        command=lambda: self.e_tok.configure(show="" if self.v_showtok.get() else "•")).pack(side="left", padx=8)
        r = self._row(c)
        ttk.Label(r, text="Chat ID", style="Card.TLabel", width=14).pack(side="left")
        self.v_chat = tk.StringVar(value=tg["chat"])
        ttk.Entry(r, textvariable=self.v_chat, width=24).pack(side="left")
        r = self._row(c)
        ttk.Button(r, text="Сохранить", style="Accent.TButton", command=self.save_telegram).pack(side="left")
        ttk.Button(r, text="Отправить тест", command=self.test_telegram).pack(side="left", padx=8)
        ttk.Label(c, text="Пусто - бот выключен, сообщения только в журнал. Всё, что уходит в Telegram, дублируется в журнал.",
                  style="Dim.TLabel").pack(anchor="w", pady=(6, 0))

    # Вкладка "ИБП" (настройки ippon_ups.py, файл data/ups.json):
    def _tab_ups(self, t) -> None:
        tk, ttk = self.tk, self.ttk
        import ippon_ups
        self.iu = ippon_ups
        c = self._card(t, "Устройство и опрос")
        self.v_u = {}
        rows = (
            ("vid", "USB VID", "hex, например 0x0665"), ("pid", "USB PID", "hex, например 0x5161"),
            ("poll_sec", "Пауза между опросами, с", "0 - максимально часто"),
            ("http_host", "Адрес сервера данных", "0.0.0.0 - вся локальная сеть, 127.0.0.1 - только этот ПК"),
            ("http_port", "Порт сервера данных", "сайт берёт данные ИБП с этого порта"),
        )
        for key, name, tip in rows:
            r = self._row(c)
            ttk.Label(r, text=name, style="Card.TLabel", width=26).pack(side="left")
            self.v_u[key] = tk.StringVar()
            ttk.Entry(r, textvariable=self.v_u[key], width=16).pack(side="left")
            ttk.Label(r, text=tip, style="Dim.TLabel").pack(side="left", padx=10)
        c = self._card(t, "Гибернация, Telegram, история")
        self.v_u["hibernate_enable"] = tk.BooleanVar()
        ttk.Checkbutton(c, text="Гибернация ПК при пропаже сети", variable=self.v_u["hibernate_enable"]).pack(anchor="w")
        for key, name, tip in (("hibernate_after_sec", "Гибернация через, с", "на батарее (или сразу при разряде АКБ)"),
                               ("flush_sec", "Запись на диск раз в, с", "на батарее - раз в 2 с"),
                               ("retention_days", "Хранить историю ИБП, дней", "")):
            r = self._row(c)
            ttk.Label(r, text=name, style="Card.TLabel", width=26).pack(side="left")
            self.v_u[key] = tk.StringVar()
            ttk.Entry(r, textvariable=self.v_u[key], width=16).pack(side="left")
            ttk.Label(r, text=tip, style="Dim.TLabel").pack(side="left", padx=10)
        self.v_u["tg_enable"] = tk.BooleanVar()
        ttk.Checkbutton(c, text="Сообщения в Telegram (токен и чат - на вкладке \"Компоненты\")",
                        variable=self.v_u["tg_enable"]).pack(anchor="w", pady=(6, 0))
        r = self._row(c)
        ttk.Button(r, text="Сохранить", style="Accent.TButton", command=self.save_ups).pack(side="left", pady=(8, 0))
        ttk.Button(r, text="По умолчанию", command=self.reset_ups).pack(side="left", padx=8, pady=(8, 0))
        self._load_ups_fields()

    # Заполнить поля вкладки "ИБП" из ups.json:
    def _load_ups_fields(self) -> None:
        self.iu.load_settings()
        try:
            with open(self.iu.UPS_FILE, encoding="utf-8-sig") as f: cfg = json.load(f)
        except (OSError, ValueError): cfg = dict(self.iu.SETTINGS_DEFAULT)
        for key, var in self.v_u.items():
            val = cfg.get(key, self.iu.SETTINGS_DEFAULT[key])
            var.set(bool(val) if isinstance(var, self.tk.BooleanVar) else (f"{val:g}" if isinstance(val, float) else str(val)))

    # Сохранить настройки ИБП:
    def save_ups(self) -> None:
        cfg = {}
        try:
            for key, default in self.iu.SETTINGS_DEFAULT.items():
                raw = self.v_u[key].get()
                if key in ("vid", "pid"): cfg[key] = f"0x{int(str(raw).strip(), 0):04x}"
                elif isinstance(default, bool): cfg[key] = bool(raw)
                elif isinstance(default, int): cfg[key] = int(str(raw).strip())
                elif isinstance(default, float): cfg[key] = float(str(raw).strip().replace(",", "."))
                else: cfg[key] = str(raw).strip() or default
        except ValueError:
            return self.say(f"Неверное значение в поле \"{key}\".", True)
        if not 1 <= cfg["http_port"] <= 65535: return self.say("Порт - число от 1 до 65535.", True)
        with open(self.iu.UPS_FILE, "w", encoding="utf-8") as f: json.dump(cfg, f, ensure_ascii=False, indent=4)
        # Сайт берёт данные ИБП с этого порта:
        web = self.ws.load_config()
        web["ups_url"] = f"http://127.0.0.1:{cfg['http_port']}"
        self.ws.save_config(web)
        LOG.info("Настройки ИБП сохранены.")
        self._load_ups_fields()
        if self.sv.want and self.ask("Настройки ИБП применятся после перезапуска сервиса. Перезапустить сейчас?"):
            self.bg(self.sv.restart)

    # Сбросить настройки ИБП по умолчанию:
    def reset_ups(self) -> None:
        if not self.ask("Вернуть настройки ИБП по умолчанию?"): return
        try: os.remove(self.iu.UPS_FILE)
        except OSError: pass
        self._load_ups_fields()
        web = self.ws.load_config()
        web["ups_url"] = f"http://127.0.0.1:{self.iu.HTTP_PORT}"
        self.ws.save_config(web)
        LOG.info("Настройки ИБП сброшены по умолчанию.")
        if self.sv.want and self.ask("Перезапустить сервис, чтобы применить?"): self.bg(self.sv.restart)

    # Вкладка "Данные":
    def _tab_data(self, t) -> None:
        ttk = self.ttk
        c = self._card(t, "Файлы (папка data)")
        self.sizes = ttk.Label(c, text="", style="Card.TLabel", justify="left")
        self.sizes.pack(anchor="w")
        r = self._row(c)
        ttk.Button(r, text="Открыть папку data", command=lambda: os.startfile(DATA)).pack(side="left")
        c = self._card(t, "Очистка и сброс")
        for text, cmd, tip in (
                ("Очистить историю", self.clear_history, "Графики ИБП и ПК, журнал событий (база sysdeck.db). Настройки не трогаются."),
                ("Очистить журнал", self.clear_log, "Файл data/sysdeck.log."),
                ("Сбросить настройки сайта", self.reset_settings, "Порт, вход, пароль, сессии - как после установки (вход без пароля)."),
                ("Сбросить Telegram", self.reset_telegram, "Токен и чат будут пустыми - бот выключится.")):
            r = self._row(c)
            ttk.Button(r, text=text, style="Danger.TButton", command=cmd, width=26).pack(side="left")
            ttk.Label(r, text=tip, style="Dim.TLabel", wraplength=440, justify="left").pack(side="left", padx=10)

    # Вкладка "Журнал":
    def _tab_log(self, t) -> None:
        tk, ttk = self.tk, self.ttk
        bar = ttk.Frame(t, padding=(12, 10, 12, 0))
        bar.pack(fill="x")
        ttk.Button(bar, text="Открыть файл журнала", command=lambda: os.path.exists(LOG_PATH) and os.startfile(LOG_PATH)).pack(side="left")
        self.v_follow = tk.BooleanVar(value=True)
        ttk.Checkbutton(bar, text="следить за новыми строками", variable=self.v_follow, style="Bar.TCheckbutton").pack(side="left", padx=10)
        fr = ttk.Frame(t, padding=12)
        fr.pack(fill="both", expand=True)
        self.logtxt = tk.Text(fr, bg=C["card"], fg=C["text"], borderwidth=0, highlightthickness=0, font=("Consolas", 9), wrap="none")
        sb = ttk.Scrollbar(fr, command=self.logtxt.yview)
        self.logtxt.configure(yscrollcommand=sb.set, state="disabled")
        sb.pack(side="right", fill="y")
        self.logtxt.pack(fill="both", expand=True)

    #
    # Трей.
    #
    def _tray(self) -> None:
        try:
            import pystray
        except ImportError:
            return
        M = pystray.MenuItem
        menu = pystray.Menu(
            M("Открыть SysDeck", lambda: self.q.put(("show",)), default=True),
            M("Открыть сайт", lambda: self.q.put(("site",))),
            pystray.Menu.SEPARATOR,
            M(lambda i: "Остановить" if self.sv.want else "Запустить", lambda: self.q.put(("toggle",))),
            M("Перезапустить", lambda: self.q.put(("restart",))),
            M("Автозапуск с Windows", lambda: self.q.put(("autostart",)), checked=lambda i: self.auto_on),
            pystray.Menu.SEPARATOR,
            M("Выход (остановить всё)", lambda: self.q.put(("quit",))))
        self.tray = pystray.Icon("SysDeck", tray_image(C["dim"]), "SysDeck", menu)
        self._tray_color = C["dim"]
        threading.Thread(target=self.tray.run, name="tray", daemon=True).start()

    # Команды из трея и от второго запуска (выполняются в потоке окна):
    def _pump(self) -> None:
        try:
            while True:
                cmd = self.q.get_nowait()[0]
                if cmd == "show": self.show()
                elif cmd == "site": self.open_site()
                elif cmd == "toggle": self.toggle()
                elif cmd == "restart": self.bg(self.sv.restart)
                elif cmd == "autostart": self.v_auto.set(not self.v_auto.get()); self.toggle_autostart()
                elif cmd == "quit": self.quit()
        except queue.Empty: pass
        self.root.after(150, self._pump)

    #
    # Действия.
    #
    def bg(self, fn, then=None) -> None:
        # Выполнить, ошибку - в журнал:
        def run() -> None:
            try: fn()
            except Exception: LOG.info("Ошибка:\n" + traceback.format_exc())
            if then: self.root.after(0, then)
        threading.Thread(target=run, daemon=True).start()

    # Показать окно:
    def show(self) -> None:
        self.root.deiconify()
        self.root.lift()
        self.root.attributes("-topmost", True)
        self.root.after(200, lambda: self.root.attributes("-topmost", False))
        self.root.focus_force()

    # Спрятать окно в трей:
    def hide(self) -> None:
        self.root.withdraw()
        if self.tray and not self.hinted:
            self.hinted = True
            try: self.tray.notify("SysDeck работает в трее. Выход - правой кнопкой по значку.", "SysDeck")
            except Exception: pass

    # Выход: остановить всё и закрыть лаунчер:
    def quit(self) -> None:
        self.state_lbl.configure(text="остановка…")
        self.root.update()
        self.sv.stop()
        if self.tray:
            try: self.tray.stop()
            except Exception: pass
        try: os.remove(PORT_FILE)
        except OSError: pass
        self.root.destroy()

    # Запустить или остановить:
    def toggle(self) -> None:
        self.bg(self.sv.stop if self.sv.want else self.sv.start)

    # Открыть сайт в браузере:
    def open_site(self) -> None:
        webbrowser.open(f"http://127.0.0.1:{self.ws.load_config().get('web_port', 8080)}/")

    # Открыть выбранный адрес:
    def _open_addr(self) -> None:
        sel = self.addr.curselection()
        if sel: webbrowser.open(self.addr.get(sel[0]).split()[-1])

    # Вопрос да/нет:
    def ask(self, text: str) -> bool:
        import tkinter.messagebox as mb
        return mb.askyesno("SysDeck", text, parent=self.root)

    # Сообщение:
    def say(self, text: str, error: bool = False) -> None:
        import tkinter.messagebox as mb
        (mb.showerror if error else mb.showinfo)("SysDeck", text, parent=self.root)

    # Сохранить параметры (restart - предложить перезапуск сервиса):
    def save_cfg(self, restart: bool = False, **kv) -> None:
        cfg = self.ws.load_config()
        cfg.update(kv)
        self.ws.save_config(cfg)
        LOG.info("Настройки изменены: " + ", ".join(f"{k}={v}" for k, v in kv.items() if "password" not in k))
        if restart and self.sv.want and self.ask("Чтобы применить, нужно перезапустить сервис. Перезапустить сейчас?"):
            self.bg(self.sv.restart)

    # Сохранить настройки входа:
    def save_access(self) -> None:
        try: days = float(self.v_days.get().replace(",", "."))
        except ValueError: days = 3
        days = min(365.0, max(1.0, days))
        cfg = self.ws.load_config()
        if self.v_auth.get() and not cfg.get("password_hash"):
            self.say("Сначала задайте пароль ниже - вход по паролю включится сам.")
            self.v_auth.set(False)
            return
        self.save_cfg(auth_enabled=self.v_auth.get(), trust_lan=self.v_lan.get(), session_days=days)
        self._refresh_pw_state()

    # Сохранить новый пароль:
    def save_password(self) -> None:
        a, b = self.v_pw1.get(), self.v_pw2.get()
        if not a: return self.say("Введите пароль.", True)
        if a != b: return self.say("Пароли не совпадают.", True)
        if len(a) < 6: return self.say("Слишком короткий пароль (нужно хотя бы 6 символов, лучше 12+).", True)
        cfg = self.ws.load_config()
        cfg.update(password="", password_hash=self.ws.hash_password(a), auth_enabled=True)
        self.ws.save_config(cfg)
        self.v_pw1.set(""); self.v_pw2.set("")
        self.v_auth.set(True)
        LOG.info("Пароль сайта изменён, вход по паролю включён.")
        self._refresh_pw_state()
        self.say("Пароль сохранён, вход по паролю включён. Все старые входы на сайт больше не действуют.")

    # Обновить подпись о пароле:
    def _refresh_pw_state(self) -> None:
        cfg = self.ws.load_config()
        has = bool(cfg.get("password_hash"))
        self.pw_state.configure(text=("Пароль задан." if has else "Пароль не задан.") +
                                (" Вход по паролю включён." if cfg.get("auth_enabled") else " Вход по паролю выключен."))

    # Завершить все сессии сайта:
    def reset_sessions(self) -> None:
        if not self.ask("Завершить все входы на сайт? Везде (и у вас) пароль спросят заново."): return
        import secrets
        with open(os.path.join(DATA, "session.key"), "wb") as f: f.write(secrets.token_bytes(32))
        LOG.info("Все сессии сайта завершены (новый ключ сессий).")
        self.say("Готово: все входы на сайт сброшены (применяется в течение пары секунд).")

    # Сохранить порт сайта:
    def save_port(self) -> None:
        try:
            port = int(self.v_port.get())
            if not 1 <= port <= 65535: raise ValueError
        except ValueError:
            return self.say("Порт - число от 1 до 65535.", True)
        self.save_cfg(web_port=port, restart=True)

    # Узнать, включён ли автозапуск:
    def _load_autostart(self) -> None:
        info = task_info()
        self.auto_on = bool(info and info["ours"] and info["state"] != "Disabled")
        self.root.after(0, lambda: self.v_auto.set(self.auto_on))

    # Включить или выключить автозапуск:
    def toggle_autostart(self) -> None:
        if not is_admin():
            self.v_auto.set(not self.v_auto.get())
            return self.say("Для автозапуска нужны права администратора: закройте SysDeck (Выход в трее) и запустите снова, "
                            "подтвердив запрос Windows.", True)
        on = self.v_auto.get()
        self.bg(autostart_on if on else autostart_off,
                then=lambda: (LOG.info("Автозапуск " + ("включён" if on else "выключен") + "."), self.bg(self._load_autostart)))

    # Перейти с системного LHM на встроенный:
    def use_own_lhm(self) -> None:
        if not os.path.exists(LHM_EXE): return self.say("В папке LibreHardwareMonitor нет программы.", True)
        if not is_admin(): return self.say("Нужны права администратора (перезапустите SysDeck с подтверждением UAC).", True)
        if not self.ask("Закрыть LibreHardwareMonitor, установленный в систему, отключить его автозапуск\n"
                        "и дальше запускать встроенный (скрытый) вместе с SysDeck?"):
            return

        # Переключение в фоне:
        def work() -> None:
            for p in lhm_procs():
                if (p.info["exe"] or "").lower() != LHM_EXE.lower():
                    try: p.kill()
                    except Exception: pass
            powershell("Get-ScheduledTask | Where-Object { $_.TaskName -like '*LibreHardwareMonitor*' } | Disable-ScheduledTask | Out-Null")
            LOG.info("Внешний LibreHardwareMonitor закрыт, его автозапуск отключён (задачу можно включить обратно в Планировщике).")
            time.sleep(1)
            self.sv.restart()
        self.bg(work)

    # Сохранить настройки Telegram:
    def save_telegram(self) -> None:
        save_tg(self.v_tok.get(), self.v_chat.get())
        LOG.info("Настройки Telegram сохранены.")
        if self.sv.want and self.ask("Перезапустить сервис, чтобы ippon_ups.py подхватил новые настройки Telegram?"):
            self.bg(self.sv.restart)

    # Отправить тестовое сообщение в Telegram:
    def test_telegram(self) -> None:
        tok, chat = self.v_tok.get().strip(), self.v_chat.get().strip()
        if not tok or not chat: return self.say("Заполните токен и Chat ID.", True)

        # Отправка в фоне:
        def work() -> None:
            try:
                import requests
                r = requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                                  data={"chat_id": chat, "text": "[SysDeck] Проверка связи ✅"}, timeout=10)
                ok, msg = r.ok, ("" if r.ok else r.text[:300])
            except Exception as e:
                ok, msg = False, str(e)
            self.root.after(0, lambda: self.say("Сообщение отправлено." if ok else f"Не отправилось: {msg}", not ok))
        self.bg(work)

    # Выполнить действие при остановленном сервисе:
    def _with_stopped(self, what: str, fn) -> None:
        was = self.sv.want

        # Остановить, выполнить, запустить снова:
        def work() -> None:
            if was: self.sv.stop()
            try: fn()
            finally:
                if was: self.sv.start()
            LOG.info(what)
        self.bg(work)

    # Очистить историю:
    def clear_history(self) -> None:
        if not self.ask("Удалить всю историю (графики ИБП и ПК, журнал событий)? Настройки останутся."): return

        # Удалить базу:
        def rm() -> None:
            for suf in ("", "-wal", "-shm"):
                try: os.remove(DB_PATH + suf)
                except OSError: pass
        self._with_stopped("История очищена (sysdeck.db удалена и создана заново).", rm)

    # Очистить журнал:
    def clear_log(self) -> None:
        if self.ask("Очистить журнал data/sysdeck.log?"):
            LOG.clear()
            LOG.info("Журнал очищен.")

    # Сбросить настройки сайта:
    def reset_settings(self) -> None:
        if not self.ask("Сбросить настройки сайта по умолчанию? Пароль будет удалён, вход станет без пароля, порт 8080."): return

        # Удалить настройки и ключ сессий:
        def rm() -> None:
            for n in ("sysdeck.json", "session.key"):
                try: os.remove(os.path.join(DATA, n))
                except OSError: pass
            self.ws.load_config()
        self._with_stopped("Настройки сайта сброшены по умолчанию.", rm)
        self.root.after(1500, self._reload_fields)

    # Сбросить Telegram:
    def reset_telegram(self) -> None:
        if not self.ask("Стереть токен и чат Telegram?"): return
        save_tg("", "")
        self.v_tok.set(""); self.v_chat.set("")
        LOG.info("Настройки Telegram сброшены.")

    # Перечитать настройки в поля окна:
    def _reload_fields(self) -> None:
        cfg = self.ws.load_config()
        self.v_auth.set(bool(cfg.get("auth_enabled"))); self.v_lan.set(bool(cfg.get("trust_lan")))
        self.v_days.set(f"{float(cfg.get('session_days') or 3):g}"); self.v_port.set(str(cfg.get("web_port", 8080)))
        self.v_ups.set(bool(cfg.get("ups", True))); self.v_lhm.set(bool(cfg.get("lhm", True)))
        self._refresh_pw_state()

    #
    # Обновление окна.
    #
    def _poll_ups(self) -> None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while True:
            try:
                url = self.ws.load_config().get("ups_url", "http://127.0.0.1:8765").rstrip("/") + "/api/status"
                with opener.open(url, timeout=1.5) as r: self.ups = json.loads(r.read().decode("utf-8"))
            except Exception:
                self.ups = None
            time.sleep(2)

    # Обновление окна раз в секунду:
    def _tick(self) -> None:
        try: self._update()
        except Exception: LOG.info("Ошибка окна:\n" + traceback.format_exc())
        self.root.after(1000, self._tick)

    # Обновить строку состояния:
    def _set(self, key: str, text: str, color: str = "text") -> None:
        lbl = self.st[key]
        if lbl.cget("text") != text: lbl.configure(text=text)
        if lbl.cget("fg") != C[color]: lbl.configure(fg=C[color])

    # Обновить всё в окне:
    def _update(self) -> None:
        sv, cfg = self.sv, self.ws.load_config()
        running = sv.running()
        u = self.ups
        on_batt = bool(u and u.get("connected") and (u.get("status") or {}).get("on_battery"))
        # Шапка и трей:
        state = sv.busy or ("работает" if running else ("запуск…" if sv.want else "остановлен"))
        self.state_lbl.configure(text="● " + state, fg=C["good"] if running else (C["warn"] if sv.want or sv.busy else C["dim"]))
        self.btn_toggle.configure(text="Остановить" if sv.want else "Запустить", style="TButton" if sv.want else "Accent.TButton")
        color = C["dim"] if not running else (C["warn"] if on_batt else C["accent"])
        if self.tray and color != self._tray_color:
            self._tray_color = color
            self.tray.icon = tray_image(color)
            self.tray.title = "SysDeck - " + ("работа от батареи!" if on_batt else state)
            try: self.tray.update_menu()
            except Exception: pass
        # Состояние:
        if running:
            up = time.time() - sv.worker_t0
            self._set("svc", f"работает {int(up // 3600)} ч {int(up % 3600 // 60)} мин (PID {sv.worker.pid})", "good")
        else:
            self._set("svc", sv.busy or ("перезапуск…" if sv.want else "остановлен"), "warn" if sv.want else "dim")
        if not cfg.get("ups", True): self._set("ups", "выключен в настройках", "dim")
        elif not u: self._set("ups", "ippon_ups.py не отвечает" if running else "—", "warn" if running else "dim")
        elif not u.get("connected"): self._set("ups", "нет связи с ИБП по USB", "warn")
        else:
            s = u.get("status") or {}
            txt = f"{'ОТ БАТАРЕИ' if s.get('on_battery') else 'сеть'} · вход {s.get('input_voltage')} В · нагрузка {s.get('load_percent')}% · АКБ {s.get('battery_voltage')} В"
            self._set("ups", txt, "bad" if s.get("on_battery") else "good")
        self._set("lhm", sv.lhm_note, "good" if "работает" in sv.lhm_note else ("text" if "внешний" in sv.lhm_note else "dim"))
        port = int(cfg.get("web_port", 8080))
        self._set("web", f"порт {port}" + ("" if running else " (остановлен)"), "text" if running else "dim")
        if cfg.get("auth_enabled"):
            self._set("auth", f"по паролю, помнить {float(cfg.get('session_days') or 3):g} дн." + (" (из дома без пароля)" if cfg.get("trust_lan") else "")
                      if cfg.get("password_hash") else "по паролю, но пароль не задан!", "text" if cfg.get("password_hash") else "bad")
        else:
            self._set("auth", "без пароля", "dim")
        # LHM на вкладке «Компоненты»:
        self.lhm_lbl.configure(text="Сейчас: " + sv.lhm_note)
        if "внешний" in sv.lhm_note and os.path.exists(LHM_EXE): self.btn_lhm.pack(side="right")
        else: self.btn_lhm.pack_forget()
        # Адреса (раз в 10 с):
        if not self._addr_sig or time.time() - self._addr_sig[1] > 10 or self._addr_sig[0] != port:
            items = site_addresses(port)
            self.addr.delete(0, "end")
            for name, url in items: self.addr.insert("end", f"{name:<44} {url}")
            self.addr.configure(height=min(8, len(items)))
            self._addr_sig = (port, time.time())
        # Размеры файлов:
        rows = []
        for name in ("sysdeck.db", "sysdeck.db-wal", "sysdeck.log", "sysdeck.json", "tgbot.json", "session.key"):
            p = os.path.join(DATA, name)
            if os.path.exists(p): rows.append(f"{name:<18} {os.path.getsize(p) / 1024 / 1024:8.2f} МБ" if os.path.getsize(p) > 50000
                                              else f"{name:<18} {os.path.getsize(p) / 1024:8.1f} КБ")
        self.sizes.configure(text="\n".join(rows) or "пусто", font=("Consolas", 10))
        # Журнал:
        if LOG.seq != self.log_seq:
            self.log_seq = LOG.seq
            lines = list(LOG.tail)
            for w, n in ((self.logtxt, 500), (self.mini, 7)):
                if w is self.logtxt and not self.v_follow.get(): continue
                w.configure(state="normal")
                w.delete("1.0", "end")
                w.insert("end", "\n".join(lines[-n:]))
                w.see("end")
                w.xview_moveto(0)
                w.configure(state="disabled")


#
# Точка входа.
#


# Точка входа:
def main() -> None:
    args = sys.argv[1:]
    if "--worker" in args:
        run_worker()
        return
    tray = "--tray" in args
    # Уже запущен - показываем его окно:
    if ping_instance("show" if not tray else "ping"): return
    # LHM нужны права администратора: через задачу автозапуска (без UAC) или с запросом UAC.
    if not is_admin() and "--no-elevate" not in args:
        info = None
        try: info = task_info()
        except Exception: pass
        if info and info["ours"] and info["state"] != "Disabled":
            run_hidden(["schtasks", "/Run", "/TN", TASK], 20)
            for _ in range(40):
                time.sleep(0.25)
                if ping_instance("show" if not tray else "ping"): return
        params = " ".join([f'"{SELF}"'] + [a for a in args if a != "--no-elevate"])
        if ctypes.windll.shell32.ShellExecuteW(None, "runas", pythonw(), params, HERE, 1) > 32: return
        # Отказались от UAC - работаем без прав (без LHM).
    miss = missing_libs()
    if miss and not install_libs(miss): return
    LOG.info(f"Лаунчер запущен (PID {os.getpid()}, администратор: {'да' if is_admin() else 'нет'}).")
    # Переезд старых файлов и восстановление удалённых - до того, как окно прочитает настройки:
    try:
        migrate()
        ensure_files()
    except Exception: LOG.info("Ошибка подготовки файлов данных:\n" + traceback.format_exc())
    # Старая задача автозапуска (от sysdeck.ps1) для этой папки - переводим на лаунчер:
    if is_admin():
        try:
            info = task_info()
            if info and info["old"] and not info["ours"]:
                autostart_on()
                LOG.info(f"Автозапуск перенастроен на SysDeck.pyw (раньше: {info['args']}).")
        except Exception as e: LOG.info(f"Не удалось проверить автозапуск: {e}")
    sv = Services()
    app = App(sv, show=not tray)
    serve_control(app.q)
    threading.Thread(target=sv.start, name="start", daemon=True).start()
    app.root.mainloop()
    os._exit(0)


# Если скрипт запускают:
if __name__ == "__main__":
    try:
        main()
    except Exception:
        LOG.info("Лаунчер упал:\n" + traceback.format_exc())
        raise
