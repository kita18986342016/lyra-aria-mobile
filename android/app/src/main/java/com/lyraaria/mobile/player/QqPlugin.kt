package com.lyraaria.mobile.player

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/**
 * QqMusic：QQ 官方接口直连（原生层，无 CORS 限制）
 * 对齐桌面端 core/qq.js：搜索(search_for_qq_cp 匿名) / 歌单(musicu.fcg 分页) / 歌词(匿名)
 * 播放直链需登录 Cookie → 移动端不配 Cookie，Web 层走「严格换源」
 * 纪律：仅返回免费歌(payplay=0)；对外只叫「QQ 音源」
 * 线程：网络 I/O 全部走单线程 io 池（Capacitor 插件方法默认主线程 → 同步阻塞会 ANR）
 */
@CapacitorPlugin(name = "QqMusic")
class QqPlugin : Plugin() {

    private val io = Executors.newSingleThreadExecutor()
    private val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"

    private fun get(url: String): Pair<Int, JSONObject?> {
        var conn: HttpURLConnection? = null
        var reader: BufferedReader? = null
        try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 20000
            conn.readTimeout = 20000
            conn.setRequestProperty("User-Agent", UA)
            conn.setRequestProperty("Referer", "https://y.qq.com/")
            val code = conn.responseCode
            val body = StringBuilder()
            reader = BufferedReader(InputStreamReader(if (code in 200..299) conn.inputStream else conn.errorStream, "utf-8"))
            var line: String?
            while (reader.readLine().also { line = it } != null) body.append(line)
            var j: JSONObject? = null
            try { j = JSONObject(body.toString()) } catch (_: Exception) {}
            return code to j
        } catch (e: Exception) {
            return 0 to null
        } finally {
            try { reader?.close() } catch (_: Exception) {}
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    private fun post(url: String, bodyObj: JSONObject): Pair<Int, JSONObject?> {
        var conn: HttpURLConnection? = null
        var reader: BufferedReader? = null
        try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 20000
            conn.readTimeout = 20000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("User-Agent", UA)
            conn.setRequestProperty("Referer", "https://y.qq.com/")
            conn.outputStream.use { it.write(bodyObj.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val body = StringBuilder()
            reader = BufferedReader(InputStreamReader(if (code in 200..299) conn.inputStream else conn.errorStream, "utf-8"))
            var line: String?
            while (reader.readLine().also { line = it } != null) body.append(line)
            var j: JSONObject? = null
            try { j = JSONObject(body.toString()) } catch (_: Exception) {}
            return code to j
        } catch (e: Exception) {
            return 0 to null
        } finally {
            try { reader?.close() } catch (_: Exception) {}
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    // 标准化歌曲
    private fun normSong(it: JSONObject): JSObject {
        val singers = it.optJSONArray("singer")
        val artist = StringBuilder()
        if (singers != null) {
            for (i in 0 until singers.length()) {
                val s = singers.optJSONObject(i) ?: continue
                val n = s.optString("name").ifEmpty { s.optString("title") }
                if (n.isNotEmpty()) { if (artist.isNotEmpty()) artist.append("、"); artist.append(n) }
            }
        }
        val albummid = it.optString("albummid").ifEmpty { it.optJSONObject("album")?.optString("mid") ?: "" }
        val o = JSObject().apply {
            put("id", it.optString("songmid").ifEmpty { it.optString("mid") })
            put("name", it.optString("songname").ifEmpty { it.optString("name") })
            put("artists", artist.toString())
            put("album", it.optString("albumname").ifEmpty { it.optJSONObject("album")?.optString("name") ?: "" })
            put("duration", it.optInt("interval", 0))
            put("picUrl", if (albummid.isNotEmpty()) "https://y.gtimg.cn/music/photo_new/T002R300x300M000$albummid.jpg" else "")
            val pay = it.optJSONObject("pay")
            put("payplay", if (pay != null) pay.optInt("payplay", 0) else 0)
        }
        return o
    }

    @PluginMethod
    fun search(call: PluginCall) {
        val query = (call.getString("q") ?: "").trim()
        val limit = call.getInt("limit", 20) ?: 20
        val lmt = limit.coerceIn(1, 30)
        if (query.isEmpty()) { call.reject("参数错误"); return }
        io.execute {
            val n = (lmt * 3).coerceIn(10, 30)
            val url = "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&platform=yqq&hostUin=0&needNewCode=0&catZhida=0&w=" +
                URLEncoder.encode(query, "utf-8") + "&n=$n"
            val (code, j) = get(url)
            if (code != 200 || j == null) { call.reject("QQ搜索无结果或服务异常"); return@execute }
            val data = j.optJSONObject("data") ?: run { call.reject("QQ搜索无结果"); return@execute }
            val song = data.optJSONObject("song") ?: run { call.reject("QQ搜索无结果"); return@execute }
            val list = song.optJSONArray("list") ?: JSONArray()
            val free = JSArray()
            var filtered = 0
            for (i in 0 until list.length()) {
                val it = list.optJSONObject(i) ?: continue
                val pay = it.optJSONObject("pay")?.optInt("payplay", 0) ?: 0
                if (pay != 0) { filtered++; continue }
                val s = normSong(it)
                if (s.getString("id").isNullOrEmpty() || s.getString("name").isNullOrEmpty()) continue
                s.put("source", "qq")
                free.put(s)
                if (free.length() >= lmt) break
            }
            if (free.length() == 0) { call.reject("QQ 未找到可播放的歌曲"); return@execute }
            call.resolve(JSObject().apply {
                put("songs", free)
                put("filtered", filtered)
            })
        }
    }

    @PluginMethod
    fun playlist(call: PluginCall) {
        val id = (call.getString("id") ?: "").trim()
        // 数字歌单 ID 位数上限约束：超 Long 上限直接拒绝（防 NumberFormatException）
        if (!Regex("^\\d{5,18}$").matches(id)) { call.reject("歌单 ID 无效"); return }
        io.execute {
            val all = JSArray()
            val seen = HashSet<String>()
            var name = ""
            var picUrl = ""
            var begin = 0
            var hasMore = true
            var firstPic = ""
            while (hasMore && begin < 5000) {
                val body = JSONObject()
                body.put("comm", JSONObject().apply { put("uin", 0); put("format", "json"); put("ct", 24); put("cv", 0) })
                body.put("req_0", JSONObject().apply {
                    put("module", "music.srfDissInfo.aiDissInfo")
                    put("method", "uniform_get_Dissinfo")
                    put("param", JSONObject().apply {
                        put("disstid", id.toLong())
                        put("enc_host_uin", "")
                        put("tag", 0)
                        put("userinfo", 1)
                        put("song_begin", begin)
                        put("song_num", 100)
                    })
                })
                val (code, j) = post("https://u.y.qq.com/cgi-bin/musicu.fcg", body)
                if (code != 200 || j == null) { call.reject("歌单获取失败"); return@execute }
                val d = j.optJSONObject("req_0")?.optJSONObject("data")
                if (d == null) { call.reject("歌单获取失败"); return@execute }
                if (name.isEmpty()) {
                    val dir = d.optJSONObject("dirinfo")
                    if (dir != null) { name = dir.optString("title"); picUrl = dir.optString("pic") }
                }
                val songs = d.optJSONArray("songlist") ?: JSONArray()
                if (songs.length() == 0) break
                for (i in 0 until songs.length()) {
                    val it = songs.optJSONObject(i) ?: continue
                    // 纪律：仅收集免费歌（pay_play != 0 跳过）
                    val pay = it.optJSONObject("pay")?.optInt("pay_play", 0) ?: 0
                    if (pay != 0) continue
                    val mid = it.optString("mid").ifEmpty { it.optString("songmid") }
                    if (mid.isEmpty() || seen.contains(mid)) continue
                    seen.add(mid)
                    val s = normSong(it)
                    s.put("source", "qq")
                    s.put("payplay", pay)
                    if (firstPic.isEmpty() && s.optString("picUrl").isNotEmpty()) firstPic = s.optString("picUrl")
                    all.put(s)
                }
                hasMore = d.optBoolean("hasmore", false)
                begin += 100
            }
            if (all.length() == 0) { call.reject("歌单为空或解析失败"); return@execute }
            val cover = picUrl.ifEmpty { firstPic }
            call.resolve(JSObject().apply {
                put("name", name)
                put("picUrl", cover)
                put("songs", all)
            })
        }
    }

    @PluginMethod
    fun lyrics(call: PluginCall) {
        val mid = (call.getString("mid") ?: "").trim()
        if (mid.isEmpty()) { call.reject("参数错误"); return }
        io.execute {
            val url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=" + URLEncoder.encode(mid, "utf-8") +
                "&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0"
            val (code, j) = get(url)
            if (code != 200 || j == null || j.optInt("retcode", -1) != 0) { call.reject("QQ歌词获取失败"); return@execute }
            call.resolve(JSObject().apply {
                put("original", j.optString("lyric", ""))
                put("translated", j.optString("trans", ""))
            })
        }
    }

    override fun handleOnDestroy() {
        try { io.shutdownNow() } catch (_: Exception) {}
        super.handleOnDestroy()
    }
}
