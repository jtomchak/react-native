#!/usr/bin/env python3
"""Functional OS-observer preflight, intentionally not a benchmark runner."""
from pathlib import Path
import argparse,json,socket,subprocess,re
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--package',required=True,choices=['dev.nativehost.reference','dev.nativehost.experiment'])
parser.add_argument('--serial',required=True)
parser.add_argument('--config',type=Path,required=True)
parser.add_argument('--label',required=True)
parser.add_argument('--candidate-revision')
args=parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9_-]+',args.label):raise RuntimeError('Invalid evidence label')
if args.package=='dev.nativehost.experiment' and not re.fullmatch(r'[0-9]{1,96}',args.candidate_revision or ''):raise RuntimeError('Exact candidate revision required')
p=Path(__file__).resolve().parents[2]/'build/performance/android';p.mkdir(parents=True,exist_ok=True);cfg=json.loads(args.config.read_text());pkg=args.package;name='reference' if pkg.endswith('reference') else 'candidate';serial=args.serial;trace=[]
s=socket.create_connection(('127.0.0.1',cfg['port']));f=s.makefile('rwb');seq=0

def call(method,params={}):
 global seq
 seq+=1;f.write((json.dumps({'id':seq,'method':method,'params':params})+'\n').encode());f.flush();r=json.loads(f.readline())
 if method!='session.authenticate':trace.append({'method':method,'params':params,'response':r})
 if 'error' in r:raise RuntimeError(r['error'])
 return r['result']
def ui(method,**params):return call('ui.'+method,{'package':pkg,**params})
def wait(text):return ui('waitFor',selector={'text':text},timeoutMs=15000)
def tap(label):return ui('tap',selector={'label':label})
def snapshot():return ui('snapshot')['nodes']
def rows(nodes):return [n for n in nodes if re.fullmatch(r'perf-row-\d+',n.get('resourceID') or n.get('label') or '')]
def visible_rows(nodes):return [n['text'] for n in nodes if n['visible'] and re.fullmatch(r'Row \d+: \d+',n['text'])]
try:
 call('session.authenticate',{'token':cfg['token']});wait('Revision: baseline-000');wait('Count: 0; order: forward');wait('Rows: 100');initial=snapshot();assert len(rows(initial))==100,(name,'rowcount',len(rows(initial)))
 tap('Update');wait('Count: 1; order: forward');wait('Row 0: 1')
 ui('type',selector={'label':'Performance input'},text='Native',clear=True);wait('Input: Native');ui('dismissKeyboard')
 tap('Reorder');wait('Count: 1; order: reverse');wait('Row 99: 1');before=visible_rows(snapshot());ui('scroll',selector={'testID':'perf-scroll'},direction='down');after=visible_rows(snapshot());assert before!=after,(name,'scroll did not change visible rows',before,after)
 tap('Unmount');wait('Rows: 0');assert len(rows(snapshot()))==0
 tap('Mount');wait('Rows: 100');wait('Row 99: 1');remounted=snapshot();assert len(rows(remounted))==100
 observer_before=subprocess.check_output(['adb','-s',serial,'shell','pidof','dev.nativehost.observer'],text=True).strip()
 subprocess.run(['adb','-s',serial,'shell','am','force-stop',pkg],check=True,stdout=subprocess.DEVNULL)
 call('session.describe');observer_after=subprocess.check_output(['adb','-s',serial,'shell','pidof','dev.nativehost.observer'],text=True).strip();assert observer_before==observer_after
 if name=='reference':command=['adb','-s',serial,'shell','am','start','-n',pkg+'/com.facebook.react.uiapp.RNTesterActivity','--es','route','NativeHostPerformance']
 else:command=['adb','-s',serial,'shell','am','start','-n',pkg+'/dev.nativehost.HostActivity','--es','devRevision',args.candidate_revision]
 subprocess.run(command,check=True,stdout=subprocess.DEVNULL);wait('Revision: baseline-000');wait('Count: 0; order: forward')
 report={'passed':True,'package':pkg,'kind':'physical-functional-preflight-not-benchmark','initialRows':len(rows(initial)),'remountedRows':len(rows(remounted)),'beforeScrollVisibleRows':before,'afterScrollVisibleRows':after,'observerPidBeforeTargetStop':observer_before,'observerPidAfterTargetStop':observer_after,'trace':trace};(p/f'{name}-{args.label}-functional-preflight.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='trace'}))
except Exception as e:
 (p/f'{name}-{args.label}-functional-preflight-failed.json').write_text(json.dumps({'error':str(e),'trace':trace},indent=2));raise
finally:f.close();s.close()
