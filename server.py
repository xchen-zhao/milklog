"""Family milk log. Local SQLite storage; no speaker or cloud integrations."""
import argparse
import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import sqlite3
import threading
import uuid
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parent
CN = timezone(timedelta(hours=8))


def now():
    return datetime.now(CN).isoformat(timespec='seconds')


class Problem(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def envelope(data=None, *, event='milk_record', saved=False, error=None):
    return dict(success=error is None, event=event, data=data, saved=saved, speak=False, error=error)


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.database = self.directory / 'milk.sqlite3'
        self.backup_lock = threading.Lock()
        with closing(self.connect()) as c:
            c.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS records (
                  id TEXT PRIMARY KEY, amount_ml INTEGER NOT NULL CHECK(amount_ml BETWEEN 1 AND 1000),
                  fed_at TEXT NOT NULL, caregiver TEXT NOT NULL, note TEXT NOT NULL,
                  version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS records_day ON records(fed_at,deleted);
                CREATE TABLE IF NOT EXISTS audit (
                  seq INTEGER PRIMARY KEY, record_id TEXT NOT NULL, action TEXT NOT NULL,
                  before_json TEXT, after_json TEXT NOT NULL, at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS requests (
                  request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settings (
                  id INTEGER PRIMARY KEY CHECK(id=1), baby_name TEXT NOT NULL,
                  setup_complete INTEGER NOT NULL, version INTEGER NOT NULL);
                INSERT OR IGNORE INTO settings VALUES (1,'',0,1);
                CREATE TABLE IF NOT EXISTS caregiver_settings (
                  id INTEGER PRIMARY KEY CHECK(id=1), names_json TEXT NOT NULL,
                  version INTEGER NOT NULL);
                INSERT OR IGNORE INTO caregiver_settings VALUES (1,'["妈妈","姥姥","爸爸"]',1);
            ''')

    @staticmethod
    def caregiver_name(value):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 20 or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise Problem(422, 'INVALID_CAREGIVER', '记录人请填写1至20字，不要包含换行或控制字符')
        return value.strip()

    def caregivers(self):
        with closing(self.connect()) as c:
            row = c.execute('SELECT names_json,version FROM caregiver_settings WHERE id=1').fetchone()
        return dict(names=json.loads(row['names_json']), version=row['version'])

    def save_caregivers(self, payload):
        values = payload.get('names')
        if not isinstance(values, list) or not 1 <= len(values) <= 12:
            raise Problem(422, 'INVALID_CAREGIVERS', '常用记录人请保留1至12位')
        names = [self.caregiver_name(value) for value in values]
        if len(names) != len(set(names)):
            raise Problem(422, 'DUPLICATE_CAREGIVER', '常用记录人不能重复')
        version = payload.get('version')
        if type(version) is not int:
            raise Problem(422, 'INVALID_VERSION', '请重新打开记录人设置后重试')
        with closing(self.connect()) as c:
            with c:
                result = c.execute('UPDATE caregiver_settings SET names_json=?,version=version+1 WHERE id=1 AND version=?',
                                   (json.dumps(names, ensure_ascii=False), version))
                if not result.rowcount:
                    raise Problem(409, 'CAREGIVERS_CONFLICT', '家人已修改常用名单，请重新打开后修改')
        try:
            self.backup()
        except (OSError, sqlite3.Error):
            pass
        return dict(names=names, version=version+1)

    def settings(self):
        with closing(self.connect()) as c:
            row = dict(c.execute('SELECT baby_name,setup_complete,version FROM settings WHERE id=1').fetchone())
        row['setup_complete'] = bool(row['setup_complete'])
        return row

    def save_settings(self, payload):
        name = payload.get('baby_name')
        if not isinstance(name, str) or len(name.strip()) > 20 or any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
            raise Problem(422, 'INVALID_BABY_NAME', '昵称请控制在20字以内，不要包含换行或控制字符')
        name = name.strip()
        version = payload.get('version')
        if type(version) is not int:
            raise Problem(422, 'INVALID_VERSION', '请刷新设置后重试')
        with closing(self.connect()) as c:
            with c:
                result = c.execute('UPDATE settings SET baby_name=?,setup_complete=1,version=version+1 WHERE id=1 AND version=?', (name, version))
                if not result.rowcount:
                    raise Problem(409, 'SETTINGS_CONFLICT', '家人已更新宝宝昵称，请重新打开设置后修改')
                row = dict(c.execute('SELECT baby_name,setup_complete,version FROM settings WHERE id=1').fetchone())
        try:
            self.backup()
        except (OSError, sqlite3.Error):
            pass  # Settings have already been committed, as with feeding records.
        row['setup_complete'] = bool(row['setup_complete'])
        return row

    def connect(self):
        c = sqlite3.connect(self.database, timeout=10)
        c.row_factory = sqlite3.Row
        return c

    @staticmethod
    def validate(payload):
        amount = payload.get('amount_ml')
        if type(amount) is not int or not 1 <= amount <= 1000:
            raise Problem(422, 'INVALID_AMOUNT', '请填写1至1000之间的整数奶量')
        try:
            fed = datetime.fromisoformat(payload.get('fed_at', ''))
            if fed.utcoffset() is None:
                raise ValueError()
            fed = fed.astimezone(CN)
            if fed > datetime.now(CN) + timedelta(minutes=5):
                raise ValueError()
            if fed.year < 2020:
                raise ValueError()
        except (ValueError, TypeError):
            raise Problem(422, 'INVALID_TIME', '请检查喂奶时间，不能填写未来时间')
        caregiver, note = Store.caregiver_name(payload.get('caregiver', '爸爸')), payload.get('note', '')
        if not isinstance(note, str) or len(note) > 200:
            raise Problem(422, 'INVALID_NOTE', '备注请控制在200字以内')
        return dict(amount_ml=amount, fed_at=fed.isoformat(timespec='seconds'), caregiver=caregiver, note=note.strip())

    def list_day(self, day):
        try:
            chosen = date.fromisoformat(day)
            if chosen.year < 2020 or chosen > datetime.now(CN).date():
                raise ValueError()
            day = chosen.isoformat()
        except (ValueError, TypeError):
            raise Problem(422, 'INVALID_DATE', '日期格式不正确')
        with closing(self.connect()) as c:
            c.execute('BEGIN')
            records = [dict(r) for r in c.execute(
                'SELECT * FROM records WHERE deleted=0 AND substr(fed_at,1,10)=? ORDER BY fed_at DESC,created_at DESC', (day,))]
            latest = c.execute('SELECT * FROM records WHERE deleted=0 ORDER BY fed_at DESC LIMIT 1').fetchone()
            days = [dict(r) for r in c.execute('''SELECT substr(fed_at,1,10) AS day,
                sum(amount_ml) AS total_ml, count(*) AS count FROM records WHERE deleted=0
                GROUP BY day ORDER BY day DESC LIMIT 60''')]
            start = chosen - timedelta(days=29)
            trend_rows = {r['day']: dict(r) for r in c.execute('''SELECT substr(fed_at,1,10) AS day,
                sum(amount_ml) AS total_ml,count(*) AS count FROM records
                WHERE deleted=0 AND fed_at>=? AND fed_at<? GROUP BY day''',
                (start.isoformat()+'T00:00:00+08:00', (chosen+timedelta(days=1)).isoformat()+'T00:00:00+08:00'))}
            trend = []
            for offset in range(30):
                stamp = (start+timedelta(days=offset)).isoformat()
                row = trend_rows.get(stamp)
                trend.append(dict(date=stamp,total_ml=row['total_ml'] if row else None,count=row['count'] if row else 0))
        return dict(date=day, records=records, total_ml=sum(r['amount_ml'] for r in records),
                    count=len(records), latest=dict(latest) if latest else None, days=days,
                    trend=trend,trend_start=start.isoformat(),trend_end=day,server_time=now(),settings=self.settings(),caregivers=self.caregivers())

    def mutate(self, action, payload, record_id=None):
        if not isinstance(payload, dict):
            raise Problem(400, 'INVALID_JSON', '请求格式不正确')
        # This service never accepts simulation or voice events as actual feedings.
        if any(k in payload for k in ('text', 'source', 'is_test', 'speak')):
            raise Problem(400, 'MANUAL_ONLY', '请通过页面手动填写实际喝奶量')
        request_id = payload.get('request_id')
        if not isinstance(request_id, str) or not 8 <= len(request_id) <= 100:
            raise Problem(400, 'INVALID_REQUEST_ID', '操作标识无效，请刷新后重试')
        fingerprint = hashlib.sha256(json.dumps([action, record_id, payload], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with closing(self.connect()) as c:
            c.execute('BEGIN IMMEDIATE')
            previous = c.execute('SELECT * FROM requests WHERE request_id=?', (request_id,)).fetchone()
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise Problem(409, 'REQUEST_CONFLICT', '操作内容发生变化，请刷新后重试')
                return json.loads(previous['result_json'])
            remember = payload.get('remember_caregiver', False)
            if type(remember) is not bool:
                raise Problem(422, 'INVALID_CAREGIVER_OPTION', '请检查是否加入常用名单')
            if remember and action in ('create', 'update'):
                name = self.caregiver_name(payload.get('caregiver'))
                options = c.execute('SELECT names_json FROM caregiver_settings WHERE id=1').fetchone()
                names = json.loads(options['names_json'])
                if name not in names:
                    if len(names) >= 12:
                        raise Problem(422, 'CAREGIVERS_FULL', '常用名单已满，请取消加入常用或先调整名单')
                    names.append(name)
                    c.execute('UPDATE caregiver_settings SET names_json=?,version=version+1 WHERE id=1', (json.dumps(names, ensure_ascii=False),))
            before = None
            if action == 'create':
                fields = self.validate(payload)
                stamp = now()
                row = dict(id=str(uuid.uuid4()), **fields, version=1, deleted=0, created_at=stamp, updated_at=stamp)
                c.execute('INSERT INTO records VALUES (:id,:amount_ml,:fed_at,:caregiver,:note,:version,:deleted,:created_at,:updated_at)', row)
            else:
                old = c.execute('SELECT * FROM records WHERE id=?', (record_id,)).fetchone()
                if not old:
                    raise Problem(404, 'NOT_FOUND', '这条记录不存在')
                before = dict(old)
                if type(payload.get('version')) is not int or payload['version'] != old['version']:
                    raise Problem(409, 'VERSION_CONFLICT', '家人已更新这条记录，请刷新后再操作')
                if (action == 'restore') != bool(old['deleted']):
                    raise Problem(409, 'STATE_CONFLICT', '记录状态已变化，请刷新后再操作')
                row = dict(before, version=old['version'] + 1, updated_at=now())
                if action == 'update':
                    row.update(self.validate(payload))
                else:
                    row['deleted'] = int(action == 'delete')
                c.execute('''UPDATE records SET amount_ml=:amount_ml,fed_at=:fed_at,caregiver=:caregiver,
                    note=:note,version=:version,deleted=:deleted,updated_at=:updated_at WHERE id=:id''', row)
            c.execute('INSERT INTO audit(record_id,action,before_json,after_json,at) VALUES (?,?,?,?,?)',
                      (row['id'], action, json.dumps(before, ensure_ascii=False) if before else None,
                       json.dumps(row, ensure_ascii=False), now()))
            result = dict(record=row)
            c.execute('INSERT INTO requests VALUES (?,?,?)', (request_id, fingerprint, json.dumps(result, ensure_ascii=False)))
            c.commit()
        try:
            self.backup()
        except (OSError, sqlite3.Error):
            pass  # The committed record remains valid; expose backup status separately.
        return result

    def backup(self):
        with self.backup_lock:
            folder = self.directory / 'backups'
            folder.mkdir(exist_ok=True)
            target = folder / (datetime.now(CN).date().isoformat() + '.sqlite3')
            temporary = folder / 'backup.tmp'
            with closing(self.connect()) as source, closing(sqlite3.connect(temporary)) as dest:
                source.backup(dest)
            os.replace(temporary, target)
            return target

    def export(self):
        with closing(self.connect()) as c:
            return [dict(r) for r in c.execute('SELECT * FROM records WHERE deleted=0 ORDER BY fed_at')]


class Handler(BaseHTTPRequestHandler):
    server_version = 'MilkLog/1'

    def log_message(self, *args):
        pass

    def send(self, body, content_type, status=200, headers=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def json(self, data=None, status=200, *, event='milk_record', saved=False, error=None):
        self.send(json.dumps(envelope(data, event=event, saved=saved, error=error), ensure_ascii=False),
                  'application/json; charset=utf-8', status)

    def authorized(self):
        supplied = self.headers.get('Authorization', '').removeprefix('Bearer ')
        if not supplied:
            try:
                supplied = SimpleCookie(self.headers.get('Cookie', '')).get('milk_family')
                supplied = supplied.value if supplied else ''
            except Exception:
                supplied = ''
        return hmac.compare_digest(supplied, self.server.secret)

    def require_auth(self):
        if not self.authorized():
            raise Problem(401, 'SCAN_REQUIRED', '请扫描家里的二维码打开小奶瓶')

    def payload(self):
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            raise Problem(403, 'INVALID_ORIGIN', '请在记奶页面内操作')
        if self.headers.get_content_type() != 'application/json':
            raise Problem(415, 'JSON_REQUIRED', '请求格式不正确')
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 8192:
                raise ValueError()
            self.connection.settimeout(8)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError()
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, TimeoutError):
            raise Problem(400, 'INVALID_JSON', '请求内容不完整，请重试')

    def handle_request(self):
        u = urlsplit(self.path)
        path = u.path
        method = self.command
        if method in ('GET', 'HEAD') and path.startswith('/f/'):
            if not hmac.compare_digest(unquote(path[3:]), self.server.secret):
                raise Problem(401, 'SCAN_REQUIRED', '二维码无效，请重新扫码')
            return self.send(b'', 'text/plain', 303, {'Location': '/', 'Set-Cookie':
                f'milk_family={self.server.secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000'})
        static = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
                  '/theme.js': ('theme.js', 'application/javascript; charset=utf-8'),
                  '/style.css': ('style.css', 'text/css; charset=utf-8'), '/icon.svg': ('icon.svg', 'image/svg+xml')}
        if method in ('GET', 'HEAD') and path in static:
            file, mime = static[path]
            return self.send((ROOT / 'web' / file).read_bytes(), mime)
        self.require_auth()
        if method == 'GET' and path == '/api/session':
            return self.json(dict(server_time=now(), mode='manual'), event='session')
        if method == 'GET' and path == '/api/settings':
            return self.json(self.server.store.settings(), event='settings')
        if method == 'PUT' and path == '/api/settings':
            return self.json(self.server.store.save_settings(self.payload()), event='settings', saved=True)
        if method == 'GET' and path == '/api/caregivers':
            return self.json(self.server.store.caregivers(), event='caregivers')
        if method == 'PUT' and path == '/api/caregivers':
            return self.json(self.server.store.save_caregivers(self.payload()), event='caregivers', saved=True)
        if method == 'GET' and path == '/api/records':
            day = parse_qs(u.query).get('date', [datetime.now(CN).date().isoformat()])[0]
            return self.json(self.server.store.list_day(day), event='milk_list')
        if method == 'POST' and path == '/api/records':
            return self.json(self.server.store.mutate('create', self.payload()), saved=True)
        parts = path.strip('/').split('/')
        if len(parts) >= 3 and parts[:2] == ['api', 'records']:
            record_id = parts[2]
            if len(parts) == 3 and method in ('PUT', 'DELETE'):
                action = 'update' if method == 'PUT' else 'delete'
            elif len(parts) == 4 and parts[3] == 'restore' and method == 'POST':
                action = 'restore'
            else:
                raise Problem(405, 'METHOD_NOT_ALLOWED', '操作不支持')
            return self.json(self.server.store.mutate(action, self.payload(), record_id), saved=True)
        if method == 'GET' and path == '/api/export.csv':
            text = io.StringIO()
            writer = csv.writer(text)
            writer.writerow(['日期', '时间', '实际喝奶量(毫升)', '记录人', '备注'])
            for r in self.server.store.export():
                def safe(value):
                    return "'" + value if value[:1] in ('=', '+', '-', '@', '\t', '\r') else value
                writer.writerow([r['fed_at'][:10], r['fed_at'][11:16], r['amount_ml'], safe(r['caregiver']), safe(r['note'])])
            return self.send(('\ufeff' + text.getvalue()).encode('utf-8'), 'text/csv; charset=utf-8',
                             headers={'Content-Disposition': 'attachment; filename="milklog.csv"; filename*=UTF-8\'\'' + quote('小奶瓶-喝奶记录.csv')})
        if method == 'GET' and path == '/api/backup':
            backup = self.server.store.backup()
            return self.send(backup.read_bytes(), 'application/vnd.sqlite3', headers={
                'Content-Disposition': 'attachment; filename="milklog-backup.sqlite3"; filename*=UTF-8\'\'' + quote('小奶瓶-数据备份.sqlite3')})
        if method == 'GET' and path == '/api/share':
            return self.json(dict(url=self.server.share_url), event='share')
        if method == 'GET' and path == '/api/qr.svg':
            import qrcode
            import qrcode.image.svg
            qr = qrcode.make(self.server.share_url, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=4)
            buf = io.BytesIO()
            qr.save(buf)
            return self.send(buf.getvalue(), 'image/svg+xml')
        raise Problem(404, 'NOT_FOUND', '页面或接口不存在')

    def dispatch(self):
        try:
            self.handle_request()
        except Problem as p:
            self.json(status=p.status, error=dict(code=p.code, message=p.message))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except sqlite3.Error:
            self.json(status=503, error=dict(code='STORAGE_ERROR', message='保存暂时失败，请稍后重试'))
        except Exception:
            self.json(status=500, error=dict(code='INTERNAL_ERROR', message='服务暂时不可用，请稍后重试'))

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = dispatch


def create_server(data_dir, host='127.0.0.1', port=18766, lan_url=None):
    store = Store(data_dir)
    config = store.directory / 'config.json'
    if not config.exists():
        config.write_text(json.dumps(dict(secret=secrets.token_urlsafe(32))), 'utf-8')
        try:
            config.chmod(0o600)
        except OSError:
            pass
    secret = json.loads(config.read_text('utf-8'))['secret']
    server = ThreadingHTTPServer((host, port), Handler)
    server.store, server.secret = store, secret
    server.share_url = (lan_url or f'http://127.0.0.1:{server.server_port}').rstrip('/') + '/f/' + secret
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=18766)
    parser.add_argument('--data', default=str(ROOT / 'data'))
    parser.add_argument('--lan-url')
    parser.add_argument('--show-access-url', action='store_true', help='Print the private family access URL to this terminal')
    args = parser.parse_args()
    server = create_server(args.data, args.host, args.port, args.lan_url)
    (Path(args.data) / 'server.pid').write_text(str(os.getpid()), 'ascii')
    print(f'MilkLog listening on {args.host}:{args.port}', flush=True)
    if args.show_access_url:
        print(f'Private family access URL (keep secret): {server.share_url}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
