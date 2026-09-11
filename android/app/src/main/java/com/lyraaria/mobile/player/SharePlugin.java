package com.lyraaria.mobile.player;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * SharePlugin — 接收其他 App 的 ACTION_SEND 文本分享（歌单链接/ID），
 * 供 Web 层预填导入弹窗。App 通过 intent-filter 接收分享后，Web 层拉取。
 * 冷启动：consumeSharedText 读启动 Intent；运行中（singleTask → onNewIntent）先暂存。
 */
@CapacitorPlugin(name = "ShareRecv")
public class SharePlugin extends Plugin {

    private volatile String pendingText = null;

    @Override
    protected void handleOnNewIntent(Intent intent) {
        // App 已运行，分享以 onNewIntent 到达 → 暂存 + 通知 Web 主动消费
        String t = extractSharedText(intent);
        if (t != null) {
            pendingText = t;
            try {
                JSObject payload = new JSObject();
                payload.put("hasText", true);
                notifyListeners("shareReceived", payload, true);
            } catch (Exception e) { /* 事件推送失败由 Web 拉取兜底 */ }
        }
    }

    private String extractSharedText(Intent intent) {
        try {
            if (intent == null) return null;
            if (!Intent.ACTION_SEND.equals(intent.getAction()) || !"text/plain".equals(intent.getType())) return null;
            Object extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (extra == null) return null;
            String t = extra.toString().trim();
            return t.isEmpty() ? null : t;
        } catch (Exception e) {
            return null;
        }
    }

    /** 读取分享文本（取到即消费清除，避免重复弹窗） */
    @PluginMethod
    public void consumeSharedText(PluginCall call) {
        try {
            String text = pendingText;
            pendingText = null;
            if (text == null) {
                Intent intent = getActivity() != null ? getActivity().getIntent() : null;
                text = extractSharedText(intent);
            }
            JSObject ret = new JSObject();
            ret.put("text", text == null ? "" : text);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("consumeSharedText failed: " + e.getMessage());
        }
    }
}
