import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp, writeFile, access, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {startOwnedPublisher} from './publisher-process.mjs';

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'native-host-publisher-owner-'));
const marker = name => path.join(fixtureRoot, `${name}.marker`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = path.join(fixtureRoot, 'publisher.mjs');
await writeFile(fixture, `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
const [mode,marker]=process.argv.slice(2);
if(mode==='ignore'||mode==='early-exit'){
  const code="const fs=require('node:fs');process.on('SIGTERM',()=>{});setTimeout(()=>fs.writeFileSync(process.argv[1],'orphan wrote'),700);setInterval(()=>{},1000);";
  const child=spawn(process.execPath,['-e',code,marker],{stdio:['ignore',process.stdout,process.stderr]});
  process.on('SIGTERM',()=>{});console.log(JSON.stringify({ready:true,descendant:child.pid}));
  if(mode==='early-exit')setTimeout(()=>process.exit(7),30);
  setInterval(()=>{},1000);
}else{
  createInterface({input:process.stdin}).on('line',line=>{if(JSON.parse(line).method==='quit')process.exit(mode==='nonzero'?9:0);});
  console.log(JSON.stringify({ready:true}));
}
`);
function ready(child) {
  return new Promise((resolve, reject) => {
    const lines=createInterface({input:child.stdout});
    const timer=setTimeout(()=>{lines.close();reject(Error('Fixture ready timeout'));},3000);
    lines.once('line',line=>{clearTimeout(timer);lines.close();resolve(JSON.parse(line));});
  });
}
const options = {graceMs:80, termMs:80, killMs:300};

test('graceful quit requires actual close zero and removes signal handlers',async()=>{
  const before=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
  const owned=startOwnedPublisher([fixture,'graceful'],options);await ready(owned.child);
  assert.deepEqual(await owned.stop(),{code:0,signal:null});assert.deepEqual(await owned.closed,{code:0,signal:null});
  assert.deepEqual([process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')],before);
});
test('nonzero cleanup rejects and surfaces failure',async()=>{
  const errors=[];const owned=startOwnedPublisher([fixture,'nonzero'],{...options,onFailure:error=>errors.push(error)});await ready(owned.child);
  await assert.rejects(owned.stop(),/exited 9|closed 9/);assert.equal((await owned.closed).code,9);assert.equal(errors.length,1);
});
test('ignoring parent and inherited-pipe grandchild are killed within a bound',async()=>{
  const file=marker('ignored');const owned=startOwnedPublisher([fixture,'ignore',file],options);await ready(owned.child);
  const start=performance.now();await assert.rejects(owned.stop(),/graceful deadline/);assert.ok(performance.now()-start<1500);
  assert.ok((await owned.closed).signal);await pause(800);await assert.rejects(access(file),{code:'ENOENT'});
});
test('abnormal parent exit still kills the inherited-pipe descendant',async()=>{
  const file=marker('early');let observed;
  const owned=startOwnedPublisher([fixture,'early-exit',file],{...options,onFailure:error=>{observed=error;}});await ready(owned.child);
  await pause(60);const start=performance.now();await assert.rejects(owned.stop(),/exited 7/);assert.ok(performance.now()-start<1000);
  assert.ok(observed);await pause(800);await assert.rejects(access(file),{code:'ENOENT'});
});
test('a missing close notification rejects without leaving an unbounded await',async()=>{
  const owned=startOwnedPublisher([fixture,'graceful'],{...options,killMs:80});await ready(owned.child);
  const emit=owned.child.emit.bind(owned.child);
  owned.child.emit=(event,...args)=>event==='close'?false:emit(event,...args);
  const start=performance.now();await assert.rejects(owned.stop(),/graceful deadline/);assert.ok(performance.now()-start<1000);
});
test('harness SIGINT kills owned descendants and retains interrupt exit semantics',async()=>{
  const file=marker('interrupt');const outer=path.join(fixtureRoot,'outer.mjs');
  const moduleURL=pathToFileURL(fileURLToPath(new URL('./publisher-process.mjs',import.meta.url))).href;
  await writeFile(outer,`import {startOwnedPublisher} from ${JSON.stringify(moduleURL)};
const owned=startOwnedPublisher(${JSON.stringify([fixture,'ignore',file])});owned.child.stdout.pipe(process.stdout);owned.child.stderr.pipe(process.stderr);`);
  const child=spawn(process.execPath,[outer],{stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  await ready(child);child.kill('SIGINT');
  const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
  let result;try{result=await closed;}finally{clearTimeout(timer);}
  assert.equal(result.signal,'SIGINT');await pause(800);await assert.rejects(access(file),{code:'ENOENT'});
});

test.after(async()=>{await rm(fixtureRoot,{recursive:true,force:true});});
