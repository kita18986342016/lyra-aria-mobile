package com.lyraaria.mobile.player

import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 应用内检查更新 + 下载安装（GitHub Release 源）。
 * checkUpdate：拉 releases/latest API，比对本地 versionCode，返回最新 APK 直链
 * downloadApk：流式下载到 cacheDir/update-<ver>.apk，进度事件 downloadProgress
 * installApk：FileProvider 拉起系统安装器（需 REQUEST_INSTALL_PACKAGES）
 */
@CapacitorPlugin(name = "AppUpdate")
class UpdatePlugin : Plugin() {

    private var dlThread: Thread? = null

    private fun versionCode(): Int {
        return try {
            val pi = activity.packageManager.getPackageInfo(activity.packageName, 0)
            if (android.os.Build.VERSION.SDK_INT >= 28) pi.longVersionCode.toInt() else @Suppress("DEPRECATION") pi.versionCode
        } catch (e: Exception) { 0 }
    }

    @PluginMethod
    fun getVersion(call: PluginCall) {
        val ret = JSObject()
        try {
            val pi = activity.packageManager.getPackageInfo(activity.packageName, 0)
            ret.put("versionName", pi.versionName ?: "")
            ret.put("versionCode", versionCode())
            call.resolve(ret)
        } catch (e: Exception) { call.reject(e.message ?: "获取版本失败") }
    }

    private fun fetchJson(urlStr: String): JSONObject? {
        return try {
            val c = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                connectTimeout = 10000; readTimeout = 15000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "LyraAriaMobile")
                setRequestProperty("Accept", "application/vnd.github+json")
            }
            try {
                if (c.responseCode !in 200..299) return null
                val txt = c.inputStream.bufferedReader().use { it.readText() }
                JSONObject(txt)
            } finally { try { c.disconnect() } catch (_: Exception) {} }
        } catch (e: Exception) { null }
    }

    @PluginMethod
    fun checkUpdate(call: PluginCall) {
        val url = call.getString("url") ?: "https://api.github.com/repos/kita18986342016/lyra-aria-mobile/releases/latest"
        Thread {
            val j = fetchJson(url)
            val ret = JSObject()
            if (j == null) { call.reject("检查更新失败：网络或 GitHub 服务不可用"); return@Thread }
            try {
                val tag = j.optString("tag_name", "")
                val assets = j.optJSONArray("assets") ?: org.json.JSONArray()
                var apkUrl = ""
                var apkSize = 0
                for (i in 0 until assets.length()) {
                    val a = assets.optJSONObject(i) ?: continue
                    val n = a.optString("name", "")
                    if (n.endsWith(".apk")) { apkUrl = a.optString("browser_download_url", ""); apkSize = a.optInt("size", 0); break }
                }
                // 版本比对：tag 里抽数字（v1.4.1 → 10401 风格不可靠），改比对 name 里的 versionName 语义化
                val remote = parseVer(tag)
                val local = parseVer("v" + (activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "0"))
                val available = apkUrl.isNotEmpty() && cmp(remote, local) > 0
                ret.put("available", available)
                ret.put("tag", tag)
                ret.put("url", apkUrl)
                ret.put("size", apkSize)
                ret.put("notes", j.optString("body", "").take(500))
                call.resolve(ret)
            } catch (e: Exception) { call.reject(e.message ?: "解析失败") }
        }.start()
    }

    private fun parseVer(s: String): IntArray {
        val m = Regex("(\\d+)\\.(\\d+)\\.(\\d+)").find(s) ?: return intArrayOf(0, 0, 0)
        return intArrayOf(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
    }

    private fun cmp(a: IntArray, b: IntArray): Int {
        for (i in 0..2) { if (a[i] != b[i]) return a[i] - b[i] }
        return 0
    }

    @PluginMethod
    fun downloadApk(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) { call.reject("缺少 url"); return }
        val name = call.getString("name", "update.apk")
        dlThread?.let { if (it.isAlive) { call.reject("已有下载进行中"); return } }
        val out = File(activity.cacheDir, name)
        try { if (out.exists()) out.delete() } catch (_: Exception) {}
        dlThread = Thread {
            try {
                val c = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15000; readTimeout = 30000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "LyraAriaMobile")
                }
                try {
                    if (c.responseCode !in 200..299) { call.reject("下载失败 HTTP " + c.responseCode); return@Thread }
                    val total = c.contentLength
                    val ins = c.inputStream
                    val os = java.io.BufferedOutputStream(java.io.FileOutputStream(out))
                    val buf = ByteArray(64 * 1024)
                    var r: Int; var done = 0; var lastPct = -1
                    while (ins.read(buf).also { r = it } != -1) {
                        os.write(buf, 0, r); done += r
                        val pct = if (total > 0) (done * 100 / total) else 0
                        if (pct / 5 != lastPct / 5) { // 节流：每 5% 报一次
                            lastPct = pct
                            val ev = JSObject(); ev.put("percent", pct); ev.put("done", done); ev.put("total", total)
                            notifyListeners("downloadProgress", ev)
                        }
                    }
                    os.flush(); os.close(); ins.close()
                    val ret = JSObject(); ret.put("ok", true); ret.put("path", out.absolutePath); ret.put("size", done)
                    call.resolve(ret)
                } finally { try { c.disconnect() } catch (_: Exception) {} }
            } catch (e: Exception) {
                try { out.delete() } catch (_: Exception) {}
                call.reject("下载中断：" + (e.message ?: ""))
            }
        }
        dlThread!!.start()
    }

    @PluginMethod
    fun installApk(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrEmpty()) { call.reject("缺少 path"); return }
        try {
            val f = File(path)
            if (!f.exists()) { call.reject("安装包文件不存在"); return }
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", f)
            val it = Intent(Intent.ACTION_VIEW)
            it.setDataAndType(uri, "application/vnd.android.package-archive")
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(it)
            val ret = JSObject(); ret.put("ok", true); call.resolve(ret)
        } catch (e: Exception) { call.reject("无法打开安装器：" + (e.message ?: "")) }
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        try { dlThread?.interrupt() } catch (_: Exception) {}
        dlThread = null
        val ret = JSObject(); ret.put("ok", true); call.resolve(ret)
    }
}
