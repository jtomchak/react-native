package dev.spahost.prototype

import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.UUID

/** Actual packaged WebView + native services, without a mock transport. */
class HostInstrumentation : Instrumentation() {
    private lateinit var host: HostActivity
    private var assertions = 0
    private var arguments = Bundle()
    override fun onCreate(arguments: Bundle?) { this.arguments = arguments ?: Bundle(); super.onCreate(arguments); start() }
    override fun onStart() {
        val selectedMode = arguments.getString("mode")
        val entryPoint = GeneratedPluginTestRegistry.modes[selectedMode]
        if (entryPoint != null) {
            try {
                val type = Class.forName(entryPoint)
                val suite = type.getDeclaredConstructor(HostInstrumentation::class.java, Bundle::class.java).apply { isAccessible = true }.newInstance(this, arguments)
                type.getDeclaredMethod("run").apply { isAccessible = true }.invoke(suite)
            } catch (error: Throwable) { finish(1, Bundle().apply { putString("status", "failed"); putString("error", error.toString()) }) }
            return
        }
        if (selectedMode != null && selectedMode !in setOf("analytics", "extensions", "verify-persistence", "plugins")) {
            finish(1, Bundle().apply { putString("status", "unsupported"); putString("error", "Requested integration suite is not installed") }); return
        }
        if (arguments.getString("mode") == "analytics") { AnalyticsSuite(this, arguments).run(); return }
        if (arguments.getString("mode") == "extensions") { ExtensionSuite(this, arguments).run(); return }
        val report = Bundle()
        try {
            host = startActivitySync(Intent(targetContext, HostActivity::class.java).setData(android.net.Uri.parse("spahost://app/")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as HostActivity
            runOnMainSync { host.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            waitFor("native document load", 40) { host.browserReady }
            waitFor("injected SDK and hydrated Next document", 40) { js("typeof window.platform === 'object' && document.readyState === 'complete'") == true }
            check("real transport handshake", action("const r=await platform.ready();return r.platform") == "android")
            if (selectedMode == "plugins") {
                check("generic plugin action identifiers permit underscores", PluginRuntime.validIdentifier("secure_storage.status") && PluginRuntime.validIdentifier("secure_storage.changed"))
                val runtime = (targetContext.applicationContext as HostApplication).plugins
                val expected = arguments.getString("expectedPlugins")?.toIntOrNull() ?: runtime.instances.size
                check("generated plugin selection matches runtime count", runtime.instances.size == expected)
                val declared = runtime.actions.keys
                check("selected plugin capabilities advertised", action("const names=(await platform.ready()).capabilities;return ${org.json.JSONArray(declared).toString()}.every(name=>names.includes(name))") == true)
                arguments.getString("absentAction")?.let { name ->
                    check("removed plugin action not advertised", action("return !(await platform.ready()).capabilities.includes(${JSONObject.quote(name)})") == true)
                    check("removed plugin action rejected by native dispatcher", action("try{await platform.call(${JSONObject.quote(name)},{});return 'bad'}catch(e){return e.code}") == "UNSUPPORTED")
                }
                check("core native storage works without optional plugins", action("await platform.storage.set('plugin-core-checkpoint','native');const value=await platform.storage.get('plugin-core-checkpoint');await platform.storage.remove('plugin-core-checkpoint');return value==='native'") == true)
                report.putString("status", "passed"); report.putInt("assertions", assertions); report.putInt("plugins", runtime.instances.size)
                runOnMainSync { host.finish() }; finish(android.app.Activity.RESULT_OK, report); return
            }
            report.putInt("pid", android.os.Process.myPid())
            if (arguments.getString("mode") == "verify-persistence") {
                check("acknowledged storage survived process termination", action("return await platform.storage.get('restart-checkpoint')") == arguments.getString("expected"))
                check("embedded NUL and emoji key/value survive process termination", action("return await platform.storage.get('unicode-prefix\\u0000😀') === 'before\\u0000after😀'") == true)
                check("prefix key remains distinct after process termination", action("return await platform.storage.get('unicode-prefix')") == "prefix-value")
                action("await platform.storage.remove('unicode-prefix\\u0000😀');await platform.storage.remove('unicode-prefix');return true")
                action("await platform.storage.remove('restart-checkpoint');return true")
                report.putInt("assertions", assertions); report.putString("status", "passed")
                runOnMainSync { host.finish() }; finish(android.app.Activity.RESULT_OK, report); return
            }
            check("native durable storage set", action("await platform.storage.set('instrumentation-draft','native-value');return true") == true)
            check("native durable storage read", action("return await platform.storage.get('instrumentation-draft')") == "native-value")
            check("native storage preserves embedded NUL and emoji key/value", action("await platform.storage.set('unicode-prefix','prefix-value');await platform.storage.set('unicode-prefix\\u0000😀','before\\u0000after😀');return await platform.storage.get('unicode-prefix\\u0000😀') === 'before\\u0000after😀'") == true)
            check("NUL-containing key is distinct from its prefix", action("return await platform.storage.get('unicode-prefix')") == "prefix-value")
            check("native invalid argument rejection", action("try{await platform.call('storage.get',{key:'x',extra:true});return 'bad'}catch(e){return e.code}") == "INVALID_REQUEST")
            check("native wrong type rejection", action("try{await platform.call('storage.set',{key:'x',value:17});return 'bad'}catch(e){return e.code}") == "INVALID_REQUEST")
            check("native unknown action rejection", action("try{await platform.call('unknown.action',{});return 'bad'}catch(e){return e.code}") == "UNSUPPORTED")
            check("opaque file path guard", action("try{await platform.files.previewURL('../private');return 'bad'}catch(e){return e.code}") == "INVALID_REQUEST")
            check("actual vibrator service dispatch", action("await platform.haptics.impact({style:'light'});return true") == true)
            check("native invocation observation", host.hapticInvocations == 1)
            check("native toolbar registration", action("window.__toolbarClicked=false;window.__unsub=platform.on('toolbar.action', e=>{if(e.registration==='instrumentation'&&e.id==='save')window.__toolbarClicked=true});await platform.toolbar.set({registration:'instrumentation',title:'Instrumentation',actions:[{id:'save',title:'Save'}]});return true") == true)
            runOnMainSync { val toolbar = host.nativeToolbar; val button = toolbar.getChildAt(2) as Button; button.performClick() }
            waitFor("native toolbar reaches web callback") { js("window.__toolbarClicked") == true }
            check("native modal presentation", action("await platform.navigation.present({screen:'native-demo'});return true") == true)
            check("native modal dismissal", action("await platform.navigation.dismiss();return true") == true)
            check("native toolbar disposal", action("window.__unsub();await platform.toolbar.clear({registration:'instrumentation'});return true") == true)
            check("wire observation installed", js("window.__nativeWire=null;const original=window.__spaNative.onmessage;window.__spaNative.onmessage=e=>{try{window.__nativeWire=JSON.parse(e.data)}catch(_){};original(e)};true") == true)
            action("await platform.storage.remove('iframe-denial');await platform.storage.set('duplicate-check','original');window.__oldWire=window.__nativeWire;return true")
            check("raw duplicate replay submitted", js("window.__spaNative.postMessage(JSON.stringify({v:1,id:__oldWire.id,document:__oldWire.document,session:__oldWire.session,action:'storage.set',args:{key:'duplicate-check',value:'replayed'}}));true") == true)
            check("duplicate request did not repeat side effect", action("return await platform.storage.get('duplicate-check')") == "original")
            check("same-origin subframe attempt submitted", js("const wire=__nativeWire;const message={v:1,id:'iframe-attempt',document:wire.document,session:wire.session,action:'storage.set',args:{key:'iframe-denial',value:'unauthorized'}};const frame=document.createElement('iframe');frame.id='guard-frame';frame.srcdoc='<script>window.__spaNative.postMessage('+JSON.stringify(JSON.stringify(message))+');window.__attempted=true;<\\/script>';document.body.appendChild(frame);true") == true)
            Thread.sleep(250)
            check("subframe actually attempted native message", js("document.getElementById('guard-frame').contentWindow.__attempted === true") == true)
            check("same-origin subframe cannot invoke native storage", action("return await platform.storage.get('iframe-denial')") == null)
            // A genuine Next Link click exercises exported route payload loading.
            check("Next exported route link exists", js("!!document.querySelector('a[href=\"/library/\"]')") == true)
            val nonce = "continuity-${UUID.randomUUID()}"
            js("window.__continuityNonce=${JSONObject.quote(nonce)};true")
            val originalIdentity = js("JSON.stringify({document:__nativeWire.document,session:__nativeWire.session})")
            js("document.querySelector('a[href=\"/library/\"]').click();true")
            waitFor("Next SPA route committed", 20) { js("location.pathname") == "/library/" }
            waitFor("library route content committed") { js("!!document.querySelector('[aria-current=page][href=\"/library/\"]')") == true }
            check("same browser document across SPA navigation", js("window.__continuityNonce") == nonce)
            action("return await platform.storage.get('instrumentation-draft')")
            check("same host session across SPA navigation", js("JSON.stringify({document:__nativeWire.document,session:__nativeWire.session})") == originalIdentity)
            check("native storage survived SPA navigation", action("return await platform.storage.get('instrumentation-draft')") == "native-value")
            check("native Back waits for committed SPA acknowledgment", action("await platform.navigation.back();return location.pathname") == "/")
            check("native Back preserves browser document", js("window.__continuityNonce") == nonce)
            val oldWire = js("JSON.stringify(window.__nativeWire)") as String
            // Explicitly load ordinary HTML; this must work independently of Next/React.
            runOnMainSync { host.webView.loadUrl(HostActivity.ORIGIN + "/plain.html") }
            waitFor("ordinary document native load", 20) { host.completedDocumentURL == HostActivity.ORIGIN + "/plain.html" }
            waitFor("ordinary document SDK", 20) { js("location.pathname === '/plain.html' && typeof platform === 'object' && document.readyState === 'complete'") == true }
            check("plain HTML real transport", action("return (await platform.ready()).platform") == "android")
            check("storage shared with authorized plain document", action("return await platform.storage.get('instrumentation-draft')") == "native-value")
            action("await platform.storage.remove('stale-document');return true")
            js("const old=${oldWire};window.__spaNative.postMessage(JSON.stringify({v:1,id:'retired-document-attempt',document:old.document,session:old.session,action:'storage.set',args:{key:'stale-document',value:'bad'}}));true")
            Thread.sleep(100)
            check("retired document session cannot invoke storage", action("return await platform.storage.get('stale-document')") == null)
            runOnMainSync { host.webView.loadUrl(HostActivity.ORIGIN + "/injected.html") }
            waitFor("unmodified document native load", 20) { host.completedDocumentURL == HostActivity.ORIGIN + "/injected.html" }
            waitFor("SDK injected into unmodified HTML before page code", 20) { js("location.pathname === '/injected.html' && window.__sdkInjectedBeforePage === true && !!window.__injectedReady") == true }
            check("HTML with no SDK script tag has real native handshake", js("window.__injectedReady.platform") == "android")
            action("const receiver=__spaNative.onmessage;__spaNative.onmessage=e=>{try{window.__queueWire=JSON.parse(e.data)}catch(_){};receiver(e)};await platform.navigation.update({path:'/',title:'Queue contract',canGoBack:false});return true")
            // Hold the actual serial disk executor while cancelled requests are
            // admitted. Cancelling delivery and replacing the document must not
            // turn its queue into an unbounded backlog. No production test hook.
            val executorField = HostActivity::class.java.getDeclaredField("worker").apply { isAccessible = true }
            val executor = executorField.get(host) as java.util.concurrent.ExecutorService
            val diskBlocked = CountDownLatch(1); val releaseDisk = CountDownLatch(1)
            executor.execute { diskBlocked.countDown(); releaseDisk.await(30, TimeUnit.SECONDS) }
            check("actual disk worker held for cancellation race", diskBlocked.await(3, TimeUnit.SECONDS))
            try {
                check("cancelled requests retain bounded disk-work capacity", action("const wire=window.__queueWire;for(let i=0;i<64;i++){__spaNative.postMessage(JSON.stringify({v:1,id:'queue-read-'+i,document:wire.document,session:wire.session,action:'storage.get',args:{key:'queue-read'}}));__spaNative.postMessage(JSON.stringify({v:1,id:'queue-cancel-'+i,document:wire.document,session:wire.session,action:'cancel',args:{requestId:'queue-read-'+i}}));}try{await platform.storage.get('overflow');return 'bad'}catch(e){return e.code}") == "QUOTA_EXCEEDED")
                runOnMainSync { host.webView.loadUrl(HostActivity.ORIGIN + "/plain.html") }
                waitFor("replacement document loaded during cancelled disk work", 20) { host.completedDocumentURL == HostActivity.ORIGIN + "/plain.html" }
                check("new document cannot bypass outstanding disk-work limit", action("try{await platform.storage.get('overflow');return 'bad'}catch(e){return e.code}") == "QUOTA_EXCEEDED")
            } finally { releaseDisk.countDown() }
            waitFor("disk capacity released only after actual work finishes") { action("try{await platform.storage.get('queue-read');return true}catch(e){return false}") == true }
            val token = "restart-${UUID.randomUUID()}"
            check("durable checkpoint committed", action("await platform.storage.set('restart-checkpoint',${JSONObject.quote(token)});return await platform.storage.get('restart-checkpoint')") == token)
            report.putString("persistenceToken", token)
            check("native storage removal", action("await platform.storage.remove('instrumentation-draft');return await platform.storage.get('instrumentation-draft')") == null)
            action("await platform.storage.remove('duplicate-check');return true")
            report.putInt("assertions", assertions); report.putString("status", "passed")
            report.putString("limits", "No camera capture, hardware sensation, process termination, or Release execution is implied by these assertions.")
            runOnMainSync { host.finish() }
            finish(android.app.Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            report.putInt("assertions", assertions); report.putString("status", "failed"); report.putString("error", error.toString()); report.putString("stack", error.stackTraceToString())
            if (::host.isInitialized) runOnMainSync { host.finish() }
            finish(1, report)
        }
    }
    private fun check(name: String, ok: Boolean) { if (!ok) throw AssertionError(name); assertions++; sendStatus(0, Bundle().apply { putString("assertion", name) }) }
    private fun waitFor(name: String, seconds: Int = 10, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds.toLong())
        while (System.nanoTime() < deadline) { if (condition()) { assertions++; return }; Thread.sleep(100) }
        throw AssertionError("Timed out: $name; document=${js("document.body?.innerText?.slice(0,1000)")}")
    }
    private fun js(source: String): Any? {
        val latch = CountDownLatch(1); var result: String? = null
        runOnMainSync { host.webView.evaluateJavascript(source) { result = it; latch.countDown() } }
        if (!latch.await(5, TimeUnit.SECONDS)) throw AssertionError("WebView evaluation timeout")
        return result?.let { JSONTokener(it).nextValue().let { value -> if (value === JSONObject.NULL) null else value } }
    }
    private fun action(body: String): Any? {
        js("window.__instrumentationResult=null;(async()=>{$body})().then(value=>window.__instrumentationResult={ok:true,value:value===undefined?null:value},error=>window.__instrumentationResult={ok:false,error:String(error)});true")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            val raw = js("JSON.stringify(window.__instrumentationResult)") as? String
            if (raw != null && raw != "null") {
                val obj = JSONObject(raw)
                if (!obj.getBoolean("ok")) throw AssertionError(obj.getString("error"))
                return obj.opt("value").let { if (it === JSONObject.NULL) null else it }
            }
            Thread.sleep(50)
        }
        throw AssertionError("SDK action timeout")
    }
}
