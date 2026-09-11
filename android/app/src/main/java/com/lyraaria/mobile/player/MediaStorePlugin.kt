package com.lyraaria.mobile.player

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * MediaStore 本地媒体库：
 *   scanSongs() / scanAlbums() / scanArtists() / songsOfAlbum(albumId) / songsOfArtist(artistId)
 *   albumArt(albumId) → dataURL
 * Web 侧播放本地歌：NP.load({url: "content://media/external/audio/media/<id>", ...})
 * 权限：Android 13+ READ_MEDIA_AUDIO；Android 12 及以下 READ_EXTERNAL_STORAGE
 */
@CapacitorPlugin(
    name = "MediaStore",
    permissions = [
        Permission(alias = "audio33", strings = [Manifest.permission.READ_MEDIA_AUDIO]),
        Permission(alias = "audioLegacy", strings = [Manifest.permission.READ_EXTERNAL_STORAGE])
    ]
)
class MediaStorePlugin : Plugin() {

    private fun hasAudioPermission(): Boolean {
        val ctx = context ?: return false
        val p = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
        return ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestOrContinue(call: PluginCall, then: () -> Unit) {
        if (hasAudioPermission()) { then(); return }
        // 按 SDK 选对应权限组：合并两组会导致组内恒有 DENIED（READ_MEDIA_AUDIO 在 ≤12 不存在、READ_EXTERNAL_STORAGE 在 ≥13 被忽略）
        val alias = if (Build.VERSION.SDK_INT >= 33) "audio33" else "audioLegacy"
        requestPermissionForAlias(alias, call, "permCallback")
    }

    @PermissionCallback
    private fun permCallback(call: PluginCall) {
        if (call.getData()?.getBoolean("granted") == true) {
            // 权限已给：重新按原方法分发（通过保存的 methodName 重入）
            when (call.getMethodName()) {
                "scanSongs" -> doScanSongs(call)
                "scanAlbums" -> doScanAlbums(call)
                "scanArtists" -> doScanArtists(call)
                "songsOfAlbum" -> doSongsOfAlbum(call)
                "songsOfArtist" -> doSongsOfArtist(call)
                else -> call.resolve()
            }
        } else {
            call.reject("需要音乐权限才能扫描本地音乐")
        }
    }

    private fun songToJS(ctx: Context, c: android.database.Cursor): JSObject {
        val id = c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID))
        val title = c.getString(c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)) ?: ""
        val artist = c.getString(c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)) ?: ""
        val album = c.getString(c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)) ?: ""
        val albumId = c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID))
        val durationMs = c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION))
        val size = c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE))
        val mime = c.getString(c.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE)) ?: ""
        val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id).toString()
        val o = JSObject().apply {
            put("id", "local:" + id)
            put("local", true)
            put("uri", uri)
            put("title", title)
            put("artist", artist)
            put("album", album)
            put("albumId", albumId)
            put("duration", (durationMs / 1000f).toInt())
            put("size", size)
            put("mime", mime)
        }
        return o
    }

    @PluginMethod
    fun scanSongs(call: PluginCall) {
        requestOrContinue(call) { doScanSongs(call) }
    }

    private fun doScanSongs(call: PluginCall) {
        val ctx = context ?: return call.reject("无上下文")
        val songs = JSArray()
        try {
            val proj = arrayOf(
                MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST, MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.ALBUM_ID, MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.MIME_TYPE
            )
            val c = ctx.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                proj,
                "${MediaStore.Audio.Media.IS_MUSIC} != 0",
                null,
                "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC"
            )
            c?.use { cur ->
                while (cur.moveToNext()) songs.put(songToJS(ctx, cur))
            }
        } catch (e: Exception) {
            return call.reject("扫描失败：" + (PlayerHolder.sanitize(e.message ?: "未知错误")))
        }
        call.resolve(JSObject().apply { put("songs", songs) })
    }

    @PluginMethod
    fun scanAlbums(call: PluginCall) {
        requestOrContinue(call) { doScanAlbums(call) }
    }

    private fun doScanAlbums(call: PluginCall) {
        val ctx = context ?: return call.reject("无上下文")
        val albums = JSArray()
        try {
            val proj = arrayOf(
                MediaStore.Audio.Albums._ID, MediaStore.Audio.Albums.ALBUM,
                MediaStore.Audio.Albums.ARTIST, MediaStore.Audio.Albums.NUMBER_OF_SONGS
            )
            val c = ctx.contentResolver.query(
                MediaStore.Audio.Albums.EXTERNAL_CONTENT_URI,
                proj, null, null,
                "${MediaStore.Audio.Albums.ALBUM} COLLATE NOCASE ASC"
            )
            c?.use { cur ->
                while (cur.moveToNext()) {
                    val id = cur.getLong(cur.getColumnIndexOrThrow(MediaStore.Audio.Albums._ID))
                    albums.put(JSObject().apply {
                        put("id", "album:" + id)
                        put("albumId", id)
                        put("name", cur.getString(cur.getColumnIndexOrThrow(MediaStore.Audio.Albums.ALBUM)) ?: "未知专辑")
                        put("artist", cur.getString(cur.getColumnIndexOrThrow(MediaStore.Audio.Albums.ARTIST)) ?: "")
                        put("count", cur.getInt(cur.getColumnIndexOrThrow(MediaStore.Audio.Albums.NUMBER_OF_SONGS)))
                    })
                }
            }
        } catch (e: Exception) {
            return call.reject("扫描失败：" + (PlayerHolder.sanitize(e.message ?: "未知错误")))
        }
        call.resolve(JSObject().apply { put("albums", albums) })
    }

    @PluginMethod
    fun scanArtists(call: PluginCall) {
        requestOrContinue(call) { doScanArtists(call) }
    }

    private fun doScanArtists(call: PluginCall) {
        val ctx = context ?: return call.reject("无上下文")
        val artists = JSArray()
        try {
            val proj = arrayOf(
                MediaStore.Audio.Artists._ID, MediaStore.Audio.Artists.ARTIST,
                MediaStore.Audio.Artists.NUMBER_OF_TRACKS, MediaStore.Audio.Artists.NUMBER_OF_ALBUMS
            )
            val c = ctx.contentResolver.query(
                MediaStore.Audio.Artists.EXTERNAL_CONTENT_URI,
                proj, null, null,
                "${MediaStore.Audio.Artists.ARTIST} COLLATE NOCASE ASC"
            )
            c?.use { cur ->
                while (cur.moveToNext()) {
                    val id = cur.getLong(cur.getColumnIndexOrThrow(MediaStore.Audio.Artists._ID))
                    artists.put(JSObject().apply {
                        put("id", "artist:" + id)
                        put("artistId", id)
                        put("name", cur.getString(cur.getColumnIndexOrThrow(MediaStore.Audio.Artists.ARTIST)) ?: "未知歌手")
                        put("tracks", cur.getInt(cur.getColumnIndexOrThrow(MediaStore.Audio.Artists.NUMBER_OF_TRACKS)))
                        put("albums", cur.getInt(cur.getColumnIndexOrThrow(MediaStore.Audio.Artists.NUMBER_OF_ALBUMS)))
                    })
                }
            }
        } catch (e: Exception) {
            return call.reject("扫描失败：" + (PlayerHolder.sanitize(e.message ?: "未知错误")))
        }
        call.resolve(JSObject().apply { put("artists", artists) })
    }

    @PluginMethod
    fun songsOfAlbum(call: PluginCall) {
        requestOrContinue(call) { doSongsOfAlbum(call) }
    }

    private fun doSongsOfAlbum(call: PluginCall) {
        val ctx = context ?: return call.reject("无上下文")
        val albumId = call.getLong("albumId", -1L) ?: -1L
        if (albumId < 0) return call.reject("albumId 无效")
        val songs = JSArray()
        try {
            val proj = arrayOf(
                MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST, MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.ALBUM_ID, MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.MIME_TYPE
            )
            val c = ctx.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                proj,
                "${MediaStore.Audio.Media.IS_MUSIC} != 0 AND ${MediaStore.Audio.Media.ALBUM_ID} = ?",
                arrayOf(albumId.toString()),
                "${MediaStore.Audio.Media.TRACK} ASC"
            )
            c?.use { cur -> while (cur.moveToNext()) songs.put(songToJS(ctx, cur)) }
        } catch (e: Exception) {
            return call.reject("查询失败：" + (PlayerHolder.sanitize(e.message ?: "未知错误")))
        }
        call.resolve(JSObject().apply { put("songs", songs) })
    }

    @PluginMethod
    fun songsOfArtist(call: PluginCall) {
        requestOrContinue(call) { doSongsOfArtist(call) }
    }

    private fun doSongsOfArtist(call: PluginCall) {
        val ctx = context ?: return call.reject("无上下文")
        val artistId = call.getLong("artistId", -1L) ?: -1L
        if (artistId < 0) return call.reject("artistId 无效")
        val songs = JSArray()
        try {
            val proj = arrayOf(
                MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST, MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.ALBUM_ID, MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.MIME_TYPE
            )
            val c = ctx.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                proj,
                "${MediaStore.Audio.Media.IS_MUSIC} != 0 AND ${MediaStore.Audio.Media.ARTIST_ID} = ?",
                arrayOf(artistId.toString()),
                "${MediaStore.Audio.Media.ALBUM} COLLATE NOCASE ASC"
            )
            c?.use { cur -> while (cur.moveToNext()) songs.put(songToJS(ctx, cur)) }
        } catch (e: Exception) {
            return call.reject("查询失败：" + (PlayerHolder.sanitize(e.message ?: "未知错误")))
        }
        call.resolve(JSObject().apply { put("songs", songs) })
    }

    /** 专辑封面 → dataURL（content uri 读取；失败回退 MediaMetadataRetriever 取内嵌封面） */
    @PluginMethod
    fun albumArt(call: PluginCall) {
        val ctx = context ?: return call.reject("无上下文")
        val albumId = call.getLong("albumId", -1L) ?: -1L
        var dataUrl: String? = null
        try {
            if (albumId >= 0) {
                val artUri = Uri.parse("content://media/external/audio/albumart")
                val uri = ContentUris.withAppendedId(artUri, albumId)
                ctx.contentResolver.openInputStream(uri)?.use { ins ->
                    dataUrl = toDataUrl(ins.readBytes())
                }
            }
            if (dataUrl == null) {
                // 兜底：取该专辑首曲内嵌封面
                val proj = arrayOf(MediaStore.Audio.Media._ID)
                val c = ctx.contentResolver.query(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, proj,
                    "${MediaStore.Audio.Media.IS_MUSIC} != 0 AND ${MediaStore.Audio.Media.ALBUM_ID} = ?",
                    arrayOf(albumId.toString()), null
                )
                var firstUri: Uri? = null
                c?.use { cur -> if (cur.moveToFirst()) {
                    val id = cur.getLong(cur.getColumnIndexOrThrow(MediaStore.Audio.Media._ID))
                    firstUri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)
                } }
                if (firstUri != null) {
                    val mmr = MediaMetadataRetriever()
                    try {
                        mmr.setDataSource(ctx, firstUri)
                        val art = mmr.embeddedPicture
                        if (art != null && art.isNotEmpty()) dataUrl = toDataUrl(art)
                    } catch (_: Exception) {
                    } finally { try { mmr.release() } catch (_: Exception) {} }
                }
            }
        } catch (_: Exception) {
        }
        call.resolve(JSObject().apply { put("dataUrl", dataUrl ?: "") })
    }

    private fun toDataUrl(bytes: ByteArray): String? {
        if (bytes.isEmpty()) return null
        // OOM 防护：先解码再缩放到 ≤512px 并压缩为 JPEG(85)，避免 1-5MB 内嵌封面
        // 三份内存（ByteArray + Bitmap + Base64 字符串）并存导致低端机崩溃
        var bmp: android.graphics.Bitmap? = null
        var scaled: android.graphics.Bitmap? = null
        try {
            bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
            scaled = if (bmp.width > 512 || bmp.height > 512) {
                val w = 512
                val h = Math.round(512f * bmp.height / bmp.width)
                android.graphics.Bitmap.createScaledBitmap(bmp, w, h, true)
            } else bmp
            val out = java.io.ByteArrayOutputStream()
            scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, out)
            val b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
            return "data:image/jpeg;base64,$b64"
        } catch (_: Exception) {
            return null
        } finally {
            // 统一回收：scaled 与 bmp 可能同一对象（≤512px 分支），回收一次即可
            try { if (scaled !== null && scaled !== bmp) scaled.recycle() } catch (_: Exception) {}
            try { bmp?.recycle() } catch (_: Exception) {}
        }
    }
}
