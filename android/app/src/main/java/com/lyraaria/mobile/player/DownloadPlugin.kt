package com.lyraaria.mobile.player

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Downloader：在线歌曲下载（存应用私有目录，无外部存储权限需求）
 *   start({url, id, title, artist, album, source}) → 解析 → 流式下载 → 写文件 → MediaScanner 登记
 * 事件：addListener('download', {id, status: queued|downloading|done|error, pct, title, path, reason})
 * 文件位置：Android/data/com.lyraaria.mobile/files/Music/深空折韵下载/<歌手> - <歌名>.<ext>（重名加 (n)）
 * 严格串行（单线程池，对齐桌面 dlPump 并发 1）；单例任务表防重复。
 * 已完成 → 系统通知（对齐桌面下载完成提示）。
 */
@CapacitorPlugin(
    name = "Downloader",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])]
)
class DownloadPlugin : Plugin() {

    private val tasks = ConcurrentHashMap<String, DownloadTask>()
    private val pool = Executors.newSingleThreadExecutor()
    private var channelReady = false

    private fun ensureChannel() {
        if (channelReady || Build.VERSION.SDK_INT < 26) return
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val ch = NotificationChannel(
                "downloads", "下载完成",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = "在线歌曲下载完成提醒" }
            nm.createNotificationChannel(ch)
            channelReady = true
        } catch (_: Exception) {}
    }

    /** 下载完成 → 系统通知（权限未授则静默跳过，不强制） */
    private fun notifyDone(t: DownloadTask) {
        try {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) return
            ensureChannel()
            val launch = PendingIntent.getActivity(
                context, 0,
                context.packageManager.getLaunchIntentForPackage(context.packageName),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            val n = NotificationCompat.Builder(context, "downloads")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("下载完成")
                .setContentText((t.artist.ifBlank { "" }.let { if (it.isNotEmpty()) "$it - " else "" }) + t.title)
                .setContentIntent(launch)
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(context).notify(t.id.hashCode(), n)
        } catch (_: Exception) {}
    }

    private inner class DownloadTask(
        val id: String, val url: String, val title: String,
        val artist: String, val album: String, val source: String,
        val coverUrl: String = "", val lrc: String = ""
    ) {
        @Volatile var canceled = false
        @Volatile var running = false
        @Volatile var path: String? = null
        @Volatile var pct = 0f
        @Volatile var lastEmitMs = 0L
        /** 当前连接引用：cancel 时 disconnect 可立即中断阻塞中的 read（不等 60s 读超时） */
        @Volatile var conn: HttpURLConnection? = null
    }

    private fun emit(t: DownloadTask, status: String, reason: String? = null) {
        val data = JSObject().apply {
            put("id", t.id)
            put("status", status)
            put("pct", t.pct)
            put("title", t.title)
            if (t.path != null) put("path", t.path)
            if (reason != null) put("reason", reason)
        }
        notifyListeners("download", data, true)
    }

    private fun safeName(s: String): String {
        var r = s.trim().replace(Regex("[\\\\/:*?\"<>|]"), "_").replace(Regex("\\s+"), " ")
        if (r.isEmpty()) r = "未知"
        return r.take(80)
    }

    private fun startTask(call: PluginCall, t: DownloadTask) {
        // 原子占位：防并发重复 start 同 id（检查+插入竞态）
        if (tasks.putIfAbsent(t.id, t) != null) { call.reject("该歌曲已在下载中"); return }
        emit(t, "queued")
        pool.execute {
            t.running = true
            var conn: HttpURLConnection? = null
            var target: File? = null
            try {
                val u = URL(t.url)
                conn = (u.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20000
                    readTimeout = 60000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "Mozilla/5.0 LyraAriaMobile/1.0")
                }
                t.conn = conn
                val code = conn.responseCode
                if (code !in 200..299) {
                    if (!t.canceled) emit(t, "error", "HTTP $code")
                    return@execute
                }
                val total = conn.contentLengthLong
                val ext = pickExt(conn.contentType, conn.url.path)
                val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "深空折韵下载")
                if (!dir.exists()) dir.mkdirs()
                // 文件名对齐桌面：<歌手> - <歌名>[ (n)].ext
                val base = if (t.artist.isNotBlank()) safeName(t.artist) + " - " + safeName(t.title) else safeName(t.title)
                var file = File(dir, base + ext)
                var seq = 1
                while (file.exists()) {
                    file = File(dir, "$base($seq)$ext")
                    seq++
                }
                target = file
                val ins = conn.inputStream
                FileOutputStream(target).use { fos ->
                    val buf = ByteArray(64 * 1024)
                    var read: Int
                    var done: Long = 0
                    while (ins.read(buf).also { read = it } != -1) {
                        if (t.canceled) {
                            // 取消：清半成品 + 中断连接（disconnect 使阻塞 read 立即抛错退出）
                            ins.close()
                            try { conn?.disconnect() } catch (_: Exception) {}
                            try { fos.fd.sync() } catch (_: Exception) {}
                            return@execute
                        }
                        fos.write(buf, 0, read)
                        done += read
                        t.pct = if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else 0f
                        // 进度节流：≥500ms 才发一次，避免海量事件压垮 WebView 桥
                        val now = System.currentTimeMillis()
                        if (now - t.lastEmitMs >= 500) { t.lastEmitMs = now; emit(t, "downloading") }
                    }
                    fos.fd.sync()
                }
                ins.close()
                if (t.canceled) {
                    target.delete()
                    tasks.remove(t.id)
                    return@execute
                }
                t.path = target.absolutePath
                t.pct = 1f
                // .lrc 歌词落盘（有歌词才写，失败不影响下载结果）
                if (t.lrc.isNotBlank()) {
                    try { File(dir, "$base.lrc").writeText(t.lrc, Charsets.UTF_8) } catch (_: Exception) {}
                }
                // 写标签（标题/歌手/专辑/封面）；mp3 → ID3v2.3，flac → Vorbis Comment + PICTURE
                if (!t.canceled && (ext == ".mp3" || ext == ".flac")) {
                    emit(t, "tagging")
                    val cover = if (t.coverUrl.isNotBlank()) fetchBytes(t.coverUrl) else null
                    try {
                        if (ext == ".mp3") writeId3Tags(target, t.title, t.artist, t.album, cover)
                        else writeFlacTags(target, t.title, t.artist, t.album, cover)
                    } catch (_: Exception) {}
                }
                // MediaScanner 登记 → 本地媒体库可见（标签写完后登记，确保时长/标签元数据最新）
                MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null, null)
                emit(t, "done")
                notifyDone(t)
            } catch (e: Exception) {
                if (!t.canceled) {
                    // 异常 = 未完成：清理半成品，避免残留损坏文件
                    try { target?.takeIf { it.exists() }?.delete() } catch (_: Exception) {}
                    emit(t, "error", PlayerHolder.sanitize(e.message ?: "网络异常"))
                }
            } finally {
                try { conn?.disconnect() } catch (_: Exception) {}
                // 兜底：取消路径的任何提前 return 都清半成品，防残片堆积
                if (t.canceled) {
                    try { target?.takeIf { it.exists() }?.delete() } catch (_: Exception) {}
                }
                tasks.remove(t.id)
            }
        }
        call.resolve(JSObject().apply { put("ok", true) })
    }

    /** 下载封面/图片字节（上限 8MB，失败返回 null） */
    private fun fetchBytes(urlStr: String): ByteArray? {
        return try {
            val c = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                connectTimeout = 10000
                readTimeout = 15000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "Mozilla/5.0 LyraAriaMobile/1.0")
            }
            try {
                if (c.responseCode !in 200..299) return null
                val ins = c.inputStream
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(32 * 1024)
                var r: Int
                var total = 0
                while (ins.read(buf).also { r = it } != -1) {
                    total += r
                    if (total > 8 * 1024 * 1024) return null
                    out.write(buf, 0, r)
                }
                out.toByteArray()
            } finally {
                try { c.disconnect() } catch (_: Exception) {}
            }
        } catch (_: Exception) { null }
    }

    /** ID3v2.3 帧封装：帧ID + 大端长度 + 标志 + 体 */
    private fun id3Frame(id: String, body: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        out.write(id.toByteArray(Charsets.ISO_8859_1))
        val n = body.size
        out.write((n ushr 24) and 0xFF); out.write((n ushr 16) and 0xFF)
        out.write((n ushr 8) and 0xFF); out.write(n and 0xFF)
        out.write(0); out.write(0)
        out.write(body)
        return out.toByteArray()
    }

    /** 文本帧：编码 0x01 = UTF-16 带 BOM（v2.3 规范内，兼容中文） */
    private fun id3TextFrame(id: String, text: String): ByteArray {
        val body = java.io.ByteArrayOutputStream()
        body.write(0x01)
        body.write(0xFF); body.write(0xFE)
        body.write(text.toByteArray(Charsets.UTF_16LE))
        body.write(0); body.write(0)
        return id3Frame(id, body.toByteArray())
    }

    /** 封面帧 APIC：latin1 mime + front cover + 空描述 + 图片数据 */
    private fun id3ApicFrame(img: ByteArray): ByteArray {
        val body = java.io.ByteArrayOutputStream()
        body.write(0x00)
        body.write("image/jpeg".toByteArray(Charsets.ISO_8859_1)); body.write(0)
        body.write(0x03)
        body.write(0)
        body.write(img)
        return id3Frame("APIC", body.toByteArray())
    }

    /** mp3 写 ID3v2.3 标签：头部插入标签帧，原音频数据保持不变；临时文件原子替换 */
    private fun writeId3Tags(file: File, title: String, artist: String, album: String, cover: ByteArray?) {
        val frames = ArrayList<ByteArray>()
        if (title.isNotBlank()) frames.add(id3TextFrame("TIT2", title))
        if (artist.isNotBlank()) frames.add(id3TextFrame("TPE1", artist))
        if (album.isNotBlank()) frames.add(id3TextFrame("TALB", album))
        if (cover != null && cover.isNotEmpty()) frames.add(id3ApicFrame(cover))
        if (frames.isEmpty()) return
        val body = java.io.ByteArrayOutputStream()
        frames.forEach { body.write(it); }
        val bodyBytes = body.toByteArray()
        val head = java.io.ByteArrayOutputStream()
        head.write("ID3".toByteArray(Charsets.ISO_8859_1))
        head.write(0x03); head.write(0x00)
        head.write(0x00)
        val n = bodyBytes.size
        head.write((n ushr 21) and 0x7F); head.write((n ushr 14) and 0x7F)
        head.write((n ushr 7) and 0x7F); head.write(n and 0x7F)
        val tmp = File(file.parentFile, file.name + ".tagtmp")
        try {
            FileOutputStream(tmp).use { fos ->
                fos.write(head.toByteArray())
                fos.write(bodyBytes)
                file.inputStream().use { it.copyTo(fos, 64 * 1024) }
                fos.fd.sync()
            }
            if (!tmp.renameTo(file)) {
                tmp.copyTo(file, overwrite = true)
                tmp.delete()
            }
        } finally {
            try { if (tmp.exists()) tmp.delete() } catch (_: Exception) {}
        }
    }

    /** FLAC 元数据块封装：1 字节（最高位=末块标志 | 低7位=类型）+ 3 字节大端长度 + 数据 */
    private fun flacBlock(type: Int, data: ByteArray, last: Boolean): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        out.write((if (last) 0x80 else 0x00) or (type and 0x7F))
        val n = data.size
        out.write((n ushr 16) and 0xFF); out.write((n ushr 8) and 0xFF); out.write(n and 0xFF)
        out.write(data)
        return out.toByteArray()
    }

    /** FLAC Vorbis Comment 块（注意：块内小端）。仅含 TITLE/ARTIST/ALBUM */
    private fun flacVorbisComment(title: String, artist: String, album: String): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val vendor = "LyraAriaMobile".toByteArray(Charsets.UTF_8)
        fun le32(n: Int) { out.write(n and 0xFF); out.write((n ushr 8) and 0xFF); out.write((n ushr 16) and 0xFF); out.write((n ushr 24) and 0xFF) }
        le32(vendor.size); out.write(vendor)
        val comments = ArrayList<ByteArray>()
        if (title.isNotBlank()) comments.add(("TITLE=$title").toByteArray(Charsets.UTF_8))
        if (artist.isNotBlank()) comments.add(("ARTIST=$artist").toByteArray(Charsets.UTF_8))
        if (album.isNotBlank()) comments.add(("ALBUM=$album").toByteArray(Charsets.UTF_8))
        le32(comments.size)
        comments.forEach { le32(it.size); out.write(it) }
        return out.toByteArray()
    }

    /** FLAC PICTURE 块（大端）：front cover + jpeg 数据 */
    private fun flacPicture(img: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun be32(n: Int) { out.write((n ushr 24) and 0xFF); out.write((n ushr 16) and 0xFF); out.write((n ushr 8) and 0xFF); out.write(n and 0xFF) }
        be32(3) // front cover
        val mime = "image/jpeg".toByteArray(Charsets.ISO_8859_1)
        be32(mime.size); out.write(mime)
        be32(0) // 描述空
        be32(0); be32(0); be32(0); be32(0) // 宽/高/位深/色数（未知置 0）
        be32(img.size); out.write(img)
        return out.toByteArray()
    }

    /**
     * FLAC 写标签：在 STREAMINFO 块之后插入 VORBIS_COMMENT + PICTURE。
     * 原 STREAMINFO 的末块标志清零；插入块中最后一个仅当原 STREAMINFO 就是末块时承接末块标志。
     */
    private fun writeFlacTags(file: File, title: String, artist: String, album: String, cover: ByteArray?) {
        val head = ByteArray(4)
        file.inputStream().use { if (it.read(head) != 4 || String(head, Charsets.ISO_8859_1) != "fLaC") return }
        // 先探测 STREAMINFO 是否为唯一元数据块（即原末块）
        var streamInfoIsLast = false
        file.inputStream().use { ins ->
            ins.skip(4)
            val b = ins.read()
            streamInfoIsLast = (b and 0x80) != 0
        }
        val tmp = File(file.parentFile, file.name + ".tagtmp")
        try {
            file.inputStream().use { ins ->
                FileOutputStream(tmp).use { fos ->
                    ins.skip(4) // 跳过 fLaC 魔数（head 单独写出）
                    fos.write(head)
                    // STREAMINFO 原样复制，末块标志清零
                    val b0 = ins.read() and 0x7F
                    val l0 = ((ins.read() and 0xFF) shl 16) or ((ins.read() and 0xFF) shl 8) or (ins.read() and 0xFF)
                    fos.write(b0)
                    fos.write((l0 ushr 16) and 0xFF); fos.write((l0 ushr 8) and 0xFF); fos.write(l0 and 0xFF)
                    val buf = ByteArray(64 * 1024)
                    var left = l0
                    while (left > 0) {
                        val r = ins.read(buf, 0, minOf(buf.size, left))
                        if (r < 0) return
                        fos.write(buf, 0, r)
                        left -= r
                    }
                    // 插入 VORBIS_COMMENT + PICTURE（此刻位于 STREAMINFO 数据之后，直接续写剩余原文件内容）
                    val vcLast = streamInfoIsLast && (cover == null || cover.isEmpty())
                    fos.write(flacBlock(4, flacVorbisComment(title, artist, album), vcLast))
                    if (cover != null && cover.isNotEmpty()) fos.write(flacBlock(6, flacPicture(cover), streamInfoIsLast))
                    val buf2 = ByteArray(64 * 1024)
                    var r2: Int
                    while (ins.read(buf2).also { r2 = it } != -1) fos.write(buf2, 0, r2)
                    fos.fd.sync()
                }
            }
            if (!tmp.renameTo(file)) { tmp.copyTo(file, overwrite = true); tmp.delete() }
        } finally {
            try { if (tmp.exists()) tmp.delete() } catch (_: Exception) {}
        }
    }

    private fun pickExt(contentType: String?, path: String?): String {
        val p = path?.lowercase() ?: ""
        if (p.contains(".flac")) return ".flac"
        if (p.contains(".m4a")) return ".m4a"
        if (p.contains(".aac")) return ".aac"
        if (p.contains(".wav")) return ".wav"
        if (p.contains(".ape")) return ".ape"
        if (p.contains(".ogg")) return ".ogg"
        val ct = contentType ?: ""
        return when {
            ct.contains("flac") -> ".flac"
            ct.contains("m4a") || ct.contains("mp4") -> ".m4a"
            ct.contains("wav") -> ".wav"
            ct.contains("aac") -> ".aac"
            else -> ".mp3"
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id 缺失")
        val url = call.getString("url") ?: return call.reject("url 缺失")
        val t = DownloadTask(
            id, url,
            call.getString("title") ?: "", call.getString("artist") ?: "",
            call.getString("album") ?: "", call.getString("source") ?: "",
            call.getString("coverUrl") ?: "", call.getString("lrc") ?: ""
        )
        startTask(call, t)
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id 缺失")
        val t = tasks[id]
        if (t != null) {
            t.canceled = true
            // disconnect 使阻塞中的 ins.read 立即抛 IOException 退出（不等 60s 读超时）
            try { t.conn?.disconnect() } catch (_: Exception) {}
        }
        call.resolve()
    }

    override fun handleOnDestroy() {
        try { pool.shutdownNow() } catch (_: Exception) {}
        super.handleOnDestroy()
    }

    /** 下载目录内已下载文件列表（供"已下载"页展示；缺失检测） */
    @PluginMethod
    fun listDownloaded(call: PluginCall) {
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "深空折韵下载")
        val arr = com.getcapacitor.JSArray()
        val out = JSObject().apply { put("files", arr) }
        try {
            if (dir.exists()) {
                dir.listFiles()?.filter { it.isFile && !it.name.endsWith(".lrc") }?.sortedByDescending { it.lastModified() }?.forEach { f ->
                    arr.put(JSObject().apply {
                        put("path", f.absolutePath)
                        put("name", f.name)
                        put("size", f.length())
                        put("url", "file://" + f.absolutePath)
                    })
                }
            }
        } catch (_: Exception) {}
        call.resolve(out)
    }

    @PluginMethod
    fun deleteFile(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("path 缺失")
        try {
            val f = File(path)
            val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "深空折韵下载")
            // 安全：只允许删下载目录**直接子文件**（精确匹配父目录，防前缀越界）
            val parentOk = try { f.parentFile?.canonicalPath == dir.canonicalPath } catch (_: Exception) { false }
            if (parentOk && f.isFile && f.exists() && f.delete()) {
                // 同名 .lrc 歌词一并清理（音频删了歌词留着没意义）
                try {
                    val lrc = File(f.parentFile, f.name.replace(Regex("\\.[^.]+$"), ".lrc"))
                    if (lrc.isFile && lrc.exists()) lrc.delete()
                } catch (_: Exception) {}
                // 通知 MediaStore 删除索引
                try {
                    context.contentResolver.delete(
                        android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                        "${android.provider.MediaStore.Audio.Media.DATA} = ?",
                        arrayOf(f.absolutePath)
                    )
                } catch (_: Exception) {}
                call.resolve(JSObject().apply { put("ok", true) })
            } else {
                call.reject("删除失败")
            }
        } catch (e: Exception) {
            call.reject(PlayerHolder.sanitize(e.message ?: "删除失败"))
        }
    }

    /* ================= 标签编辑器（对齐 PC tag:read/tag:write；范围=下载目录） ================= */

    private fun downloadDir(): File = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "深空折韵下载")

    private fun inDownloadDir(f: File): Boolean =
        try { f.parentFile?.canonicalPath == downloadDir().canonicalPath } catch (_: Exception) { false }

    /** 读 ID3v2 帧序列（v2.3 大端长度 / v2.4 synchsafe 都兼容），无标签返回 null */
    private fun parseId3Frames(f: File): List<Pair<String, ByteArray>>? {
        val ins = f.inputStream()
        val head = ByteArray(10)
        if (ins.read(head) != 10) { ins.close(); return null }
        if (!(head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() && head[2] == '3'.code.toByte())) { ins.close(); return null }
        val major = head[3].toInt() and 0xFF
        val flags = head[5].toInt() and 0xFF
        val size = ((head[6].toInt() and 0x7F) shl 21) or ((head[7].toInt() and 0x7F) shl 14) or
            ((head[8].toInt() and 0x7F) shl 7) or (head[9].toInt() and 0x7F)
        val body = ByteArray(size)
        var read = 0
        while (read < size) {
            val r = ins.read(body, read, size - read)
            if (r < 0) break
            read += r
        }
        ins.close()
        if (flags and 0x40 != 0 && body.size >= 4) {
            // 扩展头：v2.3 长度不含自身(4字节)；跳过
            val ext = ((body[0].toInt() and 0xFF) shl 24) or ((body[1].toInt() and 0xFF) shl 16) or
                ((body[2].toInt() and 0xFF) shl 8) or (body[3].toInt() and 0xFF)
            val skip = if (major >= 4) ext - 4 else ext
            return parseFrames(body, minOf(body.size, 4 + maxOf(0, skip)), major)
        }
        return parseFrames(body, 0, major)
    }

    private fun parseFrames(body: ByteArray, start: Int, major: Int): List<Pair<String, ByteArray>> {
        val frames = ArrayList<Pair<String, ByteArray>>()
        var p = start
        while (p + 10 <= body.size) {
            val id = String(body, p, 4, Charsets.ISO_8859_1)
            if (!id.matches(Regex("[A-Z0-9]{4}"))) break
            val n: Int = if (major >= 4) {
                ((body[p + 4].toInt() and 0x7F) shl 21) or ((body[p + 5].toInt() and 0x7F) shl 14) or
                    ((body[p + 6].toInt() and 0x7F) shl 7) or (body[p + 7].toInt() and 0x7F)
            } else {
                ((body[p + 4].toInt() and 0xFF) shl 24) or ((body[p + 5].toInt() and 0xFF) shl 16) or
                    ((body[p + 6].toInt() and 0xFF) shl 8) or (body[p + 7].toInt() and 0xFF)
            }
            if (n <= 0 || p + 10 + n > body.size) break
            frames.add(id to body.copyOfRange(p + 10, p + 10 + n))
            p += 10 + n
        }
        return frames
    }

    /** ID3 文本帧解码：首字节编码 0x00 latin1 / 0x01 UTF-16(BOM) / 0x02 UTF-16BE / 0x03 UTF-8 */
    private fun id3DecodeText(body: ByteArray): String {
        if (body.isEmpty()) return ""
        val enc = body[0].toInt() and 0xFF
        val text = when (enc) {
            0x01 -> {
                if (body.size >= 3 && body[1] == 0xFF.toByte() && body[2] == 0xFE.toByte())
                    String(body, 3, body.size - 3, Charsets.UTF_16LE)
                else if (body.size >= 3 && body[1] == 0xFE.toByte() && body[2] == 0xFF.toByte())
                    String(body, 3, body.size - 3, Charsets.UTF_16BE)
                else String(body, 1, body.size - 1, Charsets.UTF_16LE)
            }
            0x02 -> String(body, 1, body.size - 1, Charsets.UTF_16BE)
            0x03 -> String(body, 1, body.size - 1, Charsets.UTF_8)
            else -> String(body, 1, body.size - 1, Charsets.ISO_8859_1)
        }
        return text.trimEnd('\u0000').trim()
    }

    /** APIC 帧体 → 图片数据（enc + mime\0 + type + desc 终止 + 数据） */
    private fun id3ApicData(body: ByteArray): ByteArray? {
        if (body.size < 4) return null
        val enc = body[0].toInt() and 0xFF
        var p = 1
        while (p < body.size && body[p].toInt() != 0) p++ // mime 结尾
        p++ // mime null
        if (p >= body.size) return null
        p++ // picture type
        // 描述终止：UTF-16 系为双 0，否则单 0
        if (enc == 0x01 || enc == 0x02) {
            while (p + 1 < body.size && !(body[p].toInt() == 0 && body[p + 1].toInt() == 0)) p++
            p += 2
        } else {
            while (p < body.size && body[p].toInt() != 0) p++
            p++
        }
        if (p >= body.size) return null
        return body.copyOfRange(p, body.size)
    }

    /** FLAC 块遍历：返回 (type, data) 列表（保留原顺序与末块信息由调用方重建） */
    private fun readFlacBlocks(f: File): List<Pair<Int, ByteArray>>? {
        val ins = f.inputStream()
        val magic = ByteArray(4)
        if (ins.read(magic) != 4 || String(magic, Charsets.ISO_8859_1) != "fLaC") { ins.close(); return null }
        val blocks = ArrayList<Pair<Int, ByteArray>>()
        while (true) {
            val b = ins.read()
            if (b < 0) break
            val type = b and 0x7F
            val len = ((ins.read() and 0xFF) shl 16) or ((ins.read() and 0xFF) shl 8) or (ins.read() and 0xFF)
            if (len < 0) break
            val data = ByteArray(len)
            var read = 0
            while (read < len) {
                val r = ins.read(data, read, len - read)
                if (r < 0) break
                read += r
            }
            blocks.add(type to data)
            if (b and 0x80 != 0) break
        }
        ins.close()
        return blocks
    }

    private fun parseVorbisComments(data: ByteArray): Map<String, String> {
        val out = HashMap<String, String>()
        try {
            var p = 0
            fun le32(): Int { val v = (data[p].toInt() and 0xFF) or ((data[p + 1].toInt() and 0xFF) shl 8) or ((data[p + 2].toInt() and 0xFF) shl 16) or ((data[p + 3].toInt() and 0xFF) shl 24); p += 4; return v }
            val vendorLen = le32(); p += vendorLen
            val count = le32()
            for (i in 0 until count) {
                val cl = le32()
                if (p + cl > data.size) break
                val c = String(data, p, cl, Charsets.UTF_8); p += cl
                val idx = c.indexOf('=')
                if (idx > 0) out[c.substring(0, idx).uppercase()] = c.substring(idx + 1)
            }
        } catch (_: Exception) {}
        return out
    }

    private fun flacPictureData(data: ByteArray): ByteArray? {
        return try {
            var p = 0
            fun be32(): Int { val v = ((data[p].toInt() and 0xFF) shl 24) or ((data[p + 1].toInt() and 0xFF) shl 16) or ((data[p + 2].toInt() and 0xFF) shl 8) or (data[p + 3].toInt() and 0xFF); p += 4; return v }
            be32() // type
            val mimeLen = be32(); p += mimeLen
            val descLen = be32(); p += descLen
            p += 16 // 宽/高/位深/色数
            val dataLen = be32()
            if (dataLen < 0 || p + dataLen > data.size) null else data.copyOfRange(p, p + dataLen)
        } catch (_: Exception) { null }
    }

    @PluginMethod
    fun readTags(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("path 缺失")
        try {
            val f = File(path)
            if (!inDownloadDir(f) || !f.isFile) return call.reject("文件不在下载目录")
            val out = JSObject().apply { put("ok", true); put("title", ""); put("artist", ""); put("album", "") }
            val name = f.name.lowercase()
            if (name.endsWith(".mp3")) {
                val frames = parseId3Frames(f) ?: emptyList()
                for ((id, body) in frames) {
                    when (id) {
                        "TIT2" -> if ((out.getString("title") ?: "").isEmpty()) out.put("title", id3DecodeText(body))
                        "TPE1" -> if ((out.getString("artist") ?: "").isEmpty()) out.put("artist", id3DecodeText(body))
                        "TALB" -> if ((out.getString("album") ?: "").isEmpty()) out.put("album", id3DecodeText(body))
                        "APIC" -> if (!out.has("picture")) {
                            val pic = id3ApicData(body)
                            if (pic != null) {
                                out.put("picture", android.util.Base64.encodeToString(pic, android.util.Base64.NO_WRAP))
                                out.put("mime", "image/jpeg")
                            }
                        }
                    }
                }
            } else if (name.endsWith(".flac")) {
                val blocks = readFlacBlocks(f) ?: emptyList()
                for ((type, data) in blocks) {
                    if (type == 4) {
                        val vc = parseVorbisComments(data)
                        if ((out.getString("title") ?: "").isEmpty()) out.put("title", vc["TITLE"] ?: "")
                        if ((out.getString("artist") ?: "").isEmpty()) out.put("artist", vc["ARTIST"] ?: "")
                        if ((out.getString("album") ?: "").isEmpty()) out.put("album", vc["ALBUM"] ?: "")
                    } else if (type == 6 && !out.has("picture")) {
                        val pic = flacPictureData(data)
                        if (pic != null) {
                            out.put("picture", android.util.Base64.encodeToString(pic, android.util.Base64.NO_WRAP))
                            out.put("mime", "image/jpeg")
                        }
                    }
                }
            } else return call.reject("仅支持 MP3/FLAC 文件写入标签")
            call.resolve(out)
        } catch (e: Exception) {
            call.reject(PlayerHolder.sanitize(e.message ?: "读取标签失败"))
        }
    }

    /** 编辑器保存：mp3=剥旧 ID3v2/v1 后重建（非管理帧透传保留，对齐 node-id3 update 语义）；flac=替换 VC/PICTURE 块 */
    @PluginMethod
    fun writeTags(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("path 缺失")
        val title = call.getString("title") ?: ""
        val artist = call.getString("artist") ?: ""
        val album = call.getString("album") ?: ""
        val picB64 = call.getString("pictureBase64")
        val picMime = call.getString("pictureMime") ?: "image/jpeg"
        val removePicture = call.getBoolean("removePicture", false) == true
        try {
            val f = File(path)
            if (!inDownloadDir(f) || !f.isFile) return call.reject("文件不在下载目录")
            val name = f.name.lowercase()
            if (name.endsWith(".mp3")) {
                val old = parseId3Frames(f) ?: emptyList()
                val oldText = { id: String -> old.firstOrNull { it.first == id }?.let { id3DecodeText(it.second) } ?: "" }
                val keep = old.filter { (id, _) -> id !in setOf("TIT2", "TPE1", "TALB", "APIC") }.map { (id, body) -> id3Frame(id, body) }
                val oldApic = old.firstOrNull { it.first == "APIC" }
                val frames = ArrayList<ByteArray>()
                frames.addAll(keep)
                // 照 PC：空串不覆盖旧值
                frames.add(id3TextFrame("TIT2", title.ifBlank { oldText("TIT2") }))
                frames.add(id3TextFrame("TPE1", artist.ifBlank { oldText("TPE1") }))
                frames.add(id3TextFrame("TALB", album.ifBlank { oldText("TALB") }))
                if (picB64 != null) {
                    val pic = android.util.Base64.decode(picB64, android.util.Base64.NO_WRAP)
                    frames.add(id3ApicFrame(pic, picMime))
                } else if (!removePicture && oldApic != null) {
                    frames.add(id3Frame("APIC", oldApic.second))
                }
                rewriteMp3WithFrames(f, frames)
            } else if (name.endsWith(".flac")) {
                val blocks = readFlacBlocks(f) ?: return call.reject("不是有效的 FLAC 文件")
                val oldVc = blocks.firstOrNull { it.first == 4 }?.second
                val oldVcMap = if (oldVc != null) parseVorbisComments(oldVc) else emptyMap()
                val oldPic = blocks.firstOrNull { it.first == 6 }
                val kept = blocks.filter { it.first != 4 && it.first != 6 }
                val newVc = flacVorbisComment(
                    title.ifBlank { oldVcMap["TITLE"] ?: "" },
                    artist.ifBlank { oldVcMap["ARTIST"] ?: "" },
                    album.ifBlank { oldVcMap["ALBUM"] ?: "" }
                )
                val picBlock: Pair<Int, ByteArray>? = when {
                    picB64 != null -> 6 to flacPicture(android.util.Base64.decode(picB64, android.util.Base64.NO_WRAP))
                    removePicture -> null
                    oldPic != null -> oldPic
                    else -> null
                }
                rewriteFlacBlocks(f, kept, newVc, picBlock)
            } else return call.reject("仅支持 MP3/FLAC 文件写入标签")
            MediaScannerConnection.scanFile(context, arrayOf(f.absolutePath), null, null)
            call.resolve(JSObject().apply { put("ok", true) })
        } catch (e: Exception) {
            call.reject(PlayerHolder.sanitize(e.message ?: "标签保存失败"))
        }
    }

    /** mp3：剥旧 ID3v2（含 footer）与尾部 ID3v1，重建头部标签（非管理帧透传保留） */
    private fun rewriteMp3WithFrames(f: File, frames: List<ByteArray>) {
        val ins = f.inputStream()
        val bodyOut = java.io.ByteArrayOutputStream()
        val head = ByteArray(10)
        var audioStart = 0L
        if (ins.read(head) == 10 && head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() && head[2] == '3'.code.toByte()) {
            val size = ((head[6].toInt() and 0x7F) shl 21) or ((head[7].toInt() and 0x7F) shl 14) or
                ((head[8].toInt() and 0x7F) shl 7) or (head[9].toInt() and 0x7F)
            var skip = 10L + size
            if ((head[5].toInt() and 0x10) != 0) skip += 10 // footer
            ins.skip(skip)
            audioStart = skip
        } else {
            ins.close()
            // 无标签：整文件即音频
            val tag = buildId3Tag(frames)
            val tmp = File(f.parentFile, f.name + ".tagtmp")
            try {
                FileOutputStream(tmp).use { fos -> fos.write(tag); f.inputStream().use { it.copyTo(fos, 64 * 1024) }; fos.fd.sync() }
                if (!tmp.renameTo(f)) { tmp.copyTo(f, overwrite = true); tmp.delete() }
            } finally { try { if (tmp.exists()) tmp.delete() } catch (_: Exception) {} }
            return
        }
        val buf = ByteArray(64 * 1024)
        var r: Int
        while (ins.read(buf).also { r = it } != -1) bodyOut.write(buf, 0, r)
        ins.close()
        var audio = bodyOut.toByteArray()
        // 剥尾部 ID3v1
        if (audio.size > 128 && audio[audio.size - 128] == 'T'.code.toByte() &&
            audio[audio.size - 127] == 'A'.code.toByte() && audio[audio.size - 126] == 'G'.code.toByte()
        ) audio = audio.copyOfRange(0, audio.size - 128)
        val tag = buildId3Tag(frames)
        val tmp = File(f.parentFile, f.name + ".tagtmp")
        try {
            FileOutputStream(tmp).use { fos -> fos.write(tag); fos.write(audio); fos.fd.sync() }
            if (!tmp.renameTo(f)) { tmp.copyTo(f, overwrite = true); tmp.delete() }
        } finally { try { if (tmp.exists()) tmp.delete() } catch (_: Exception) {} }
    }

    private fun buildId3Tag(frames: List<ByteArray>): ByteArray {
        val body = java.io.ByteArrayOutputStream()
        frames.forEach { body.write(it) }
        val bodyBytes = body.toByteArray()
        val head = java.io.ByteArrayOutputStream()
        head.write("ID3".toByteArray(Charsets.ISO_8859_1))
        head.write(0x03); head.write(0x00); head.write(0x00)
        val n = bodyBytes.size
        head.write((n ushr 21) and 0x7F); head.write((n ushr 14) and 0x7F)
        head.write((n ushr 7) and 0x7F); head.write(n and 0x7F)
        val out = java.io.ByteArrayOutputStream()
        out.write(head.toByteArray()); out.write(bodyBytes)
        return out.toByteArray()
    }

    /** flac：保留块 + 新 VC + 可选 PICTURE，重建全部块（末块标志重算） */
    private fun rewriteFlacBlocks(f: File, kept: List<Pair<Int, ByteArray>>, vc: ByteArray, picBlock: Pair<Int, ByteArray>?) {
        // STREAMINFO 必须第一块
        val ordered = ArrayList<Pair<Int, ByteArray>>()
        val si = kept.firstOrNull { it.first == 0 }
        if (si != null) ordered.add(si)
        ordered.add(4 to vc)
        if (picBlock != null) ordered.add(picBlock)
        kept.forEach { if (it.first != 0) ordered.add(it) }
        val tmp = File(f.parentFile, f.name + ".tagtmp")
        try {
            FileOutputStream(tmp).use { fos ->
                fos.write("fLaC".toByteArray(Charsets.ISO_8859_1))
                ordered.forEachIndexed { i, (type, data) ->
                    fos.write(flacBlock(type, data, i == ordered.size - 1))
                }
                fos.fd.sync()
            }
            if (!tmp.renameTo(f)) { tmp.copyTo(f, overwrite = true); tmp.delete() }
        } finally { try { if (tmp.exists()) tmp.delete() } catch (_: Exception) {} }
    }

    /** APIC 帧体：enc0 + mime\0 + type3 + 空描述\0 + 数据（自定义 mime） */
    private fun id3ApicFrame(img: ByteArray, mime: String): ByteArray {
        val body = java.io.ByteArrayOutputStream()
        body.write(0x00)
        body.write(mime.toByteArray(Charsets.ISO_8859_1)); body.write(0)
        body.write(0x03)
        body.write(0)
        body.write(img)
        return id3Frame("APIC", body.toByteArray())
    }

    /* ================= 重复歌曲清理（对齐 PC：大小分桶 + SHA1 内容查重） ================= */

    private fun sha1File(f: File): String? {
        return try {
            val md = java.security.MessageDigest.getInstance("SHA-1")
            f.inputStream().use { ins ->
                val buf = ByteArray(64 * 1024)
                var r: Int
                while (ins.read(buf).also { r = it } != -1) md.update(buf, 0, r)
            }
            md.digest().joinToString("") { "%02x".format(it) }
        } catch (_: Exception) { null }
    }

    @PluginMethod
    fun scanDupes(call: PluginCall) {
        pool.execute {
            try {
                val dir = downloadDir()
                val files = dir.listFiles()?.filter { it.isFile && !it.name.endsWith(".lrc") && !it.name.endsWith(".tagtmp") } ?: emptyList()
                val groups = com.getcapacitor.JSArray()
                // 第一阶段：字节大小分桶（照 PC statSync.size）
                for (bucket in files.groupBy { it.length() }.values) {
                    if (bucket.size < 2) continue
                    // 第二阶段：桶内 SHA1 内容比对
                    val byHash = LinkedHashMap<String, MutableList<File>>()
                    for (f in bucket) {
                        val h = sha1File(f) ?: continue
                        byHash.getOrPut(h) { mutableListOf() }.add(f)
                    }
                    for (list in byHash.values) {
                        if (list.size < 2) continue
                        val arr = com.getcapacitor.JSArray()
                        list.sortedBy { it.name }.forEach { f ->
                            arr.put(JSObject().apply {
                                put("path", f.absolutePath); put("name", f.name); put("size", f.length())
                            })
                        }
                        groups.put(arr)
                    }
                }
                call.resolve(JSObject().apply { put("groups", groups) })
            } catch (e: Exception) {
                call.reject(PlayerHolder.sanitize(e.message ?: "扫描失败"))
            }
        }
    }

    /** 批量删除（每组保留项由前端不传）；无回收站 → 直接删 + MediaStore/歌词同步清理 */
    @PluginMethod
    fun deleteFiles(call: PluginCall) {
        val paths = call.getArray("paths") ?: return call.reject("paths 缺失")
        val list = mutableListOf<String>()
        try {
            for (i in 0 until paths.length()) list.add(paths.getString(i))
        } catch (_: Exception) {}
        var failed = 0
        val dir = downloadDir()
        for (p in list) {
            try {
                val f = File(p)
                if (!inDownloadDir(f) || !f.isFile || !f.exists()) { failed++; continue }
                if (!f.delete()) { failed++; continue }
                try {
                    val lrc = File(f.parentFile, f.name.replace(Regex("\\.[^.]+$"), ".lrc"))
                    if (lrc.isFile && lrc.exists()) lrc.delete()
                } catch (_: Exception) {}
                try {
                    context.contentResolver.delete(
                        android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                        "${android.provider.MediaStore.Audio.Media.DATA} = ?",
                        arrayOf(f.absolutePath)
                    )
                } catch (_: Exception) {}
            } catch (_: Exception) { failed++ }
        }
        call.resolve(JSObject().apply { put("ok", true); put("failed", failed) })
    }
}
