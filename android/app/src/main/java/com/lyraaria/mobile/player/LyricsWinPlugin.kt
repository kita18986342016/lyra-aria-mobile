package com.lyraaria.mobile.player

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextPaint
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 桌面歌词悬浮窗 v6（固定配对双行扫色，用户批次16规范）：
 *  - 无翻译：显示第 2m、2m+1 两行（固定配对，居中）——唱上行时上行扫色、下行白色；
 *    上行唱完扫色移到下行（上行满色）；下行唱完 JS 换发下一对。有翻译：只显示正在唱的一行
 *  - 扫色进度每帧直读 PlayerHolder 内核 currentPosition（严格跟随音频实际进度）
 *  - 控制条图标描边 Canvas 绘制（prev/pause/play/next/lock + 解锁/关闭），播放/暂停随内核状态
 *  - 锁定交互（用户规范）：锁定后短按歌词框弹出解锁按钮 4s，点击解锁；设置页/通知栏也可切换
 *  - 交互三态：解锁-空闲=透明纯歌词；解锁-操作中（点按/拖动后 4s）=灰黑框+控制条；锁定=纯歌词
 */
@CapacitorPlugin(name = "LyricsWin")
class LyricsWinPlugin : Plugin() {

    private var root: FrameLayout? = null
    private var karaoke: KaraokeView? = null
    private var ctrlBar: LinearLayout? = null
    private var closeWrap: ViewGroup? = null
    private var lockWrap: ViewGroup? = null
    private var toggleIcon: View? = null
    private var wm: WindowManager? = null
    private var params: WindowManager.LayoutParams? = null
    private val main = Handler(Looper.getMainLooper())
    private var locked = false
    private var activeUntil = 0L
    private var lockedTapUntil = 0L
    private val activeHideRunnable = Runnable { applyChrome() }
    private val lockedTapHideRunnable = Runnable { applyChrome() }

    private var fsMain = 18f
    private var winAlpha = 1f
    private var bgOn = true
    private var sungColor = Color.parseColor("#4deaff")
    private var unsungColor = Color.WHITE

    private fun ctx(): Context = context

    /** 可见区（排除状态栏/手势条）：默认位与拖动 clamp 都按它算，防止飘出屏幕外 */
    private fun visibleBounds(): android.graphics.Rect = try {
        if (Build.VERSION.SDK_INT >= 30) wm!!.currentWindowMetrics.bounds
        else android.graphics.Rect(0, 0, ctx().resources.displayMetrics.widthPixels, ctx().resources.displayMetrics.heightPixels)
    } catch (_: Exception) {
        android.graphics.Rect(0, 0, ctx().resources.displayMetrics.widthPixels, ctx().resources.displayMetrics.heightPixels)
    }

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), ctx().resources.displayMetrics).toInt()

    private fun sp(v: Float): Float = v * ctx().resources.displayMetrics.scaledDensity

    /** 描边图标 View（24x24 设计网格，白色描边圆头，与底栏 SVG 图标风格统一） */
    private inner class IconView(c: Context, private val nameOf: () -> String) : View(c) {
        private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
            color = Color.WHITE
            setShadowLayer(dp(2).toFloat(), 0f, dp(1).toFloat(), Color.argb(170, 0, 0, 0))
        }
        override fun onDraw(canvas: Canvas) {
            val name = nameOf()
            val s = width / 24f
            canvas.save()
            canvas.scale(s, s)
            p.strokeWidth = 2f
            val path = Path()
            when (name) {
                "prev" -> {
                    path.moveTo(7f, 6f); path.lineTo(7f, 18f)
                    path.moveTo(17f, 6f); path.lineTo(9f, 12f); path.lineTo(17f, 18f); path.close()
                }
                "next" -> {
                    path.moveTo(17f, 6f); path.lineTo(17f, 18f)
                    path.moveTo(7f, 6f); path.lineTo(15f, 12f); path.lineTo(7f, 18f); path.close()
                }
                "play" -> {
                    path.moveTo(9f, 6f); path.lineTo(17f, 12f); path.lineTo(9f, 18f); path.close()
                }
                "pause" -> {
                    path.moveTo(9f, 7f); path.lineTo(9f, 17f)
                    path.moveTo(15f, 7f); path.lineTo(15f, 17f)
                }
                "lock" -> {
                    path.addRoundRect(7f, 11f, 17f, 19f, 2f, 2f, Path.Direction.CW)
                    path.moveTo(9f, 11f); path.lineTo(9f, 8f)
                    path.arcTo(6f, 5f, 18f, 11f, 180f, -180f, false)
                    path.lineTo(15f, 11f)
                }
                "unlock" -> {
                    path.addRoundRect(7f, 11f, 17f, 19f, 2f, 2f, Path.Direction.CW)
                    path.moveTo(7f, 11f); path.lineTo(7f, 7f)
                    path.arcTo(7f, 2f, 17f, 12f, 180f, -150f, false)
                }
                "close" -> {
                    path.moveTo(8f, 8f); path.lineTo(16f, 16f)
                    path.moveTo(16f, 8f); path.lineTo(8f, 16f)
                }
            }
            canvas.drawPath(path, p)
            canvas.restore()
        }
    }

    /** 控制条按钮：图标 + 扩大触摸区的包裹层，点击 → ctrl 事件给 JS */
    private fun ctrlBtn(c: Context, nameOf: () -> String, action: String): ViewGroup {
        val iv = IconView(c, nameOf)
        val wrap = FrameLayout(c)
        wrap.setPadding(dp(10), dp(6), dp(10), dp(6))
        wrap.addView(iv, FrameLayout.LayoutParams(dp(24), dp(24)))
        wrap.setOnClickListener {
            notifyListeners("ctrl", JSObject().apply { put("action", action) })
        }
        return wrap
    }

    /**
     * 固定配对双行卡拉OK（用户批次16规范）：显示第 2m、2m+1 两行，水平居中；
     * 上行在唱时上行扫色、下行白色；上行唱完扫色移到下行（上行满色）；下行唱完 JS 换下一对。
     * single=有翻译时只显示当前唱的一行。超宽行跟随滚动（分界越过可视区 70% 后左移）
     */
    private inner class KaraokeView(c: Context) : View(c) {
        val paint = TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        var sweep = "soft" // 扫色样式（对齐 PC sweepStyle：classic/soft/clean/bold/legacy，非法回退 classic）
            set(v) { field = v; invalidate() }
        var topText: String = "" // 配对上行（第 2m 行）
            set(v) { field = v; cacheWidths(); requestLayout(); invalidate() }
        var bottomText: String = "" // 配对下行（第 2m+1 行）
            set(v) { field = v; cacheWidths(); requestLayout(); invalidate() }
        var curRow = 0 // 正在唱的行：0=上行 1=下行
            set(v) { field = v; invalidate() }
        var single = false
            set(v) { field = v; requestLayout(); invalidate() }
        var charStarts: FloatArray = FloatArray(0) // 当前唱行的每字起始（歌曲秒）
        var lineEndSec = -1f
        private var lastDbgLog = 0L
        private var topWidths: FloatArray = FloatArray(0)
        private var botWidths: FloatArray = FloatArray(0)
        private var topTotal = 0f
        private var botTotal = 0f

        fun setTimeline(starts: FloatArray, endSec: Float) {
            charStarts = starts
            // 归一化：时间轴异常（全等/相对行首/单位为毫秒等）时按行窗 [first, lineEnd] 均分，
            // 防止所有字被判已唱完导致扫色瞬间满格+末字抖动。正常递增且落在行窗内的逐字数据保持不动
            if (starts.size > 1 && endSec > 0) {
                val first = starts.first(); val last = starts.last()
                val bad = last - first < 0.1f || last > endSec + 0.5f || first > endSec
                if (bad) {
                    val step = (endSec - first) / starts.size
                    for (i in starts.indices) starts[i] = first + step * i
                }
            }
            lineEndSec = endSec
            invalidate()
        }
        fun applySize() { paint.textSize = sp(fsMain); cacheWidths(); requestLayout(); invalidate() }
        fun applyColors() { invalidate() }
        /** 九款字体（对齐 PC lyricFont）：设备缺字体时 Typeface.create 自动回落系统默认 */
        fun applyFont(key: String) {
            paint.typeface = fontFor(key)
            strokePaint.typeface = paint.typeface
            cacheWidths(); requestLayout(); invalidate()
        }
        private fun fontFor(key: String): Typeface = when (key) {
            "noto" -> Typeface.create("Noto Sans SC", Typeface.BOLD)
            "misans" -> Typeface.create("MiSans", Typeface.BOLD)
            "yahei" -> Typeface.create("Microsoft YaHei", Typeface.BOLD)
            "songti" -> Typeface.SERIF
            "kai", "wenkai" -> Typeface.create("KaiTi", Typeface.BOLD)
            "xingkai" -> Typeface.create("STXingkai", Typeface.BOLD)
            "xinwei" -> Typeface.create("STXinwei", Typeface.BOLD)
            else -> Typeface.create("sans-serif", Typeface.BOLD)
        }
        /** 各扫色样式的阴影层 [radius, dx, dy, alpha]（对齐 PC drop-shadow 组合） */
        private fun shadowSpecs(): List<FloatArray> = when (sweep) {
            "soft" -> listOf(
                floatArrayOf(dp(5).toFloat(), 0f, 0f, 140f),
                floatArrayOf(dp(12).toFloat(), 0f, 0f, 77f)
            )
            "bold" -> listOf(
                floatArrayOf(0f, dp(1).toFloat(), dp(1).toFloat(), 178f),
                floatArrayOf(0f, dp(2).toFloat(), dp(2).toFloat(), 115f)
            )
            "legacy" -> listOf(
                floatArrayOf(dp(3).toFloat(), 0f, 0f, 230f),
                floatArrayOf(dp(8).toFloat(), 0f, 0f, 140f),
                floatArrayOf(dp(2).toFloat(), 0f, dp(1).toFloat(), 204f)
            )
            "classic" -> listOf(
                floatArrayOf(dp(3).toFloat(), 0f, 0f, 230f),
                floatArrayOf(dp(2).toFloat(), 0f, dp(1).toFloat(), 204f)
            )
            else -> emptyList() // clean：纯渐变无装饰
        }
        private fun cacheWidths() {
            topWidths = FloatArray(topText.length)
            var s1 = 0f
            for (i in topText.indices) { topWidths[i] = paint.measureText(topText, i, i + 1); s1 += topWidths[i] }
            topTotal = s1
            botWidths = FloatArray(bottomText.length)
            var s2 = 0f
            for (i in bottomText.indices) { botWidths[i] = paint.measureText(bottomText, i, i + 1); s2 += botWidths[i] }
            botTotal = s2
        }

        /** 正在唱行的已唱宽度占比：分母 = 整行所有字符宽度之和（防"飞速扫完+末尾抖动"，见批次13/15） */
        private fun sungFraction(posSec: Float): Float {
            val text = if (curRow == 0) topText else bottomText
            val widths = if (curRow == 0) topWidths else botWidths
            val total = if (curRow == 0) topTotal else botTotal
            if (charStarts.isEmpty() || text.isEmpty() || lineEndSec <= 0) return 0f
            var w = 0f
            for (i in text.indices) {
                val st = if (i < charStarts.size) charStarts[i] else lineEndSec
                val en = if (i + 1 < charStarts.size) charStarts[i + 1] else lineEndSec
                val cw = widths.getOrElse(i) { 0f }
                if (posSec >= en) { w += cw; continue }
                if (posSec > st && en > st) { w += cw * ((posSec - st) / (en - st)) }
                break
            }
            return if (total > 0) (w / total).coerceIn(0f, 1f) else 0f
        }

        /** 画一行（居中；超宽时跟随滚动），frac=已唱占比（1=满色，0=纯未唱白） */
        private fun drawLine(canvas: Canvas, text: String, totalW: Float, frac: Float, baseY: Float) {
            if (text.isEmpty()) return
            val avail = (width - paddingLeft - paddingRight).coerceAtLeast(1).toFloat()
            val x0: Float
            var scroll = 0f
            if (totalW > avail) {
                x0 = paddingLeft.toFloat()
                scroll = (x0 + totalW * frac - avail * 0.7f).coerceIn(0f, totalW - avail)
            } else {
                x0 = (width - totalW) / 2f
            }
            canvas.save()
            canvas.translate(-scroll, 0f)
            strokePaint.textSize = paint.textSize
            strokePaint.typeface = paint.typeface
            // 装饰层（对齐 PC sweepStyle）：先逐层画阴影，classic 再描边，最后正文双色
            for (s in shadowSpecs()) {
                val sc = Color.argb(s[3].toInt(), 0, 0, 0)
                paint.setShadowLayer(s[0], s[1], s[2], sc)
                paint.color = sc
                canvas.drawText(text, x0, baseY, paint)
            }
            paint.clearShadowLayer()
            if (sweep == "classic") {
                strokePaint.strokeWidth = sp(1.8f)
                canvas.drawText(text, x0, baseY, strokePaint) // 黑描边打底（仅 classic，PC 1.2px）
            }
            paint.color = unsungColor
            canvas.drawText(text, x0, baseY, paint)
            if (frac > 0f) {
                val cut = x0 + totalW * frac
                val save = canvas.save()
                canvas.clipRect(x0 - dp(2), 0f, cut, height.toFloat())
                paint.color = sungColor
                canvas.drawText(text, x0, baseY, paint)
                canvas.restoreToCount(save)
            }
            canvas.restore()
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (topText.isEmpty() && bottomText.isEmpty()) return
            val player = PlayerHolder.player
            val playing = player?.isPlaying == true
            val posSec = if (player != null) player.currentPosition / 1000f else 0f
            val frac = sungFraction(posSec)
            val dbgNow = System.currentTimeMillis()
            if (dbgNow - lastDbgLog > 500) {
                lastDbgLog = dbgNow
                android.util.Log.d("LyrWinDraw", "frac=" + (frac * 100).toInt() + "% row=" + curRow + " playing=" + playing + " pos=" + posSec + " n=" + charStarts.size + " top=" + topText.take(10) + " bot=" + bottomText.take(10))
            }
            if (playing) postInvalidateOnAnimation() // 播放中逐帧推进；暂停自然冻结
            val fm = paint.fontMetrics
            val lineH = fm.bottom - fm.top
            val two = !single && bottomText.isNotEmpty()
            if (single) {
                // 有翻译：只显示正在唱的一行
                val text = if (curRow == 0) topText else bottomText
                val total = if (curRow == 0) topTotal else botTotal
                val base = height / 2f - (fm.descent + fm.ascent) / 2f
                drawLine(canvas, text, total, frac, base)
            } else {
                // 上行 frac：在唱=实时扫色；唱完（下行在唱）=满色
                val topFrac = if (curRow == 0) frac else 1f
                // 下行 frac：在唱=实时扫色；未唱=0（纯白）
                val botFrac = if (curRow == 1) frac else 0f
                if (two) {
                    val topBase = lineH / 2f - (fm.descent + fm.ascent) / 2f
                    drawLine(canvas, topText, topTotal, topFrac, topBase)
                    val botBase = lineH + dp(3) + lineH / 2f - (fm.descent + fm.ascent) / 2f
                    drawLine(canvas, bottomText, botTotal, botFrac, botBase)
                } else {
                    val text = if (topText.isNotEmpty()) topText else bottomText
                    val total = if (topText.isNotEmpty()) topTotal else botTotal
                    val f = if (topText.isNotEmpty()) topFrac else botFrac
                    val base = height / 2f - (fm.descent + fm.ascent) / 2f
                    drawLine(canvas, text, total, f, base)
                }
            }
        }

        override fun onMeasure(wSpec: Int, hSpec: Int) {
            val w = View.MeasureSpec.getSize(wSpec)
            val fm = paint.fontMetrics
            val lineH = fm.bottom - fm.top
            val two = !single && bottomText.isNotEmpty()
            val gap = dp(3)
            val th = (if (two) lineH * 2 + gap else lineH).toInt() + paddingTop + paddingBottom + dp(4)
            setMeasuredDimension(w, th)
        }
    }

    private val strokePaint: TextPaint by lazy {
        TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            style = android.graphics.Paint.Style.STROKE
            strokeWidth = sp(2.4f)
            color = Color.argb(210, 10, 12, 18)
        }
    }

    @PluginMethod
    fun canDrawOverlays(call: PluginCall) {
        call.resolve(JSObject().apply { put("ok", Settings.canDrawOverlays(ctx())) })
    }

    @PluginMethod
    fun requestPerm(call: PluginCall) {
        if (!Settings.canDrawOverlays(ctx())) {
            try {
                val i = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx().packageName))
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx().startActivity(i)
            } catch (e: Exception) {
                call.reject(PlayerHolder.sanitize(e.message ?: "无法打开权限页"))
                return
            }
        }
        call.resolve()
    }

    /** 框与控制条显隐：锁定=纯歌词（短按弹解锁按钮）；空闲=透明；操作中 4s=灰黑框+控制条 */
    private fun applyChrome() {
        val r = root ?: return
        val now = System.currentTimeMillis()
        val active = !locked && now < activeUntil
        r.background = when {
            locked -> null
            active -> GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(Color.argb((255 * 0.45).toInt(), 24, 26, 32)) // 灰黑框
            }
            else -> null
        }
        ctrlBar?.visibility = if (active) View.VISIBLE else View.GONE
        closeWrap?.visibility = if (locked) View.GONE else View.VISIBLE
        lockWrap?.visibility = if (locked && now < lockedTapUntil) View.VISIBLE else View.GONE
        if (active) main.postDelayed({ toggleIcon?.invalidate() }, 250) // 播放/暂停图标随内核状态刷新
        karaoke!!.invalidate()
    }

    private fun pokeActive() {
        activeUntil = System.currentTimeMillis() + 4000
        applyChrome()
        main.removeCallbacks(activeHideRunnable)
        main.postDelayed(activeHideRunnable, 4100)
    }

    private fun pokeLockedTap() {
        lockedTapUntil = System.currentTimeMillis() + 4000
        applyChrome()
        main.removeCallbacks(lockedTapHideRunnable)
        main.postDelayed(lockedTapHideRunnable, 4100)
    }

    /** 锁定/解锁（用户规范）：锁定=完全触摸穿透（窗口加 FLAG_NOT_TOUCHABLE，点击歌词无反应），解锁仅通过通知栏迷你播放条或设置页切换 */
    @PluginMethod
    fun setLocked(call: PluginCall) {
        locked = call.getBoolean("locked", false) == true
        main.post {
            try {
                ensureView()
                activeUntil = 0
                lockedTapUntil = 0
                applyChrome()
                applyTouchThrough()
                call.resolve(JSObject().apply { put("ok", true) })
            } catch (e: Exception) {
                call.reject(PlayerHolder.sanitize(e.message ?: "失败"))
            }
        }
    }

    /** 锁定态窗口完全触摸穿透（点击歌词无反应）；解锁态恢复可触摸（拖动/控制条） */
    private fun applyTouchThrough() {
        val p = params ?: return
        p.flags = if (locked) {
            p.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        } else {
            p.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        }
        try { val w = wm; if (root != null && w != null) w.updateViewLayout(root, p) } catch (_: Exception) {}
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun ensureView() {
        if (root != null) return
        val c = ctx()
        wm = c.getSystemService(Context.WINDOW_SERVICE) as WindowManager

        karaoke = KaraokeView(c).apply {
            paint.textSize = sp(fsMain)
        }
        closeWrap = ctrlBtn(c, { "close" }, "close")
        (closeWrap as FrameLayout).layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.END or Gravity.TOP }
        (closeWrap as FrameLayout).setOnClickListener {
            hideInternal()
            notifyListeners("ctrl", JSObject().apply { put("action", "close") })
        }
        lockWrap = ctrlBtn(c, { "unlock" }, "noop") // 点击行为在下方覆盖（原生直接解锁）
        (lockWrap as FrameLayout).layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER_HORIZONTAL }
        (lockWrap as FrameLayout).setOnClickListener {
            locked = false
            lockedTapUntil = 0
            applyChrome()
            notifyListeners("lock", JSObject().apply { put("locked", false) })
        }
        ctrlBar = LinearLayout(c).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(0, dp(4), 0, 0)
            addView(ctrlBtn(c, { "prev" }, "prev"))
            val toggleWrap = ctrlBtn(c, { if (PlayerHolder.player?.isPlaying == true) "pause" else "play" }, "toggle")
            toggleIcon = (toggleWrap as FrameLayout).getChildAt(0)
            addView(toggleWrap)
            addView(ctrlBtn(c, { "next" }, "next"))
            addView(ctrlBtn(c, { "lock" }, "lock"))
        }
        val col = LinearLayout(c).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        col.addView(karaoke, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        col.addView(ctrlBar)
        col.addView(lockWrap)
        root = FrameLayout(c).apply {
            setPadding(dp(14), dp(8), dp(14), dp(8))
            alpha = winAlpha
        }
        root!!.addView(col)
        root!!.addView(closeWrap)

        params = WindowManager.LayoutParams().apply {
            type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
            flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
            format = PixelFormat.TRANSLUCENT
            val vbd = visibleBounds()
            width = (vbd.width() - dp(24)).coerceAtLeast(dp(100))
            height = WindowManager.LayoutParams.WRAP_CONTENT
            gravity = Gravity.TOP or Gravity.START
            val sp2 = c.getSharedPreferences("lyrwin", Context.MODE_PRIVATE)
            val savedX = sp2.getInt("x", Int.MIN_VALUE)
            val savedY = sp2.getInt("y", Int.MIN_VALUE)
            val vb = visibleBounds()
            x = if (savedX != Int.MIN_VALUE) savedX.coerceIn(vb.left, (vb.right - root!!.width).coerceAtLeast(vb.left)) else vb.left + dp(12)
            y = if (savedY != Int.MIN_VALUE) savedY.coerceIn(vb.top, (vb.bottom - root!!.height).coerceAtLeast(vb.top)) else vb.top + (vb.height() * 0.62).toInt()
        }

        root!!.setOnTouchListener(object : View.OnTouchListener {
            private var downX = 0f; private var downY = 0f
            private var startX = 0; private var startY = 0
            private var moved = false
            override fun onTouch(v: View, e: MotionEvent): Boolean {
                // ✕/控制条/解锁按钮：放行给子控件处理点击（否则被拖动监听吞掉，按钮点不动）
                if (e.action == MotionEvent.ACTION_DOWN && (hitChild(closeWrap, e.rawX, e.rawY) || hitChild(ctrlBar, e.rawX, e.rawY) || hitChild(lockWrap, e.rawX, e.rawY))) return false
                when (e.action) {
                    MotionEvent.ACTION_DOWN -> {
                        downX = e.rawX; downY = e.rawY
                        startX = params!!.x; startY = params!!.y
                        moved = false
                        if (locked) return true
                        pokeActive()
                        return true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        if (locked) return true // 锁定禁拖
                        val dx = (e.rawX - downX).toInt(); val dy = (e.rawY - downY).toInt()
                        if (moved || Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                            moved = true
                            val vb = visibleBounds()
                            params!!.x = (startX + dx).coerceIn(vb.left, (vb.right - v.width).coerceAtLeast(vb.left))
                            params!!.y = (startY + dy).coerceIn(vb.top, (vb.bottom - v.height).coerceAtLeast(vb.top))
                            try { wm!!.updateViewLayout(root, params) } catch (_: Exception) {}
                            pokeActive()
                        }
                        return true
                    }
                    MotionEvent.ACTION_UP -> {
                        if (locked) {
                            if (!moved) pokeLockedTap() // 锁定短按：弹解锁按钮 4s
                            return true
                        }
                        if (moved) {
                            val sp2 = c.getSharedPreferences("lyrwin", Context.MODE_PRIVATE)
                            sp2.edit().putInt("x", params!!.x).putInt("y", params!!.y).apply()
                        } else {
                            pokeActive() // 短按：弹控制条 4s
                        }
                        return true
                    }
                }
                return false
            }
        })
    }

    private fun hitChild(vv: View?, ex: Float, ey: Float): Boolean {
        if (vv == null || vv.visibility != View.VISIBLE || vv.width == 0) return false
        val l = IntArray(2); vv.getLocationOnScreen(l)
        return ex >= l[0] && ex <= l[0] + vv.width && ey >= l[1] && ey <= l[1] + vv.height
    }

    private fun hideInternal() {
        try { root?.visibility = View.GONE } catch (_: Exception) {}
    }

    @PluginMethod
    fun show(call: PluginCall) {
        if (!Settings.canDrawOverlays(ctx())) return call.reject("无悬浮窗权限")
        val l1 = call.getString("line1") ?: "深空折韵"
        main.post {
            try {
                ensureView()
                applyChrome()
                karaoke!!.topText = ""
                karaoke!!.bottomText = l1
                karaoke!!.curRow = 0
                karaoke!!.charStarts = FloatArray(0)
                if (root!!.parent == null) {
                    wm!!.addView(root, params)
                }
                root!!.visibility = View.VISIBLE
                call.resolve(JSObject().apply { put("ok", true) })
            } catch (e: Exception) {
                call.reject(PlayerHolder.sanitize(e.message ?: "显示失败"))
            }
        }
    }

    /** 歌词更新（固定配对模型）：top=第 2m 行，bottom=第 2m+1 行；curRow=正在唱的行（0/1）；
     *  single=有翻译仅显示当前唱的一行；chars=当前唱行每字起始秒数组，lineEnd=行尾（进度内核直读） */
    @PluginMethod
    fun update(call: PluginCall) {
        val top = call.getString("top")
        val bottom = call.getString("bottom")
        val curRow = (call.getDouble("curRow") ?: 0.0).toInt()
        val single = call.getBoolean("single", false) == true
        val chars = call.getArray("chars")
        val lineEnd = (call.getDouble("lineEnd") ?: -1.0).toFloat()
        main.post {
            try {
                if (root == null || root!!.visibility != View.VISIBLE) { call.resolve(); return@post }
                if (top != null) karaoke!!.topText = top
                if (bottom != null) karaoke!!.bottomText = bottom
                karaoke!!.curRow = if (curRow == 1) 1 else 0
                karaoke!!.single = single
                if (chars != null) {
                    val n = chars.length()
                    val starts = FloatArray(n)
                    for (i in 0 until n) starts[i] = chars.getDouble(i).toFloat()
                    karaoke!!.setTimeline(starts, lineEnd)
                }
                call.resolve()
            } catch (e: Exception) {
                call.reject(PlayerHolder.sanitize(e.message ?: "更新失败"))
            }
        }
    }

    @PluginMethod
    fun setStyle(call: PluginCall) {
        val fs = call.getDouble("fontSize")
        val op = call.getDouble("opacity")
        val bg = call.getBoolean("bg")
        val sung = call.getString("sung")
        val unsung = call.getString("unsung")
        val sweep = call.getString("sweep")
        val font = call.getString("font")
        main.post {
            try {
                ensureView()
                if (fs != null) { fsMain = fs.toFloat().coerceIn(12f, 32f); karaoke!!.applySize() }
                if (op != null) { winAlpha = (op.toFloat() / 100f).coerceIn(0.3f, 1f); root!!.alpha = winAlpha }
                if (sung != null) { sungColor = Color.parseColor(sung); karaoke!!.applyColors() }
                if (unsung != null) { unsungColor = Color.parseColor(unsung); karaoke!!.applyColors() }
                if (bg != null) { bgOn = bg; applyChrome() }
                // 扫色样式：PC 契约非法值回退 classic；字体：非法回退 default
                if (sweep != null) karaoke!!.sweep = if (sweep in setOf("classic", "soft", "clean", "bold", "legacy")) sweep else "classic"
                if (font != null) karaoke!!.applyFont(if (font in setOf("default", "kai", "xinwei", "songti", "yahei", "noto", "misans", "wenkai", "xingkai")) font else "default")
                call.resolve(JSObject().apply { put("ok", true) })
            } catch (e: Exception) {
                call.reject(PlayerHolder.sanitize(e.message ?: "样式失败"))
            }
        }
    }

    @PluginMethod
    fun hide(call: PluginCall) {
        main.post {
            try { root?.visibility = View.GONE } catch (_: Exception) {}
            call.resolve()
        }
    }
}
