# DeepSeek Monitor Windows (Enhanced Fork)

基于 [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows) 的增强版本，Windows 桌面端 DeepSeek API 用量监控工具。

## 截图

![DeepSeek Monitor Windows](screenshots/overview.png)

## 安装

下载 Release 中的 `DeepSeekMonitorWindows_1.3.0_x64-setup.exe` 安装即可。

## 源码构建

```powershell
git clone https://github.com/lungphage/DeepSeekMonitorWindows.git
cd DeepSeekMonitorWindows
npm install
npm run tauri:dev
```

## 系统要求

- Windows 10/11
- Microsoft Edge WebView2 Runtime (Win11 已内置)

## 许可证

MIT License - 详见 [LICENSE](LICENSE)

## 致谢

- 原项目：[JayHome137/deepseek-monitor](https://github.com/JayHome137/DeepSeekMonitor)
- 上游 Fork：[Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows)