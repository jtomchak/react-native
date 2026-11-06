package dev.spahost.prototype

import dev.nativehost.auth.AuthVault

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real native OAuth browser/callback/network/Keystore/cookie/SSR against an isolated local issuer. */
internal class AuthLiveSuite(private val runner: HostInstrumentation, private val arguments: Bundle) {
    private lateinit var host: HostActivity
    private var assertions = 0
    fun run() {
        val report = Bundle()
        try {
            val origin = arguments.getString("origin") ?: "http://127.0.0.1:18803"
            val fixture = android.net.Uri.parse(origin)
            require(fixture.scheme == "http" && fixture.host == "127.0.0.1" && fixture.port in 1024..65535) { "Auth acceptance suite requires an isolated loopback origin" }
            // Fixture restarts intentionally use a fresh server database. Reset
            // only this loopback origin before mounting React, so an orphaned
            // previous-test credential cannot race the page's startup refresh.
            AuthVault(runner.targetContext).clear(origin)
            val cleared = CountDownLatch(1)
            runner.runOnMainSync { android.webkit.CookieManager.getInstance().setCookie(origin, "spa_dev_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax") { cleared.countDown() } }
            check("isolated loopback fixture state reset", cleared.await(5, TimeUnit.SECONDS))
            host = runner.startActivitySync(Intent(runner.targetContext, HostActivity::class.java)
                .putExtra("spa.content", "hosted").putExtra("spa.hosted.url", origin).putExtra("spa.auth.origin", origin)
                .putExtra("spa.navigation", "native").putExtra("spa.chrome", "tabs")
                .setData(android.net.Uri.parse("spahost://app/hosted/auth/"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as HostActivity
            runner.runOnMainSync { host.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            waitFor("hosted auth page ready", 40) { host.browserReady && js("typeof platform==='object'") == true }
            // Explicit clean start only for this isolated loopback test origin.
            js("window.__authCleanup=true;(async()=>{for(let i=0;i<50;i++){try{await platform.call('auth.signOut',{});return}catch(e){if(e.code!=='BUSY')throw e;await new Promise(r=>setTimeout(r,100))}}})().catch(()=>{});true")
            waitFor("native cleanup refreshes hosted document", 40) { host.browserReady && js("window.__authCleanup!==true") == true }
            check("native test auth configured", action("const s=await platform.call('auth.status',{});return s.configured===true&&s.authenticated===false&&s.providers.includes('test')") == true)
            check("SSR starts signed out", js("document.querySelector('[data-testid=auth-server-status]')?.textContent") == "Server anonymous")
            js("platform.call('chrome.selectTab',{id:'compose'}).catch(()=>{});true")
            waitFor("sibling hosted document ready", 40) { host.browserReady && host.completedDocumentURL?.contains("/compose/") == true }
            js("window.__oldAccountRealm=true;window.__oldRealmTicks=0;setInterval(()=>window.__oldRealmTicks++,50);true")
            val sibling = host.webView
            js("platform.call('chrome.selectTab',{id:'overview'}).catch(()=>{});true")
            waitFor("auth document restored", 40) { host.browserReady && host.completedDocumentURL?.contains("/hosted/auth/") == true }
            fire("const s=await platform.call('auth.signIn',{method:'oauth',provider:'test'},{timeoutMs:120000});window.__nativeSigninSummarySafe=s.authenticated===true&&!('accessToken'in s)&&!('refreshToken'in s)")
            waitFor("native OAuth completes and app regains foreground", 120) {
                var complete = false
                runner.runOnMainSync { complete = host.hasWindowFocus() && AuthVault(runner.targetContext).read(origin) != null }
                complete
            }
            waitFor("real CustomTabs OAuth callback establishes native session without JS tokens", 10) { js("window.__nativeSigninSummarySafe===true") == true }
            check("inactive sibling JavaScript realm retired before cookie handoff", !liveWidgets().contains(sibling))
            check("old hosted document is concealed pending cookie sync", host.webView.alpha == 0f && host.webView.importantForAccessibility == android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS)
            check("native status reflects verified issuer identity", action("return (await platform.call('auth.status',{})).user.name") == "Local OAuth user")
            val beforeSync = host.webView
            fire("return await platform.call('auth.syncWebSession',{})")
            waitFor("cookie sync commits a fresh native widget", 40) { host.webView !== beforeSync && host.browserReady }
            check("authenticated server rendering", js("document.querySelector('[data-testid=auth-server-status]')?.textContent") == "Server authenticated: Local OAuth user")
            check("session cookie unavailable to page JavaScript", js("!document.cookie.includes('spa_dev_session')") == true)
            val oldCookie = android.webkit.CookieManager.getInstance().getCookie(origin)
            check("native cookie handoff installed cookie", oldCookie?.contains("spa_dev_session=") == true)
            check("server rendered authenticated user", js("!!document.querySelector('[data-testid=auth-server-user]')?.textContent") == true)
            val beforeLogout = host.webView
            fire("return await platform.call('auth.signOut',{})")
            waitFor("logout commits a fresh native widget", 40) { host.webView !== beforeLogout && host.browserReady }
            check("signed out server rendering", js("document.querySelector('[data-testid=auth-server-status]')?.textContent") == "Server anonymous")
            val connection = java.net.URL("$origin/api/auth/web/session/").openConnection() as java.net.HttpURLConnection
            try {
                connection.connectTimeout = 10000; connection.readTimeout = 10000; connection.setRequestProperty("Cookie", oldCookie)
                val previous = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                check("logout revoked the previous server cookie", !previous.getBoolean("authenticated"))
            } finally { connection.disconnect() }
            waitFor("React sign-in control becomes available", 20) { js("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Sign in with test'&&!b.disabled)") == true }
            val beforeReactLogin = host.webView
            fire("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Sign in with test').click()")
            waitFor("React helper OAuth returns to native foreground", 120) {
                var complete = false
                runner.runOnMainSync { complete = host.hasWindowFocus() && AuthVault(runner.targetContext).read(origin) != null }
                complete
            }
            waitFor("React helper installs cookie and replaces document", 40) { host.webView !== beforeReactLogin && host.browserReady }
            check("actual React sign-in helper renders authenticated SSR", js("document.querySelector('[data-testid=auth-server-status]')?.textContent") == "Server authenticated: Local OAuth user")
            waitFor("React sign-out control becomes available", 20) { js("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Sign out'&&!b.disabled)") == true }
            val beforeReactLogout = host.webView
            fire("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Sign out').click()")
            waitFor("React sign-out replaces hosted document", 40) { host.webView !== beforeReactLogout && host.browserReady }
            check("actual React sign-out helper renders anonymous SSR", js("document.querySelector('[data-testid=auth-server-status]')?.textContent") == "Server anonymous")
            report.putString("status", "passed"); report.putInt("assertions", assertions)
            report.putString("limits", "Isolated loopback OIDC issuer only. No production provider or passkey prompt/enrollment claim.")
            runner.runOnMainSync { host.finish() }; runner.finish(Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            report.putString("status", "failed"); report.putInt("assertions", assertions); report.putString("error", error.toString()); report.putString("stack", error.stackTraceToString())
            if (::host.isInitialized) runner.runOnMainSync { host.finish() }
            runner.finish(1, report)
        }
    }
    private fun liveWidgets(): List<android.webkit.WebView> {
        val stacks = HostActivity::class.java.getDeclaredField("stacks").apply { isAccessible = true }.get(host) as Map<*, *>
        return stacks.values.flatMap { it as List<*> }.map { surface -> surface!!::class.java.getDeclaredField("view").apply { isAccessible = true }.get(surface) as android.webkit.WebView }
    }
    private fun check(name: String, value: Boolean) { if (!value) throw AssertionError(name); assertions++; runner.sendStatus(0, Bundle().apply { putString("assertion", name) }) }
    private fun waitFor(name: String, seconds: Int, check: () -> Boolean) {
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds.toLong())
        while (System.nanoTime() < end) { if (check()) { assertions++; runner.sendStatus(0, Bundle().apply { putString("assertion", name) }); return }; Thread.sleep(100) }
        throw AssertionError("Timed out: $name")
    }
    private fun js(script: String): Any? {
        val latch = CountDownLatch(1); var raw: String? = null
        runner.runOnMainSync { host.webView.evaluateJavascript(script) { raw = it; latch.countDown() } }
        if (!latch.await(5, TimeUnit.SECONDS)) throw AssertionError("WebView evaluation timed out")
        return raw?.let { JSONTokener(it).nextValue().let { value -> if (value === JSONObject.NULL) null else value } }
    }
    private fun fire(body: String) {
        // Browser presentation and native cookie sync can suspend/destroy the
        // source renderer. Native observation, not a background JS evaluation
        // callback, owns completion for these operations.
        runner.runOnMainSync { host.webView.evaluateJavascript("(async()=>{for(let attempt=0;attempt<50;attempt++){try{await(async()=>{$body})();return}catch(error){if(error.code!=='BUSY'||attempt===49)throw error;await new Promise(r=>setTimeout(r,100))}}})().catch(error=>window.__authFireError=error.code||'UNKNOWN');true", null) }
    }
    private fun action(body: String, seconds: Int = 30): Any? {
        js("window.__authLiveResult=null;(async()=>{for(let attempt=0;attempt<50;attempt++){try{return await(async()=>{$body})()}catch(error){if(error.code!=='BUSY'||attempt===49)throw error;await new Promise(r=>setTimeout(r,100))}}})().then(value=>window.__authLiveResult={ok:true,value},error=>window.__authLiveResult={ok:false,code:error.code});true")
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds.toLong())
        while (System.nanoTime() < end) {
            val raw = js("JSON.stringify(window.__authLiveResult)") as? String
            if (raw != null && raw != "null") { val result = JSONObject(raw); if (!result.getBoolean("ok")) throw AssertionError("Auth action failed: " + result.optString("code")); return result.opt("value").let { if (it === JSONObject.NULL) null else it } }
            Thread.sleep(100)
        }
        throw AssertionError("Auth action timed out")
    }
}
