#
# ippon_ups.py - Скрипт для работы с бесперибойником.
#
# Был разработан для Ippon  Back Basic 650 Euro.
#
# Дополнительно пишет историю в data/sysdeck.db и раздаёт её по сети (только чтение):
#   GET /api/status                          - Последний замер, флаги, информация об ИБП.
#   GET /api/data?start=&end=&max_points=    - История за диапазон (unix-время или ISO).
#                     &bucket=               - Или шаг группировки в секундах вместо max_points.
#   GET /api/events?limit=                   - Журнал событий (всё, что уходило в тг).
#


# Подключаем:
import hid
import time
import subprocess
import requests
import os
import sys
import json
import queue
import atexit
import sqlite3
import threading
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler


# Глобальные переменные:
VID, PID = 0x0665, 0x5161
TG_TOKEN, TG_CHAT = "", ""  # Читаются из tgbot.json при запуске (load_tg).
TG_ENABLE = True            # Выключить тг вручную. Без токена или чата он выключается сам.
HIBERNATE_ENABLE = True     # Включена ли гибернация.
POLL_SEC = 0.0              # Частота опроса в секундах.
HIBERNATE_AFTER_SEC = 30.0  # Сколько ждать на батарее перед гибернацией в секундах.
HTTP_HOST = "0.0.0.0"       # Адрес сервера данных (0.0.0.0 = вся локальная сеть).
HTTP_PORT = 8765            # Порт сервера данных.
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DATA_DIR, "sysdeck.db")  # Одна база на весь проект (сайт пишет туда же свои таблицы).
TG_FILE = os.path.join(DATA_DIR, "tgbot.json")  # Токен и чат бота.
UPS_FILE = os.path.join(DATA_DIR, "ups.json")   # Настройки выше (их можно менять в лаунчере).
FLUSH_SEC = 15.0     # Как часто сбрасывать замеры на диск (на батарее - раз в 2 секунды).
RETENTION_DAYS = 90  # Сколько дней хранить историю.


# Класс бесперибойника:
class IpponUPS:
    # Инициализация:
    def __init__(self, vid=0x0665, pid=0x5161) -> None:
        self.vid, self.pid = vid, pid
        self.dev = None

    # Пытаемся подключиться к ИБП:
    def connect(self) -> bool:
        self.close()
        try:
            self.dev = hid.device()
            self.dev.open(self.vid, self.pid)
        except Exception:
            self.dev = None
            return False
        if not self.is_connected():
            self.close()
            return False
        return True

    # Проверка соединения с ИБП:
    def is_connected(self) -> bool:
        if self.dev is None: return False
        try:
            raw = self.cmd("Q1")
            return raw.startswith("(") and len(raw[1:].split()) == 8
        except Exception: return False

    # Закрыть соединение:
    def close(self) -> None:
        if self.dev is not None:
            try: self.dev.close()
            except Exception: pass
            self.dev = None

    # Отправить команду устройству:
    def cmd(self, command: str, timeout_ms=1000) -> str:
        if self.dev is None:
            raise IOError("ИБП не подключён")
        while self.dev.read(8, 1): pass  # Выкидываем хвосты прошлых ответов.
        data = (command + "\r").encode("ascii")
        for i in range(0, len(data), 8):
            chunk = data[i:i + 8].ljust(8, b"\x00")
            self.dev.write([0x00] + list(chunk))
        buf = b""
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            part = bytes(self.dev.read(8, 200))
            if part:
                buf += part
                if b"\r" in buf:
                    break
        return buf.split(b"\r")[0].replace(b"\x00", b"").decode("ascii", "ignore").strip()


    # Получить статус:
    def status(self) -> dict:
        raw = self.cmd("Q1")
        if not raw.startswith("("):
            raise IOError(f"Incorrect answer: {raw!r}")
        f = raw[1:].split()
        bits = f[7]
        batt_v = float(f[5])
        return {
            "input_voltage": float(f[0]),
            "input_fault_voltage": float(f[1]),
            "output_voltage": float(f[2]),
            "load_percent": int(f[3]),
            "frequency": float(f[4]),
            "battery_voltage": batt_v,
            # Грубая оценка заряда по напряжению 12В АКБ (10.5В = 0%, 13.0В = 100%):
            "battery_percent_est": max(0, min(100, round((batt_v - 10.5) / 2.5 * 100))),
            "temperature": float(f[6]),
            "on_battery": bits[0] == "1",
            "battery_low": bits[1] == "1",
            "avr_active": bits[2] == "1",
            "ups_fault": bits[3] == "1",
            "standby_type": bits[4] == "1",
            "test_in_progress": bits[5] == "1",
            "shutdown_active": bits[6] == "1",
            "beeper_on": bits[7] == "1",
            "raw": raw,
            "timestamp": time.time(),
        }


# Класс хранилища данных:
class Storage:
    COLUMNS = [
        "t", "vin_avg", "vin_min", "vin_max", "vout_avg", "vout_min", "vout_max", "vfault_min",
        "load_avg", "load_max", "freq_avg", "freq_min", "freq_max", "vbat_avg", "vbat_min",
        "batt_pct", "temp_avg", "temp_max",
        "on_battery", "battery_low", "avr_active", "ups_fault",
        "standby_type", "test_in_progress", "shutdown_active", "beeper_on", "samples",
    ]
    KINDS = [("line is down", "power_lost"), ("restored after", "power_restored"), ("hibernat", "hibernate"),
             ("connection lost", "link_lost"), ("is failed", "link_lost"), ("connection restored", "link_restored"),
             ("successful", "link_restored"), ("error", "error")]

    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.db = None
        self.pending = []          # Замеры, ещё не записанные на диск.
        self.last = None           # Последний замер (для /api/status).
        self.info = {}             # Ответы на F и I.
        self.on_batt_since = None  # Когда пропала сеть.
        self.rate_hz, self._rate_n, self._rate_t0 = 0.0, 0, time.time()
        self._last_flush = self._last_cleanup = time.time()
        self._last_event = ("", 0.0)

    # Открыть базу (вызывается из start_server):
    def open(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS samples (
            ts REAL PRIMARY KEY, vin REAL, vfault REAL, vout REAL,
            load INTEGER, freq REAL, vbat REAL, temp REAL, flags INTEGER)""")
        self.db.execute("CREATE TABLE IF NOT EXISTS events (ts REAL, kind TEXT, text TEXT)")
        self.db.execute("CREATE INDEX IF NOT EXISTS events_ts ON events (ts)")
        self.db.commit()
        self.cleanup()

    # Новый замер из handler():
    def add(self, s: dict) -> None:
        try:
            now = s["timestamp"]
            flags = int(s["raw"].split()[-1], 2)  # Биты статуса одним числом (b7 = 128 = on_battery).
            prev = self.last
            with self.lock:
                self.last = dict(s, flags=flags)
                self.pending.append((now, s["input_voltage"], s["input_fault_voltage"], s["output_voltage"],
                                     s["load_percent"], s["frequency"], s["battery_voltage"], s["temperature"], flags))
                if s["on_battery"] and self.on_batt_since is None: self.on_batt_since = now
                elif not s["on_battery"]: self.on_batt_since = None
                self._rate_n += 1
                if now - self._rate_t0 >= 5.0:
                    self.rate_hz, self._rate_n, self._rate_t0 = self._rate_n / (now - self._rate_t0), 0, now
            # Флаги, о которых тг не сообщает, тоже пишем в журнал:
            if prev:
                if s["battery_low"] and not prev["battery_low"]: self.event("Battery low!", "battery_low")
                if s["ups_fault"] and not prev["ups_fault"]: self.event("UPS fault!", "fault")
            if now - self._last_flush >= (2.0 if s["on_battery"] else FLUSH_SEC): self.flush()
            if now - self._last_cleanup >= 86400: self.cleanup()
        except Exception as e: print(f"[W] Storage add error: {e}")

    # Записать накопленное:
    def flush(self) -> None:
        self._last_flush = time.time()
        if self.db is None: return
        try:
            with self.lock:
                if not self.pending: return
                rows, self.pending = self.pending, []
                with self.db: self.db.executemany("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?,?)", rows)
        except Exception as e: print(f"[W] Storage flush error: {e}")

    # Записать событие (одинаковые сообщения чаще раза в минуту не дублируем):
    def event(self, text: str, kind: str = "") -> None:
        text = text.replace("[UPS]", "").strip()
        now = time.time()
        if self.db is None or (text == self._last_event[0] and now - self._last_event[1] < 60): return
        self._last_event = (text, now)
        if not kind:
            kind = next((k for key, k in self.KINDS if key in text.lower()), "info")
        try:
            with self.lock, self.db: self.db.execute("INSERT INTO events VALUES (?,?,?)", (now, kind, text))
        except Exception as e: print(f"[W] Storage event error: {e}")

    # Удалить старые данные:
    def cleanup(self) -> None:
        self._last_cleanup = time.time()
        border = time.time() - RETENTION_DAYS * 86400
        try:
            with self.lock, self.db:
                self.db.execute("DELETE FROM samples WHERE ts < ?", (border,))
                self.db.execute("DELETE FROM events WHERE ts < ?", (border,))
        except Exception as e: print(f"[W] Storage cleanup error: {e}")

    # Данные за диапазон, сгруппированные по bucket секунд (min/max сохраняют короткие скачки):
    def query(self, start: float, end: float, bucket: float) -> dict:
        self.flush()  # Сайт должен видеть и то, что ещё не успело записаться.
        bucket = max(bucket, (end - start) / 50000, 1e-3)
        c = sqlite3.connect(self.path, timeout=10)
        try:
            rows = c.execute("""
                SELECT MIN(ts),
                       ROUND(AVG(vin), 2), MIN(vin), MAX(vin),
                       ROUND(AVG(vout), 2), MIN(vout), MAX(vout), MIN(vfault),
                       ROUND(AVG(load), 1), MAX(load),
                       ROUND(AVG(freq), 2), MIN(freq), MAX(freq),
                       ROUND(AVG(vbat), 2), MIN(vbat),
                       ROUND(MIN(100.0, MAX(0.0, (AVG(vbat) - 10.5) / 2.5 * 100.0)), 0),
                       ROUND(AVG(temp), 1), MAX(temp),
                       MAX((flags >> 7) & 1), MAX((flags >> 6) & 1), MAX((flags >> 5) & 1), MAX((flags >> 4) & 1),
                       MAX((flags >> 3) & 1), MAX((flags >> 2) & 1), MAX((flags >> 1) & 1), MAX(flags & 1),
                       COUNT(*)
                FROM samples WHERE ts >= :s AND ts <= :e
                GROUP BY CAST(ts / :b AS INTEGER) ORDER BY 1""",
                {"s": start, "e": end, "b": bucket}).fetchall()
        finally: c.close()
        out = {name: [r[i] for r in rows] for i, name in enumerate(self.COLUMNS)}
        out.update({"start": start, "end": end, "bucket_sec": bucket, "points": len(rows)})
        return out

    # Журнал событий (новые сверху):
    def events(self, limit: int) -> list:
        c = sqlite3.connect(self.path, timeout=10)
        try: rows = c.execute("SELECT ts, kind, text FROM events ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        finally: c.close()
        return [{"ts": r[0], "kind": r[1], "text": r[2]} for r in rows]


storage = Storage(DB_PATH)


# Номинальные параметры (F) и модель (I) - для сайта:
def read_info(ups: IpponUPS) -> dict:
    out = {}
    try:
        f, i = ups.cmd("F"), ups.cmd("I")
        p = f[1:].split() if f.startswith("#") else []
        if len(p) >= 4:
            out.update(rating_voltage=float(p[0]), rating_current=float(p[1]),
                       rating_battery_voltage=float(p[2]), rating_frequency=float(p[3]))
        if i.startswith("#"):
            p = i[1:].split(None, 1)
            out["company"] = p[0] if p else ""
            out["model"] = p[1].strip() if len(p) > 1 else ""
    except Exception: pass
    return out


# Время из запроса: unix-секунды, unix-миллисекунды или ISO (локальное время):
def parse_time(s: str) -> float:
    s = s.strip()
    try:
        v = float(s)
        return v / 1000 if v > 1e11 else v
    except ValueError:
        return datetime.fromisoformat(s).timestamp()


# Обработчик запросов сервера данных (сервер только читает, к ИБП не обращается):
class Handler(BaseHTTPRequestHandler):
    # Не писать каждый запрос в консоль:
    def log_message(self, *args) -> None: pass

    # Отправить ответ в JSON:
    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    # Обработать GET-запрос:
    def do_GET(self) -> None:
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/api/status":
                now = time.time()
                with storage.lock: last, since, rate = storage.last, storage.on_batt_since, storage.rate_hz
                # Связь есть, если свежий замер был недавно:
                connected = last is not None and now - last["timestamp"] < max(3.0, POLL_SEC * 2 + 2)
                self._json({"connected": connected, "rate_hz": round(rate, 2), "status": last, "info": storage.info,
                            "on_battery_since": since, "server_time": now})
            elif u.path == "/api/data":
                end = parse_time(q["end"][0]) if "end" in q else time.time()
                start = parse_time(q["start"][0]) if "start" in q else end - 3600
                if end <= start: raise ValueError("end must be greater than start")
                if "bucket" in q: bucket = float(q["bucket"][0])
                else: bucket = (end - start) / max(10, min(int(q.get("max_points", ["3000"])[0]), 30000))
                self._json(storage.query(start, end, bucket))
            elif u.path == "/api/events":
                self._json({"events": storage.events(max(1, min(int(q.get("limit", ["100"])[0]), 5000)))})
            else:
                self._json({"error": "not found"}, 404)
        except (ValueError, KeyError) as e:
            self._json({"error": str(e)}, 400)


# HTTP-сервер без трассировок в журнале, когда клиент сам оборвал соединение:
class QuietServer(ThreadingHTTPServer):
    # На Windows SO_REUSEADDR позволяет второму процессу занять уже занятый порт и перехватывать запросы - запрещаем:
    allow_reuse_address = False

    # Ошибка обработки запроса (обрыв соединения клиентом - не ошибка):
    def handle_error(self, request, client_address) -> None:
        if isinstance(sys.exc_info()[1], (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)): return
        super().handle_error(request, client_address)


# Открыть базу и поднять сервер данных в фоне (если порт занят - управление ИБП всё равно работает):
def start_server() -> None:
    # Эмодзи в сообщениях не должны ронять вывод в консоль/лог с кодировкой Windows:
    for stream in (sys.stdout, sys.stderr):
        if stream and hasattr(stream, "reconfigure"): stream.reconfigure(errors="replace")
    try: storage.open()
    except Exception as e: print(f"[W] DB open error: {e}")
    atexit.register(storage.flush)  # Ctrl+C или обычное завершение - дописываем историю на диск.
    try:
        srv = QuietServer((HTTP_HOST, HTTP_PORT), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        print(f"[I] Data server: http://127.0.0.1:{HTTP_PORT}/api/status")
    except Exception as e: print(f"[W] Data server error: {e}")


# Настройки по умолчанию (значения глобальных переменных выше) и их типы:
SETTINGS_DEFAULT = {
    "vid": f"0x{VID:04x}", "pid": f"0x{PID:04x}", "tg_enable": TG_ENABLE, "hibernate_enable": HIBERNATE_ENABLE,
    "hibernate_after_sec": HIBERNATE_AFTER_SEC, "poll_sec": POLL_SEC, "http_host": HTTP_HOST, "http_port": HTTP_PORT,
    "flush_sec": FLUSH_SEC, "retention_days": RETENTION_DAYS,
}


# Прочитать настройки из ups.json. Нет файла, ключа или значение неверное - берём по умолчанию и дописываем файл:
def load_settings() -> None:
    global VID, PID, TG_ENABLE, HIBERNATE_ENABLE, HIBERNATE_AFTER_SEC, POLL_SEC, HTTP_HOST, HTTP_PORT, FLUSH_SEC, RETENTION_DAYS
    data = {}
    try:
        with open(UPS_FILE, encoding="utf-8-sig") as f: data = json.load(f)
        if not isinstance(data, dict): raise ValueError("not an object")
    except FileNotFoundError: pass
    except (OSError, ValueError) as e:
        print(f"[W] ups.json is broken ({e}) - defaults restored, old file: ups.json.broken")
        try: os.replace(UPS_FILE, UPS_FILE + ".broken")
        except OSError: pass
        data = {}
    cfg, fixed = {}, False
    for key, default in SETTINGS_DEFAULT.items():
        value = data.get(key, default)
        try:
            if key in ("vid", "pid"): value = f"0x{int(str(value), 0):04x}"
            elif isinstance(default, bool): value = bool(value)
            elif isinstance(default, int): value = int(value)
            elif isinstance(default, float): value = float(value)
            else: value = str(value)
        except (TypeError, ValueError):
            value = default
        if key not in data or data[key] != value: fixed = True
        cfg[key] = value
    if fixed:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(UPS_FILE, "w", encoding="utf-8") as f: json.dump(cfg, f, ensure_ascii=False, indent=4)
        except OSError as e: print(f"[W] Can't write ups.json: {e}")
    VID, PID = int(str(cfg["vid"]), 0), int(str(cfg["pid"]), 0)
    TG_ENABLE, HIBERNATE_ENABLE = cfg["tg_enable"], cfg["hibernate_enable"]
    HIBERNATE_AFTER_SEC, POLL_SEC = max(1.0, cfg["hibernate_after_sec"]), max(0.0, cfg["poll_sec"])
    HTTP_HOST, HTTP_PORT = cfg["http_host"], cfg["http_port"]
    FLUSH_SEC, RETENTION_DAYS = max(1.0, cfg["flush_sec"]), max(1, cfg["retention_days"])


# Настройка тг бота:
def load_tg() -> None:
    global TG_TOKEN, TG_CHAT, TG_ENABLE
    if not os.path.exists(TG_FILE):
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(TG_FILE, "w", encoding="utf-8") as f:
                json.dump({"token": "", "chat": ""}, f, ensure_ascii=False, indent=4)
            print(f"[I] Created {TG_FILE} - put bot token and chat id there to enable Telegram.")
        except OSError as e: print(f"[W] Can't create tgbot.json: {e}")
    try:
        with open(TG_FILE, encoding="utf-8-sig") as f: cfg = json.load(f)
    except (OSError, ValueError) as e:
        print(f"[W] tgbot.json read error: {e}")
        cfg = {}
    if not isinstance(cfg, dict): cfg = {}
    TG_TOKEN, TG_CHAT = str(cfg.get("token") or "").strip(), str(cfg.get("chat") or "").strip()
    TG_ENABLE = TG_ENABLE and bool(TG_TOKEN and TG_CHAT)
    print("[I] Telegram: " + ("on" if TG_ENABLE else "off (no token/chat in tgbot.json), messages go to console only"))


_tg_last = {}            # Когда какой текст последний раз уходил в тг.
_tg_queue = queue.Queue()  # Сообщения ждут отправки здесь: цикл опроса ИБП не ждёт сеть.
_tg_thread = None


# Отправка сообщений в тг по очереди, в фоне (без сети при отключении света запрос висит секундами):
def _tg_sender() -> None:
    while True:
        text = _tg_queue.get()
        try:
            requests.post(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                data={"chat_id": TG_CHAT, "text": text}, timeout=5.0)
        except Exception as e: print(f"[W] TG connection error: {e}")
        finally: _tg_queue.task_done()


# Дождаться, пока очередь тг отправится (не дольше timeout секунд):
def tg_wait(timeout: float) -> None:
    end = time.time() + timeout
    while _tg_queue.unfinished_tasks and time.time() < end: time.sleep(0.1)


# Сообщить по тг (и всегда - в консоль). Одинаковый текст в тг - не чаще раза в минуту:
def tg(text: str) -> None:
    global _tg_thread
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}")
    storage.event(text)  # Всё, что уходит в тг, попадает и в журнал событий на сайте.
    if not TG_ENABLE: return
    now = time.time()
    for key in [k for k, t in _tg_last.items() if now - t >= 60]: del _tg_last[key]
    if text in _tg_last: return
    _tg_last[text] = now
    if _tg_thread is None:
        _tg_thread = threading.Thread(target=_tg_sender, name="ups", daemon=True)
        _tg_thread.start()
    _tg_queue.put(text)


# Переход в гибернацию:
def hibernate() -> None:
    if not HIBERNATE_ENABLE: return
    subprocess.run(["shutdown", "/h"])


# Функция обработки данных:
def handler(status: dict) -> None:
    storage.add(status)  # История в БД + последнее состояние для сервера данных.


# Основная функция:
def main() -> None:
    ups = IpponUPS(VID, PID)
    on_batt_since = None  # Состояние когда сеть пропала или появилась.
    hibernated = False    # Переход в гибернацию.
    connection_lost = False

    # Подключаемся к ибп:
    if ups.connect():
        storage.info = read_info(ups)
        tg("[UPS] Connection to UPS is successful!")
        connection_lost = False
    else:
        tg("[UPS] Connection to UPS is failed!")
        connection_lost = True

    # Вечный цикл:
    while True:
        try: s = ups.status()  # Получаем статус.
        except Exception as e:
            # Если соединение пропало:
            if not ups.is_connected():
                ups.connect()  # Переродключаемся.
                # Выводим сообщение о потере соединения 1 раз:
                if not connection_lost: tg(f"[UPS] Connection lost!")
                connection_lost = True
            else: tg(f"[UPS] Read error: {e}")

            # Если соединение восстановлено:
            if ups.is_connected():
                if connection_lost: tg(f"[UPS] Connection restored!")
                connection_lost = False
                if not storage.info: storage.info = read_info(ups)  # ИБП подключили позже запуска - модель и номинал.
            time.sleep(max(POLL_SEC, 0.5))  # При ошибке не крутимся без паузы.
            continue

        # Обрабатываем данные тут:
        handler(s)

        # Обрабатываем пропажу сети и восстановление:
        if s["on_battery"] and on_batt_since is None:
            on_batt_since = time.time()
            tg(f"[UPS] ⚡ The line is down!\nLoad: {s['load_percent']}%\nBAT: {s['battery_voltage']}V")
        elif not s["on_battery"] and on_batt_since is not None:
            after = round(time.time() - on_batt_since, 2) if on_batt_since is not None else "None"
            tg(f"[UPS] ✅ The network has been restored after {after} sec.\nIN: {s['input_voltage']}V")
            on_batt_since = None
            hibernated = False

        # Обрабатываем действие гибернации:
        if on_batt_since and not hibernated and (s["battery_low"] or time.time() - on_batt_since > HIBERNATE_AFTER_SEC):
            tg("[UPS] 💤 PC going into hibernation.")
            tg_wait(6.0)  # Даём сообщениям уйти.
            hibernated = True
            hibernate()

        # Задержка парсинга:
        time.sleep(POLL_SEC)


# Если скрипт запускают:
if __name__ == "__main__":
    load_settings()
    load_tg()
    start_server()
    main()
