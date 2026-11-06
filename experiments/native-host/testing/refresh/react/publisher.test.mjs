import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp, mkdir, readFile, writeFile, chmod, symlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const parent = path.join(root, 'build/refresh-publisher-tests');
await mkdir(parent, {recursive:true});
const mock = path.join(parent, 'mock-transport.mjs');
await writeFile(mock, `#!/usr/bin/env node
import {readFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const config=JSON.parse(readFileSync(process.argv[3],'utf8'));
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
emit({event:'ready',generation:7,revision:config.initialRevision,sequence:'1'});
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='quit')process.exit(0);
const result={status:'applied',generation:7,sequence:message.sequence,baseRevision:message.baseRevision,
targetRevision:message.targetRevision,appliedRevision:message.targetRevision,payloadSha256:message.payloadSha256,
phase:'mount-submitted',reloadRequired:false,message:''};
if(process.env.NH_REFRESH_MOCK_MODE==='wrong-identity')result.targetRevision='incorrect';
const delay=process.env.NH_REFRESH_MOCK_MODE==='hold'?10000:50;
setTimeout(()=>emit({event:'patch.terminal',result}),delay);
});
`);
await chmod(mock, 0o755);
async function fixture(mode, extraEnv = {}) {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  const application = path.join(directory, 'application'); await mkdir(application);
  const component = path.join(application,'Screen.jsx');
  await writeFile(component,'export default function Screen(){return "initial";}\n');
  const entry=path.join(directory,'entry.js');await writeFile(entry,'import Screen from "./application/Screen.jsx";globalThis.result=Screen();\n');
  const child=spawn(process.execPath,[path.join(root,'scripts/refresh-watch.mjs'),'--entry',entry,'--application-directory',application,'--transport',mock],
    {env:{...process.env,NH_REFRESH_MOCK_MODE:mode||'',...extraEnv},stdio:['pipe','pipe','pipe']});
  let stderr='';const messages=[],waiters=[];
  child.stderr.on('data',bytes=>stderr+=bytes);
  child.stdin.on('error',()=>{});
  createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);messages.push(value);for(const waiter of [...waiters])if(waiter.predicate(value)){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(value);}});
  const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  const wait=(event,after=0)=>{
    const found=messages.slice(after).find(value=>value.event===event);if(found)return Promise.resolve(found);
    return new Promise((resolve,reject)=>{const waiter={predicate:value=>value.event===event,resolve};waiter.timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error(`Publisher timeout: ${event}; ${stderr}; ${JSON.stringify(messages)}`));},10000);waiters.push(waiter);});
  };
  const initial=await wait('initial.ready');
  assert.equal(path.basename(path.dirname(initial.bundleFile)),initial.initialRevision);
  const session=JSON.parse(await readFile(initial.configFile,'utf8'));
  assert.deepEqual(Object.keys(session).sort(),['initialBundleSha256','initialRevision','port','schemaVersion','sessionId','token'].sort());
  const config=path.join(directory,'desktop.json');await writeFile(config,JSON.stringify({...session,host:'127.0.0.1',port:1}),{mode:0o600});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const connect=async()=>{send({method:'connect',config});await wait('connected');};
  const finish=async()=>{send({method:'quit'});const outcome=await exited;assert.equal(stderr,'');const report=JSON.parse(await readFile(path.join(path.dirname(initial.configFile),'report.json')));assert.ok(!JSON.stringify(messages).includes(session.token),'Control output must not contain token');return {outcome,report};};
  return {child,messages,initial,config,directory,component,send,connect,finish,wait,exited};
}

test('real compiler publisher orders immutable patches and survives a compiler error (mock transport only)', async()=>{
  const f=await fixture();try{
    await f.connect();await writeFile(f.component,'export default function Screen(){return "first";}\n');
    const sent=await f.wait('patch.sent');const cursor=f.messages.length;
    await writeFile(f.component,'export default function Screen(){return "second";}\n');
    await f.wait('patch.applied');
    while(f.messages.filter(value=>value.event==='patch.applied').length<2)await f.wait('patch.applied',f.messages.length);
    const sentValues=f.messages.filter(value=>value.event==='patch.sent');assert.equal(sentValues.length,2);
    assert.equal(sentValues[1].baseRevision,sent.targetRevision);assert.deepEqual(sentValues.map(x=>x.sequence),['1','2']);
    assert.match(await readFile(sent.payloadFile,'utf8'),/__nhApplyDevUpdate/);
    const errorCursor=f.messages.length;await writeFile(f.component,'export default function Screen( {');await f.wait('compiler.error',errorCursor);
    assert.equal(f.child.exitCode,null);const fixCursor=f.messages.length;await writeFile(f.component,'export default function Screen(){return "fixed";}\n');await f.wait('patch.applied',fixCursor);
    const {outcome,report}=await f.finish();assert.equal(outcome.code,0);assert.equal(report.status,'stopped');assert.equal(report.applied.length,3);assert.equal(report.compilerErrors.length,1);
  }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');}
});
test('source edit before connect cannot acknowledge a stale initial graph',async()=>{
  const f=await fixture();try{
    await writeFile(f.component,'export default function Screen(){return "preconnect";}\n');f.send({method:'connect',config:f.config});
    const outcome=await f.exited;assert.notEqual(outcome.code,0);assert.equal(f.messages.some(x=>x.event==='connected'),false);
    const report=JSON.parse(await readFile(path.join(path.dirname(f.initial.configFile),'report.json')));assert.match(JSON.stringify(report),/changed.*(initial|connection|connect)|graph changed/i);
  }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');}
});
test('mismatched terminal identity never advances the applied base',async()=>{
  const f=await fixture('wrong-identity');try{await f.connect();await writeFile(f.component,'export default function Screen(){return "changed";}\n');await f.wait('stopped');const outcome=await f.exited;assert.equal(outcome.code,1);
    const report=JSON.parse(await readFile(path.join(path.dirname(f.initial.configFile),'report.json')));assert.equal(report.status,'failed');assert.equal(report.applied.length,0);assert.match(JSON.stringify(report.errors),/identity mismatch/);
  }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');}
});
test('quit during delivery records cancellation requiring reload',async()=>{
  const f=await fixture('hold');try{await f.connect();await writeFile(f.component,'export default function Screen(){return "changed";}\n');await f.wait('patch.sent');const {outcome,report}=await f.finish();assert.equal(outcome.code,2);assert.equal(report.status,'cancelled-reload-required');assert.equal(report.applied.length,0);assert.equal(report.pendingPatches,1);
  }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');}
});
test('symlink, FIFO and oversized desktop config are rejected before transport starts',async()=>{
  for(const mode of ['symlink','fifo','oversized']){const f=await fixture();try{
    const invalid=path.join(f.directory,`${mode}.json`);if(mode==='symlink')await symlink(f.config,invalid);else if(mode==='fifo')execFileSync('mkfifo',['-m','600',invalid]);else await writeFile(invalid,' '.repeat(16385),{mode:0o600});
    f.send({method:'connect',config:invalid});const outcome=await f.exited;assert.equal(outcome.code,1);assert.equal(f.messages.some(x=>x.event==='connected'),false);
  }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');}}
});
test('EOF during a delayed patch write never sends after shutdown or reports clean completion',async()=>{
  const f=await fixture('',{NH_REFRESH_TEST_PREPARE_DELAY_MS:'250'});try{
    await f.connect();await writeFile(f.component,'export default function Screen(){return "changed";}\n');
    await f.wait('patch.preparing');f.child.stdin.end();
    const outcome=await f.exited;assert.equal(outcome.code,2);
    assert.equal(f.messages.some(value=>value.event==='patch.sent'),false);
    const report=JSON.parse(await readFile(path.join(path.dirname(f.initial.configFile),'report.json')));
    assert.equal(report.status,'cancelled');assert.equal(report.pendingPatches,1);assert.ok(report.cancellation.preparing);assert.equal(report.cancellation.inFlight,null);
  }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');}
});
