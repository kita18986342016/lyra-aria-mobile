# 深空折韵 · 安卓版（Lyra Aria Mobile）

深空折韵音乐播放器的 Android 版本，与桌面版（[lyra-aria](https://github.com/kita18986342016/lyra-aria)）数据互通。

## 功能
- 本地音乐库（扫描/播放/歌词/通知栏控制/后台播放）
- 在线音乐：网易云 / 酷狗 / QQ 音源，搜索、歌单导入、收藏、下载
- 桌面歌词悬浮窗
- **双端互通**：同一 WiFi 下与电脑端自动同步歌单、收藏、最近播放与登录态（首次配对后无感同步）

## 安装
到 [Releases](../../releases) 下载最新 APK 安装（Android 6.0+）。

## 与电脑端同步
1. 电脑端：设置 → 账号管理 → 局域网同步 → 开启
2. 手机端：设置 → 局域网同步 → 自动发现电脑 → 首次同步时电脑端点「允许」（或输入配对码）
3. 之后两端自动同步，无需任何操作

## 构建
```bash
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
# 产物 android/app/build/outputs/apk/debug/app-debug.apk
```

