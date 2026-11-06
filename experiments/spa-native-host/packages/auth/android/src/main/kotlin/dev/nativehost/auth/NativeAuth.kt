package dev.nativehost.auth

import dev.nativehost.pluginapi.PluginFailure

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.CookieManager
import androidx.browser.customtabs.CustomTabsIntent
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class AuthConfiguration(val enabled: Boolean = false, val origin: String? = null, val providers: List<String> = emptyList(), val rpId: String? = null) {
    companion object {
        fun parse(raw: JSONObject?, debugOrigin: String? = null, debug: Boolean = false): AuthConfiguration {
            if (raw == null && debugOrigin == null) return AuthConfiguration()
            val value = raw ?: JSONObject()
            if (value.keys().asSequence().any { it !in setOf("enabled", "origin", "providers", "rpId") } || (value.has("enabled") && value.opt("enabled") !is Boolean)) throw PluginFailure("INVALID_REQUEST", "Invalid auth configuration")
            val enabled = debugOrigin != null || value.optBoolean("enabled", false)
            val origin = debugOrigin ?: value.optString("origin").takeUnless { it.isEmpty() || it == "null" }
            val normalized = origin?.let { normalizeOrigin(it, debug) }
            val array = value.optJSONArray("providers")
            if (value.has("providers") && array == null) throw PluginFailure("INVALID_REQUEST", "Invalid auth providers")
            val providers = array?.let { (0 until it.length()).map { index -> it.opt(index) as? String ?: throw PluginFailure("INVALID_REQUEST", "Invalid auth provider") } } ?: emptyList()
            if (providers.size > 8 || providers.distinct().size != providers.size || providers.any { !Regex("[a-z][a-z0-9_-]{0,31}").matches(it) }) throw PluginFailure("INVALID_REQUEST", "Invalid auth providers")
            val rp = value.optString("rpId").takeUnless { it.isEmpty() || it == "null" }
            if (rp != null && (!Regex("[a-z0-9]+(?:[.-][a-z0-9]+)*").matches(rp) || rp.length > 253 || normalized == null || !(Uri.parse(normalized).host == rp || Uri.parse(normalized).host!!.endsWith(".$rp")))) throw PluginFailure("INVALID_REQUEST", "Invalid auth relying party")
            if (enabled && normalized == null) throw PluginFailure("INVALID_REQUEST", "Auth origin is required")
            return AuthConfiguration(enabled, normalized, if (debugOrigin != null && providers.isEmpty()) listOf("test") else providers, rp)
        }
        private fun normalizeOrigin(value: String, debug: Boolean): String {
            val uri = Uri.parse(value)
            val local = debug && uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1024..65535
            if ((!local && uri.scheme != "https") || uri.host.isNullOrEmpty() || uri.userInfo != null || uri.encodedQuery != null || uri.fragment != null || uri.path !in listOf("", "/")) throw PluginFailure("INVALID_REQUEST", "Invalid authentication origin")
            return value.trimEnd('/')
        }
    }
}

/** App-owned coordinator. No credentials, cookies, provider errors or tickets enter the bridge. */
internal class NativeAuth(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val network = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue<Runnable>(8))
    private val random = SecureRandom()
    private val vault = AuthVault(context)
    @Volatile private var pending: Operation? = null
    private var refreshing: Operation? = null
    var eventSink: ((JSONObject) -> Unit)? = null
    private class Operation(val owner: String, val request: String, val config: AuthConfiguration, val callback: (JSONObject?, PluginFailure?) -> Unit) {
        @Volatile var cancelled = false
        @Volatile var connection: HttpURLConnection? = null
        var signal: CancellationSignal? = null
        var verifier: String? = null
        var oauth = false
    }
    internal val isBusy get() = pending != null || refreshing != null
    internal val browserActive get() = pending?.oauth == true
    private fun active(op: Operation) = pending === op && !op.cancelled
    private fun finish(op: Operation, value: JSONObject? = null, error: PluginFailure? = null) {
        if (!active(op)) return
        pending = null; op.cancelled = true; op.signal?.cancel(); if (refreshing !== op) op.connection?.disconnect()
        op.callback(value, error)
    }
    fun cancel(owner: String, request: String? = null) {
        val op = pending ?: return
        if (op.owner == owner && (request == null || op.request == request)) finish(op, error = PluginFailure("CANCELLED", "Authentication operation cancelled"))
    }
    fun perform(activity: Activity, config: AuthCallConfiguration, owner: String, request: String, action: String, args: JSONObject, callback: (JSONObject?, PluginFailure?) -> Unit) {
        if (pending != null || refreshing != null) throw PluginFailure("BUSY", "Authentication operation active")
        val settings = config.auth
        if (!settings.enabled || settings.origin == null) {
            if (action == "auth.status") callback(JSONObject().put("authenticated", false).put("configured", false).put("providers", org.json.JSONArray()).put("passkeys", false), null)
            else throw PluginFailure("UNAVAILABLE", "Authentication is not configured")
            return
        }
        val op = Operation(owner, request, settings, callback); pending = op
        main.postDelayed({ if (active(op)) finish(op, error = PluginFailure("TIMEOUT", "Authentication operation timed out")) }, 115000)
        try {
            when (action) {
                "auth.status" -> {
                    val stored = vault.read(settings.origin)
                    if (stored == null) finish(op, status(settings, JSONObject().put("authenticated", false)))
                    else withAccess(op) { token -> post(op, "native/session", JSONObject(), token) { response, _ -> finish(op, status(settings, safeSession(response))) } }
                }
                "auth.signIn" -> {
                    if (vault.read(settings.origin) != null) throw PluginFailure("BUSY", "Sign out before starting another account session")
                    val cookieName = if (settings.origin.startsWith("http://")) "spa_dev_session" else "__Host-spa_session"
                    if (CookieManager.getInstance().getCookie(settings.origin)?.split(';')?.any { it.trim().startsWith("$cookieName=") } == true) {
                        clearCookie(settings.origin) {
                            eventSink?.invoke(JSONObject().put("authenticated", false))
                            finish(op, error = PluginFailure("UNAUTHORIZED", "Existing web session reset; retry sign-in from the fresh page"))
                        }
                        return
                    }
                    when (args.getString("method")) {
                        "oauth" -> {
                            val provider = args.optString("provider")
                            if (provider !in settings.providers) throw PluginFailure("INVALID_REQUEST", "OAuth provider is not configured")
                            val verifier = nonce(); op.verifier = verifier
                            post(op, "native/start", JSONObject().put("provider", provider).put("challenge", challenge(verifier)).put("callbackURL", "spahost-auth://callback")) { data, _ ->
                                val uri = Uri.parse(data.getString("authorizationURL"))
                                if (!sameOrigin(uri, settings.origin) || uri.path != "/api/auth/oauth/authorize/" || uri.fragment != null) throw PluginFailure("UNAUTHORIZED", "Invalid authorization endpoint")
                                op.oauth = true
                                try { CustomTabsIntent.Builder().build().launchUrl(activity, uri) }
                                catch (_: Exception) { finish(op, error = PluginFailure("UNAVAILABLE", "Authentication browser unavailable")) }
                            }
                        }
                        "passkey" -> passkey(activity, op, false)
                        else -> throw PluginFailure("INVALID_REQUEST", "Unsupported authentication method")
                    }
                }
                "auth.registerPasskey" -> passkey(activity, op, true)
                "auth.syncWebSession" -> {
                    if (!config.hosted || config.origin != settings.origin) throw PluginFailure("UNAVAILABLE", "Web session sync requires hosted content at the auth origin")
                    withAccess(op) { token ->
                        val verifier = nonce()
                        post(op, "native/web-ticket", JSONObject().put("challenge", challenge(verifier)).put("returnPath", config.initialPath), token) { data, _ ->
                            post(op, "native/web-session", JSONObject().put("ticket", data.getString("ticket")).put("verifier", verifier), token) { session, cookies ->
                                val cookie = cookies.singleOrNull { validSessionCookie(it, settings.origin) } ?: throw PluginFailure("UNAUTHORIZED", "Server did not issue a valid web session cookie")
                                CookieManager.getInstance().setCookie(settings.origin, cookie) { accepted ->
                                    if (active(op)) {
                                        if (accepted) { CookieManager.getInstance().flush(); finish(op, JSONObject().put("synchronized", true).put("session", safeSession(session))) }
                                        else finish(op, error = PluginFailure("IO_ERROR", "Unable to install web session"))
                                    }
                                }
                            }
                        }
                    }
                }
                "auth.signOut" -> {
                    val stored = vault.read(settings.origin); vault.clear(settings.origin)
                    clearCookie(settings.origin) {
                        eventSink?.invoke(JSONObject().put("authenticated", false))
                        if (stored == null) finish(op, JSONObject().put("authenticated", false).put("revoked", true))
                        else post(op, "native/logout", JSONObject(), stored.getString("accessToken"), failure = { error ->
                            if (error.code != "UNAUTHORIZED") finish(op, JSONObject().put("authenticated", false).put("revoked", false))
                            else post(op, "native/refresh", JSONObject().put("refreshToken", stored.getString("refreshToken")), failure = { finish(op, JSONObject().put("authenticated", false).put("revoked", false)) }) { replacement, _ ->
                                // Local vault stays cleared; this replacement exists
                                // solely to revoke the server-side device group.
                                post(op, "native/logout", JSONObject(), replacement.getString("accessToken"), failure = { finish(op, JSONObject().put("authenticated", false).put("revoked", false)) }) { _, _ -> finish(op, JSONObject().put("authenticated", false).put("revoked", true)) }
                            }
                        }) { _, _ -> finish(op, JSONObject().put("authenticated", false).put("revoked", true)) }
                    }
                }
                else -> throw PluginFailure("UNSUPPORTED", "Unsupported auth action")
            }
        } catch (error: Exception) { finish(op, error = error as? PluginFailure ?: PluginFailure("IO_ERROR", "Authentication operation failed")) }
    }
    fun browserReturned() {
        val op = pending ?: return
        if (op.oauth) finish(op, error = PluginFailure("CANCELLED", "Authentication browser closed"))
    }
    fun consumeCallback(intent: Intent): Boolean {
        val uri = intent.data ?: return false
        if (uri.scheme != "spahost-auth" || uri.host != "callback") return false
        val op = pending
        if (op == null || !op.oauth || !active(op)) return true
        if (uri.port != -1 || uri.userInfo != null || !uri.path.isNullOrEmpty() || uri.fragment != null || uri.queryParameterNames != setOf("code") || uri.getQueryParameters("code").size != 1) { finish(op, error = PluginFailure("UNAUTHORIZED", "Invalid authentication callback")); return true }
        val code = uri.getQueryParameter("code") ?: ""
        if (!Regex("[A-Za-z0-9_-]{16,512}").matches(code)) { finish(op, error = PluginFailure("UNAUTHORIZED", "Invalid authentication callback")); return true }
        op.oauth = false
        post(op, "native/redeem", JSONObject().put("code", code).put("verifier", op.verifier)) { data, _ -> install(op, data) }
        return true
    }
    private fun passkey(activity: Activity, op: Operation, register: Boolean) {
        if (Build.VERSION.SDK_INT < 28 || op.config.rpId == null) throw PluginFailure("UNAVAILABLE", "Passkeys are not configured or supported")
        val begin: (String?) -> Unit = { token ->
            post(op, "passkeys/options", JSONObject().put("operation", if (register) "register" else "authenticate"), token) { data, _ ->
                val options = data.getJSONObject("options")
                val rp = if (register) options.getJSONObject("rp").getString("id") else options.getString("rpId")
                if (rp != op.config.rpId) throw PluginFailure("UNAUTHORIZED", "Unexpected passkey relying party")
                val manager = CredentialManager.create(activity); val signal = CancellationSignal(); op.signal = signal
                val executor = java.util.concurrent.Executor { main.post(it) }
                fun verify(json: String) {
                    if (!active(op)) return
                    post(op, "passkeys/verify", JSONObject().put("transaction", data.getString("transaction")).put("credential", JSONObject(json)), token) { result, _ ->
                        if (register) finish(op, JSONObject().put("registered", result.getBoolean("registered"))) else install(op, result)
                    }
                }
                if (register) manager.createCredentialAsync(activity, CreatePublicKeyCredentialRequest(options.toString()), signal, executor,
                    object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                        override fun onResult(result: CreateCredentialResponse) { if (result is CreatePublicKeyCredentialResponse) verify(result.registrationResponseJson) else finish(op, error = PluginFailure("UNAVAILABLE", "Passkey creation unavailable")) }
                        override fun onError(e: CreateCredentialException) { finish(op, error = credentialError(e.type)) }
                    })
                else manager.getCredentialAsync(activity, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(options.toString()))), signal, executor,
                    object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                        override fun onResult(result: GetCredentialResponse) { val credential = result.credential; if (credential is PublicKeyCredential) verify(credential.authenticationResponseJson) else finish(op, error = PluginFailure("UNAVAILABLE", "Passkey unavailable")) }
                        override fun onError(e: GetCredentialException) { finish(op, error = credentialError(e.type)) }
                    })
            }
        }
        if (register) withAccess(op) { begin(it) } else begin(null)
    }
    private fun credentialError(type: String) = PluginFailure(if (type.contains("CANCEL", true)) "CANCELLED" else "UNAVAILABLE", "Passkey operation did not complete")
    private fun install(op: Operation, credentials: JSONObject) {
        val session = safeSession(credentials.getJSONObject("session"))
        // An old web cookie may outlive a missing native vault. Clear it
        // before installing a different native identity; future navigations can
        // render only anonymous content until explicit web-session sync.
        clearCookie(op.config.origin!!) {
            if (active(op)) try {
                persistCredentials(op.config.origin, credentials)
                eventSink?.invoke(session); finish(op, session)
            } catch (error: Exception) { finish(op, error = error as? PluginFailure ?: PluginFailure("IO_ERROR", "Unable to retain session")) }
        }
    }
    private fun withAccess(op: Operation, done: (String) -> Unit) {
        val credentials = vault.read(op.config.origin!!) ?: throw PluginFailure("UNAUTHORIZED", "Sign in first")
        val token = credentials.getString("accessToken")
        post(op, "native/session", JSONObject(), token, failure = { problem ->
            if (problem.code != "UNAUTHORIZED") finish(op, error = problem)
            else post(op, "native/refresh", JSONObject().put("refreshToken", credentials.getString("refreshToken")), failure = { refreshError ->
                if (refreshError.code == "UNAUTHORIZED") { vault.clear(op.config.origin); eventSink?.invoke(JSONObject().put("authenticated", false)) }
                finish(op, error = refreshError)
            }) { data, _ ->
                persistCredentials(op.config.origin, data)
                done(data.getString("accessToken"))
            }
        }) { session, _ ->
            if (safeSession(session).optBoolean("authenticated")) done(token)
            else finish(op, error = PluginFailure("UNAUTHORIZED", "Session is no longer authenticated"))
        }
    }
    private fun persistCredentials(origin: String, data: JSONObject) {
        if (!safeSession(data.getJSONObject("session")).getBoolean("authenticated")) throw PluginFailure("UNAUTHORIZED", "Invalid session")
        for (key in listOf("accessToken", "refreshToken")) if (!Regex("[A-Za-z0-9._~-]{16,4096}").matches(data.getString(key))) throw PluginFailure("UNAUTHORIZED", "Invalid session credential")
        vault.write(origin, JSONObject().put("accessToken", data.getString("accessToken")).put("refreshToken", data.getString("refreshToken")))
    }
    private fun post(op: Operation, path: String, body: JSONObject, token: String? = null, failure: ((PluginFailure) -> Unit)? = null, done: (JSONObject, List<String>) -> Unit) {
        if (!active(op)) return
        if (path == "native/refresh") refreshing = op
        try { network.execute {
            if (!active(op) && path != "native/refresh") return@execute
            val result = runCatching {
                val connection = URL(op.config.origin + "/api/auth/" + path + "/").openConnection() as HttpURLConnection
                op.connection = connection
                try {
                    if (!active(op) && path != "native/refresh") throw PluginFailure("CANCELLED", "Authentication operation cancelled")
                    connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 15000
                    connection.requestMethod = "POST"; connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
                    token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
                    connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                    val code = connection.responseCode
                    val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                    val bytes = stream?.use {
                        val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(4096)
                        while (output.size() <= 65536) { val count = it.read(buffer); if (count < 0) break; output.write(buffer, 0, count) }
                        output.toByteArray()
                    } ?: byteArrayOf()
                    if (bytes.size > 65536) throw PluginFailure("QUOTA_EXCEEDED", "Authentication response too large")
                    val json = JSONObject(String(bytes, Charsets.UTF_8))
                    if (code !in 200..299) {
                        val problem = json.optJSONObject("error")?.optString("code") ?: "IO_ERROR"
                        throw PluginFailure(if (problem in setOf("UNAUTHORIZED", "UNAVAILABLE", "INVALID_REQUEST", "BUSY", "CANCELLED", "TIMEOUT", "CONFLICT")) problem else "IO_ERROR", "Authentication request did not succeed")
                    }
                    json to (connection.headerFields.entries.firstOrNull { it.key.equals("Set-Cookie", true) }?.value ?: emptyList())
                } finally { connection.disconnect(); op.connection = null }
            }
            main.post {
                // A cancelled refresh may already have rotated on the server.
                // Checkpoint its replacement only if the same credential remains
                // installed; never resurrect a signed-out or different session.
                if (path == "native/refresh") result.getOrNull()?.first?.let { data ->
                    runCatching { if (vault.read(op.config.origin!!)?.optString("refreshToken") == body.optString("refreshToken")) persistCredentials(op.config.origin, data) }
                }
                if (refreshing === op && path == "native/refresh") refreshing = null
                if (!active(op)) return@post
                result.fold({ (json, cookies) -> try { done(json, cookies) } catch (e: Exception) { finish(op, error = e as? PluginFailure ?: PluginFailure("IO_ERROR", "Invalid authentication response")) } },
                    { error -> val problem = error as? PluginFailure ?: PluginFailure("IO_ERROR", "Authentication service unavailable"); if (failure != null) failure(problem) else finish(op, error = problem) })
            }
        } } catch (_: java.util.concurrent.RejectedExecutionException) {
            if (refreshing === op && path == "native/refresh") refreshing = null
            finish(op, error = PluginFailure("BUSY", "Authentication network queue is full"))
        }
    }
    private fun status(config: AuthConfiguration, session: JSONObject) = session.put("configured", true).put("providers", org.json.JSONArray(config.providers)).put("passkeys", Build.VERSION.SDK_INT >= 28 && config.rpId != null)
    private fun safeSession(raw: JSONObject): JSONObject {
        if (raw.opt("authenticated") != true) return JSONObject().put("authenticated", false)
        val user = raw.getJSONObject("user"); val id = user.getString("id"); val name = user.getString("name")
        if (id.isEmpty() || id.length > 256 || name.length > 256 || raw.opt("expiresAt") !is Number) throw PluginFailure("UNAUTHORIZED", "Invalid session summary")
        return JSONObject().put("authenticated", true).put("user", JSONObject().put("id", id).put("name", name)).put("expiresAt", raw.getLong("expiresAt"))
    }
    private fun nonce(): String = ByteArray(32).also { random.nextBytes(it) }.let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
    private fun challenge(verifier: String): String = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    private fun clearCookie(origin: String, done: () -> Unit) {
        val name = if (origin.startsWith("http://")) "spa_dev_session" else "__Host-spa_session"
        CookieManager.getInstance().setCookie(origin, "$name=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" + if (origin.startsWith("https://")) "; Secure" else "") { CookieManager.getInstance().flush(); done() }
    }
    companion object {
        internal fun sameOrigin(uri: Uri, origin: String): Boolean {
            val expected = Uri.parse(origin)
            fun port(value: Uri) = if (value.port == -1) if (value.scheme == "https") 443 else 80 else value.port
            return uri.scheme == expected.scheme && uri.host == expected.host && port(uri) == port(expected) && uri.userInfo == null
        }
        internal fun validSessionCookie(cookie: String, origin: String): Boolean {
            if (cookie.length > 8192 || cookie.any { it == '\r' || it == '\n' }) return false
            val parts = cookie.split(';').map { it.trim() }; val first = parts.firstOrNull() ?: return false
            val secure = origin.startsWith("https://")
            val name = if (secure) "__Host-spa_session" else "spa_dev_session"
            if (!first.startsWith("$name=") || !Regex("[A-Za-z0-9._~-]{16,4096}").matches(first.substringAfter('='))) return false
            val attrs = parts.drop(1).map { it.lowercase() }
            return attrs.contains("httponly") && attrs.contains("path=/") && attrs.contains("samesite=lax") && (!secure || attrs.contains("secure")) && attrs.none { it.startsWith("domain=") }
        }
    }
}

/** AES-GCM ciphertext is origin-scoped; its non-exportable key stays in Android Keystore. */
class AuthVault(context: Context) {
    private val prefs = context.getSharedPreferences("native-auth", Context.MODE_PRIVATE)
    private val alias = "dev.spahost.prototype.auth.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()) }.generateKey()
    }
    private fun slot(origin: String) = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(origin.toByteArray()), Base64.NO_WRAP)
    fun read(origin: String): JSONObject? {
        val encoded = prefs.getString(slot(origin), null) ?: return null
        try {
            val bytes = Base64.decode(encoded, Base64.NO_WRAP); if (bytes.size !in 29..16384) throw IllegalStateException()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))); cipher.updateAAD(origin.toByteArray())
            return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        } catch (_: Exception) { clear(origin); throw PluginFailure("UNAUTHORIZED", "Stored authentication session is unavailable") }
    }
    fun write(origin: String, value: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(origin.toByteArray())
        val encrypted = cipher.iv + cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
        if (!prefs.edit().putString(slot(origin), Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) throw PluginFailure("IO_ERROR", "Unable to persist authentication session")
    }
    fun clear(origin: String) { if (!prefs.edit().remove(slot(origin)).commit()) throw PluginFailure("IO_ERROR", "Unable to clear authentication session") }
}
