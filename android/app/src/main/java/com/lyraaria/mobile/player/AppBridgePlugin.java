package com.lyraaria.mobile.player;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// 极小桥接：Web 层在"无可返回内容"时显式请求原生退出到桌面
@CapacitorPlugin(name = "AppBridge")
public class AppBridgePlugin extends Plugin {

    @PluginMethod
    public void exitApp(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
        final android.app.Activity act = getActivity();
        if (act != null) act.runOnUiThread(act::finish);
    }
}
