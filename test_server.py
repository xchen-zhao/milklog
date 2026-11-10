import concurrent.futures
import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path

from server import CN, create_server


class MilkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = create_server(self.temp.name, port=0)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.serial = 0

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        self.temp.cleanup()

    def request(self, method, path, payload=None, auth=True, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        hs = {'Content-Type': 'application/json'}
        if auth:
            hs['Authorization'] = 'Bearer ' + self.server.secret
        hs.update(headers or {})
        c.request(method, path, json.dumps(payload).encode() if payload is not None else None, hs)
        r = c.getresponse()
        status, content_type, body = r.status, r.getheader('Content-Type'), r.read()
        response_headers = dict(r.getheaders())
        c.close()
        if content_type.startswith('application/json'):
            body = json.loads(body)
            self.assertEqual(set(body), {'success','event','data','saved','speak','error'})
            self.assertFalse(body['speak'])
        return status, body, response_headers

    def payload(self, **updates):
        self.serial += 1
        p = dict(amount_ml=150, fed_at=datetime.now(CN).isoformat(timespec='seconds'),
                 caregiver='姥姥', note='', request_id='test-request-' + str(self.serial))
        p.update(updates)
        return p

    def create(self, **updates):
        status, body, _ = self.request('POST','/api/records', self.payload(**updates))
        self.assertEqual(status, 200)
        self.assertTrue(body['saved'])
        return body['data']['record']

    def test_auth_qr_and_read_only_page(self):
        self.assertEqual(self.request('GET','/api/records', auth=False)[0], 401)
        status, _, headers = self.request('GET','/f/'+self.server.secret, auth=False)
        self.assertEqual(status, 303)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        cookie=headers['Set-Cookie'].split(';')[0]
        self.assertEqual(self.request('GET','/api/session',auth=False,headers={'Cookie':cookie})[0],200)
        status, svg, _=self.request('GET','/api/qr.svg')
        self.assertEqual(status,200)
        self.assertIn(b'<svg',svg)
        self.assertEqual(self.request('GET','/data/config.json')[0],404)

    def test_dates_totals_and_edit_delete_restore(self):
        yesterday=(datetime.now(CN)-timedelta(days=1)).replace(hour=23,minute=59,second=0).isoformat()
        a=self.create()
        self.create(amount_ml=210)
        self.create(amount_ml=120,fed_at=yesterday)
        day=datetime.now(CN).date().isoformat()
        status,b,_=self.request('GET','/api/records?date='+day)
        self.assertEqual((b['data']['total_ml'],b['data']['count']),(360,2))
        p=self.payload(amount_ml=160,version=a['version'])
        status,b,_=self.request('PUT','/api/records/'+a['id'],p)
        self.assertEqual(status,200);a=b['data']['record']
        stale=self.payload(amount_ml=180,version=1)
        self.assertEqual(self.request('PUT','/api/records/'+a['id'],stale)[0],409)
        status,b,_=self.request('DELETE','/api/records/'+a['id'],dict(version=a['version'],request_id='delete-test-one'))
        self.assertEqual(status,200);deleted=b['data']['record']
        _,b,_=self.request('GET','/api/records?date='+day)
        self.assertEqual(b['data']['total_ml'],210)
        self.assertEqual(self.request('POST','/api/records/'+a['id']+'/restore',dict(version=deleted['version'],request_id='restore-test-one'))[0],200)
        _,b,_=self.request('GET','/api/records?date='+day)
        self.assertEqual(b['data']['total_ml'],370)
        _,b,_=self.request('GET','/api/records?date='+yesterday[:10])
        self.assertEqual(b['data']['total_ml'],120)
        with closing(self.server.store.connect()) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM audit').fetchone()[0],6)

    def test_idempotency_and_parallel_writes(self):
        payload=self.payload()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(lambda _:self.request('POST','/api/records',payload),range(4)))
        self.assertTrue(all(r[0]==200 for r in results))
        self.assertTrue(all(r[1]==results[0][1] for r in results))
        self.assertEqual(len(self.server.store.export()),1)
        self.assertEqual(self.request('POST','/api/records',dict(payload,amount_ml=151))[0],409)

    def test_validation_no_simulation_or_speech(self):
        for amount in (0,-1,1001,True,150.5,'150'):
            self.assertEqual(self.request('POST','/api/records',self.payload(amount_ml=amount))[0],422)
        self.assertEqual(self.request('POST','/api/records',self.payload(fed_at=(datetime.now(CN)+timedelta(days=1)).isoformat()))[0],422)
        for k,v in [('source','xiaoai'),('is_test',True),('text','宝宝刚才喝了150毫升'),('speak',True)]:
            self.assertEqual(self.request('POST','/api/records',self.payload(**{k:v}))[0],400)
        self.assertEqual(self.request('POST','/api/records',self.payload(),headers={'Origin':'http://elsewhere.invalid'})[0],403)
        self.assertEqual(self.server.store.export(),[])

    def test_caregiver_choices_and_legacy_preservation(self):
        legacy=self.create(caregiver='家人')
        dad=self.create(caregiver='爸爸')
        exported={r['id']:r for r in self.server.store.export()}
        self.assertEqual(exported[legacy['id']]['caregiver'],'家人')
        self.assertEqual(exported[dad['id']]['caregiver'],'爸爸')
        custom=self.create(caregiver='奶奶')
        self.assertEqual(custom['caregiver'],'奶奶')
        for value in ('','  ',None,123,'奶'*21,'奶\n奶'):
            self.assertEqual(self.request('POST','/api/records',self.payload(caregiver=value))[0],422)

    def test_common_caregivers_settings_auth_conflicts_and_history(self):
        self.assertEqual(self.request('GET','/api/caregivers',auth=False)[0],401)
        self.assertEqual(self.request('PUT','/api/caregivers',dict(names=['奶奶'],version=1),auth=False)[0],401)
        _,body,_=self.request('GET','/api/caregivers')
        self.assertEqual(body['data'],dict(names=['妈妈','姥姥','爸爸'],version=1))
        record=self.create(caregiver='爸爸')
        for values in ([],['奶奶']*2,['奶奶',' 奶奶 '],[''],['人'+str(i) for i in range(13)],'奶奶'):
            self.assertEqual(self.request('PUT','/api/caregivers',dict(names=values,version=1))[0],422)
        self.assertEqual(self.request('PUT','/api/caregivers',dict(names=['奶奶'],version=1),headers={'Origin':'http://elsewhere.invalid'})[0],403)
        status,body,_=self.request('PUT','/api/caregivers',dict(names=[' 妈妈 ','奶奶','爷爷'],version=1))
        self.assertEqual(status,200);self.assertEqual(body['data'],dict(names=['妈妈','奶奶','爷爷'],version=2))
        self.assertEqual(self.request('PUT','/api/caregivers',dict(names=['阿姨'],version=1))[0],409)
        update=self.payload(caregiver='爸爸',version=1,amount_ml=160)
        self.assertEqual(self.request('PUT','/api/records/'+record['id'],update)[0],200)
        self.assertEqual(self.server.store.export()[0]['caregiver'],'爸爸')
        from server import Store
        self.assertEqual(Store(self.temp.name).caregivers()['names'],['妈妈','奶奶','爷爷'])
        _,body,_=self.request('GET','/api/records')
        self.assertEqual(body['data']['caregivers']['version'],2)
        with closing(sqlite3.connect(self.server.store.backup())) as c:
            self.assertEqual(json.loads(c.execute('SELECT names_json FROM caregiver_settings').fetchone()[0]),['妈妈','奶奶','爷爷'])

    def test_remember_caregiver_is_atomic_idempotent_and_export_is_safe(self):
        payload=self.payload(caregiver='奶奶',remember_caregiver=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(lambda _:self.request('POST','/api/records',payload),range(4)))
        self.assertTrue(all(result[0]==200 for result in results))
        self.assertEqual(self.server.store.caregivers(),dict(names=['妈妈','姥姥','爸爸','奶奶'],version=2))
        self.assertEqual(len(self.server.store.export()),1)
        self.assertEqual(self.request('POST','/api/records',self.payload(caregiver='阿姨',amount_ml=0,remember_caregiver=True))[0],422)
        self.assertNotIn('阿姨',self.server.store.caregivers()['names'])
        self.create(caregiver='=1+1')
        _,raw,_=self.request('GET','/api/export.csv')
        self.assertIn("'=1+1",raw.decode('utf-8-sig'))
        self.server.store.save_caregivers(dict(names=['人'+str(i) for i in range(12)],version=2))
        self.assertEqual(self.request('POST','/api/records',self.payload(caregiver='阿姨',remember_caregiver=True))[0],422)
        self.create(caregiver='阿姨')
        self.assertEqual(len(self.server.store.export()),3)

    def test_caregivers_migrate_old_database_without_changing_records(self):
        record=self.create(caregiver='爸爸')
        with closing(self.server.store.connect()) as c:
            c.execute('DROP TABLE caregiver_settings');c.commit()
        from server import Store
        migrated=Store(self.temp.name)
        self.assertEqual(migrated.caregivers()['names'],['妈妈','姥姥','爸爸'])
        self.assertEqual(migrated.export()[0]['id'],record['id'])
        self.assertEqual(migrated.export()[0]['caregiver'],'爸爸')

    def test_thirty_day_trend_boundaries_gaps_and_deleted_records(self):
        end=datetime.now(CN).date()-timedelta(days=1)
        start=end-timedelta(days=29)
        def stamp(day,hour):return day.isoformat()+f'T{hour:02d}:00:00+08:00'
        self.create(amount_ml=100,fed_at=stamp(start-timedelta(days=1),8))
        self.create(amount_ml=150,fed_at=stamp(start,8))
        removed=self.create(amount_ml=500,fed_at=stamp(end,10))
        self.create(amount_ml=180,fed_at=stamp(end,8))
        self.create(amount_ml=210,fed_at=stamp(end,16))
        self.create(amount_ml=240,fed_at=stamp(end+timedelta(days=1),0))
        self.request('DELETE','/api/records/'+removed['id'],dict(version=1,request_id='remove-trend-fixture'))
        status,body,_=self.request('GET','/api/records?date='+end.isoformat())
        self.assertEqual(status,200)
        data=body['data'];trend=data['trend']
        self.assertEqual(len(trend),30)
        self.assertEqual((trend[0]['date'],trend[-1]['date']),(start.isoformat(),end.isoformat()))
        self.assertEqual((trend[0]['total_ml'],trend[0]['count']),(150,1))
        self.assertIsNone(trend[1]['total_ml']);self.assertEqual(trend[1]['count'],0)
        self.assertEqual((trend[-1]['total_ml'],trend[-1]['count']),(390,2))
        self.assertEqual(data['total_ml'],trend[-1]['total_ml'])
        self.assertEqual(sum(r['total_ml'] or 0 for r in trend),540)
        changed=self.payload(amount_ml=160,fed_at=stamp(start,8),version=1)
        earliest=next(r for r in self.server.store.export() if r['fed_at']==stamp(start,8))
        self.request('PUT','/api/records/'+earliest['id'],changed)
        self.assertEqual(self.server.store.list_day(end.isoformat())['trend'][0]['total_ml'],160)

    def test_backup_export_and_persistence(self):
        self.create(note='=HYPERLINK("bad")')
        status,raw,_=self.request('GET','/api/export.csv')
        self.assertEqual(status,200)
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))
        self.assertIn("'=HYPERLINK",raw.decode('utf-8-sig'))
        status,raw,_=self.request('GET','/api/backup')
        self.assertEqual(status,200)
        backup=Path(self.temp.name)/'download.sqlite3';backup.write_bytes(raw)
        with closing(sqlite3.connect(backup)) as c:
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(c.execute('SELECT sum(amount_ml) FROM records WHERE deleted=0').fetchone()[0],150)
        from server import Store
        self.assertEqual(len(Store(self.temp.name).export()),1)

    def test_shared_baby_name_skip_validation_conflict_and_backup(self):
        self.assertEqual(self.request('GET','/api/settings',auth=False)[0],401)
        self.assertEqual(self.request('PUT','/api/settings',dict(baby_name='小米',version=1),auth=False)[0],401)
        _,body,_=self.request('GET','/api/settings')
        self.assertEqual(body['data'],dict(baby_name='',setup_complete=False,version=1))
        for name in (None,123,'奶'*21,'小\n米'):
            self.assertEqual(self.request('PUT','/api/settings',dict(baby_name=name,version=1))[0],422)
        self.assertEqual(self.request('PUT','/api/settings',dict(baby_name='小米',version=1),headers={'Origin':'http://elsewhere.invalid'})[0],403)
        status,body,_=self.request('PUT','/api/settings',dict(baby_name='  小米  ',version=1))
        self.assertEqual(status,200);self.assertEqual(body['data'],dict(baby_name='小米',setup_complete=True,version=2))
        self.assertEqual(self.request('PUT','/api/settings',dict(baby_name='小豆',version=1))[0],409)
        from server import Store
        self.assertEqual(Store(self.temp.name).settings()['baby_name'],'小米')
        _,body,_=self.request('GET','/api/records')
        self.assertEqual(body['data']['settings']['baby_name'],'小米')
        backup=self.server.store.backup()
        with closing(sqlite3.connect(backup)) as c:
            self.assertEqual(c.execute('SELECT baby_name FROM settings').fetchone()[0],'小米')
        _,body,_=self.request('PUT','/api/settings',dict(baby_name='',version=2))
        self.assertEqual(body['data'],dict(baby_name='',setup_complete=True,version=3))


if __name__ == '__main__':
    unittest.main(verbosity=2)
