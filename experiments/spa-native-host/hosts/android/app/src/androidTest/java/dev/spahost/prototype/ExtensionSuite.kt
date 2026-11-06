package dev.spahost.prototype

import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import android.view.View
import android.view.ViewGroup
import com.google.android.material.bottomnavigation.BottomNavigationView
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Actual native shell/WebView service contracts. No mock native transport. */
internal class ExtensionSuite(private val runner: Instrumentation, private val arguments: Bundle) {
    private lateinit var host: HostActivity
    private var assertions = 0
    fun run() {
        val report = Bundle()
        try {
            val source = arguments.getString("source", "packaged")!!
            val launch = Intent(runner.targetContext, HostActivity::class.java).setData(android.net.Uri.parse("spahost://app/"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                .putExtra("spa.navigation", "native").putExtra("spa.chrome", "tabs")
            if (arguments.getString("feature") == "offline") { val port = java.net.ServerSocket(0).use { it.localPort }; launch.putExtra("spa.content", "hosted").putExtra("spa.hosted.url", "http://127.0.0.1:$port") }
            else if (source == "hosted") launch.putExtra("spa.content", "hosted").putExtra("spa.hosted.url", "http://127.0.0.1:18797")
            host = runner.startActivitySync(launch) as HostActivity
            runner.runOnMainSync { host.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            if (arguments.getString("feature") == "offline") {
                waitFor("native hosted error UI", 25) { findButton(host.window.decorView, "Use packaged app") != null }
                runner.runOnMainSync { findButton(host.window.decorView, "Retry")!!.performClick() }
                waitFor("native retry remains usable", 25) { findButton(host.window.decorView, "Use packaged app") != null }
                runner.runOnMainSync { findButton(host.window.decorView, "Use packaged app")!!.performClick() }
                ready()
                check("offline fallback establishes packaged mode", action("return (await platform.ready()).host.contentMode") == "packaged")
                check("offline fallback replaces privileged origin", js("location.origin") == HostActivity.ORIGIN)
                check("native bridge works after explicit packaged fallback", action("await platform.storage.set('fallback-proof','native');return await platform.storage.get('fallback-proof')") == "native")
                report.putString("status", "passed"); report.putInt("assertions", assertions); report.putString("feature", "offline")
                runner.runOnMainSync { host.finish() }; runner.finish(android.app.Activity.RESULT_OK, report); return
            }
            ready()
            arguments.getString("feature")?.let { feature ->
                runFeature(feature)
                report.putString("status", "passed"); report.putInt("assertions", assertions); report.putString("feature", feature); report.putInt("pid", android.os.Process.myPid())
                runner.runOnMainSync { host.finish() }; runner.finish(android.app.Activity.RESULT_OK, report); return
            }
            check("metadata declares requested content mode", JSONObject(action("return (await platform.ready()).host") as String).getString("contentMode") == source)
            check("native tabs are actual Material controls", findTabs(host.window.decorView) != null)
            check("native mode metadata", action("return (await platform.ready()).host.navigationMode") == "native")
            check("native chrome state", JSONObject(action("return await platform.call('chrome.state',{})") as String).getString("mode") == "tabs")
            check("unconfigured push does not invent registration", action("try{await platform.call('notifications.register',{});return 'bad'}catch(e){return e.code}") == "UNAVAILABLE")
            check("biometric status uses native availability", action("return typeof (await platform.call('biometrics.status',{})).available") == "boolean")
            val secureConfig = HostConfiguration(contentMode = "hosted", origin = "https://native.example.test")
            check("configured HTTPS App Link parses canonically", secureConfig.deepLink(android.net.Uri.parse("https://native.example.test/compose/?item=1")) == "/compose/?item=1")
            check("foreign HTTPS App Link is rejected", secureConfig.deepLink(android.net.Uri.parse("https://foreign.example/compose/")) == null)
            check("hosted server-added routes need no native enum", secureConfig.validRoute("/hosted/item/42/"))
            check("packaged routes remain finite", !HostConfiguration().validRoute("/hosted/item/42/"))
            check("hosted encoded traversal remains denied", !secureConfig.validRoute("/hosted/%2e%2e/private/") && !secureConfig.validRoute("/hosted/item%2fprivate/"))
            action("await platform.toolbar.set({registration:'title-contract',title:'Toolbar title',actions:[]});await platform.navigation.update({path:'/',title:'Generic route title',canGoBack:false});return true")
            check("toolbar title survives generic route acknowledgment", (host.nativeToolbar.getChildAt(1) as android.widget.TextView).text.toString() == "Toolbar title")
            action("await platform.toolbar.clear({registration:'title-contract'});return true")
            check("toolbar disposal restores route title", (host.nativeToolbar.getChildAt(1) as android.widget.TextView).text.toString() == "Generic route title")
            val base = host.webView
            js(base, "window.__surfaceNonce='retained-root';true")
            action("await platform.storage.set('extension-shared','shared-native');return true")
            action("await platform.call('chrome.update',{toolbarHidden:true,tabBarHidden:true,statusBarStyle:'light'});return true")
            check("surface appearance applied", host.nativeToolbar.visibility == View.GONE)
            fire("platform.call('navigation.visit',{path:'/compose/',presentation:'push'})")
            waitFor("native push creates a distinct WebView") { host.webView !== base }
            ready()
            val pushed = host.webView
            check("new surface appearance defaults restored", host.nativeToolbar.visibility == View.VISIBLE)
            check("native stack depth", JSONObject(action("return await platform.call('chrome.state',{})") as String).getInt("depth") == 2)
            check("services shared across surfaces", action("return await platform.storage.get('extension-shared')") == "shared-native")
            check("hidden surface cannot mutate foreground chrome", action(base, "try{await platform.call('chrome.update',{title:'hidden attack'});return 'bad'}catch(e){return e.code}") == "UNAUTHORIZED")
            fire("platform.navigation.back()")
            waitFor("native pop restores existing root") { host.webView === base }
            check("native pop retains root JS document", js(base, "window.__surfaceNonce") == "retained-root")
            check("returning surface reapplies its appearance", host.nativeToolbar.visibility == View.GONE)
            action("await platform.call('chrome.update',{toolbarHidden:false,tabBarHidden:false,statusBarStyle:'default'});return true")
            // Native tab selection exercises the real BottomNavigationView.
            runner.runOnMainSync { findTabs(host.window.decorView)!!.selectedItemId = 2 }
            waitFor("native tab selection activates compose") { host.webView !== base }
            ready()
            val compose = host.webView
            js(compose, "window.__tabNonce='compose-retained';true")
            check("native tab metadata", action("return (await platform.ready()).host.activeTab") == "compose")
            action("await platform.call('chrome.selectTab',{id:'overview'});return true")
            waitFor("tab root identity restored") { host.webView === base }
            action("await platform.call('chrome.selectTab',{id:'compose'});return true")
            waitFor("second native tab reused") { host.webView === compose }
            check("tab document state retained", js(compose, "window.__tabNonce") == "compose-retained")
            fire("platform.call('navigation.visit',{path:'/library/',presentation:'modal'})")
            waitFor("native modal route created") { host.webView !== compose }
            ready()
            check("route modal is a native dialog window", host.window.decorView.windowToken != host.webView.windowToken)
            fire("platform.navigation.dismiss()")
            waitFor("SDK dismissal closes route modal") { host.webView === compose }
            check("modal dismissal restores parent document", js(compose, "window.__tabNonce") == "compose-retained")
            // Filling one stack reserves the third tab's root rather than crashing it.
            repeat(3) { index -> fire("platform.call('navigation.visit',{path:'/compose/?visit=$index',presentation:'push'})"); waitFor("native bounded push $index") { host.webView !== compose && host.completedDocumentURL?.contains("visit=$index") == true }; ready() }
            check("full native stack rejects further push", action("try{await platform.call('navigation.visit',{path:'/compose/?overflow=1',presentation:'push'});return 'bad'}catch(e){return e.code}") == "QUOTA_EXCEEDED")
            val beforeIntent = host.webView
            action("const original=__spaNative.onmessage;window.__intentHandled=null;__spaNative.onmessage=e=>{try{const w=JSON.parse(e.data);if(w.event==='links.opened')window.__intentHandled=w.data}catch(_){};original(e)};await platform.call('events.subscribe',{event:'links.opened',subscription:'intent-capacity-test'});return true")
            runner.runOnMainSync { host.startActivity(Intent(runner.targetContext, HostActivity::class.java).setData(android.net.Uri.parse("spahost://app/compose/?overflow=2")).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            waitFor("native capacity intent was processed") { js("!!window.__intentHandled") == true }
            check("capacity error from native intent leaves active surface intact", host.webView === beforeIntent && js("window.__intentHandled.error") == "QUOTA_EXCEEDED")
            action("await platform.call('chrome.selectTab',{id:'library'});return true")
            ready()
            check("reserved tab root remains reachable", action("return (await platform.ready()).host.activeTab") == "library")
            check("live native surfaces remain bounded", host.liveSurfaceCount <= 8)
            check("invalid chrome update is atomic", action("const before=await platform.call('chrome.state',{});try{await platform.call('chrome.update',{toolbarHidden:true,statusBarStyle:'invalid'})}catch(e){return e.code==='INVALID_REQUEST'&&(await platform.call('chrome.state',{})).toolbarHidden===before.toolbarHidden}return false") == true)
            if (source == "hosted") {
                val old = host.webView
                fire("platform.call('navigation.visit',{path:'/hosted/',presentation:'push'})")
                waitFor("server-native visit activated") { host.webView !== old }
                ready()
                check("production hosted SSR content reached native view", js("document.body.innerText.includes('Server-rendered') || !!document.querySelector('[data-testid=server-nonce]')") == true)
                check("hosted origin exact loopback", js("location.origin") == "http://127.0.0.1:18797")
                val hostedRoot = host.webView
                val firstNonce = js("document.querySelector('[data-testid=server-nonce]').textContent")
                js("document.querySelector('button[name=preference][value=forest]').click();true")
                waitFor("actual Next server action committed cookie state") { js("document.querySelector('[data-testid=server-preference]')?.textContent") == "forest" }
                check("server action produced a new request payload", js("document.querySelector('[data-testid=server-nonce]').textContent") != firstNonce)
                js("document.querySelector('a[href=\"/hosted/item/42/\"]').click();true")
                waitFor("NativeLink created dynamic server route surface") { host.webView !== hostedRoot }; ready()
                check("server-owned item route is not native enumerated", js("document.querySelector('[data-testid=server-item-id]')?.textContent") == "42")
                waitFor("server item native toolbar title survives route acknowledgment") { (host.nativeToolbar.getChildAt(1) as android.widget.TextView).text.toString() == "Item 42" }
                val firstItem = host.webView
                fire("platform.call('navigation.visit',{path:'/hosted/item/fresh_73/',presentation:'replace'})")
                waitFor("native replace activates another server-owned item") { host.webView !== firstItem }; ready()
                check("new dynamic route served without app change", js("document.querySelector('[data-testid=server-item-id]')?.textContent") == "fresh_73")
                fire("platform.navigation.back()")
                waitFor("native pop restores hosted parent") { host.webView === hostedRoot }
                fire("platform.call('navigation.visit',{path:'/hosted/?cookiecheck=1',presentation:'replace'})")
                waitFor("new hosted document for cookie persistence") { host.webView !== hostedRoot }; ready()
                check("server HttpOnly cookie shared across native surfaces", js("document.querySelector('[data-testid=server-preference]')?.textContent") == "forest")
            }
            report.putString("status", "passed"); report.putInt("assertions", assertions); report.putInt("pid", android.os.Process.myPid()); report.putString("source", source)
            report.putString("limits", "Native widget/state assertions; no APNs/FCM delivery, receiver delivery, biometric presence or predictive system gesture implied")
            runner.runOnMainSync { host.finish() }; runner.finish(android.app.Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            report.putString("status", "failed"); report.putInt("assertions", assertions); report.putString("error", error.toString()); report.putString("stack", error.stackTraceToString())
            if (::host.isInitialized) runner.runOnMainSync { host.finish() }
            runner.finish(1, report)
        }
    }
    private fun runFeature(feature: String) {
        when (feature) {
            "links" -> {
                val initial = host.webView
                runner.runOnMainSync { host.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("spahost://app/compose/?os-link=1")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                waitFor("OS custom-scheme intent creates native visit") { host.webView !== initial }; ready()
                check("OS custom-scheme canonical path reaches document", js("location.pathname + location.search") == "/compose/?os-link=1")
                check("OS custom-scheme uses native stack", JSONObject(action("return await platform.call('chrome.state',{})") as String).getInt("depth") == 2)
            }
            "share" -> {
                check("share result is presentation, not delivered", JSONObject(action("return await platform.call('share.present',{text:'Native host share fixture'})") as String).getString("status") == "presented")
                waitFor("actual OS chooser window") { val pkg = runner.uiAutomation.rootInActiveWindow?.packageName?.toString(); pkg == "android" || pkg == "com.android.intentresolver" }
                runner.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                waitFor("share chooser dismissed") { runner.uiAutomation.rootInActiveWindow?.packageName?.toString() == runner.targetContext.packageName }
                check("share presentation lease released after returning", action("await platform.navigation.present({screen:'native-demo'});await platform.navigation.dismiss();return true") == true)
            }
            "biometrics" -> {
                val state = JSONObject(action("return await platform.call('biometrics.status',{})") as String)
                check("biometric status is native boolean", state.opt("available") is Boolean && state.opt("enrolled") is Boolean)
                if (!state.getBoolean("available")) {
                    check("unavailable biometrics never report success", action("try{await platform.call('biometrics.authenticate',{reason:'Native authentication fixture'});return 'bad'}catch(e){return e.code}") == "UNAVAILABLE")
                } else {
                    js("window.__biometricResult=null;platform.call('biometrics.authenticate',{reason:'Native authentication cancellation fixture'}).then(v=>window.__biometricResult=v,e=>window.__biometricResult={error:e.code});true")
                    waitFor("actual system biometric prompt") { val node=runner.uiAutomation.rootInActiveWindow; node?.packageName?.toString()!=runner.targetContext.packageName && findText(node,"Authenticate")!=null }
                    runner.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                    waitFor("system biometric cancellation callback") { js("window.__biometricResult?.error") == "CANCELLED" }
                    check("cancelled biometric request did not authenticate", js("window.__biometricResult?.authenticated === true") == false)
                }
            }
            "permissions" -> {
                check("runtime notification permission platform", android.os.Build.VERSION.SDK_INT >= 33)
                runner.targetContext.getSharedPreferences("native-permissions", android.content.Context.MODE_PRIVATE).edit().clear().commit()
                shell("pm revoke dev.spahost.prototype android.permission.POST_NOTIFICATIONS")
                shell("pm clear-permission-flags dev.spahost.prototype android.permission.POST_NOTIFICATIONS user-set user-fixed")
                check("unasked native notification status", action("return (await platform.call('notifications.status',{})).authorization") == "notDetermined")
                js("window.__permissionResult=null;platform.call('notifications.requestPermission',{}).then(v=>window.__permissionResult=v,e=>window.__permissionResult={error:e.code});true")
                waitFor("actual OS notification permission dialog") { findText(runner.uiAutomation.rootInActiveWindow, "Don’t allow") != null || findText(runner.uiAutomation.rootInActiveWindow, "Don't allow") != null }
                val button = findText(runner.uiAutomation.rootInActiveWindow, "Don’t allow") ?: findText(runner.uiAutomation.rootInActiveWindow, "Don't allow")!!
                check("OS permission denial clicked", button.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK))
                waitFor("permission callback returns denied") { js("window.__permissionResult?.authorization") == "denied" }
                check("status remains denied after actual denial", action("return (await platform.call('notifications.status',{})).authorization") == "denied")
                check("unconfigured registration still unavailable", action("try{await platform.call('notifications.register',{});return 'bad'}catch(e){return e.code}") == "UNAVAILABLE")
            }
            "gestures" -> {
                check("predictive gesture platform", android.os.Build.VERSION.SDK_INT >= 34)
                val rootView = host.webView; js(rootView, "window.__gestureRoot='retained';true")
                fire("platform.call('navigation.visit',{path:'/compose/',presentation:'push'})")
                waitFor("native gesture destination loaded") { host.webView !== rootView }; ready()
                val destination = host.webView; js(destination, "window.__gestureDestination='unchanged';true")
                val cancelledBefore = host.predictiveCancels
                gesture(cancel = true)
                waitFor("system predictive cancellation callback") { host.predictiveCancels > cancelledBefore }
                check("cancelled gesture preserves native stack and surface", host.webView === destination && JSONObject(action("return await platform.call('chrome.state',{})") as String).getInt("depth") == 2)
                check("cancelled gesture preserves document", js(destination, "window.__gestureDestination") == "unchanged")
                val committedBefore = host.predictiveCommits
                gesture(cancel = false)
                waitFor("system predictive commit pops native surface") { host.webView === rootView && host.predictiveCommits > committedBefore }
                check("actual system progress callbacks observed", host.predictiveStarts >= 2 && host.predictiveProgressEvents > 0)
                check("native pop restores root document", js(rootView, "window.__gestureRoot") == "retained")
                val startsAtRoot = host.predictiveStarts
                gesture(cancel = true)
                check("root gesture is delegated to Android", host.predictiveStarts == startsAtRoot && host.webView === rootView)
            }
            else -> throw AssertionError("Unknown native feature fixture")
        }
    }
    private fun shell(command: String) { runner.uiAutomation.executeShellCommand(command).use { fd -> android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes() } } }
    private fun findText(node: android.view.accessibility.AccessibilityNodeInfo?, text: String): android.view.accessibility.AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.text?.toString()?.equals(text, true) == true) return node
        for (index in 0 until node.childCount) findText(node.getChild(index), text)?.let { return it }
        return null
    }
    private fun gesture(cancel: Boolean) {
        val metrics = runner.targetContext.resources.displayMetrics
        val y = metrics.heightPixels * .55f; val width = metrics.widthPixels.toFloat()
        val down = android.os.SystemClock.uptimeMillis()
        fun send(action: Int, x: Float) {
            val event = android.view.MotionEvent.obtain(down, android.os.SystemClock.uptimeMillis(), action, x, y, 0)
            event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            try { if (!runner.uiAutomation.injectInputEvent(event, true)) throw AssertionError("System touch injection rejected") } finally { event.recycle() }
        }
        send(android.view.MotionEvent.ACTION_DOWN, 1f); Thread.sleep(50)
        for (step in 1..8) { send(android.view.MotionEvent.ACTION_MOVE, width * .5f * step / 8); Thread.sleep(35) }
        if (cancel) for (step in 7 downTo 0) { send(android.view.MotionEvent.ACTION_MOVE, 1f + width * .5f * step / 8); Thread.sleep(40) }
        send(android.view.MotionEvent.ACTION_UP, if (cancel) 1f else width * .65f)
        Thread.sleep(350)
    }
    private fun ready() { waitFor("native surface finished loading", 40) { host.browserReady }; waitFor("actual injected SDK/application ready", 30) { js("typeof platform==='object' && document.readyState==='complete'") == true }; action("return await platform.ready()") }
    private fun check(name: String, ok: Boolean) { if (!ok) throw AssertionError(name); assertions++; runner.sendStatus(0, Bundle().apply { putString("assertion", name) }) }
    private fun waitFor(name: String, seconds: Int = 15, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds.toLong())
        while (System.nanoTime() < deadline) { if (condition()) { assertions++; return }; Thread.sleep(75) }
        throw AssertionError("Timed out: $name")
    }
    private fun fire(expression: String) { js("Promise.resolve($expression).catch(()=>{});true") }
    private fun js(source: String): Any? = js(host.webView, source)
    private fun js(view: WebView, source: String): Any? {
        val latch = CountDownLatch(1); var result: String? = null
        runner.runOnMainSync { view.evaluateJavascript(source) { result = it; latch.countDown() } }
        if (!latch.await(5, TimeUnit.SECONDS)) throw AssertionError("Native WebView evaluation timeout")
        return result?.let { JSONTokener(it).nextValue().let { value -> if (value === JSONObject.NULL) null else value } }
    }
    private fun action(body: String): Any? = action(host.webView, body)
    private fun action(view: WebView, body: String): Any? {
        js(view, "window.__extensionResult=null;(async()=>{$body})().then(v=>window.__extensionResult={ok:true,value:v===undefined?null:v},e=>window.__extensionResult={ok:false,error:String(e)});true")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            val value = js(view, "JSON.stringify(window.__extensionResult)") as? String
            if (value != null && value != "null") {
                val obj = JSONObject(value); if (!obj.getBoolean("ok")) throw AssertionError(obj.getString("error"))
                val result = obj.opt("value"); return when { result === JSONObject.NULL -> null; result is JSONObject || result is org.json.JSONArray -> result.toString(); else -> result }
            }; Thread.sleep(50)
        }; throw AssertionError("Native SDK action timeout")
    }
    private fun findButton(view: View, text: String): android.widget.Button? {
        if (view is android.widget.Button && view.text.toString() == text) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) findButton(view.getChildAt(index), text)?.let { return it }
        return null
    }
    private fun findTabs(view: View): BottomNavigationView? {
        if (view is BottomNavigationView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) findTabs(view.getChildAt(index))?.let { return it }
        return null
    }
}
