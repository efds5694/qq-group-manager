import csv
import io
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app import api
from app.core import fields
from app.core.errors import AppError
from app.server import Request
from app.services import collection, comparison, groups, members, query, rename, results


def request(body=None, query_args=None):
    return Request('POST','/',query_args or {},body or {},{})


def person(qq, card='', **extra):
    return members.normalize({'user_id':str(qq),'nickname':f'昵称{qq}','card':card,'role':'member','level':'10',
                              'join_time':0,'last_sent_time':0,'title':'',**extra})


class ResultStoreTests(unittest.TestCase):
    def setUp(self):
        self.store=results.ResultStore()
        self.owner=('connection-a','99')
        self.result={'entity':'memberships','items':[{'id':str(i),'values':{'member.qq':str(i)},'display':{'member.qq':str(i)},'bucket':'A' if i<220 else 'B'} for i in range(450)],
                     'total':450,'columns':['member.qq'],'fields':fields.FIELDS,'buckets':{'A':220,'B':230}}

    def test_windows_can_jump_to_end_and_keep_group_rows(self):
        first=self.store.create(self.owner,self.result,{})
        self.assertEqual(first['total'],450)
        self.assertEqual(first['total_rows'],452)
        self.assertEqual(first['items'][0]['kind'],'group')
        last=self.store.window(self.owner,first['query_id'],400,200)
        self.assertEqual(last['items'][-1]['id'],'449')
        self.assertEqual(last['items'][-1]['position'],450)
        self.assertEqual(len(last['items']),52)
        self.assertEqual(last['query_id'],first['query_id'])

    def test_results_are_frozen_and_connection_and_account_isolated(self):
        first=self.store.create(self.owner,self.result,{'search':'原条件'})
        self.result['items'][0]['display']['member.qq']='已改变'
        entry=self.store.get(self.owner,first['query_id'])
        self.assertEqual(entry['result']['items'][0]['display']['member.qq'],'0')
        self.assertNotIn('entries',entry)
        for other in [('connection-b','99'),('connection-a','100')]:
            with self.assertRaises(AppError) as error:self.store.get(other,first['query_id'])
            self.assertEqual(error.exception.code,'QUERY_EXPIRED')

    def test_selection_returns_all_filtered_ids_without_bucket_headers_or_window_limit(self):
        first=self.store.create(self.owner,self.result,{})
        ids=self.store.selection(self.owner,first['query_id'])['ids']
        self.assertEqual(ids,[str(i) for i in range(450)])
        self.assertNotIn('bucket:0',ids)
        self.assertEqual(len(first['items']),200)
        with self.assertRaises(AppError):
            self.store.selection(('other-account','99'),first['query_id'])

    def test_idle_expiry_and_lru_are_bounded(self):
        with patch('app.services.results.time.time',return_value=100):
            first=self.store.create(self.owner,self.result,{})
        with patch('app.services.results.time.time',return_value=100+results.IDLE_SECONDS):
            with self.assertRaises(AppError):self.store.get(self.owner,first['query_id'])
        with patch.object(results,'MAX_RESULTS',2):
            a=self.store.create(self.owner,self.result,{})
            b=self.store.create(self.owner,self.result,{})
            self.store.get(self.owner,a['query_id'])
            self.store.create(self.owner,self.result,{})
            with self.assertRaises(AppError):self.store.get(self.owner,b['query_id'])
            self.assertEqual(len(self.store._items),2)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.client=SimpleNamespace(cache_namespace='report-tests')
        self.listing=[{'group_id':gid,'group_name':name,'my_role':'owner','manageable':True} for gid,name in [('10','【师生】26级'),('11','【师生】25级'),('20','【活动】观众'),('21','【活动】志愿者')]]
        self.entries={gid:{'group_id':gid,'fetched_at':time.time(),'members':rows} for gid,rows in {
            '10':[person('1','26级-张三'),person('2','李四')],
            '11':[person('1','张三'),person('4','王五')],
            '20':[person('1','旧昵称'),person('3','赵六')],
            '21':[person('2','李四')],
        }.items()}
        mocks=[patch.object(groups,'list_groups',return_value=self.listing),patch.object(collection,'load',return_value={}),
               patch.object(members,'fetch_many',side_effect=lambda client,ids,force=False:({gid:self.entries[gid] for gid in ids},{})),
               patch.object(api,'_session',return_value={'login':{'user_id':'99'}}),patch.object(api,'_active_client',return_value=(self.client,{})),
               patch.object(results,'STORE',results.ResultStore())]
        for mock in mocks:mock.start();self.addCleanup(mock.stop)

    def spec(self,**changes):
        return {'source_group_ids':['10','11'],'target_group_ids':['20','21'],'status':'all',**changes}

    def test_roster_selection_projects_one_qq_into_each_membership_and_exports_only_those_rows(self):
        base = {'scope': {'group_ids': ['10', '11']}, 'roster_qqs': ['1'], 'project_selection': ['1'],
                'fields': ['member.qq', 'group.group_id']}
        people = api.api_query_start(request({**base, 'entity': 'people'}))
        self.assertEqual(people['projected_selection'], ['1'])
        detail = api.api_query_start(request({**base, 'entity': 'memberships'}))
        self.assertEqual(set(detail['projected_selection']), {'10:1', '11:1'})
        self.assertEqual(detail['total'], 2)
        exported = api.api_query_export(request({'query_id': detail['query_id'], 'selected': ['11:1']}))
        values = list(csv.reader(io.StringIO(exported.body.decode('utf-8-sig'))))
        self.assertEqual(values[1:], [['1', '11']])

    def test_comparison_merges_sources_and_reports_each_target(self):
        data=api.api_members_compare(request(self.spec()))
        summary={group['group_id']:group for group in data['summaries']}
        self.assertEqual(data['expected'],3)
        self.assertEqual((summary['20']['missing'],summary['20']['outside'],summary['20']['common']),(2,1,1))
        self.assertEqual((summary['21']['missing'],summary['21']['outside'],summary['21']['common']),(2,0,1))
        statuses={row['qq']:row['values']['comparison.status'] for row in data['items']}
        self.assertEqual(statuses,{'1':'common','2':'missing','3':'outside','4':'missing'})
        missing=next(row for row in data['items'] if row['qq']=='2')
        self.assertEqual(missing['display']['member.card'],'未加入')
        self.assertEqual(missing['detail_group_id'],'10')
        common=next(row for row in data['items'] if row['qq']=='1')
        self.assertEqual(common['source_group_ids'],['10','11'])
        self.assertEqual(common['values']['comparison.source_groups'],['【师生】26级','【师生】25级'])

    def test_source_filter_runs_before_dedup_and_target_members_stay_complete(self):
        data=api.api_members_compare(request(self.spec(source_filter={'field':'member.card','op':'regex','value':'^26级'})))
        self.assertEqual(data['expected'],1)
        self.assertEqual(data['summaries'][0]['outside'],1)
        first=next(row for row in data['items'] if row['qq']=='1')
        self.assertEqual(first['display']['comparison.source_card'],'26级-张三')
        self.assertEqual(first['source_group_ids'],['10'])
        self.assertEqual(first['values']['comparison.source_groups'],['【师生】26级'])

    def test_status_active_target_search_and_export_use_same_complete_results(self):
        data=api.api_members_compare(request(self.spec(target_group_id='21',status='missing',search='昵称4')))
        self.assertEqual([row['qq'] for row in data['items']],['4'])
        exported=api.api_query_export(request({'query_id':data['query_id'],'format':'csv'}))
        rows=list(csv.reader(io.StringIO(exported.body.decode('utf-8-sig'))))
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[1][0],'4')
        empty=api.api_query_export(request({'query_id':data['query_id'],'selected':['21:2'],'format':'csv'}))
        self.assertEqual(len(list(csv.reader(io.StringIO(empty.body.decode('utf-8-sig'))))),1)

    def test_self_comparison_is_read_only_and_read_failure_is_not_absence(self):
        data=api.api_members_compare(request(self.spec(target_group_ids=['10'])))
        self.assertEqual(data['summaries'][0]['common'],2)
        with patch.object(members,'fetch_many',return_value=({}, {'20':'读取失败'})):
            with self.assertRaises(AppError):api.api_members_compare(request(self.spec()))

    def test_rename_shows_chosen_source_and_priority_conflicts(self):
        spec={'entity':'memberships','scope':{'group_ids':['20'],'source_group_ids':['10','11']},'selected':['20:1']}
        dataset=query.prepare(self.client,'99',spec)
        plan=rename.preview(dataset,{'query':spec,'options':{'method':'sync','template':'{result}'}},'99')
        item=plan['items'][0]
        self.assertEqual(item['source_group_name'],'【师生】26级')
        self.assertEqual(item['source_text'],'26级-张三')
        self.assertTrue(item['source_conflict'])
        self.assertEqual(item['new_card'],'26级-张三')
        self.assertEqual(len(item['source_values']),2)

    def test_selected_source_field_controls_conflicts_and_reference_text(self):
        spec={'entity':'people','scope':{'group_ids':['20'],'source_group_ids':['10','11']},'source_field':'member.nickname'}
        result=query.execute(query.prepare(self.client,'99',spec),spec)
        row=next(row for row in result['items'] if row['qq']=='1')
        self.assertEqual(row['person']['reference_text'],'昵称1')
        self.assertFalse(row['person']['source_conflict'])

    def test_data_time_and_stale_state_include_sources_outside_visible_scope(self):
        self.entries['10']['fetched_at']=100
        self.entries['10']['stale']=True
        spec={'entity':'memberships','scope':{'group_ids':['20'],'source_group_ids':['10','11']}}
        data=api.api_query_start(request(spec))
        self.assertEqual(data['data_at'],100)
        self.assertTrue(data['stale'])
        comparison_data=api.api_members_compare(request(self.spec()))
        self.assertEqual(comparison_data['data_at'],100)
        self.assertTrue(comparison_data['stale'])

    def test_large_result_window_does_not_prepare_or_query_again(self):
        base=[person(i,f'成员{i}') for i in range(500)]
        self.listing[:]=[{'group_id':str(gid),'group_name':f'群{gid}','my_role':'admin','manageable':True} for gid in range(100)]
        self.entries.clear();self.entries.update({str(gid):{'group_id':str(gid),'fetched_at':time.time(),'members':base} for gid in range(100)})
        spec={'entity':'memberships','scope':{'group_ids':list(self.entries)},'fields':['member.qq','member.card']}
        with patch.object(query,'prepare',wraps=query.prepare) as prepare,patch.object(query,'execute',wraps=query.execute) as execute:
            started=time.perf_counter();first=api.api_query_start(request(spec));created=time.perf_counter()
            last=api.api_result_window(request(query_args={'offset':['49800'],'limit':['200']}),first['query_id'])
            self.assertEqual(first['total'],50000)
            self.assertEqual(len(last['items']),200)
            self.assertEqual(prepare.call_count,1)
            self.assertEqual(execute.call_count,1)
            self.assertEqual(len(results.STORE.get(api._result_owner(),first['query_id'])['result']['groups']),100)
            print(f'  100 groups / 50000 records: create {created-started:.3f}s, end window {time.perf_counter()-created:.3f}s')
