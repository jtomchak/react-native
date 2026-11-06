import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile, copyFile, chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeDevEngine} from '../../../scripts/dev-engine.mjs';
import {buildNativeRefreshBootstrap, nativeRefreshTransform} from '../../../scripts/refresh-transform.mjs';
import {Host, nodeByID, textOf} from '../../host.mjs';
import {screenSource} from './fixtures.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(root, 'build/refresh', `react-${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(directory, {recursive:true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {schemaVersion:1, status:'running', directory, checks:[], errors:[], artifacts:[], ignoredEvents:[]};
const save = async (name, bytes) => {await writeFile(path.join(directory,name), bytes);report.artifacts.push({name,sha256:hash(bytes)});};
class Queue {
  values=[]; waiting=[];
  put(value){const waiter=this.waiting.shift();waiter?waiter(value):this.values.push(value);}
  async take(){if(this.values.length)return this.values.shift();let timer,fn;try{return await new Promise((resolve,reject)=>{fn=resolve;this.waiting.push(fn);timer=setTimeout(()=>reject(Error('Compiler event timeout')),15000);});}finally{clearTimeout(timer);this.waiting=this.waiting.filter(x=>x!==fn);}}
}
const renderer = path.join(root,'js/renderer.js');
globalThis.__refreshFixtureRenderer = renderer;
let engine, host, caseNumber=0, sequenceOffset=0;
const outputs=new Queue(),updates=new Queue();
const project=path.join(directory,'project'), app=path.join(project,'application');
async function event(queue=updates){for(let i=0;i<20;i++){const value=await queue.take();if(value instanceof Error)return value;if(value.updates.some(x=>x.clientId==='react-gate'&&x.update.type!=='Noop'))return value;report.ignoredEvents.push(value);}throw Error('Too many irrelevant events');}
async function edit(file,source,{status='applied'}={}){
  await engine.ensureCurrentBuildFinish();await writeFile(path.join(app,file),source);
  const value=await event();if(value instanceof Error)throw value;
  const update=value.updates.find(x=>x.clientId==='react-gate').update;
  assert.equal(update.type,'Patch');
  const prefix=String(++caseNumber).padStart(2,'0');
  await save(`${prefix}.json`,JSON.stringify(value,null,2));await save(`${prefix}.js`,update.code);await save(`${prefix}.map`,update.sourcemap);
  const metadata={schemaVersion:1,sequence:update.seq+sequenceOffset,changedIds:update.changedIds};
  const result=await host.call('runtime.eval',{source:`${update.code}\nglobalThis.__nhApplyDevUpdate(${JSON.stringify(metadata)});`});
  await engine.notifyPayloadDelivered(update.filename);
  assert.equal(result.status,status,JSON.stringify(result));
  return {result,update};
}
const snapshot=()=>host.call('ui.snapshot');
const evaluate=source=>host.call('runtime.eval',{source});
async function checkState({count,input,label,same=true}){
  const tree=await snapshot();
  if(count!==undefined)assert.equal(textOf(nodeByID(tree,'count')),String(count));
  if(input!==undefined)assert.equal(nodeByID(tree,'input').props.value,input);
  if(label!==undefined)assert.equal(textOf(nodeByID(tree,'label')),label);
  const identity=await evaluate(`({marker:__testMarker===__originalMarker,node:__testInputRef===__originalNode,
    renderer:__nhFlushMount===__originalFlush,react:__testScreenReact===__originalReact,
    services:__nhServiceEvent===__originalServiceHandler,state:__nhDevRefreshState()})`);
  assert.equal(identity.marker,same);assert.equal(identity.node,same);
  assert.equal(identity.renderer,true);assert.equal(identity.react,true);assert.equal(identity.services,true);
  assert.equal(identity.state.renderers,1);assert.equal(identity.state.mountedRoots,1);
  return {tree,identity};
}
try{
  await mkdir(app,{recursive:true});
  const binary=path.join(directory,'native-host');await copyFile(process.env.NH_HOST_BINARY||path.join(root,'build/headless/native-host'),binary);await chmod(binary,0o755);
  process.env.NH_HOST_BINARY=binary;report.binarySha256Before=hash(await readFile(binary));
  report.sources={};
  for(const name of ['js/dev/refresh-client.js','js/dev/renderer-bootstrap.js','scripts/refresh-transform.mjs','scripts/dev-engine.mjs','testing/refresh/react/fixtures.mjs','testing/refresh/react/run.mjs'])report.sources[name]=hash(await readFile(path.join(root,name)));
  report.versions={};for(const name of ['react','react-reconciler','react-refresh','rolldown'])report.versions[name]=JSON.parse(await readFile(path.join(root,'node_modules',name,'package.json'))).version;
  await writeFile(path.join(app,'Screen.jsx'),screenSource());
  await writeFile(path.join(app,'value.js'),'export const suffix="one";\n');
  await writeFile(path.join(app,'extra.js'),'export const extra="extra";\n');
  await writeFile(path.join(app,'legacy.cjs'),'module.exports={suffix:"cjs"};\n');
  const childSource=label=>`import React,{useState} from 'react';import {Pressable,Text} from ${JSON.stringify(renderer)};
export default function Screen(){const [count,setCount]=useState(100);return <Pressable testID="child" onPress={()=>setCount(value=>value+1)}><Text testID="child-count">{count}</Text><Text testID="child-label">${label}</Text></Pressable>;}`;
  await writeFile(path.join(app,'Child.jsx'),childSource('first'));
  const entry=`import React from 'react';import * as Native from ${JSON.stringify(renderer)};
import * as Services from ${JSON.stringify(path.join(root,'js/services.js'))};
import {attachRefreshRenderer} from ${JSON.stringify(path.join(root,'js/dev/renderer-bootstrap.js'))};
import Screen from './application/Screen.jsx';
globalThis.__testEffects=[];attachRefreshRenderer(Native.reconciler);
globalThis.__originalReact=React;globalThis.__originalFlush=globalThis.__nhFlushMount;globalThis.__originalServiceHandler=globalThis.__nhServiceEvent;
globalThis.__testServices=Services;
globalThis.__nhDispatch=(method,params)=>method==='app.event'?Native.dispatchEvent(params):Native.snapshot();
Native.render(React.createElement(Screen));`;
  await writeFile(path.join(project,'entry.js'),entry);
  const runtime=await buildNativeRefreshBootstrap({clientId:'react-gate'});await save('refresh-bootstrap.js',runtime);
  engine=await createNativeDevEngine({root:project,entry:path.join(project,'entry.js'),runtime,
    transform:{define:{'process.env.NODE_ENV':'"development"',__NH_TEST_HOOKS__:'true'}},
    plugins:[nativeRefreshTransform({root:project})],onOutput:value=>outputs.put(value),onHmrUpdates:value=>updates.put(value)});
  await engine.run();const initial=await outputs.take();if(initial instanceof Error)throw initial;
  const code=initial.output.find(x=>x.type==='chunk').code;await save('initial.js',code);
  host=new Host({bundle:path.join(directory,'initial.js')});report.runtime=await host.call('session.describe');
  await evaluate('globalThis.__originalMarker=__testMarker;globalThis.__originalNode=__testInputRef;undefined');
  await engine.registerClient('react-gate');
  const first=await snapshot();
  await host.call('app.event',{nodeId:nodeByID(first,'button').id,event:'press'});
  await host.call('app.event',{nodeId:nodeByID(first,'input').id,event:'changeText',payload:{text:'edited',eventCount:1}});
  await checkState({count:1,input:'edited',label:'initial:one'});
  await evaluate(`globalThis.__testEchoResult=null;__testServices.echo('across-refresh',50).promise.then(value=>globalThis.__testEchoResult=value);
globalThis.__testMessages=[];globalThis.__testSubscription=__testServices.subscribe(value=>__testMessages.push(value));undefined`);
  assert.equal((await evaluate('__testServices.serviceStatus()')).pending,1);
  report.checks.push({name:'seeded-real-reconciler-state'});
  await edit('Screen.jsx',screenSource({label:'body',step:10}));
  await checkState({count:1,input:'edited',label:'body:one'});
  assert.deepEqual(await evaluate('__testEffects'),['setup:initial','cleanup:initial','setup:body']);
  const body=await snapshot();await host.call('app.event',{nodeId:nodeByID(body,'button').id,event:'press'});
  await checkState({count:11,input:'edited'});report.checks.push({name:'component-body-handler-effects-state-ref-node-preserved'});
  await host.wait('runtime.eval',{source:'globalThis.__testEchoResult'},value=>value==='across-refresh');
  await evaluate('__testSubscription.publish("after-refresh");undefined');
  await host.wait('runtime.eval',{source:'globalThis.__testMessages'},value=>value.includes('after-refresh'));
  await evaluate('__testSubscription.unsubscribe();undefined');
  assert.equal((await evaluate('__testServices.serviceStatus()')).pending,0);
  report.checks.push({name:'pending-service-and-subscription-survive-refresh'});
  await edit('value.js','export const suffix="two";\n');await checkState({count:11,input:'edited',label:'body:two'});report.checks.push({name:'noncomponent-dependency-propagates-to-boundary'});
  await edit('Screen.jsx',screenSource({label:'add',step:10,imports:'import {suffix} from "./value.js";import {extra} from "./extra.js";',suffix:'suffix+extra'}));
  await checkState({count:11,input:'edited',label:'add:twoextra'});report.checks.push({name:'dependency-added'});
  await edit('Screen.jsx',screenSource({label:'remove',step:10,imports:'import {extra} from "./extra.js";',suffix:'extra'}));
  await checkState({count:11,input:'edited',label:'remove:extra'});report.checks.push({name:'dependency-removed'});
  await edit('Screen.jsx',screenSource({label:'cjs',step:10,imports:'import legacy from "./legacy.cjs";',suffix:'legacy.suffix'}));
  await checkState({count:11,input:'edited',label:'cjs:cjs'});
  await edit('legacy.cjs','module.exports={suffix:"updated"};\n');await checkState({count:11,input:'edited',label:'cjs:updated'});report.checks.push({name:'commonjs-add-and-update'});
  await edit('Screen.jsx',screenSource({label:'nested',step:10,imports:'import {suffix} from "./value.js";import Child from "./Child.jsx";',children:'<Child />'}));
  const nested=await snapshot();await host.call('app.event',{nodeId:nodeByID(nested,'child').id,event:'press'});
  const beforeChildEffects=await evaluate('__testEffects.length');
  await edit('Child.jsx',childSource('second'));
  await checkState({count:11,input:'edited',label:'nested:two'});
  const afterChild=await snapshot();assert.equal(textOf(nodeByID(afterChild,'child-count')),'101');assert.equal(textOf(nodeByID(afterChild,'child-label')),'second');
  assert.equal(nodeByID(afterChild,'child').id,nodeByID(nested,'child').id);
  assert.equal(await evaluate('__testEffects.length'),beforeChildEffects);
  report.checks.push({name:'nested-factory-same-local-component-name-independent-families'});
  await engine.ensureCurrentBuildFinish();await writeFile(path.join(app,'Screen.jsx'),'export default function Screen( {');
  const syntaxError=await event();assert.ok(syntaxError instanceof Error);report.syntaxError=String(syntaxError);
  await checkState({count:11,input:'edited',label:'nested:two'});
  sequenceOffset++;
  await edit('Screen.jsx',screenSource({label:'fixed',step:10}));await checkState({count:11,input:'edited',label:'fixed:two'});report.checks.push({name:'syntax-error-and-fix-preserve-state'});
  report.checks.push({name:'native-attempt-sequence-gap-accepted-after-compile-failure'});
  await edit('Screen.jsx',screenSource({label:'hook',extraHook:true}));await checkState({count:0,input:'seed',label:'hook:two',same:false});report.checks.push({name:'hook-signature-change-remounts'});
  const mixed=await edit('Screen.jsx',screenSource({label:'mixed',extraHook:true,mixed:true}),{status:'reload-required'});
  assert.match(mixed.result.reason,/boundary exports changed/);report.checks.push({name:'mixed-export-boundary-explicit-reload',result:mixed.result});
  const poisoned=await evaluate('__nhApplyDevUpdate({schemaVersion:1,sequence:999,changedIds:["application/Screen.jsx"]})');assert.equal(poisoned.status,'reload-required');
  report.checks.push({name:'poisoned-session-requires-reload'});
  assert.deepEqual((await host.call('runtime.pump')).errors,[]);
  await host.stop();host=null;await engine.close();engine=null;
  // Independent sessions: a rejected update must never be recycled into an
  // apparently clean success by resetting only a JavaScript flag.
  for(const mode of ['entry-boundary','initialization-error','stale-sequence','unknown-id']){
    const isolated=path.join(directory,mode),application=path.join(isolated,'application');await mkdir(application,{recursive:true});
    await writeFile(path.join(application,'Screen.jsx'),screenSource());await writeFile(path.join(application,'value.js'),'export const suffix="one";\n');
    await writeFile(path.join(application,'metadata.js'),'export const metadata="original";\n');
    await writeFile(path.join(isolated,'entry.js'),`${entry}\nimport {metadata} from './application/metadata.js';globalThis.__staticMetadata=metadata;`);
    const boot=new Queue(),changed=new Queue();
    engine=await createNativeDevEngine({root:isolated,entry:path.join(isolated,'entry.js'),runtime,
      transform:{define:{'process.env.NODE_ENV':'"development"',__NH_TEST_HOOKS__:'true'}},plugins:[nativeRefreshTransform({root:isolated})],onOutput:value=>boot.put(value),onHmrUpdates:value=>changed.put(value)});
    await engine.run();const built=await boot.take();if(built instanceof Error)throw built;
    const filename=path.join(isolated,'initial.js');await writeFile(filename,built.output.find(x=>x.type==='chunk').code);
    host=new Host({bundle:filename});await host.call('session.describe');await engine.registerClient('react-gate');await engine.ensureCurrentBuildFinish();
    if(mode==='stale-sequence'){
      await writeFile(path.join(application,'value.js'),'export const suffix="changed";\n');
      const value=await event(changed);if(value instanceof Error)throw value;const patch=value.updates.find(x=>x.clientId==='react-gate').update;
      assert.equal(patch.type,'Patch');await save('stale-sequence-valid-predecessor.json',JSON.stringify(patch,null,2));
      const firstApply=await evaluate(`${patch.code}\n__nhApplyDevUpdate(${JSON.stringify({schemaVersion:1,sequence:20,changedIds:patch.changedIds})})`);assert.equal(firstApply.status,'applied');
      const stale=await evaluate(`__nhApplyDevUpdate(${JSON.stringify({schemaVersion:1,sequence:19,changedIds:patch.changedIds})})`);assert.equal(stale.status,'error');report.checks.push({name:'stale-sequence-rejected',result:stale});
    }else if(mode==='unknown-id'){
      const unknown=await evaluate('__nhApplyDevUpdate({schemaVersion:1,sequence:1,changedIds:["application/absent.js"]})');
      assert.equal(unknown.status,'reload-required');assert.match(unknown.reason,/Unknown changed module/);report.checks.push({name:'unknown-changed-id-rejected',result:unknown});
    }else{
      await writeFile(path.join(application,mode==='entry-boundary'?'metadata.js':'Screen.jsx'),mode==='entry-boundary'?'export const metadata="changed";\n':`globalThis.__sideEffectBeforeError=true;throw new Error('module-initialization-failure');\n${screenSource()}`);
      const delivery=await event(changed);if(delivery instanceof Error)throw delivery;
      const patch=delivery.updates.find(x=>x.clientId==='react-gate').update;assert.equal(patch.type,'Patch');await save(`${mode}.json`,JSON.stringify(patch,null,2));
      const outcome=await evaluate(`${patch.code}\n__nhApplyDevUpdate(${JSON.stringify({schemaVersion:1,sequence:patch.seq,changedIds:patch.changedIds})})`);
      assert.equal(outcome.status,mode==='entry-boundary'?'reload-required':'error');
      if(mode==='entry-boundary'){assert.match(outcome.reason,/Permanent bootstrap reached/);assert.equal(await evaluate('__staticMetadata'),'original');}
      else {assert.match(outcome.reason,/module-initialization-failure/);assert.equal(await evaluate('__sideEffectBeforeError'),true);}
      assert.equal(textOf(nodeByID(await snapshot(),'label')),'initial:one');
      report.checks.push({name:mode,result:outcome});
    }
    await host.stop();host=null;await engine.close();engine=null;
  }
  report.binarySha256After=hash(await readFile(binary));assert.equal(report.binarySha256Before,report.binarySha256After);
  report.status='passed';
}catch(error){report.status='failed';report.errors.push({message:String(error),stack:error.stack});process.exitCode=1;}
finally{
  const cleanup=await Promise.allSettled([Promise.resolve().then(()=>host?.stop()),Promise.resolve().then(()=>engine?.close())]);
  cleanup.forEach((result,index)=>{if(result.status==='rejected'){report.errors.push({phase:index?'compiler-cleanup':'host-cleanup',message:String(result.reason)});report.status='failed';process.exitCode=1;}});
  report.hostStderr=host?.stderr;report.finishedAt=new Date().toISOString();
  await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,report:path.join(directory,'report.json'),errors:report.errors}));
}
