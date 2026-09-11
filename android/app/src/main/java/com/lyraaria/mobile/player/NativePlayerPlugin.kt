package com.lyraaria.mobile.player

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * NativePlayer：Web 层 ↔ 原生播放内核 的桥
 * Web 侧：const NP = window.Capacitor.Plugins.NativePlayer;
 *   NP.load({url,title,artist,duration}) / play / pause / seek / setRate
 * 事件：NP.addListener('state', e => {state, position, duration, message})
 * 注意：Capacitor 插件方法跑在后台线程，ExoPlayer 操作全部切主线程。
 */
@CapacitorPlugin(
    name = "NativePlayer",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])]
)
class NativePlayerPlugin : Plugin() {

    override fun load() {
        super.load()
        PlayerHolder.listener = { state, pos, dur, msg -> emit(state, pos, dur, msg) }
    }

    override fun handleOnDestroy() {
        // 注销静态监听，防 PlayerHolder（进程级单例）强持有本插件实例与 Context
        if (PlayerHolder.listener != null) PlayerHolder.listener = null
        super.handleOnDestroy()
    }

    private fun emit(state: String, position: Float, duration: Float, message: String?) {
        val data = JSObject().apply {
            put("state", state)
            put("position", position)
            put("duration", duration)
            if (message != null) put("message", message)
        }
        notifyListeners("state", data, true)
    }

    private fun ensureService() {
        val ctx = context ?: return
        val intent = Intent(ctx, PlayerService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent)
        } else {
            ctx.startService(intent)
        }
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val url = (call.getString("url") ?: "").trim()
        if (url.isEmpty()) return call.reject("url 缺失")
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissionForAlias("notifications", call, "permissionCallback")
            return
        }
        ensureService()
        val title = call.getString("title") ?: ""
        val artist = call.getString("artist") ?: ""
        val duration = call.getFloat("duration", 0f) ?: 0f
        PlayerService.loadAndPlay(context, url, title, artist, duration) {
            call.resolve(JSObject().apply { put("ok", true) })
        }
    }

    @PermissionCallback
    private fun permissionCallback(call: PluginCall) {
        if (call.getData()?.getBoolean("granted") == true) {
            load(call)
        } else {
            ensureService()
            val url = (call.getString("url") ?: "").trim()
            if (url.isEmpty()) return call.reject("url 缺失")
            PlayerService.loadAndPlay(context, url, call.getString("title") ?: "", call.getString("artist") ?: "", call.getFloat("duration", 0f) ?: 0f) {
                call.resolve(JSObject().apply { put("ok", true) })
            }
        }
    }

    @PluginMethod
    fun play(call: PluginCall) {
        PlayerService.onMain { PlayerHolder.player?.play() }
        call.resolve()
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        PlayerService.onMain { PlayerHolder.player?.pause() }
        call.resolve()
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val pos = call.getFloat("position", 0f) ?: 0f
        // 范围约束：非法/负值/NaN 兜底 0，防脏数据进 ExoPlayer（对齐 setRate 的 coerceIn）
        val ms = if (pos.isFinite() && pos > 0) (pos * 1000).toLong().coerceAtLeast(0L) else 0L
        PlayerService.onMain { PlayerHolder.player?.seekTo(ms) }
        call.resolve()
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        // ExoPlayer 要求 speed > 0，否则主线程未捕获异常直接 crash（0/负值兜底 1x）
        val rate = (call.getFloat("rate", 1f) ?: 1f).coerceIn(0.25f, 3f)
        PlayerService.onMain { PlayerHolder.player?.setPlaybackSpeed(rate) }
        call.resolve()
    }

    @PluginMethod
    fun setLyric(call: PluginCall) {
        // 通知栏歌词：Web 层当前歌词行推送（无歌词/空行 → null 清空）
        val line = call.getString("line")
        PlayerService.setLyric(line)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        PlayerService.onMain {
            PlayerHolder.player?.stop()
            PlayerHolder.player?.clearMediaItems()
            // 停止播放 → 结束前台服务，通知随服务销毁移除（防服务/通知常驻泄漏）
            PlayerHolder.service?.stopSelf()
        }
        call.resolve()
    }
}
