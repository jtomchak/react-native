package dev.spahost.prototype

import dev.nativehost.auth.AuthConfiguration
import dev.nativehost.auth.AuthPlugin
import dev.nativehost.auth.AuthVault
import dev.nativehost.pluginapi.PluginCallContext
import dev.nativehost.pluginapi.PluginEnvironment

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Non-interactive native security checks; no live OAuth/passkey claims. */
internal class AuthSuite(private val runner: HostInstrumentation, private val arguments: Bundle) {
    private var assertions = 0
    private var host: HostActivity? = null
    private fun check(name: String, value: Boolean) { if (!value) throw AssertionError(name); assertions++; runner.sendStatus(0, Bundle().apply { putString("assertion", name) }) }
    fun run() {
        val report = Bundle()
        try {
            val context = runner.targetContext
            val origin = "https://auth-security.example.test"
            val vault = AuthVault(context)
            vault.clear(origin)
            check("vault starts empty", vault.read(origin) == null)
            val token = "native-only-credential-value-0123456789"
            vault.write(origin, JSONObject().put("accessToken", token).put("refreshToken", token + "refresh"))
            check("Keystore encrypted credential round trip", vault.read(origin)?.getString("accessToken") == token)
            check("vault origin isolation", vault.read("https://other.example.test") == null)
            val preferenceValues = context.getSharedPreferences("native-auth", android.content.Context.MODE_PRIVATE).all.values.joinToString()
            check("preferences contain no plaintext credential", !preferenceValues.contains(token))
            vault.clear(origin)
            check("secure credential removal", vault.read(origin) == null)
            val secure = "__Host-spa_session=0123456789abcdef0123456789abcdef; Path=/; Secure; HttpOnly; SameSite=Lax"
            check("exact secure session cookie accepted", AuthPlugin.validSessionCookie(secure, origin))
            check("domain-scoped cookie denied", !AuthPlugin.validSessionCookie("$secure; Domain=example.test", origin))
            check("missing HttpOnly denied", !AuthPlugin.validSessionCookie(secure.replace("; HttpOnly", ""), origin))
            check("missing Secure denied", !AuthPlugin.validSessionCookie(secure.replace("; Secure", ""), origin))
            check("foreign cookie name denied", !AuthPlugin.validSessionCookie(secure.replace("__Host-spa_session", "foreign"), origin))
            check("cookie header injection denied", !AuthPlugin.validSessionCookie(secure + "\r\nSet-Cookie: other=value", origin))
            check("debug cookie cannot replace production cookie", !AuthPlugin.validSessionCookie(secure.replace("__Host-spa_session", "spa_dev_session"), origin))
            check("origin comparison rejects foreign port", !AuthPlugin.sameOrigin(Uri.parse("https://auth-security.example.test:444/"), origin))
            check("origin comparison rejects userinfo", !AuthPlugin.sameOrigin(Uri.parse("https://user@auth-security.example.test/"), origin))
            check("unconfigured auth disabled", !AuthConfiguration.parse(null).enabled)
            check("provider underscore accepted consistently", AuthConfiguration.parse(JSONObject().put("enabled", true).put("origin", origin).put("providers", org.json.JSONArray(listOf("enterprise_oidc")))).providers == listOf("enterprise_oidc"))
            check("invalid auth RP rejected", runCatching { AuthConfiguration.parse(JSONObject().put("enabled", true).put("origin", origin).put("providers", org.json.JSONArray()).put("rpId", "foreign.example")) }.isFailure)
            check("unexpected configuration field rejected", runCatching { AuthConfiguration.parse(JSONObject().put("accessToken", token)) }.isFailure)
            val cookieReady = CountDownLatch(1)
            runner.runOnMainSync { android.webkit.CookieManager.getInstance().setCookie(origin, secure) { cookieReady.countDown() } }
            check("orphan cookie fixture installed", cookieReady.await(5, TimeUnit.SECONDS))
            var resetEventValue = false
            val resetAuth = AuthPlugin(PluginEnvironment(context, true, { _, value -> resetEventValue = !value.optBoolean("authenticated") }, { _ -> }, { _ -> }, { it() })); val resetDone = CountDownLatch(1); var resetCode: String? = null; var resetEvent = false
            runner.runOnMainSync {
                val config = JSONObject().put("plugins", JSONObject().put("auth", JSONObject().put("enabled", true).put("origin", origin).put("providers", org.json.JSONArray(listOf("enterprise_oidc"))).put("rpId", JSONObject.NULL)))
                resetAuth.invoke(PluginCallContext(Activity(), "orphan", "signin", config), "auth.signIn", JSONObject().put("method", "oauth").put("provider", "enterprise_oidc")) { _, error -> resetCode = error?.code; resetEvent = resetEventValue; resetDone.countDown() }
            }
            check("orphan web session blocks OAuth before new identity", resetDone.await(5, TimeUnit.SECONDS) && resetCode == "UNAUTHORIZED" && resetEvent)
            check("orphan web cookie removed before retry", android.webkit.CookieManager.getInstance().getCookie(origin)?.contains("__Host-spa_session=") != true)
            check("orphan web reset creates no native credential", vault.read(origin) == null)
            val auth = AuthPlugin(PluginEnvironment(context, true, { _, _ -> }, { _ -> }, { _ -> }, { it() }))
            var status: JSONObject? = null
            runner.runOnMainSync { auth.invoke(PluginCallContext(Activity(), "suite", "status", JSONObject()), "auth.status", JSONObject()) { value, error -> if (error != null) throw error; status = value as? JSONObject } }
            check("disabled native auth status does not invent session", status?.optBoolean("configured") == false && status?.optBoolean("authenticated") == false)
            runner.runOnMainSync {
                check("orphan auth callback consumed without login", auth.consumeIntent(Intent().setData(Uri.parse("spahost-auth://callback?code=0123456789abcdef"))))
                check("ordinary route is not consumed by auth", !auth.consumeIntent(Intent().setData(Uri.parse("spahost://app/"))))
            }
            val activity = runner.startActivitySync(Intent(context, HostActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as HostActivity
            host = activity
            runner.runOnMainSync { activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
            while (System.nanoTime() < deadline && !activity.browserReady) Thread.sleep(100)
            check("real WebView document loaded", activity.browserReady)
            check("real bridge advertises auth actions", action("return (await platform.ready()).capabilities.includes('auth.signIn')") == true)
            check("bridge returns unconfigured native auth status", action("const r=await platform.call('auth.status',{});return r.configured===false&&r.authenticated===false&&!('accessToken'in r)&&!('refreshToken'in r)") == true)
            check("bridge rejects undeclared auth arguments", action("try{await platform.call('auth.signIn',{method:'oauth',provider:'test',extra:true});return 'bad'}catch(e){return e.code}") == "INVALID_REQUEST")
            check("disabled passkey action fails explicitly", action("try{await platform.call('auth.signIn',{method:'passkey'});return 'bad'}catch(e){return e.code}") == "UNAVAILABLE")
            check("failed auth releases native presentation lease", action("try{await platform.call('auth.signIn',{method:'passkey'});return 'bad'}catch(e){return e.code}") == "UNAVAILABLE")
            runner.runOnMainSync { activity.finish() }; host = null
            report.putString("status", "passed"); report.putInt("assertions", assertions)
            report.putString("limits", "No OAuth provider sign-in, passkey enrollment, native prompt interaction or hosted server session is implied.")
            runner.finish(Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            host?.let { activity -> runner.runOnMainSync { activity.finish() } }
            report.putString("status", "failed"); report.putInt("assertions", assertions); report.putString("error", error.toString()); report.putString("stack", error.stackTraceToString()); runner.finish(1, report)
        }
    }
    private fun js(source: String): Any? {
        val latch = CountDownLatch(1); var result: String? = null
        runner.runOnMainSync { host!!.webView.evaluateJavascript(source) { result = it; latch.countDown() } }
        if (!latch.await(5, TimeUnit.SECONDS)) throw AssertionError("WebView evaluation timed out")
        return result?.let { org.json.JSONTokener(it).nextValue().let { value -> if (value === JSONObject.NULL) null else value } }
    }
    private fun action(body: String): Any? {
        js("window.__authSuite=null;(async()=>{$body})().then(value=>window.__authSuite={ok:true,value},()=>window.__authSuite={ok:false});true")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            val value = js("JSON.stringify(window.__authSuite)") as? String
            if (value != null && value != "null") { val objectValue = JSONObject(value); if (!objectValue.getBoolean("ok")) throw AssertionError("Bridge action failed"); return objectValue.opt("value") }
            Thread.sleep(50)
        }
        throw AssertionError("Auth bridge action timed out")
    }
}
