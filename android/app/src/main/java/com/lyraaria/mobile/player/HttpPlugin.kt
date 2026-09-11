package com.lyraaria.mobile.player

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.URL

/** 原生 HTTP（无 CORS 限制）：B站公开 API / LeiZ 合成流触发等跨域请求走这里 */
@CapacitorPlugin(name = "NativeHttp")
class HttpPlugin : Plugin() {

    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) { call.reject("缺少 url"); return }
        val method = (call.getString("method", "GET") ?: "GET").uppercase()
        val headers = call.getObject("headers")
        val readTimeoutMs = (call.getInt("readTimeout", 20000) ?: 20000).coerceIn(3000, 60000)
        // 酷狗个别子域（specialrec 等）证书不含该子域名 → 仅 *.kugou.com 放行（对齐 PC kugouTlsOk）
        val trustAll = call.getBoolean("trustAll", false) == true
        Thread {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 15000
                    readTimeout = readTimeoutMs
                    instanceFollowRedirects = true
                    if (trustAll) {
                        val host = try { URL(url).host } catch (_: Exception) { "" }
                        if (host == "kugou.com" || host.endsWith(".kugou.com")) {
                            val tm = object : javax.net.ssl.X509TrustManager {
                                override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {}
                                override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {}
                                override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
                            }
                            val trustManagers = arrayOf<javax.net.ssl.TrustManager>(tm)
                            val ssl = javax.net.ssl.SSLContext.getInstance("TLS")
                            ssl.init(null, trustManagers, java.security.SecureRandom())
                            (this as javax.net.ssl.HttpsURLConnection).sslSocketFactory = ssl.socketFactory
                            (this as javax.net.ssl.HttpsURLConnection).hostnameVerifier = javax.net.ssl.HostnameVerifier { h, _ -> h == "kugou.com" || h.endsWith(".kugou.com") }
                        }
                    }
                    if (headers != null) {
                        val it = headers.keys()
                        while (it.hasNext()) {
                            val k = it.next()
                            setRequestProperty(k, headers.getString(k) ?: continue)
                        }
                    }
                    if (method != "GET") doOutput = true
                    val reqBody = call.getString("body")
                    if (!reqBody.isNullOrEmpty()) {
                        val os = outputStream
                        os.write(reqBody.toByteArray(Charsets.UTF_8))
                        os.flush()
                    }
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                // 响应头回传（set-cookie 多条用 \n 连接——网易云登录态回收依赖）
                val hs = JSObject()
                for ((k, v) in conn.headerFields) {
                    if (k == null || v == null) continue
                    val key = k.lowercase()
                    hs.put(key, if (key == "set-cookie") v.joinToString("\n") else v.joinToString(", "))
                }
                call.resolve(JSObject().apply { put("status", code); put("data", body); put("headers", hs) })
            } catch (e: Exception) {
                call.reject(PlayerHolder.sanitize(e.message ?: "网络异常"))
            } finally {
                try { conn?.disconnect() } catch (_: Exception) {}
            }
        }.start()
    }
}
