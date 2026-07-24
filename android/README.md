# 蛇域 Android 客户端

这是一个 Kotlin 原生单 Activity 外壳。游戏仍由现有 Svelte/Pixi 客户端渲染，但运行在专用 WebView 中，因此没有浏览器地址栏和工具栏，并具备沉浸式系统栏、常亮、返回导航、加载错误页和受控麦克风授权。

## D 盘工具链

项目脚本只把新工具和依赖写入 `D:\Android`：

```text
D:\Android\jdk-21             JDK 21
D:\Android\sdk                Android SDK / platform-tools
D:\Android\gradle-8.10.2      Gradle 启动包
D:\Android\gradle-home        Gradle、AGP、Kotlin 和 Maven 缓存
D:\Android\android-user-home  Android CLI 用户数据
D:\Android\tmp                构建临时文件
```

首次安装工具链：

```powershell
cd D:\Serpentia\android
powershell -ExecutionPolicy Bypass -File .\tools\bootstrap-d.ps1
```

不需要安装 Android Studio。脚本优先将机器上已有的 JDK 21 镜像到 D 盘（不向 C 盘写文件），然后安装 Android command-line tools、API 35、Build Tools 35.0.0 和 platform-tools，并生成 Gradle wrapper。若以后安装 Android Studio，也应把安装目录、SDK 和 Gradle cache 都改到 `D:\Android`。

## 本地调试

模拟器默认访问 `http://10.0.2.2:3000`。先在仓库根目录启动完整服务：

```bash
bun run dev
```

构建 debug APK：

```powershell
cd D:\Serpentia\android
.\gradlew-d.bat assembleDebug
```

APK 输出：

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

真机 USB 调试时，将设备端口反向映射到电脑，并覆盖应用地址：

```powershell
.\adb-d.bat reverse tcp:3000 tcp:3000
.\gradlew-d.bat assembleDebug -PSERPENTIA_APP_URL=http://127.0.0.1:3000
.\adb-d.bat install -r .\app\build\outputs\apk\debug\app-debug.apk
```

debug 构建只允许 `10.0.2.2`、`localhost` 和 `127.0.0.1` 使用 HTTP；其他服务器地址必须使用 HTTPS。真机调试推荐使用上面的 `adb reverse`，不开放整个局域网的明文流量。

## Release 签名与构建

首次生成长期 release key：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\create-release-keystore-d.ps1
```

私钥和密码分别保存在：

```text
D:\Android\keystores\serpentia-release.p12
D:\Android\keystores\serpentia-release.properties
```

它们不会进入 Git。**发布前必须把这两个文件一起加密备份到另一块磁盘或密码库**；丢失 release key 后，直接分发的同包名 APK 将无法继续覆盖升级。Google Play App Signing 开启后，这把密钥可以作为 upload key。

release 构建拒绝明文 HTTP，也拒绝缺少签名配置或服务器地址。默认正式地址为 `https://38-246-253-238.sslip.io`：

```powershell
.\gradlew-d.bat assembleRelease
```

如需构建其他环境，可显式覆盖：

```powershell
.\gradlew-d.bat assembleRelease -PSERPENTIA_RELEASE_APP_URL=https://game.example.com
```

签名 APK 输出到：

```text
android\app\build\outputs\apk\release\app-release.apk
```

验证 APK：

```powershell
D:\Android\sdk\build-tools\35.0.0\apksigner.bat verify --verbose --print-certs .\app\build\outputs\apk\release\app-release.apk
```

应用只允许服务器同源页面留在 WebView 中，外部链接交给系统浏览器；麦克风权限也只会授予配置的服务器 origin。

## 沉浸行为

- 启动后隐藏状态栏和导航栏
- 边缘滑动仍可临时唤出系统栏，这是普通 Android 应用无法取消的系统安全行为
- 屏幕常亮，旋转时保留同一个 WebView 和 WebSocket 会话
- WebView 使用 Android System WebView；建议从 Play 商店保持其更新
