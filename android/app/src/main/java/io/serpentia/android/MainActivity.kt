package io.serpentia.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView

class MainActivity : Activity() {
  private lateinit var webView: WebView
  private lateinit var progress: ProgressBar
  private lateinit var errorPanel: View
  private lateinit var errorTitle: TextView
  private lateinit var errorMessage: TextView
  private lateinit var retryButton: Button

  private val permissionPreferences by lazy {
    getSharedPreferences(PERMISSION_PREFERENCES, MODE_PRIVATE)
  }

  private var appUri: Uri? = null
  private var pageFailed = false
  private var pendingAudioRequest: PermissionRequest? = null
  private var audioPermissionDialog: AlertDialog? = null
  private var awaitingAudioSettings = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    configureCutout()
    setContentView(R.layout.activity_main)

    webView = findViewById(R.id.game_web_view)
    progress = findViewById(R.id.loading_progress)
    errorPanel = findViewById(R.id.error_panel)
    errorTitle = findViewById(R.id.error_title)
    errorMessage = findViewById(R.id.error_message)
    retryButton = findViewById(R.id.retry_button)
    appUri = parseConfiguredAppUri()

    configureWebView()
    retryButton.setOnClickListener { loadHome() }

    val restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null
    if (!restored) loadHome()
    hideSystemBars()
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun configureWebView() {
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    webView.setBackgroundColor(Color.BLACK)
    webView.overScrollMode = View.OVER_SCROLL_NEVER

    with(webView.settings) {
      javaScriptEnabled = true
      domStorageEnabled = true
      mediaPlaybackRequiresUserGesture = false
      allowFileAccess = false
      allowContentAccess = false
      javaScriptCanOpenWindowsAutomatically = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      safeBrowsingEnabled = true
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      userAgentString = "$userAgentString SerpentiaAndroid/${BuildConfig.VERSION_NAME}"
    }

    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      setAcceptThirdPartyCookies(webView, false)
    }

    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        if (isTrustedOrigin(uri)) return false
        openExternal(uri)
        return true
      }

      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        pageFailed = false
        errorPanel.visibility = View.GONE
        progress.visibility = View.VISIBLE
      }

      override fun onPageFinished(view: WebView, url: String) {
        progress.visibility = View.GONE
        if (!pageFailed) errorPanel.visibility = View.GONE
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        if (!request.isForMainFrame) return
        pageFailed = true
        progress.visibility = View.GONE
        showError(
          getString(R.string.load_error_title),
          getString(R.string.load_error_message, error.description),
          true,
        )
      }
    }

    webView.webChromeClient = object : WebChromeClient() {
      override fun onProgressChanged(view: WebView, newProgress: Int) {
        progress.progress = newProgress
        progress.visibility = if (newProgress in 0..99 && !pageFailed) View.VISIBLE else View.GONE
      }

      override fun onPermissionRequest(request: PermissionRequest) {
        runOnUiThread { handlePermissionRequest(request) }
      }

      override fun onPermissionRequestCanceled(request: PermissionRequest) {
        runOnUiThread {
          if (pendingAudioRequest === request) {
            pendingAudioRequest = null
            awaitingAudioSettings = false
            dismissAudioPermissionDialog()
          }
        }
      }
    }
  }

  private fun parseConfiguredAppUri(): Uri? {
    val value = BuildConfig.SERPENTIA_APP_URL.trim()
    if (value.isEmpty()) return null
    val uri = Uri.parse(value)
    val validScheme = uri.scheme.equals("https", true) ||
      (BuildConfig.DEBUG && uri.scheme.equals("http", true))
    return uri.takeIf { validScheme && !it.host.isNullOrBlank() }
  }

  private fun loadHome() {
    val uri = appUri
    if (uri == null) {
      showError(
        getString(R.string.configuration_error_title),
        getString(R.string.configuration_error_message),
        false,
      )
      return
    }
    pageFailed = false
    errorPanel.visibility = View.GONE
    progress.visibility = View.VISIBLE
    webView.loadUrl(uri.toString())
  }

  private fun showError(title: String, message: String, canRetry: Boolean) {
    errorTitle.text = title
    errorMessage.text = message
    retryButton.visibility = if (canRetry) View.VISIBLE else View.GONE
    errorPanel.visibility = View.VISIBLE
  }

  private fun isTrustedOrigin(uri: Uri): Boolean {
    val trusted = appUri ?: return false
    return trusted.scheme.equals(uri.scheme, true) &&
      trusted.host.equals(uri.host, true) &&
      effectivePort(trusted) == effectivePort(uri)
  }

  private fun effectivePort(uri: Uri): Int {
    if (uri.port >= 0) return uri.port
    return if (uri.scheme.equals("https", true)) 443 else 80
  }

  private fun openExternal(uri: Uri) {
    try {
      startActivity(Intent(Intent.ACTION_VIEW, uri))
    } catch (_: ActivityNotFoundException) {
      showError(
        getString(R.string.external_link_error_title),
        getString(R.string.external_link_error_message),
        true,
      )
    }
  }

  private fun handlePermissionRequest(request: PermissionRequest) {
    val requestsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
    if (!requestsAudio || !isTrustedOrigin(request.origin)) {
      request.deny()
      return
    }
    if (hasAudioPermission()) {
      request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
      return
    }

    denyPendingAudioRequest()
    pendingAudioRequest = request
    when {
      isAudioPermissionPermanentlyDenied() -> showAudioSettingsDialog()
      shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) ->
        showAudioRationaleDialog()
      else -> requestAudioPermission()
    }
  }

  private fun hasAudioPermission(): Boolean =
    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  private fun isAudioPermissionPermanentlyDenied(): Boolean =
    !hasAudioPermission() &&
      permissionPreferences.getBoolean(AUDIO_PERMISSION_REQUESTED, false) &&
      !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)

  private fun requestAudioPermission() {
    if (pendingAudioRequest == null) return
    dismissAudioPermissionDialog()
    permissionPreferences.edit().putBoolean(AUDIO_PERMISSION_REQUESTED, true).apply()
    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), RECORD_AUDIO_REQUEST)
  }

  private fun showAudioRationaleDialog() {
    if (pendingAudioRequest == null || isFinishing || isDestroyed) return
    dismissAudioPermissionDialog()
    audioPermissionDialog = AlertDialog.Builder(this)
      .setTitle(R.string.microphone_permission_title)
      .setMessage(R.string.microphone_permission_rationale)
      .setPositiveButton(R.string.microphone_permission_retry) { _, _ ->
        requestAudioPermission()
      }
      .setNegativeButton(R.string.microphone_permission_not_now) { _, _ ->
        denyPendingAudioRequest()
      }
      .setOnCancelListener { denyPendingAudioRequest() }
      .show()
  }

  private fun showAudioSettingsDialog() {
    if (pendingAudioRequest == null || isFinishing || isDestroyed) return
    dismissAudioPermissionDialog()
    audioPermissionDialog = AlertDialog.Builder(this)
      .setTitle(R.string.microphone_settings_title)
      .setMessage(R.string.microphone_settings_message)
      .setPositiveButton(R.string.microphone_settings_open) { _, _ ->
        openApplicationSettings()
      }
      .setNegativeButton(R.string.microphone_permission_not_now) { _, _ ->
        denyPendingAudioRequest()
      }
      .setOnCancelListener { denyPendingAudioRequest() }
      .show()
  }

  private fun openApplicationSettings() {
    if (pendingAudioRequest == null) return
    dismissAudioPermissionDialog()
    awaitingAudioSettings = true
    val applicationDetails = Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.fromParts("package", packageName, null),
    )
    try {
      startActivity(applicationDetails)
    } catch (_: ActivityNotFoundException) {
      try {
        startActivity(Intent(Settings.ACTION_SETTINGS))
      } catch (_: ActivityNotFoundException) {
        awaitingAudioSettings = false
        denyPendingAudioRequest()
      }
    }
  }

  private fun grantPendingAudioRequest() {
    val request = pendingAudioRequest ?: return
    pendingAudioRequest = null
    awaitingAudioSettings = false
    dismissAudioPermissionDialog()
    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
  }

  private fun denyPendingAudioRequest() {
    val request = pendingAudioRequest
    pendingAudioRequest = null
    awaitingAudioSettings = false
    dismissAudioPermissionDialog()
    request?.deny()
  }

  private fun dismissAudioPermissionDialog() {
    audioPermissionDialog?.dismiss()
    audioPermissionDialog = null
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != RECORD_AUDIO_REQUEST || pendingAudioRequest == null) return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
      grantPendingAudioRequest()
    } else if (isAudioPermissionPermanentlyDenied()) {
      showAudioSettingsDialog()
    } else {
      showAudioRationaleDialog()
    }
  }

  private fun configureCutout() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun hideSystemBars() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(false)
      window.insetsController?.apply {
        hide(WindowInsets.Type.systemBars())
        systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      }
    } else {
      window.decorView.systemUiVisibility =
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
          View.SYSTEM_UI_FLAG_FULLSCREEN or
          View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
          View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
          View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
          View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    hideSystemBars()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    webView.saveState(outState)
    super.onSaveInstanceState(outState)
  }

  override fun onResume() {
    super.onResume()
    webView.onResume()
    if (awaitingAudioSettings) {
      awaitingAudioSettings = false
      if (hasAudioPermission()) grantPendingAudioRequest() else denyPendingAudioRequest()
    }
    hideSystemBars()
  }

  override fun onPause() {
    webView.onPause()
    super.onPause()
  }

  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
  }

  override fun onDestroy() {
    denyPendingAudioRequest()
    dismissAudioPermissionDialog()
    webView.stopLoading()
    webView.webChromeClient = null
    webView.destroy()
    super.onDestroy()
  }

  companion object {
    private const val RECORD_AUDIO_REQUEST = 1001
    private const val PERMISSION_PREFERENCES = "permission-state"
    private const val AUDIO_PERMISSION_REQUESTED = "audio-permission-requested"
  }
}
