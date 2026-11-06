export const page = name => ({html: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}p{margin:0;height:28px}button{position:absolute;left:8px;top:40px;width:160px;height:40px}</style>
<p>Document ${name}</p><button onclick="advanceHistory()">Next history entry</button>
<script>
window.historyMode='hash';window.historyStep=0;
function reportHistory(){const state=history.state;NativeHost.postMessage(state && state.mode!=='hash' ? 'history:'+state.mode+':'+state.step : 'history:'+location.hash)}
function advanceHistory(){const step=++window.historyStep,mode=window.historyMode;const next=mode==='same'?location.href:mode==='path'?(step===1?'?step=one':'next?step=two'):(step===1?'#one':'#two');history.pushState({mode,step},'',next);reportHistory()}
window.addEventListener('message', e => window.NativeHost.postMessage('echo:'+e.data));
window.addEventListener('popstate', reportHistory);
(function ready(){if(window.NativeHost) NativeHost.postMessage('ready:${name}');else setTimeout(ready,10)})();
</script>`});
