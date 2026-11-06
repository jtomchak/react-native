package dev.spahost.prototype

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

internal data class HostTab(val id: String, val title: String, val path: String, val icon: String)
internal data class HostConfiguration(
    val contentMode: String = "packaged",
    val origin: String = HostActivity.ORIGIN,
    val initialPath: String = "/",
    val navigationMode: String = "web",
    val chromeMode: String = "standard",
    val maxSurfaces: Int = 8,
    val maxDepth: Int = 4,
    val backGestures: Boolean = true,
    val tabs: List<HostTab> = listOf(HostTab("overview", "Overview", "/", "house"), HostTab("compose", "Compose", "/compose/", "square.and.pencil"), HostTab("library", "Library", "/library/", "photo")),
    val notifications: JSONObject? = null,
    val analytics: AnalyticsConfiguration = AnalyticsConfiguration(),
    val plugins: JSONObject = JSONObject(),
    val pluginExtras: Map<String, String> = emptyMap(),
) {
    val hosted get() = contentMode == "hosted"
    fun runtimeConfiguration(): JSONObject = JSONObject().put("plugins", plugins).put("content", JSONObject().put("mode", contentMode).put("origin", origin).put("initialPath", initialPath))

    fun validRoute(path: String): Boolean {
        if (path.toByteArray().size > 2048 || !path.startsWith('/') || path.startsWith("//") || path.contains('#') || path.contains('\\') || path.any { it.code < 32 }) return false
        val uri = Uri.parse("$origin$path")
        if (!trusted(uri)) return false
        val encoded = uri.encodedPath ?: return false
        if (encoded in setOf("/", "/compose/", "/library/")) return true
        if (!hosted || !encoded.startsWith("/hosted/")) return false
        // Permit server-added routes without granting a new origin or accepting
        // ambiguous separator/traversal decoding at the native boundary.
        if (Regex("(?i)%(2f|5c)").containsMatchIn(encoded) || Regex("%(?![0-9a-fA-F]{2})").containsMatchIn(encoded)) return false
        val decoded = Uri.decode(encoded)
        if (decoded.contains('%') || decoded.contains('\\') || decoded.any { it.code < 32 } || decoded.split('/').any { it == "." || it == ".." }) return false
        return true
    }
    fun trusted(uri: Uri): Boolean {
        val expected = Uri.parse(origin)
        fun port(value: Uri) = if (value.port != -1) value.port else if (value.scheme == "https") 443 else 80
        return uri.scheme == expected.scheme && uri.host == expected.host && port(uri) == port(expected) && uri.userInfo == null
    }
    fun deepLink(uri: Uri): String? {
        if (uri.userInfo != null || uri.fragment != null) return null
        val canonicalScheme = uri.scheme == "spahost" && uri.host == "app" && uri.port == -1
        val appLink = hosted && uri.scheme == "https" && trusted(uri)
        if (!canonicalScheme && !appLink) return null
        val path = (uri.encodedPath?.ifEmpty { "/" } ?: "/") + (uri.encodedQuery?.let { "?$it" } ?: "")
        return path.takeIf { validRoute(it) }
    }
    companion object {
        fun load(context: Context, intent: Intent?): HostConfiguration {
            val raw = try { context.assets.open("web/host-config.json").bufferedReader().use { JSONObject(it.readText()) } }
                catch (_: java.io.FileNotFoundException) { JSONObject() }
            if (raw.length() > 0 && raw.optInt("schemaVersion") != 1) throw HostError("INVALID_REQUEST", "Invalid host configuration version")
            val content = raw.optJSONObject("content") ?: JSONObject()
            val nav = raw.optJSONObject("navigation") ?: JSONObject()
            val chrome = raw.optJSONObject("chrome") ?: JSONObject()
            var mode = content.optString("mode", "packaged")
            var origin = content.optString("origin", "").takeUnless { it == "null" || it.isEmpty() }
            var navigation = nav.optString("mode", "web")
            var chromeMode = chrome.optString("mode", "standard")
            if (BuildConfig.DEBUG && intent != null) {
                intent.getStringExtra("spa.content")?.let { mode = it }
                intent.getStringExtra("spa.hosted.url")?.let { origin = it }
                intent.getStringExtra("spa.navigation")?.let { navigation = it }
                intent.getStringExtra("spa.chrome")?.let { chromeMode = it }
                intent.getStringExtra("spa.dev.url")?.let { mode = "hosted"; origin = it }
            }
            if (mode !in setOf("packaged", "hosted") || navigation !in setOf("web", "native") || chromeMode !in setOf("standard", "tabs", "adaptive")) throw HostError("INVALID_REQUEST", "Unsupported host mode")
            val selectedOrigin = if (mode == "hosted") normalizeOrigin(origin ?: throw HostError("INVALID_REQUEST", "Hosted origin is not configured")) else HostActivity.ORIGIN
            val tabs = chrome.optJSONArray("tabs")?.let { array ->
                if (array.length() !in 1..5) throw HostError("INVALID_REQUEST", "Invalid native tabs")
                (0 until array.length()).map { index ->
                    val tab = array.getJSONObject(index)
                    val id = tab.getString("id"); val title = tab.getString("title"); val path = tab.getString("path"); val icon = tab.getString("icon")
                    if (!Regex("[a-z][a-z0-9-]{0,31}").matches(id) || title.isEmpty() || title.length > 64 || icon !in setOf("house", "square.and.pencil", "photo")) throw HostError("INVALID_REQUEST", "Invalid native tab")
                    HostTab(id, title, path, icon)
                }
            } ?: HostConfiguration().tabs
            if (tabs.map { it.id }.distinct().size != tabs.size) throw HostError("INVALID_REQUEST", "Duplicate native tab")
            val analyticsRaw = if (raw.has("analytics")) raw.optJSONObject("analytics") ?: throw HostError("INVALID_REQUEST", "Invalid analytics configuration") else null
            val config = HostConfiguration(mode, selectedOrigin, content.optString("initialPath", "/"), navigation, chromeMode,
                nav.optInt("maxLiveSurfaces", 8).coerceIn(1, 8), nav.optInt("maxDepthPerTab", 4).coerceIn(1, 4), chrome.optBoolean("backGestures", true), tabs, raw.optJSONObject("notifications"),
                AnalyticsConfiguration.parse(analyticsRaw, if (BuildConfig.DEBUG) intent?.getStringExtra("spa.analytics.origin") else null),
                if (raw.has("plugins")) raw.optJSONObject("plugins") ?: throw HostError("INVALID_REQUEST", "Invalid plugin configuration") else JSONObject(),
                if (BuildConfig.DEBUG && intent?.extras != null) intent.extras!!.keySet().filter { it.startsWith("spa.") }.mapNotNull { key -> (intent.extras!!.get(key) as? String)?.let { key to it } }.toMap() else emptyMap())
            if (config.chromeMode != "standard" && config.maxSurfaces < config.tabs.size) throw HostError("INVALID_REQUEST", "Surface limit cannot hold tab roots")
            if (!config.validRoute(config.initialPath) || tabs.any { !config.validRoute(it.path) }) throw HostError("INVALID_REQUEST", "Invalid configured route")
            return config
        }
        fun normalizeOrigin(value: String): String {
            val uri = Uri.parse(value)
            val localDebug = BuildConfig.DEBUG && uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1024..65535
            if ((!localDebug && uri.scheme != "https") || uri.host.isNullOrEmpty() || uri.userInfo != null || uri.encodedQuery != null || uri.fragment != null || uri.path !in listOf("", "/")) throw HostError("INVALID_REQUEST", "Invalid hosted origin")
            return value.trimEnd('/')
        }
    }
}
