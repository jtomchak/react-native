package dev.spahost.prototype

import android.Manifest
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.bottomnavigation.BottomNavigationView
import dev.nativehost.pluginapi.PluginAction
import dev.nativehost.pluginapi.PluginCallContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.net.URLConnection
import java.util.UUID
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

/** Native shell owns screens; each screen independently owns its WebView/session. */
class HostActivity : ComponentActivity() {
    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        private const val MAX_WIRE = 128 * 1024
        private val ACTIONS = listOf("haptics.impact", "storage.get", "storage.set", "storage.remove", "navigation.update", "navigation.back", "navigation.present", "navigation.dismiss", "toolbar.set", "toolbar.clear", "camera.capture", "files.previewURL", "files.remove", "cancel", "chrome.state", "chrome.update", "chrome.selectTab", "events.subscribe", "events.unsubscribe", "notifications.status", "notifications.requestPermission", "notifications.register", "links.getInitial", "share.present", "biometrics.status", "biometrics.authenticate", "analytics.track", "analytics.observe", "analytics.status", "analytics.flush")
        private val UI_ACTIONS = setOf("haptics.impact", "navigation.update", "navigation.back", "navigation.present", "navigation.dismiss", "navigation.visit", "toolbar.set", "toolbar.clear", "chrome.update", "chrome.selectTab", "camera.capture", "share.present", "biometrics.authenticate", "notifications.requestPermission", "notifications.register", "analytics.track", "analytics.observe", "analytics.status", "analytics.flush")
        private val EXTERNAL_EVENTS = setOf("navigation.changed", "chrome.tabSelected", "links.opened", "notifications.token", "notifications.received", "notifications.opened")
        private val ID = Regex("[!-~]{1,128}")
        private val PHOTO = Regex("[a-f0-9-]{36}\\.jpg")
    }
    private lateinit var configuration: HostConfiguration
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var storage: Storage
    private lateinit var analytics: NativeAnalytics
    private val plugins get() = (application as HostApplication).plugins
    private var pluginRequest: Request? = null
    private var contentEpoch = 0
    private var analyticsScreen: String? = null
    private lateinit var root: LinearLayout
    private lateinit var content: FrameLayout
    private lateinit var titleView: TextView
    private lateinit var toolbar: LinearLayout
    private var tabsView: BottomNavigationView? = null
    private val stacks = linkedMapOf<String, MutableList<Surface>>()
    private var activeTab = "overview"
    private var active: Surface? = null
    private var receiving: Surface? = null
    private var foreground = false
    private var keyboardVisible = false
    private var pushObserver: ((String, JSONObject) -> Unit)? = null
    private var destroyed = false
    private var diskOutstanding = 0
    private var modal: AlertDialog? = null
    private var modalSurface: Surface? = null
    private var visitDialog: com.google.android.material.bottomsheet.BottomSheetDialog? = null
    private var pendingExternalRoute: String? = null
    private var presentationOwner: Pair<String, String>? = null
    private var sharingPaused = false
    private var biometricSignal: CancellationSignal? = null
    private var biometricRequest: Request? = null
    private var permissionRequest: Request? = null
    private var photoFile: File? = null
    private var cameraRequest: Request? = null
    private var initialLink: String? = null
    private var predictiveSurface: Surface? = null
    private var predictivePrevious: Surface? = null
    private var predictiveRevision = 0
    private var stackRevision = 0
    private var selectingTab = false
    private lateinit var backCallback: OnBackPressedCallback
    private val photos by lazy { File(filesDir, "photos").apply { mkdirs() } }
    private val camera = registerForActivityResult(ActivityResultContracts.TakePicture()) { success -> finishPhoto(success) }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val req = permissionRequest; permissionRequest = null
        getSharedPreferences("native-permissions", MODE_PRIVATE).edit().putBoolean("notifications.requested", true).apply()
        req?.let { releasePresentation(it); respond(it, JSONObject().put("authorization", if (granted) "authorized" else "denied")) }
    }
    private data class Request(val id: String, val document: String, val session: String, val action: String, val args: JSONObject, val proxy: JavaScriptReplyProxy, val surface: Surface, val startedNanos: Long = System.nanoTime(), var admitted: Boolean = false, var analyticsRecorded: Boolean = false)
    private inner class Surface(val tab: String, val initialPath: String, val modalVisit: Boolean = false) {
        val id = UUID.randomUUID().toString()
        lateinit var view: WebView
        var document: String? = null
        var session: String? = null
        var proxy: JavaScriptReplyProxy? = null
        val retired = LinkedHashSet<String>()
        val seen = HashSet<String>()
        val analyticsLane = AnalyticsRequestLane()
        val pending = HashMap<String, Request>()
        val subscriptions = linkedMapOf<String, String>()
        var route = initialPath
        var title = configuration.tabs.firstOrNull { it.id == tab }?.title ?: "Native actions"
        var routeTitle = title
        var canGoBack = false
        var registration: String? = null
        var toolbarActions = emptyList<Pair<String, String>>()
        var toolbarHidden = false
        var tabBarHidden = false
        var statusBarStyle = "default"
        var navigationToken: String? = null
        var backRequest: Request? = null
        var exhausted = false
        var disposed = false
        var rendererGone = false
        var contentEpoch = this@HostActivity.contentEpoch
        var loadedContentEpoch = this@HostActivity.contentEpoch
        var errorPanel: View? = null
        var modalToolbar: LinearLayout? = null
        var modalTitle: TextView? = null
        @Volatile var ready = false
        @Volatile var completedURL: String? = null
    }
    private val source get() = receiving ?: active ?: error("No active surface")
    internal val webView get() = active!!.view
    internal val browserReady get() = active?.ready ?: false
    internal val completedDocumentURL get() = active?.completedURL
    internal val nativeToolbar get() = active?.modalToolbar ?: toolbar
    internal val liveSurfaceCount get() = stacks.values.sumOf { it.size } + if (modalSurface != null) 1 else 0
    internal var predictiveStarts = 0
        private set
    internal var predictiveProgressEvents = 0
        private set
    internal var predictiveCancels = 0
        private set
    internal var predictiveCommits = 0
        private set
    internal var hapticInvocations = 0
        private set
    private val appOrigin get() = configuration.origin
    // Dispatch aliases are synchronous only; async callbacks always use Request.surface.
    private var route: String get() = source.route; set(v) { source.route = v }
    private var canGoBack: Boolean get() = source.canGoBack; set(v) { source.canGoBack = v }
    private var registration: String? get() = source.registration; set(v) { source.registration = v }
    private var navigationToken: String? get() = source.navigationToken; set(v) { source.navigationToken = v }
    private var backRequest: Request? get() = source.backRequest; set(v) { source.backRequest = v }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try { configuration = HostConfiguration.load(this, intent) }
        catch (_: Exception) { setContentView(TextView(this).apply { text = "Invalid native host configuration" }); return }
        analytics = (application as HostApplication).analytics
        analytics.configure(configuration.analytics)
        plugins.bind(this, { name, value -> publish(name, value) },
            { _ -> invalidateContentSurfaces() },
            { _ -> main.post { if (!destroyed) active?.let { refreshContentSurface(it) } } })
        plugins.consumeIntent(intent)
        storage = Storage(this)
        val initialTap = NativePushState.consumeTap(this, intent)
        initialLink = deepLink(intent) ?: initialTap?.first?.takeIf { validRoute(it) }
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE); fitsSystemWindows = true }
        toolbar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(12, 8, 12, 8); setBackgroundColor(Color.rgb(234, 240, 248)) }
        toolbar.addView(Button(this).apply { text = "Back"; contentDescription = "Native Back"; setOnClickListener { nativeBack(null) } })
        titleView = TextView(this).apply { text = "SPA Native Host"; textSize = 19f; setTextColor(Color.rgb(20, 35, 60)); gravity = android.view.Gravity.CENTER_VERTICAL }
        toolbar.addView(titleView, LinearLayout.LayoutParams(0, -1, 1f))
        root.addView(toolbar, LinearLayout.LayoutParams(-1, 60.dp))
        content = FrameLayout(this)
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        if (configuration.chromeMode != "standard") {
            tabsView = BottomNavigationView(this).apply {
                id = View.generateViewId(); contentDescription = "Native tab bar"
                configuration.tabs.forEachIndexed { index, tab ->
                    menu.add(0, index + 1, index, tab.title).setIcon(when (tab.icon) { "photo" -> android.R.drawable.ic_menu_gallery; "square.and.pencil" -> android.R.drawable.ic_menu_edit; else -> android.R.drawable.ic_menu_view })
                }
                setOnItemSelectedListener { item ->
                    if (selectingTab) true else try { selectTab(configuration.tabs[item.itemId - 1].id); true }
                    catch (error: HostError) { nativeError(error); false }
                }
            }
            root.addView(tabsView, LinearLayout.LayoutParams(-1, -2))
        }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets -> keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime()); updateBackCallback(); insets }
        photos.listFiles()?.filter { it.name.endsWith(".pending.jpg") }?.forEach { it.delete() }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) { titleView.text = "WebView update required"; return }
        configuration.tabs.forEach { stacks[it.id] = mutableListOf() }
        activeTab = configuration.tabs.first().id
        val restored = getSharedPreferences("host", MODE_PRIVATE).getString("route", configuration.initialPath)
        val path = initialLink ?: restored?.takeIf { validRoute(it) } ?: configuration.initialPath
        if (configuration.chromeMode != "standard") activeTab = configuration.tabs.firstOrNull { it.path.substringBefore('?') == path.substringBefore('?') }?.id ?: activeTab
        showSurface(createSurface(activeTab, path))
        tabsView?.selectedItemId = configuration.tabs.indexOfFirst { it.id == activeTab } + 1
        backCallback = object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() { if (predictiveSurface != null) predictiveCommits++; commitPredictive(); nativeBack(null, hardware = true) }
            override fun handleOnBackStarted(backEvent: BackEventCompat) { predictiveStarts++; beginPredictive() }
            override fun handleOnBackProgressed(backEvent: BackEventCompat) { predictiveProgressEvents++; progressPredictive(backEvent.progress) }
            override fun handleOnBackCancelled() { predictiveCancels++; cancelPredictive() }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
        updateBackCallback()
        pushObserver = { event, data -> main.post { publish(event, data) } }
        NativePushState.observe(this, pushObserver!!)
        initialTap?.let { (_, data) -> publish("notifications.opened", data) }
    }
    override fun onResume() {
        super.onResume(); foreground = true
        if (::configuration.isInitialized) plugins.resumed(this)
        if (sharingPaused) { sharingPaused = false; presentationOwner = null }
        if (::configuration.isInitialized) { pendingExternalRoute?.let { path -> pendingExternalRoute = null; routeLink(path) }; drainEvents() }
    }
    override fun onPause() { if (::configuration.isInitialized) plugins.paused(this); foreground = false; biometricSignal?.cancel(); if (presentationOwner != null && biometricRequest == null && cameraRequest == null && permissionRequest == null && pluginRequest == null) sharingPaused = true; super.onPause() }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        if (plugins.consumeIntent(intent)) return
        deepLink(intent)?.let { path -> if (foreground) routeLink(path) else pendingExternalRoute = path }
        NativePushState.consumeTap(this, intent)?.let { (path, payload) -> publish("notifications.opened", payload); if (validRoute(path)) { if (foreground) routeLink(path) else pendingExternalRoute = path } }
    }
    private fun capabilities() = ACTIONS + plugins.actions.keys + if (configuration.navigationMode == "native") listOf("navigation.visit") else emptyList()
    private fun hostMetadata(s: Surface) = JSONObject().put("apiVersion", 2).put("contentMode", configuration.contentMode).put("navigationMode", configuration.navigationMode).put("chromeMode", configuration.chromeMode).put("surfaceId", s.id).put("activeTab", s.tab)
    private fun isForeground(s: Surface) = foreground && !destroyed && !s.disposed && active === s
    private fun validRoute(path: String) = configuration.validRoute(path)
    private fun trusted(uri: Uri) = configuration.trusted(uri)
    private fun deepLink(intent: Intent): String? = intent.data?.let { configuration.deepLink(it) }
    private fun routeLink(path: String) {
        if (!validRoute(path)) return
        if (predictiveSurface != null || presentationOwner != null || photoFile != null || modal != null) { pendingExternalRoute = path; return }
        if (modalSurface != null) popSurface()
        try {
            val tab = configuration.tabs.firstOrNull { it.path.substringBefore('?') == path.substringBefore('?') }?.id ?: activeTab
            if (configuration.chromeMode != "standard" && tab != activeTab) selectTab(tab)
            active?.let { s ->
                if (configuration.navigationMode == "native" && s.route != path) nativeVisit(s, path, "push")
                else s.view.loadUrl(appOrigin + path)
            }
            publish("links.opened", JSONObject().put("path", path))
        } catch (error: HostError) {
            nativeError(error)
            publish("links.opened", JSONObject().put("path", path).put("error", error.code))
        }
    }
    private fun createSurface(tab: String, path: String, modalVisit: Boolean = false): Surface {
        val stack = stacks.getValue(tab)
        // Reserve a root slot for every unopened configured tab; filling one
        // stack must not make the native tab bar crash or strand a destination.
        val reservedRoots = if (configuration.chromeMode == "standard") 0 else stacks.count { (id, items) -> id != tab && items.isEmpty() }
        if (liveSurfaceCount + 1 + reservedRoots > configuration.maxSurfaces) fail("QUOTA_EXCEEDED", "Native surface capacity exceeded")
        if (!modalVisit && stack.size >= configuration.maxDepth) fail("QUOTA_EXCEEDED", "Native stack capacity exceeded")
        val s = Surface(tab, path, modalVisit)
        installWebView(s)
        if (modalVisit) modalSurface = s else stack.add(s)
        s.view.visibility = View.GONE
        if (!modalVisit) content.addView(s.view, FrameLayout.LayoutParams(-1, -1))
        s.view.loadUrl(appOrigin + path)
        return s
    }
    private fun installWebView(s: Surface) {
        s.view = WebView(this).apply {
            settings.javaScriptEnabled = true; settings.domStorageEnabled = true
            settings.allowFileAccess = false; settings.allowContentAccess = false; settings.setSupportMultipleWindows(false)
            contentDescription = "Native web surface ${s.id}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        WebViewCompat.addWebMessageListener(s.view, "__spaNative", setOf(appOrigin)) { view, message, origin, mainFrame, proxy ->
            if (view === s.view && mainFrame && configuration.trusted(origin)) receive(s, message.data ?: "", proxy)
        }
        val sdk = assets.open("web/platform-sdk.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
        val bootstrap = """
          if(window.top===window){
          Object.defineProperty(window,'__SPA_TRANSPORT__',{value:Object.freeze({postMessage(value){window.__spaNative.postMessage(value)}}),writable:false,configurable:false});
          window.__spaNative.onmessage=e=>{try{const value=JSON.parse(e.data);if(typeof window.__spaReceive==='function')window.__spaReceive(value)}catch(_){}};
        """.trimIndent() + "\n" + sdk + "\n}"
        WebViewCompat.addDocumentStartJavaScript(s.view, bootstrap, setOf(appOrigin))
        s.view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = if (view === s.view) resource(request.url) else null
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (view !== s.view) return true
                if (!request.isForMainFrame) return !trusted(request.url)
                if (trusted(request.url)) return false
                if (request.url.scheme == "https") runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
            override fun onPageStarted(view: WebView, url: String?, icon: android.graphics.Bitmap?) { if (view === s.view) { invalidateDocument(s); s.ready = false; s.completedURL = null } }
            override fun onPageCommitVisible(view: WebView, url: String?) {
                if (view === s.view && configuration.hosted && s.loadedContentEpoch == contentEpoch && !s.disposed) { s.contentEpoch = contentEpoch; view.alpha = 1f; view.isEnabled = true; view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO; if (active !== s && predictivePrevious !== s) view.visibility = View.GONE }
            }
            override fun onPageFinished(view: WebView, url: String?) { if (view === s.view) { s.ready = true; s.completedURL = url } }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) { if (view === s.view && request.isForMainFrame && active === s) showLoadFailure(s) }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, error: WebResourceResponse) { if (view === s.view && request.isForMainFrame && active === s && error.statusCode >= 400) showLoadFailure(s) }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean { if (view === s.view) { s.rendererGone = true; invalidateDocument(s); showLoadFailure(s) }; return true }
        }
    }
    private fun showSurface(s: Surface) {
        cancelPredictive()
        active?.takeIf { it !== s }?.view?.apply { if (!s.modalVisit) visibility = View.GONE; onPause() }
        refreshContentSurface(s)
        active = s; s.view.visibility = View.VISIBLE; s.view.onResume(); s.view.bringToFront()
        renderToolbar(s); applyAppearance(s); updateBackCallback(); stackRevision++
        externalEvent(s, "navigation.changed", JSONObject().put("reason", "activated").put("host", hostMetadata(s)).put("path", s.route).put("depth", stacks[s.tab]?.size ?: 1))
        captureScreen(s)
        drainEvents()
    }
    private fun invalidateContentSurfaces() {
        if (!configuration.hosted) return
        cancelPredictive(); contentEpoch++
        configuration.tabs.indices.forEach { tabsView?.removeBadge(it + 1) }
        for (surface in stacks.values.flatMap { it.toList() } + listOfNotNull(modalSurface)) {
            surface.contentEpoch = -1; surface.loadedContentEpoch = -1
            surface.view.alpha = 0f
            surface.view.isEnabled = false
            surface.view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            surface.title = "Native actions"; surface.routeTitle = "Native actions"
            surface.registration = null; surface.toolbarActions = emptyList()
        }
        // Concealment alone is insufficient: old pages must not keep timers
        // or fetch loops alive when a new account cookie is later installed.
        for (surface in stacks.values.flatMap { it.toList() } + listOfNotNull(modalSurface)) if (surface !== active) retireContentSurface(surface)
        active?.let { renderToolbar(it) }
    }
    private fun retireContentSurface(surface: Surface) {
        if (surface.disposed) return
        val old = surface.view; val parent = old.parent as? ViewGroup
        val index = parent?.indexOfChild(old) ?: -1; val layout = old.layoutParams
        val visibility = old.visibility
        invalidateDocument(surface)
        installWebView(surface)
        surface.loadedContentEpoch = -1; surface.ready = false; surface.completedURL = null
        surface.view.alpha = 0f; surface.view.visibility = visibility; surface.view.isEnabled = false
        surface.view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        if (parent != null && index >= 0) { parent.removeView(old); parent.addView(surface.view, index, layout) }
        old.stopLoading(); old.destroy()
    }
    private fun refreshContentSurface(surface: Surface) {
        if (!configuration.hosted || surface.contentEpoch == contentEpoch || surface.disposed || surface.loadedContentEpoch == contentEpoch) return
        // Replace the widget, not just its URL: queued callbacks from an older
        // same-URL navigation can never reveal the old DOM under a new identity.
        retireContentSurface(surface)
        surface.loadedContentEpoch = contentEpoch
        surface.view.loadUrl(appOrigin + surface.route)
    }
    private fun captureScreen(s: Surface) {
        val key = s.id + ":" + s.route.substringBefore('?')
        if (analyticsScreen != key) { analyticsScreen = key; analytics.record("navigation", "navigation.screen", JSONObject().put("screen", NativeAnalytics.screen(s.route)).put("tab", s.tab).put("state", "committed")) }
    }
    private fun renderToolbar(s: Surface) {
        val bar = s.modalToolbar ?: toolbar
        (s.modalTitle ?: titleView).text = s.title
        while (bar.childCount > 2) bar.removeViewAt(2)
        s.toolbarActions.forEach { (id, title) -> bar.addView(Button(this).apply { text = title; contentDescription = "Native $title"; setOnClickListener { s.registration?.let { reg -> if (isForeground(s)) event(s, "toolbar.action", JSONObject().put("registration", reg).put("id", id)) } } }) }
        if (s.modalVisit) bar.addView(Button(this).apply { text = "Done"; contentDescription = "Native Done"; setOnClickListener { if (active === s) popSurface() } })
    }
    private fun applyAppearance(s: Surface) {
        (s.modalToolbar ?: toolbar).visibility = if (s.toolbarHidden) View.GONE else View.VISIBLE
        tabsView?.visibility = if (s.tabBarHidden) View.GONE else View.VISIBLE
        val targetWindow = if (s.modalVisit) visitDialog?.window ?: window else window
        androidx.core.view.WindowCompat.getInsetsController(targetWindow, targetWindow.decorView).isAppearanceLightStatusBars = s.statusBarStyle != "light"
    }
    private fun selectTab(id: String) {
        if (predictiveSurface != null || presentationOwner != null || modal != null || modalSurface != null) fail("BUSY", "Native transition active")
        val tab = configuration.tabs.firstOrNull { it.id == id } ?: fail("INVALID_REQUEST", "Unknown native tab")
        val next = stacks.getValue(id).lastOrNull() ?: createSurface(id, tab.path)
        // Admission and creation succeeded before changing the active identity.
        val changed = activeTab != tab.id
        activeTab = tab.id
        showSurface(next)
        if (changed) analytics.record("navigation", "navigation.tab", JSONObject().put("tab", id).put("state", "selected"))
        selectingTab = true
        try { tabsView?.selectedItemId = configuration.tabs.indexOfFirst { it.id == id } + 1 } finally { selectingTab = false }
        externalEvent(next, "chrome.tabSelected", JSONObject().put("id", id).put("host", hostMetadata(next)))
    }
    private fun nativeError(error: HostError) {
        android.widget.Toast.makeText(this, error.message?.take(128) ?: "Native navigation unavailable", android.widget.Toast.LENGTH_SHORT).show()
    }
    private fun nativeVisit(from: Surface, path: String, presentation: String): Surface {
        if (!isForeground(from) || configuration.navigationMode != "native") fail("UNAUTHORIZED", "Native navigation is not active")
        if (!validRoute(path)) fail("INVALID_REQUEST", "Unsupported native route")
        if (presentationOwner != null || modal != null || predictiveSurface != null) fail("BUSY", "Native transition unavailable")
        if (presentation !in setOf("push", "replace", "modal")) fail("INVALID_REQUEST", "Unsupported presentation")
        if (modalSurface != null) fail("BUSY", "Dismiss the current native modal first")
        if (presentation == "replace") {
            val stack = stacks.getValue(activeTab)
            val old = stack.removeAt(stack.lastIndex); disposeSurface(old)
        }
        val next = createSurface(activeTab, path, presentation == "modal")
        var sheet: LinearLayout? = null
        if (presentation == "modal") {
            sheet = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; layoutParams = ViewGroup.LayoutParams(-1, resources.displayMetrics.heightPixels * 85 / 100) }
            val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(12, 8, 12, 8); setBackgroundColor(Color.rgb(234, 240, 248)) }
            bar.addView(Button(this).apply { text = "Back"; contentDescription = "Native Back"; setOnClickListener { nativeBack(null) } })
            next.modalTitle = TextView(this).apply { text = next.title; textSize = 19f; gravity = android.view.Gravity.CENTER_VERTICAL }
            bar.addView(next.modalTitle, LinearLayout.LayoutParams(0, -1, 1f)); next.modalToolbar = bar
            sheet.addView(bar, LinearLayout.LayoutParams(-1, 60.dp)); sheet.addView(next.view, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        showSurface(next)
        if (presentation == "modal") {
            visitDialog = com.google.android.material.bottomsheet.BottomSheetDialog(this).apply {
                setContentView(sheet!!)
                setOnDismissListener { if (modalSurface === next) { modalSurface = null; visitDialog = null; disposeSurface(next); showSurface(stacks.getValue(activeTab).last()) } }
                show()
                behavior.state = com.google.android.material.bottomsheet.BottomSheetBehavior.STATE_EXPANDED
            }
            applyAppearance(next)
        }
        return next
    }
    private fun popSurface(): Boolean {
        modalSurface?.let { s -> modalSurface = null; val dialog = visitDialog; visitDialog = null; dialog?.dismiss(); disposeSurface(s); showSurface(stacks.getValue(activeTab).last()); return true }
        val stack = stacks.getValue(activeTab)
        if (stack.size <= 1) return false
        disposeSurface(stack.removeAt(stack.lastIndex)); showSurface(stack.last()); return true
    }
    private fun disposeSurface(s: Surface) {
        plugins.cancel(s.id)
        invalidateDocument(s); s.disposed = true; s.errorPanel?.let { content.removeView(it) }; s.errorPanel = null; (s.view.parent as? ViewGroup)?.removeView(s.view)
        s.view.stopLoading(); s.view.destroy()
    }
    private fun showLoadFailure(s: Surface) {
        if (active !== s || s.disposed || s.errorPanel?.parent != null) return
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24); setBackgroundColor(Color.WHITE) }
        panel.addView(TextView(this).apply { text = "Unable to load content"; textSize = 22f })
        panel.addView(Button(this).apply { text = "Retry"; setOnClickListener { content.removeView(panel); s.errorPanel = null; if (s.rendererGone) recreateSurface(s) else s.view.reload() } })
        if (configuration.hosted) panel.addView(Button(this).apply { text = "Use packaged app"; setOnClickListener { content.removeView(panel); switchToPackaged() } })
        panel.addView(Button(this).apply { text = "Back"; setOnClickListener { content.removeView(panel); nativeBack(null) } })
        s.errorPanel = panel
        content.addView(panel, FrameLayout.LayoutParams(-1, -1))
    }
    private fun recreateSurface(s: Surface) {
        if (s.modalVisit) { popSurface(); return }
        val stack = stacks.getValue(s.tab); val index = stack.indexOf(s)
        if (index < 0) return
        stack.removeAt(index); disposeSurface(s)
        val next = createSurface(s.tab, s.route)
        stack.remove(next); stack.add(index, next); showSurface(next)
    }
    private fun switchToPackaged() {
        visitDialog?.setOnDismissListener(null); visitDialog?.dismiss(); visitDialog = null
        stacks.values.flatMap { it.toList() }.forEach { disposeSurface(it) }; stacks.values.forEach { it.clear() }
        modalSurface?.let { disposeSurface(it) }; modalSurface = null; active = null
        configuration = configuration.copy(contentMode = "packaged", origin = ORIGIN, initialPath = "/")
        showSurface(createSurface(activeTab, configuration.tabs.first { it.id == activeTab }.path))
    }
    private fun beginPredictive() {
        val s = active ?: return
        val stack = stacks.getValue(activeTab)
        if (!configuration.backGestures || s.canGoBack || stack.size < 2 || presentationOwner != null || modal != null) return
        val previous = stack[stack.lastIndex - 1]
        if (configuration.hosted && previous.contentEpoch != contentEpoch) { previous.view.visibility = View.VISIBLE; refreshContentSurface(previous); return }
        predictiveSurface = s; predictivePrevious = previous; predictiveRevision = stackRevision
        predictivePrevious!!.view.visibility = View.VISIBLE
        s.view.bringToFront()
    }
    private fun progressPredictive(progress: Float) { predictiveSurface?.view?.translationX = content.width * progress.coerceIn(0f, 1f) }
    private fun cancelPredictive() {
        predictiveSurface?.view?.translationX = 0f
        predictivePrevious?.takeIf { active !== it }?.view?.visibility = View.GONE
        val wasPredictive = predictiveSurface != null
        predictiveSurface = null; predictivePrevious = null
        if (wasPredictive) pendingExternalRoute?.let { path -> pendingExternalRoute = null; main.post { if (!destroyed) routeLink(path) } }
    }
    private fun commitPredictive() {
        val s = predictiveSurface ?: return
        val valid = active === s && predictiveRevision == stackRevision
        cancelPredictive()
        if (valid) { /* nativeBack below performs the single committed pop. */ }
    }
    private fun resource(uri: Uri): WebResourceResponse? {
        fun error(code: Int) = WebResourceResponse("text/plain", "utf-8", code, if (code == 404) "Not Found" else "Forbidden", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream("Unavailable".toByteArray()))
        val nativeOrigin = uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.userInfo == null && uri.port in listOf(-1, 443)
        if (!nativeOrigin) {
            if (trusted(uri) || (uri.scheme == "https" && uri.userInfo == null)) return null
            if (BuildConfig.DEBUG && configuration.hosted && uri.scheme == "http" && uri.host == "127.0.0.1" && uri.userInfo == null) return null
            return error(403)
        }
        val path = uri.path ?: return error(404)
        if (path.contains('\\') || path.split('/').any { it == ".." || it == "." } || path.any { it.code < 32 } || path.length > 4096) return error(403)
        if (path.startsWith("/__photos/")) {
            val name = path.removePrefix("/__photos/")
            if (!PHOTO.matches(name)) return error(403)
            return try { WebResourceResponse("image/jpeg", null, File(photos, name).inputStream()).apply { responseHeaders = mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff", "Access-Control-Allow-Origin" to appOrigin) } } catch (_: Exception) { error(404) }
        }
        if (configuration.hosted) return error(404)
        val asset = "web/" + path.removePrefix("/").let { if (it.isEmpty() || it.endsWith('/')) "${it}index.html" else it }
        return try {
            val mime = when { asset.endsWith(".js") -> "application/javascript"; asset.endsWith(".css") -> "text/css"; asset.endsWith(".html") -> "text/html"; asset.endsWith(".json") -> "application/json"; asset.endsWith(".txt") || asset.endsWith(".rsc") -> "text/plain"; else -> URLConnection.guessContentTypeFromName(asset) ?: "application/octet-stream" }
            WebResourceResponse(mime, "utf-8", assets.open(asset)).apply { responseHeaders = mapOf("X-Content-Type-Options" to "nosniff", "Cache-Control" to "no-cache") }
        } catch (_: Exception) { error(404) }
    }
    private fun invalidateDocument(s: Surface) {
        plugins.cancel(s.id)
        s.document?.let { if (s.retired.size < 4096) s.retired.add(it) else s.exhausted = true }
        s.document = null; s.session = null; s.proxy = null; s.pending.clear(); s.seen.clear(); s.analyticsLane.reset(); s.subscriptions.clear()
        s.navigationToken = null; s.backRequest = null; s.registration = null; s.toolbarActions = emptyList(); s.canGoBack = false
        if (active === s) { renderToolbar(s); updateBackCallback() }
    }
    private fun receive(s: Surface, raw: String, proxy: JavaScriptReplyProxy) {
        if (destroyed || s.disposed || s.exhausted || raw.length > MAX_WIRE || raw.toByteArray().size > MAX_WIRE || !boundedJson(raw)) return
        var req: Request? = null
        val prior = receiving; receiving = s
        try {
            val obj = JSONObject(raw)
            requireKeys(obj, setOf("v", "id", "document", "session", "action", "args"))
            if (obj.opt("v") !is Number || obj.getDouble("v") != 1.0) fail("INVALID_REQUEST", "Unsupported protocol")
            val id = text(obj, "id", 128); val doc = text(obj, "document", 128)
            if (!ID.matches(id) || !ID.matches(doc)) fail("INVALID_REQUEST", "Invalid request identity")
            val action = text(obj, "action", 64); val args = obj.opt("args") as? JSONObject ?: fail("INVALID_REQUEST", "Invalid arguments")
            if (action == "hello") {
                requireKeys(args, emptySet())
                if (obj.opt("session") !== JSONObject.NULL || doc in s.retired || (s.document != null && s.document != doc)) fail("UNAUTHORIZED", "Invalid document handshake")
                if (s.document == null) { s.document = doc; s.session = UUID.randomUUID().toString(); s.proxy = proxy }
            } else if (s.document != doc || obj.opt("session") !is String || obj.optString("session") != s.session) fail("UNAUTHORIZED", "Invalid document session")
            req = Request(id, doc, s.session ?: "", action, args, proxy, s)
            val telemetry = s.analyticsLane.admit(doc, id, action, args)
            if (!telemetry && id in s.seen) fail("INVALID_REQUEST", "Duplicate request")
            if ((!telemetry && s.seen.size >= 4096) || s.pending.size >= 64) fail("QUOTA_EXCEEDED", "Request capacity exceeded")
            if (!telemetry) s.seen.add(id)
            s.pending[id] = req; req.admitted = true
            dispatch(req)
        } catch (error: Exception) { req?.let { respond(it, error = error as? HostError ?: HostError("INVALID_REQUEST", "Malformed request")) } }
        finally { receiving = prior }
    }
    private fun dispatch(req: Request) {
        val a = req.args
        val policy = plugins.actions[req.action]
        if (configuration.hosted && req.surface.contentEpoch != contentEpoch && policy?.permitsStale != true && req.action !in setOf("hello", "cancel", "events.subscribe", "events.unsubscribe")) fail("UNAUTHORIZED", "Document session context is stale")
        if (policy?.requiresFresh == true && configuration.hosted && req.surface.contentEpoch != contentEpoch) fail("UNAUTHORIZED", "Native action requires a fresh document")
        if ((req.action in UI_ACTIONS || policy?.visible == true) && !isForeground(req.surface)) fail("UNAUTHORIZED", "Surface is not visible")
        if ((req.action in UI_ACTIONS || policy?.visible == true) && predictiveSurface != null) fail("BUSY", "Native back gesture is in progress")
        if (policy != null) { dispatchPlugin(req, policy); return }
        when (req.action) {
            "hello" -> respond(req, JSONObject().put("platform", "android").put("capabilities", JSONArray(capabilities())).put("host", hostMetadata(req.surface)))
            "storage.get", "storage.set", "storage.remove" -> {
                requireKeys(a, if (req.action == "storage.set") setOf("key", "value") else setOf("key"))
                val key = text(a, "key", 128, allowNul = true)
                val value = if (req.action == "storage.set") text(a, "value", 32768, empty = true, allowNul = true) else ""
                if (diskOutstanding >= 64) fail("QUOTA_EXCEEDED", "Storage operation capacity exceeded")
                diskOutstanding++
                worker.execute {
                    val outcome = runCatching {
                        when (req.action) { "storage.get" -> storage.get(key); "storage.set" -> { storage.set(key, value); null }; else -> { storage.remove(key); null } }
                    }
                    main.post {
                        diskOutstanding--
                        outcome.fold({ respond(req, it) }, { respond(req, error = it as? HostError ?: HostError("IO_ERROR", "Storage operation failed")) })
                    }
                }
            }
            "haptics.impact" -> {
                requireKeys(a, setOf("style")); val style = text(a, "style", 16)
                val duration = when (style) { "light" -> 15L; "medium" -> 30L; "heavy" -> 50L; else -> fail("INVALID_REQUEST", "Unknown impact style") }
                val vibrator = getSystemService(VIBRATOR_SERVICE) as Vibrator
                if (!vibrator.hasVibrator()) fail("UNAVAILABLE", "Haptics unavailable")
                vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE)); hapticInvocations++
                respond(req)
            }
            "navigation.update" -> {
                requireKeys(a, setOf("path", "title", "canGoBack"), setOf("ack"))
                val path = text(a, "path", 2048); if (!validRoute(path)) fail("INVALID_REQUEST", "Unsupported route")
                val title = text(a, "title", 128, true)
                val back = a.opt("canGoBack") as? Boolean ?: fail("INVALID_REQUEST", "Invalid back state")
                val ack = if (a.has("ack")) text(a, "ack", 128) else null
                if (ack != null && ack != navigationToken) fail("INVALID_REQUEST", "Stale navigation acknowledgment")
                route = path; canGoBack = back; req.surface.routeTitle = title
                captureScreen(req.surface)
                if (req.surface.registration == null) { req.surface.title = title; (req.surface.modalTitle ?: titleView).text = title }
                updateBackCallback()
                getSharedPreferences("host", MODE_PRIVATE).edit().putString("route-${req.surface.tab}", path).putString("route", path).apply()
                if (ack != null) { navigationToken = null; backRequest?.let { respond(it) }; backRequest = null }
                respond(req)
            }
            "navigation.back" -> { requireKeys(a, emptySet()); nativeBack(req) }
            "navigation.present" -> {
                requireKeys(a, setOf("screen")); if (text(a, "screen", 32) != "native-demo") fail("UNSUPPORTED", "Unknown native screen")
                if (modal != null || photoFile != null || presentationOwner != null) fail("BUSY", "Presentation already active")
                modal = AlertDialog.Builder(this).setTitle("Native screen").setMessage("This is an Android native modal, requested by the web app.").setPositiveButton("Done") { dialog, _ -> dialog.dismiss() }.create().also { dialog -> dialog.setOnDismissListener { modal = null; drainPendingRoute() }; dialog.show() }
                respond(req)
            }
            "navigation.dismiss" -> { requireKeys(a, emptySet()); if (modal != null) { modal?.dismiss(); modal = null; respond(req) } else if (modalSurface != null) { respond(req); popSurface() } else respond(req) }
            "toolbar.set" -> {
                requireKeys(a, setOf("registration", "title", "actions"))
                val reg = text(a, "registration", 128); val title = text(a, "title", 128, true)
                val actions = a.opt("actions") as? JSONArray ?: fail("INVALID_REQUEST", "Invalid toolbar actions")
                if (actions.length() > 2) fail("INVALID_REQUEST", "Too many toolbar actions")
                val parsed = (0 until actions.length()).map { i ->
                    val obj = actions.opt(i) as? JSONObject ?: fail("INVALID_REQUEST", "Invalid toolbar action")
                    requireKeys(obj, setOf("id", "title")); Pair(text(obj, "id", 128), text(obj, "title", 64))
                }
                if (parsed.map { it.first }.distinct().size != parsed.size) fail("INVALID_REQUEST", "Duplicate toolbar action")
                registration = reg; req.surface.title = title; req.surface.toolbarActions = parsed; renderToolbar(req.surface)
                respond(req)
            }
            "toolbar.clear" -> {
                requireKeys(a, setOf("registration")); if (text(a, "registration", 128) == registration) {
                    registration = null; req.surface.toolbarActions = emptyList(); req.surface.title = req.surface.routeTitle; renderToolbar(req.surface)
                }; respond(req)
            }
            "camera.capture" -> { requireKeys(a, emptySet()); capture(req) }
            "files.previewURL", "files.remove" -> {
                requireKeys(a, setOf("file")); val name = text(a, "file", 128)
                if (!PHOTO.matches(name)) fail("INVALID_REQUEST", "Unknown file handle")
                val file = File(photos, name)
                if (!file.isFile) fail("UNAVAILABLE", "Photo no longer exists")
                if (req.action == "files.previewURL") respond(req, "$ORIGIN/__photos/$name")
                else { if (!file.delete()) fail("IO_ERROR", "Unable to delete photo"); respond(req) }
            }
            "cancel" -> {
                requireKeys(a, setOf("requestId")); val target = text(a, "requestId", 128)
                if (target != req.id) { plugins.cancel(req.surface.id, target); req.surface.pending.remove(target) }
                if (biometricRequest?.surface === req.surface && biometricRequest?.id == target) biometricSignal?.cancel()
                if (backRequest?.id == target) { backRequest = null; navigationToken = null }
                respond(req)
            }
            else -> dispatchExtension(req)
        }
    }

    private fun analyticsReply(req: Request): (JSONObject?, HostError?) -> Unit {
        val owner = WeakReference(this); val request = WeakReference(req)
        return { result, error -> val activity = owner.get(); val caller = request.get(); if (activity != null && caller != null) activity.respond(caller, result, error) }
    }
    private fun dispatchPlugin(req: Request, policy: PluginAction) {
        if (policy.visible) { claimPresentation(req); pluginRequest = req }
        try {
            val context = PluginCallContext(this, req.surface.id, req.id, configuration.runtimeConfiguration(), configuration.pluginExtras)
            plugins.invoke(context, req.action, req.args) { result, error ->
                if (pluginRequest === req) pluginRequest = null
                if (policy.visible) releasePresentation(req)
                respond(req, result, error)
            }
        } catch (error: Exception) {
            if (pluginRequest === req) pluginRequest = null
            if (policy.visible) releasePresentation(req)
            throw error
        }
    }
    private fun dispatchExtension(req: Request) {
        val a = req.args; val s = req.surface
        when (req.action) {
            "analytics.track" -> {
                requireKeys(a, setOf("name"), setOf("properties"))
                val name = text(a, "name", 64)
                if (!name.startsWith("custom.") || !NativeAnalytics.NAME.matches(name)) fail("INVALID_REQUEST", "Custom analytics names must use custom namespace")
                val props = if (a.has("properties")) a.opt("properties") as? JSONObject ?: fail("INVALID_REQUEST", "Invalid semantic properties") else JSONObject()
                analytics.record("custom", name, props, "web", analyticsReply(req))
            }
            "analytics.observe" -> {
                requireKeys(a, setOf("type", "kind"), setOf("control"))
                val type = text(a, "type", 16)
                if (type !in setOf("click", "submit", "change")) fail("INVALID_REQUEST", "Invalid semantic observation")
                val props = JSONObject().put("kind", a.opt("kind"))
                if (a.has("control")) props.put("control", a.opt("control"))
                analytics.record("interaction", "interaction.$type", props, "web", analyticsReply(req))
            }
            "analytics.status" -> { requireKeys(a, emptySet()); analytics.status(analyticsReply(req)) }
            "analytics.flush" -> { requireKeys(a, emptySet()); analytics.flush(analyticsReply(req)) }
            "navigation.visit" -> {
                requireKeys(a, setOf("path", "presentation"))
                val next = nativeVisit(s, text(a, "path", 2048), text(a, "presentation", 16))
                respond(req, JSONObject().put("surfaceId", next.id).put("path", next.route))
            }
            "chrome.state" -> { requireKeys(a, emptySet()); respond(req, chromeState(s)) }
            "chrome.selectTab" -> { requireKeys(a, setOf("id")); val id = text(a, "id", 32); if (configuration.tabs.none { it.id == id }) fail("INVALID_REQUEST", "Unknown tab"); selectTab(id); respond(req) }
            "chrome.update" -> {
                requireKeys(a, emptySet(), setOf("title", "largeTitle", "tabBarHidden", "toolbarHidden", "statusBarStyle", "badge"))
                if (a.has("largeTitle")) { if (a.opt("largeTitle") !is Boolean) fail("INVALID_REQUEST", "Invalid large title"); fail("UNSUPPORTED", "Android does not use iOS large titles") }
                val title = if (a.has("title")) text(a, "title", 128, true) else null
                for (key in listOf("tabBarHidden", "toolbarHidden")) if (a.has(key) && a.opt(key) !is Boolean) fail("INVALID_REQUEST", "Invalid chrome visibility")
                val style = if (a.has("statusBarStyle")) text(a, "statusBarStyle", 16).also { if (it !in setOf("default", "light", "dark")) fail("INVALID_REQUEST", "Invalid status bar style") } else null
                val badge = if (a.has("badge")) a.optJSONObject("badge") ?: fail("INVALID_REQUEST", "Invalid tab badge") else null
                var badgeIndex = -1; var badgeValue: String? = null
                if (badge != null) {
                    requireKeys(badge, setOf("id", "value")); val id = text(badge, "id", 32)
                    badgeIndex = configuration.tabs.indexOfFirst { it.id == id }
                    if (badgeIndex < 0) fail("INVALID_REQUEST", "Unknown tab")
                    if (tabsView == null) fail("UNSUPPORTED", "Native tabs are disabled")
                    if (!badge.isNull("value")) badgeValue = text(badge, "value", 3)
                }
                // Validate the complete update before mutating native appearance.
                title?.let { s.title = it; (s.modalTitle ?: titleView).text = it }
                if (a.has("tabBarHidden")) s.tabBarHidden = a.getBoolean("tabBarHidden")
                if (a.has("toolbarHidden")) s.toolbarHidden = a.getBoolean("toolbarHidden")
                style?.let { s.statusBarStyle = it }
                applyAppearance(s)
                if (badge != null) { if (badgeValue == null) tabsView!!.removeBadge(badgeIndex + 1) else tabsView!!.getOrCreateBadge(badgeIndex + 1).text = badgeValue }
                respond(req)
            }
            "events.subscribe" -> {
                requireKeys(a, setOf("event", "subscription")); val name = text(a, "event", 64); val id = text(a, "subscription", 128)
                if (name !in EXTERNAL_EVENTS && name !in plugins.events || !ID.matches(id)) fail("INVALID_REQUEST", "Unsupported event subscription")
                if (s.subscriptions[id] != null && s.subscriptions[id] != name) fail("INVALID_REQUEST", "Subscription identity conflict")
                if (id !in s.subscriptions && s.subscriptions.size >= 32) fail("QUOTA_EXCEEDED", "Subscription capacity exceeded")
                s.subscriptions[id] = name; respond(req)
                if (name == "navigation.changed" && isForeground(s)) externalEvent(s, name, JSONObject().put("reason", "activated").put("host", hostMetadata(s)))
                drainEvents()
            }
            "events.unsubscribe" -> { requireKeys(a, setOf("subscription")); s.subscriptions.remove(text(a, "subscription", 128)); respond(req) }
            "links.getInitial" -> { requireKeys(a, emptySet()); respond(req, initialLink?.let { JSONObject().put("path", it) }) }
            "notifications.status" -> { requireKeys(a, emptySet()); respond(req, NativePushState.status(this, configuration.notifications)) }
            "notifications.requestPermission" -> {
                requireKeys(a, emptySet())
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    claimPresentation(req); permissionRequest = req; notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else respond(req, NativePushState.status(this, configuration.notifications))
            }
            "notifications.register" -> {
                requireKeys(a, emptySet())
                NativePushState.register(this, configuration.notifications) { token, problem -> main.post {
                    if (problem != null) respond(req, error = problem)
                    else respond(req, JSONObject().put("provider", "fcm").put("token", token).put("environment", if (BuildConfig.DEBUG) "development" else "production"))
                } }
            }
            "share.present" -> {
                requireKeys(a, emptySet(), setOf("text", "url", "file"))
                val text = if (a.has("text")) text(a, "text", 8192, true) else null
                val url = if (a.has("url")) text(a, "url", 2048).also { val parsed = Uri.parse(it); if (parsed.scheme != "https" || parsed.host.isNullOrEmpty() || parsed.userInfo != null) fail("INVALID_REQUEST", "Invalid share URL") } else null
                val file = if (a.has("file")) text(a, "file", 128).let { name -> if (!PHOTO.matches(name)) fail("INVALID_REQUEST", "Unknown file handle"); File(photos, name).also { if (!it.isFile) fail("UNAVAILABLE", "Photo is unavailable") } } else null
                if (text.isNullOrEmpty() && url == null && file == null) fail("INVALID_REQUEST", "Share content is empty")
                claimPresentation(req)
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = if (file == null) "text/plain" else "image/jpeg"
                    putExtra(Intent.EXTRA_TEXT, listOfNotNull(text, url).joinToString("\n"))
                    file?.let { val uri = FileProvider.getUriForFile(this@HostActivity, "$packageName.files", it); putExtra(Intent.EXTRA_STREAM, uri); clipData = android.content.ClipData.newRawUri("Shared photo", uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                }
                try { startActivity(Intent.createChooser(intent, "Share")); respond(req, JSONObject().put("status", "presented")) }
                catch (_: Exception) { releasePresentation(req); fail("UNAVAILABLE", "No share application is available") }
            }
            "biometrics.status" -> { requireKeys(a, emptySet()); respond(req, biometricStatus()) }
            "biometrics.authenticate" -> { requireKeys(a, setOf("reason")); authenticate(req, text(a, "reason", 128)) }
            else -> fail("UNSUPPORTED", "Unknown platform action")
        }
    }
    private fun chromeState(s: Surface) = hostMetadata(s).put("mode", configuration.chromeMode).put("depth", stacks[s.tab]?.size ?: 1)
        .put("tabs", JSONArray(configuration.tabs.map { JSONObject().put("id", it.id).put("title", it.title).put("path", it.path) })).put("largeTitle", false)
        .put("toolbarHidden", s.toolbarHidden).put("tabBarHidden", s.tabBarHidden).put("statusBarStyle", s.statusBarStyle)
        .put("supported", JSONArray(listOf("title", "toolbarHidden", "tabBarHidden", "statusBarStyle", "badge")))
    private fun claimPresentation(req: Request) {
        if (!isForeground(req.surface)) fail("UNAUTHORIZED", "Surface is not visible")
        if (presentationOwner != null || modal != null || photoFile != null) fail("BUSY", "Native presentation active")
        presentationOwner = req.surface.id to req.id
    }
    private fun drainPendingRoute() {
        if (!foreground || destroyed || presentationOwner != null || modal != null || photoFile != null || predictiveSurface != null) return
        pendingExternalRoute?.let { path -> pendingExternalRoute = null; main.post { if (!destroyed && foreground) routeLink(path) else pendingExternalRoute = path } }
    }
    private fun releasePresentation(req: Request) {
        if (presentationOwner == (req.surface.id to req.id)) {
            presentationOwner = null
            drainPendingRoute()
        }
    }
    private fun biometricStatus(): JSONObject {
        if (Build.VERSION.SDK_INT < 28) return JSONObject().put("available", false).put("enrolled", false)
        val available = if (Build.VERSION.SDK_INT >= 29) (getSystemService(android.hardware.biometrics.BiometricManager::class.java).canAuthenticate() == android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS)
            else { val fp = getSystemService(android.hardware.fingerprint.FingerprintManager::class.java); fp != null && fp.isHardwareDetected && fp.hasEnrolledFingerprints() }
        return JSONObject().put("available", available).put("enrolled", available)
    }
    private fun authenticate(req: Request, reason: String) {
        if (Build.VERSION.SDK_INT < 28 || !biometricStatus().getBoolean("available")) fail("UNAVAILABLE", "Biometric authentication is unavailable")
        claimPresentation(req); biometricRequest = req
        val cancellation = CancellationSignal(); biometricSignal = cancellation
        val prompt = android.hardware.biometrics.BiometricPrompt.Builder(this).setTitle("Authenticate").setDescription(reason)
            .setNegativeButton("Cancel", mainExecutor) { _, _ -> finishBiometric(req, false, HostError("CANCELLED", "Authentication cancelled")) }.build()
        prompt.authenticate(cancellation, mainExecutor, object : android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: android.hardware.biometrics.BiometricPrompt.AuthenticationResult?) { finishBiometric(req, true, null) }
            override fun onAuthenticationError(code: Int, message: CharSequence?) { finishBiometric(req, false, HostError(if (code == 5 || code == 10 || code == 13) "CANCELLED" else "UNAVAILABLE", "Authentication did not complete")) }
        })
    }
    private fun finishBiometric(req: Request, authenticated: Boolean, error: HostError?) {
        if (biometricRequest !== req) return
        biometricRequest = null; biometricSignal = null; releasePresentation(req)
        respond(req, JSONObject().put("authenticated", authenticated), error)
    }
    private fun updateBackCallback() {
        if (!::backCallback.isInitialized) return
        val s = active
        // At a true application root, let Android own predictive back-to-home.
        val ownsBack = s != null && (s.canGoBack || (stacks[s.tab]?.size ?: 0) > 1 || modalSurface != null)
        backCallback.isEnabled = ownsBack
        (s?.modalToolbar ?: toolbar).getChildAt(0)?.isEnabled = ownsBack || keyboardVisible
    }
    private fun nativeBack(req: Request?, hardware: Boolean = false) {
        val s = req?.surface ?: active ?: return
        if (predictiveSurface != null) { req?.let { respond(it, error = HostError("BUSY", "Native back gesture active")) }; return }
        if (!isForeground(s)) { req?.let { respond(it, error = HostError("UNAUTHORIZED", "Surface is not visible")) }; return }
        if (ViewCompat.getRootWindowInsets(s.view)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
            (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(s.view.windowToken, 0); req?.let { respond(it) }; return
        }
        modal?.let { it.dismiss(); modal = null; req?.let { r -> respond(r) }; return }
        if (photoFile != null || presentationOwner != null) { req?.let { respond(it, error = HostError("BUSY", "Native presentation active")) }; return }
        if (!s.canGoBack) { if (req != null) respond(req); if (!popSurface() && hardware) finish(); return }
        if (s.navigationToken != null) { req?.let { respond(it, error = HostError("BUSY", "Navigation pending")) }; return }
        val token = UUID.randomUUID().toString(); s.navigationToken = token; s.backRequest = req
        event(s, "navigation.back", JSONObject().put("token", token))
        main.postDelayed({ if (s.navigationToken == token) { s.navigationToken = null; s.backRequest?.let { respond(it, error = HostError("TIMEOUT", "Navigation acknowledgment timed out")) }; s.backRequest = null } }, 5000)
    }
    private fun capture(req: Request) {
        if (photoFile != null || modal != null || presentationOwner != null) fail("BUSY", "Presentation already active")
        val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
        if (intent.resolveActivity(packageManager) == null) fail("UNAVAILABLE", "No camera application available")
        if (photos.listFiles()?.sumOf { it.length() } ?: 0 > 80L * 1024 * 1024) fail("QUOTA_EXCEEDED", "Photo storage quota exceeded")
        val file = File(photos, "${UUID.randomUUID()}.pending.jpg")
        claimPresentation(req)
        cameraRequest = req; photoFile = file
        try { camera.launch(FileProvider.getUriForFile(this, "$packageName.files", file)) }
        catch (_: SecurityException) { photoFile = null; cameraRequest = null; releasePresentation(req); file.delete(); fail("UNAUTHORIZED", "Camera access denied") }
        catch (_: Exception) { photoFile = null; cameraRequest = null; releasePresentation(req); file.delete(); fail("UNAVAILABLE", "Camera could not open") }
    }
    private fun finishPhoto(success: Boolean) {
        val file = photoFile; val req = cameraRequest
        photoFile = null; cameraRequest = null
        req?.let { releasePresentation(it) }
        if (file == null) return
        if (req == null || !isLive(req)) { file.delete(); return }
        if (!success) { file.delete(); respond(req, error = HostError("CANCELLED", "Camera capture cancelled")); return }
        if (!file.isFile || file.length() <= 0 || file.length() > 20L * 1024 * 1024) {
            file.delete(); respond(req, error = HostError("QUOTA_EXCEEDED", "Captured image is empty or too large")); return
        }
        val header = ByteArray(3)
        val jpeg = runCatching { file.inputStream().use { it.read(header) == 3 } && header[0] == 0xff.toByte() && header[1] == 0xd8.toByte() && header[2] == 0xff.toByte() }.getOrDefault(false)
        val dimensions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, dimensions)
        if (!jpeg || dimensions.outWidth <= 0 || dimensions.outHeight <= 0) {
            file.delete(); respond(req, error = HostError("IO_ERROR", "Camera returned an invalid JPEG")); return
        }
        val dest = File(photos, "${UUID.randomUUID()}.jpg")
        if (!file.renameTo(dest)) { file.delete(); respond(req, error = HostError("IO_ERROR", "Unable to retain photo")); return }
        respond(req, JSONObject().put("file", dest.name).put("mimeType", "image/jpeg"))
    }
    private fun isLive(req: Request) = !destroyed && !req.surface.disposed && req.surface.session == req.session && req.surface.document == req.document && req.surface.pending[req.id] === req
    private fun respond(req: Request, result: Any? = null, error: HostError? = null) {
        if (req.admitted && !req.analyticsRecorded && NativeAnalytics.instrumented(req.action)) {
            req.analyticsRecorded = true
            val props = JSONObject().put("action", req.action).put("durationMs", ((System.nanoTime() - req.startedNanos) / 1000000).coerceIn(0, 600000))
                .put("outcome", if (error == null) "ok" else when (error.code) { "CANCELLED" -> "cancelled"; "UNAVAILABLE" -> "unavailable"; else -> "error" })
            error?.let { props.put("code", it.code) }
            analytics.record("bridge", "bridge.completed", props)
        }
        if (!isLive(req)) return
        req.surface.pending.remove(req.id)
        val obj = JSONObject().put("v", 1).put("id", req.id).put("document", req.document).put("session", req.session).put("ok", error == null)
        if (error != null) obj.put("error", JSONObject().put("code", error.code).put("message", error.message?.take(200))) else obj.put("result", result ?: JSONObject.NULL)
        runCatching { req.proxy.postMessage(obj.toString()) }
    }
    private fun event(s: Surface, name: String, data: JSONObject, subscription: String? = null) {
        if (s.session == null || s.document == null || destroyed || s.disposed || active !== s) return
        val obj = JSONObject().put("v", 1).put("session", s.session).put("document", s.document).put("event", name).put("data", data)
        subscription?.let { obj.put("subscription", it) }
        runCatching { s.proxy?.postMessage(obj.toString()) }
    }
    private fun externalEvent(s: Surface, name: String, data: JSONObject) {
        if (!isForeground(s)) return
        s.subscriptions.filterValues { it == name }.keys.toList().forEach { event(s, name, data, it) }
    }
    private val queuedEvents = ArrayDeque<Pair<String, JSONObject>>()
    private fun publish(event: String, data: JSONObject) {
        if (queuedEvents.size == 32) queuedEvents.removeFirst()
        queuedEvents.addLast(event to data); drainEvents()
    }
    private fun drainEvents() {
        val s = active ?: return
        if (!isForeground(s)) return
        val iterator = queuedEvents.iterator()
        while (iterator.hasNext()) { val next = iterator.next(); if (s.subscriptions.containsValue(next.first)) { externalEvent(s, next.first, next.second); iterator.remove() } }
    }
    private fun requireKeys(obj: JSONObject, required: Set<String>, optional: Set<String> = emptySet()) {
        val keys = obj.keys().asSequence().toSet()
        if (!keys.containsAll(required) || !keys.all { it in required || it in optional }) fail("INVALID_REQUEST", "Unexpected argument fields")
    }
    // Bound nesting before the recursive platform JSON parser sees the payload.
    private fun boundedJson(raw: String): Boolean {
        var depth = 0; var quoted = false; var escaped = false
        for (character in raw) {
            if (quoted) {
                if (escaped) escaped = false
                else if (character == '\\') escaped = true
                else if (character == '"') quoted = false
            } else when (character) {
                '"' -> quoted = true
                '{', '[' -> { depth++; if (depth > 16) return false }
                '}', ']' -> { depth--; if (depth < 0) return false }
            }
        }
        return depth == 0 && !quoted
    }
    private fun text(obj: JSONObject, key: String, limit: Int, empty: Boolean = false, allowNul: Boolean = false): String {
        val value = obj.opt(key) as? String ?: fail("INVALID_REQUEST", "Invalid $key")
        if ((!empty && value.isEmpty()) || value.toByteArray().size > limit || (!allowNul && value.contains('\u0000'))) fail("INVALID_REQUEST", "Invalid $key length")
        return value
    }
    private fun fail(code: String, message: String): Nothing = throw HostError(code, message)
    private val Int.dp: Int get() = (this * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        destroyed = true
        NativePushState.remove(this); pushObserver = null
        if (::configuration.isInitialized) { pluginRequest?.let { plugins.cancel(it.surface.id, it.id) }; plugins.destroyed(this); plugins.unbind(this) }
        visitDialog?.setOnDismissListener(null); visitDialog?.dismiss(); visitDialog = null
        biometricSignal?.cancel(); biometricSignal = null
        if (::content.isInitialized) { stacks.values.flatMap { it.toList() }.forEach { disposeSurface(it) }; modalSurface?.let { disposeSurface(it) } }
        if (::storage.isInitialized) { worker.execute { storage.close() }; worker.shutdown() }
        super.onDestroy()
    }
}
