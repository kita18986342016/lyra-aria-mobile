package com.lyraaria.mobile;

import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;
import com.lyraaria.mobile.player.NativePlayerPlugin;
import com.lyraaria.mobile.player.MediaStorePlugin;
import com.lyraaria.mobile.player.DownloadPlugin;
import com.lyraaria.mobile.player.LyricsWinPlugin;
import com.lyraaria.mobile.player.QqPlugin;
import com.lyraaria.mobile.player.SharePlugin;
import com.lyraaria.mobile.player.HttpPlugin;
import com.lyraaria.mobile.player.AppBridgePlugin;
import com.lyraaria.mobile.player.LanDiscoveryPlugin;
import com.lyraaria.mobile.player.UpdatePlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePlayerPlugin.class);
        registerPlugin(MediaStorePlugin.class);
        registerPlugin(DownloadPlugin.class);
        registerPlugin(QqPlugin.class);
        registerPlugin(SharePlugin.class);
        registerPlugin(LyricsWinPlugin.class);
        registerPlugin(HttpPlugin.class);
        registerPlugin(AppBridgePlugin.class);
        registerPlugin(LanDiscoveryPlugin.class);
        registerPlugin(UpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // 高刷屏（90/120Hz）上申报最高刷新率，动画/滚动更顺；60Hz 设备无副作用
        try {
            Window w = getWindow();
            WindowManager.LayoutParams at = w.getAttributes();
            at.preferredRefreshRate = Float.MAX_VALUE;
            w.setAttributes(at);
        } catch (Throwable ignored) {}
    }

    // 系统返回键 / 边缘返回手势：一律交 Web 层 __handleNativeBack() 决定（App 内逐级返回）；
    // Web 层判定无可返回内容时会主动调用 AppBridge.exitApp() 退出到桌面。
    // bridge/WebView 未就绪时兜底走系统默认返回。
    @Override
    public void onBackPressed() {
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().eval("window.__handleNativeBack && window.__handleNativeBack();", (v) -> {});
                return;
            }
        } catch (Throwable ignored) {}
        super.onBackPressed();
    }
}
