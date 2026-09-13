package com.lyraaria.mobile.player

import androidx.media3.exoplayer.ExoPlayer
import java.util.concurrent.ConcurrentLinkedQueue

/** 播放内核共享状态：Service 与 Plugin 之间的单例桥 */
object PlayerHolder {
    @Volatile
    var player: ExoPlayer? = null
    @Volatile
    var service: PlayerService? = null

    /** 通知栏歌词：当前播放行的文本（Web 层歌词行变化时推送；无歌词为 null） */
    @Volatile
    var lyricLine: String? = null
    @Volatile
    var coverUrl: String = ""

    /** 服务启动窗口内积压的播放请求（并发安全队列，防单槽覆盖竞态） */
    val pendingQueue = ConcurrentLinkedQueue<() -> Unit>()

    /** 原生交接队列：JS 预解析好的下一首（ENDED 时原生直接续播，WebView 冻结不阻断） */
    data class PendingTrack(val url: String, val title: String, val artist: String, val duration: Float, val songId: String)
    @Volatile
    var handoff: PendingTrack? = null

    /** 插件注册的状态监听 */
    @Volatile
    var listener: ((state: String, position: Float, duration: Float, message: String?) -> Unit)? = null

    fun notifyState(state: String) = listener?.invoke(state, currentPos(), currentDur(), null)

    /** 通知栏/线控切歌命令 → Web 层（走 listener 的 message 通道） */
    fun notifyMedia(action: String) = listener?.invoke("media", currentPos(), currentDur(), action)

    fun notifyProgress(position: Float, duration: Float) =
        listener?.invoke("progress", position, duration, null)

    fun notifyError(msg: String) = listener?.invoke("error", currentPos(), currentDur(), sanitize(msg))

    /** 外部错误文本 → 用户可见前的统一净化：
     *  剔除 URL/查询串（防 key=、token 等参数泄漏）+ 保密词表词（波点/酷我/逆向/接口/CDN/token/key），
     *  确保透传异常消息不把内部实现细节带进 UI */
    fun sanitize(raw: String?): String {
        var s = (raw ?: "").replace(Regex("https?://\\S+"), "[链接]")
        s = s.replace(Regex("key=\\S+"), "key=[已隐藏]")
        s = s.replace(Regex("(?i)token"), "令牌")
        s = s.replace(Regex("(?i)cd[mn]\\b"), "节点")
        s = s.replace("波点", "在线音源").replace("酷我", "在线音源")
        s = s.replace("逆向", "解析").replace("接口", "服务")
        return s.trim().take(160)
    }

    private fun currentPos(): Float = (player?.currentPosition?.toFloat() ?: 0f) / 1000f
    private fun currentDur(): Float =
        (player?.duration?.takeIf { it > 0 }?.toFloat() ?: 0f) / 1000f
}
