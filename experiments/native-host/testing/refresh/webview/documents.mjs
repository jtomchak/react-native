// Browser state is created by the real document, never fabricated by the host.
export const documentSource = name => ({html: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;height:700px}input{width:150px}#bottom{margin-top:500px}</style>
<p>Browser ${name}</p><input id="value" value="seed"><p id="bottom">Browser bottom</p>
<script>
window.documentNonce=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
window.browserCount=0;window.browserError=null;
function report(request){NativeHost.postMessage(JSON.stringify({name:'${name}',request,nonce:documentNonce,count:browserCount,
 value:document.getElementById('value').value,scrollY:Math.round(scrollY),historyLength:history.length,
 historyStep:history.state&&history.state.step||0,hash:location.hash,error:browserError}));}
addEventListener('message',function(event){try{const command=JSON.parse(event.data);
 if(command.op==='seed'){browserCount++;document.getElementById('value').value='browser-${name}-'+browserCount;
  history.pushState({step:browserCount},'','#state-'+browserCount);scrollTo(0,120);}
 requestAnimationFrame(function(){report(command.request)});
 }catch(error){browserError=String(error);report(-1);}});
(function ready(){if(window.NativeHost)report(0);else setTimeout(ready,10)})();
</script>`});

export const sources = {A: documentSource('A'), B: documentSource('B')};
