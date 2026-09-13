package com.lyraaria.mobile.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaNotification
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.MediaStyleNotificationHelper
import com.lyraaria.mobile.R

/**
 * 播放内核：Media3 ExoPlayer + MediaSession（通知栏媒体控制 + 通知栏歌词）
 * - 前台服务（mediaPlayback 类型），后台播放不断
 * - 所有 ExoPlayer 操作必须在主线程（Capacitor 插件线程 → 主线程切换）
 * - 手动 startForeground：Media3 1.5.1 的服务仅经 MediaController 连接才自动前台，
 *   这里在 onStartCommand 显式 startForeground 防 5 秒崩溃（controller 连接后由 Media3 接管通知）
 * - 通知栏歌词：自定义 NotificationProvider 在 contentText 追加当前行（对齐桌面歌词窗体验）
 */
class PlayerService : MediaSessionService() {

    private var mediaSession: MediaSession? = null
    private var selfController: androidx.media3.session.MediaController? = null
    private var player: ExoPlayer? = null
    // B站音源：CDN（bilivideo 等）校验 Referer，loadAndPlay 时按域动态下发
    private val httpFactory = androidx.media3.datasource.DefaultHttpDataSource.Factory()
        .setUserAgent("Mozilla/5.0 MusicPlayer/1.3.8")
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(15000)
        .setReadTimeoutMs(15000)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val progressRunnable = object : Runnable {
        override fun run() {
            val p = player
            if (p != null) {
                if (p.isPlaying || p.playWhenReady) {
                    PlayerHolder.notifyProgress(p.currentPosition.toFloat() / 1000f, p.duration.takeIf { it > 0 }?.toFloat()?.div(1000f) ?: 0f)
                }
                mainHandler.postDelayed(this, 500)
            }
        }
    }

    /** 通知栏歌词 Provider：contentText = "歌手 · 当前行"（无歌词时仅歌手）
     *  通知 id 统一为 NOTIFICATION_ID（1）：默认 NotificationIdProvider 返回 1001，
     *  与手动 startForeground 的 id=1 不一致会并存两条通知 → 注入统一 id */
    private class LyricNotificationProvider(context: Context) : DefaultMediaNotificationProvider(
        context,
        { NOTIFICATION_ID }, // NotificationIdProvider：通知 id = 1（与前台通知一致）
        CHANNEL_ID,
        DefaultMediaNotificationProvider.DEFAULT_CHANNEL_NAME_RESOURCE_ID
    ) {
        override fun getNotificationContentText(metadata: MediaMetadata): CharSequence {
            val artist = super.getNotificationContentText(metadata)?.toString()?.ifEmpty { "正在播放" } ?: "正在播放"
            val lyric = PlayerHolder.lyricLine
            return if (!lyric.isNullOrEmpty()) "$artist · $lyric" else artist
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        // 通知栏歌词接管：Media3 默认 Provider 仅 title/artist，换自定义 Provider
        try { setMediaNotificationProvider(LyricNotificationProvider(this)) } catch (_: Exception) {}
        val p = ExoPlayer.Builder(this)
            // DefaultDataSource 包装：HTTP 走 httpFactory（含 B站 Referer 注入），content:///file 走系统源（曲库本地歌必须）——此前只用 httpFactory 导致曲库歌全部无法播放
            .setMediaSourceFactory(androidx.media3.exoplayer.source.DefaultMediaSourceFactory(androidx.media3.datasource.DefaultDataSource.Factory(this, httpFactory)))
            .build()
        player = p
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_READY -> PlayerHolder.notifyState("loaded")
                    Player.STATE_ENDED -> {
                        // 原生交接：有预解析好的下一首则直接续播（后台/锁屏 WebView 冻结也能推进）
                        val nxt = PlayerHolder.handoff
                        PlayerHolder.handoff = null
                        PlayerHolder.notifyState("ended")
                        nxt?.let {
                            PlayerHolder.notifyMedia("native-advanced:" + it.songId)
                            loadAndPlay(this@PlayerService, it.url, it.title, it.artist, it.duration)
                        }
                    }
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                PlayerHolder.notifyState(if (isPlaying) "playing" else "paused")
                // 通知刷新：media3 manager 激活走 provider（五按钮媒体卡），否则手动重建
                try {
                    val session = mediaSession
                    if (session != null && session.player.mediaItemCount > 0) {
                        onUpdateNotification(session, false)
                    } else {
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.notify(NOTIFICATION_ID, buildNotification())
                    }
                } catch (_: Exception) {}
            }
            override fun onPlayerError(error: PlaybackException) {
                PlayerHolder.notifyError(error.errorCodeName + ": " + error.message)
            }
        })
        // 通知点击 → 回到应用主界面（缺失时点通知无反应，用户报障）
        val launchIntent: android.content.Intent? = packageManager.getLaunchIntentForPackage(packageName)
        val sessionPi = launchIntent?.let {
            android.app.PendingIntent.getActivity(this, 0, it,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE)
        }
        mediaSession = MediaSession.Builder(this, p)
            // 通知栏/线控 上一首·下一首 → 转发 Web 层（单曲模型下 Media3 默认无队列可跳）
            .setSessionActivity(sessionPi!!)
            .setCallback(object : MediaSession.Callback {
                // 拦截标准切歌命令并转发 Web 层执行真正的队列导航
                override fun onPlayerCommandRequest(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    playerCommand: Int
                ): Int {
                    when (playerCommand) {
                        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> PlayerHolder.notifyMedia("next")
                        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> PlayerHolder.notifyMedia("prev")
                    }
                    // 返回 OK（默认值）：单曲模型下 Media3 自身 seek 为 no-op，无副作用
                    return super.onPlayerCommandRequest(session, controller, playerCommand)
                }
                // 通知栏自定义命令（Android 13+ 系统媒体卡只认 session 布局，不认 addAction）
                override fun onCustomCommand(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    customCommand: androidx.media3.session.SessionCommand,
                    extras: android.os.Bundle
                ): com.google.common.util.concurrent.ListenableFuture<androidx.media3.session.SessionResult> {
                    when (customCommand.customAction) {
                        CMD_FAV -> PlayerHolder.notifyMedia("fav")
                        CMD_NEXT -> PlayerHolder.notifyMedia("next")
                        CMD_LOCK -> PlayerHolder.notifyMedia("lock")
                    }
                    return com.google.common.util.concurrent.Futures.immediateFuture(
                        androidx.media3.session.SessionResult(androidx.media3.session.SessionResult.RESULT_SUCCESS)
                    )
                }
                // 广告切歌命令：通知栏按钮按 controller 可用命令渲染，单曲播放器默认不含 next/prev
                override fun onConnect(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo
                ): MediaSession.ConnectionResult {
                    val cmds = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                        .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                        .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                        .build()
                    val sessionCmds = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                        .add(androidx.media3.session.SessionCommand(CMD_FAV, android.os.Bundle.EMPTY))
                        .add(androidx.media3.session.SessionCommand(CMD_NEXT, android.os.Bundle.EMPTY))
                        .add(androidx.media3.session.SessionCommand(CMD_LOCK, android.os.Bundle.EMPTY))
                        .build()
                    // 新连接的 controller（含系统媒体通知）必须从 ConnectionResult 拿到 customLayout，
                    // 只调 setCustomLayout 对后连的 controller 无效 → 通知栏不显示收藏/锁定按钮
                    return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                        .setAvailableSessionCommands(sessionCmds)
                        .setAvailablePlayerCommands(cmds)
                        .setCustomLayout(customLayoutButtons())
                        .build()
                }
            })
            .build()
        // 系统媒体通知的自定义按钮：收藏 / 锁定歌词（Android 13+ 渲染自 custom layout）
        try { mediaSession?.setCustomLayout(customLayoutButtons()) } catch (_: Exception) {}
        // 自建 controller 连接：Media3 的通知管理器仅在 session 被 addSession 后激活，
        // 激活后由 LyricNotificationProvider（DefaultMediaNotificationProvider 子类）发通知，
        // 通知里含 custom layout 按钮（收藏/锁定）+ 标准三键 = 五按钮
        try {
            val token = androidx.media3.session.SessionToken(this, android.content.ComponentName(this, PlayerService::class.java))
            val future = androidx.media3.session.MediaController.Builder(this, token).buildAsync()
            future.addListener({
                try { selfController = future.get() } catch (_: Exception) {}
            }, { mainHandler.post(it) })
        } catch (_: Exception) {}
        PlayerHolder.player = p
        PlayerHolder.service = this
        // 服务就绪后执行插件等待的播放请求（逐个消费积压队列）
        while (true) {
            val r = PlayerHolder.pendingQueue.poll() ?: break
            try { r.invoke() } catch (_: Exception) {}
        }
        mainHandler.postDelayed(progressRunnable, 500)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 通知栏五按钮（收藏/上一首/播放暂停/下一首/锁定）：自定义 action 分发
        when (intent?.action) {
            ACTION_TOGGLE -> player?.let { p -> if (p.isPlaying) p.pause() else p.play() }
            ACTION_PREV -> PlayerHolder.notifyMedia("prev")
            ACTION_NEXT -> PlayerHolder.notifyMedia("next")
            ACTION_FAV -> PlayerHolder.notifyMedia("fav")
            ACTION_LOCK -> PlayerHolder.notifyMedia("lock")
        }
        // 显式 startForeground：startForegroundService 后 5 秒内必须调用，否则系统抛 RemoteServiceException
        val s = mediaSession
        if (s != null) {
            try {
                startForeground(NOTIFICATION_ID, buildNotification())
            } catch (e: Exception) { /* 忽略：Media3 接管后自行更新 */ }
        }
        return super.onStartCommand(intent, flags, startId)
    }

    /** 系统媒体通知自定义按钮：收藏 / 锁定歌词 */
    private fun customLayoutButtons(): List<androidx.media3.session.CommandButton> = listOf(
        androidx.media3.session.CommandButton.Builder()
            .setDisplayName("收藏")
            .setIconResId(R.drawable.ic_notif_fav)
            .setSessionCommand(androidx.media3.session.SessionCommand(CMD_FAV, android.os.Bundle.EMPTY))
            .build(),
        androidx.media3.session.CommandButton.Builder()
            .setDisplayName("下一首")
            .setIconResId(R.drawable.ic_notif_next)
            .setSessionCommand(androidx.media3.session.SessionCommand(CMD_NEXT, android.os.Bundle.EMPTY))
            .build(),
        androidx.media3.session.CommandButton.Builder()
            .setDisplayName("锁定歌词")
            .setIconResId(R.drawable.ic_notif_lock)
            .setSessionCommand(androidx.media3.session.SessionCommand(CMD_LOCK, android.os.Bundle.EMPTY))
            .build()
    )

    private fun notifAction(action: String, iconRes: Int, title: String): NotificationCompat.Action {
        val pi = android.app.PendingIntent.getService(
            this, action.hashCode(),
            Intent(this, PlayerService::class.java).setAction(action),
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Action(iconRes, title, pi)
    }

    private fun buildNotification(): Notification {
        val p = player
        val title = p?.mediaMetadata?.title?.toString()?.ifEmpty { "深空折韵" } ?: "深空折韵"
        val artist = p?.mediaMetadata?.artist?.toString()?.ifEmpty { "正在播放" } ?: "正在播放"
        val lyric = PlayerHolder.lyricLine
        val text = if (!lyric.isNullOrEmpty()) "$artist · $lyric" else artist
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            // 五按钮（用户批次16规范）：收藏 / 上一首 / 播放暂停 / 下一首 / 锁定
            .addAction(notifAction(ACTION_FAV, R.drawable.ic_notif_fav, "收藏"))
            .addAction(notifAction(ACTION_PREV, R.drawable.ic_notif_prev, "上一首"))
            .addAction(
                notifAction(
                    ACTION_TOGGLE,
                    if (p?.isPlaying == true) R.drawable.ic_notif_pause else R.drawable.ic_notif_play,
                    if (p?.isPlaying == true) "暂停" else "播放"
                )
            )
            .addAction(notifAction(ACTION_NEXT, R.drawable.ic_notif_next, "下一首"))
            .addAction(notifAction(ACTION_LOCK, R.drawable.ic_notif_lock, "锁定歌词"))
        // MediaStyle：Android 13+ 系统渲染媒体卡，标准键来自 session、自定义键（收藏/锁定）来自
        // addAction；紧凑位=上一首/播放暂停/下一首
        try {
            mediaSession?.let {
                builder.setStyle(
                    MediaStyleNotificationHelper.MediaStyle(it).setShowActionsInCompactView(1, 2, 3)
                )
            }
        } catch (_: Exception) {}
        return builder.build()
    }

    private fun createNotificationChannel() {
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL_ID, "播放控制", NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 任务移除后继续播放（音乐 App 常规行为：通知栏仍在，可控制）
        val p = player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(progressRunnable)
        PlayerHolder.service = null
        PlayerHolder.player = null
        // Media3 惯例：先释放 controller 连接，再释放 MediaSession、ExoPlayer
        try { selfController?.release() } catch (_: Exception) {}
        selfController = null
        mediaSession?.release()
        mediaSession = null
        player?.release()
        player = null
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_ID = 1
        const val CHANNEL_ID = "lyra_playback"
        const val ACTION_FAV = "com.lyraaria.mobile.notif.FAV"
        const val ACTION_PREV = "com.lyraaria.mobile.notif.PREV"
        const val ACTION_TOGGLE = "com.lyraaria.mobile.notif.TOGGLE"
        const val ACTION_NEXT = "com.lyraaria.mobile.notif.NEXT"
        const val ACTION_LOCK = "com.lyraaria.mobile.notif.LOCK"
        const val CMD_FAV = "com.lyraaria.mobile.CMD_FAV"
        const val CMD_NEXT = "com.lyraaria.mobile.CMD_NEXT"
        const val CMD_LOCK = "com.lyraaria.mobile.CMD_LOCK"
        private val main = Handler(Looper.getMainLooper())

        /** 播放指定 URL 并开始播放（任意线程可调，内部切主线程） */
        fun loadAndPlay(context: Context, url: String, title: String, artist: String, duration: Float, onReady: (() -> Unit)? = null) {
            val p = PlayerHolder.player
            if (p == null) {
                // 服务未就绪：入队等待（防连续调用覆盖）
                PlayerHolder.pendingQueue.add { loadAndPlay(context, url, title, artist, duration, onReady) }
                return
            }
            main.post {
                // 竞态守卫：等待期间播放器已被释放/重建则重新入队
                if (p !== PlayerHolder.player) {
                    PlayerHolder.pendingQueue.add { loadAndPlay(context, url, title, artist, duration, onReady) }
                    return@post
                }
                // B站 CDN 校验 Referer：bilivideo 系域名动态下发，其他音源清空（防外链 Referer 被拒）
                try {
                    val svc0 = PlayerHolder.service
                    if (svc0 != null) {
                        val needsBili = url.contains("bilivideo.com") || url.contains("akamaized.net") || url.contains("bilitv.com")
                        svc0.httpFactory.setDefaultRequestProperties(
                            if (needsBili) mapOf("Referer" to "https://www.bilibili.com/") else emptyMap()
                        )
                    }
                } catch (_: Exception) {}
                p.stop()
                p.clearMediaItems()
                val item = MediaItem.Builder()
                    .setUri(url)
                    .setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(title)
                            .setArtist(artist)
                            .build()
                    )
                    .build()
                p.setMediaItem(item)
                p.prepare()
                p.playWhenReady = true
                onReady?.invoke()
                // 播放即刷新通知（标题/歌手/歌词行）：Media3 manager 激活时走 onUpdateNotification
                // （provider 通知含五按钮）；未激活退回手动 notify
                try {
                    val svc = PlayerHolder.service ?: return@post
                    val session = svc.mediaSession
                    if (session != null && session.player.mediaItemCount > 0) {
                        try { svc.onUpdateNotification(session, false) } catch (_: Exception) {}
                    } else {
                        val nm = svc.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.notify(NOTIFICATION_ID, svc.buildNotification())
                    }
                } catch (_: Exception) {}
            }
        }

        fun onMain(action: () -> Unit) = main.post(action)

        /** 通知栏歌词：Web 层推送当前行 → 更新缓存 + 刷新通知（无歌词传 null/空）
         *  路径说明（反编译 Media3 1.5.1 确认）：
         *  - MediaSessionService.addSession 仅在 media action intent（通知栏按钮 PendingIntent）
         *    或 MediaBrowser onBind 时触发；本应用 Web→插件直接静态驱动播放内核，无 controller 连接
         *    → isSessionAdded=false → MediaNotificationManager.updateNotification 直接 return，
         *    Media3 manager 永不发通知（历史 dumpsys 中 id=1 通知均来自手动 startForeground）。
         *  - 因此主路径 = 手动 NotificationManager.notify 重建前台通知（id 一致，同 id 更新不重复）。
         *  - onUpdateNotification + LyricNotificationProvider（id 注入=1）保留：未来若有 controller
         *    连接，Media3 接管时通知 id 与手动路径一致，不并存不冲突。 */
        fun setLyric(line: String?) {
            PlayerHolder.lyricLine = line?.takeIf { it.isNotBlank() }
            main.post {
                val s = PlayerHolder.service ?: return@post
                val session = s.mediaSession
                if (session != null && session.player.mediaItemCount > 0) {
                    // Media3 manager 激活：provider 重建通知（含五按钮 + 歌词行 contentText）
                    try { s.onUpdateNotification(session, false) } catch (_: Exception) {}
                } else {
                    // 未激活：手动重建前台通知
                    try {
                        val nm = s.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.notify(NOTIFICATION_ID, s.buildNotification())
                    } catch (_: Exception) {}
                }
            }
        }
    }
}
