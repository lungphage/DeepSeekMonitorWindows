# DeepSeek Monitor Windows (Enhanced Fork)

基于 [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows) 的增强版本，Windows 桌面端 DeepSeek API 用量监控工具。

## 更新日志

完整发布记录见 [GitHub Releases](https://github.com/lungphage/DeepSeekMonitorWindows/releases)。

### v1.2.0
- **动态模型支持**：自动展示所有返回的模型，新模型自动配色
- **托盘悬停提示**：鼠标悬停查看余额、今日消耗与本月消费
- **提醒与预算**：余额提醒阈值和月度预算，触发系统通知
- **余额可用天数预测**：按近 7 日日均消耗估算
- **当日消耗环比**：显示与昨日相比的涨跌百分比
- **历史月份查看**：详情页可切换任意月份，支持近 7 天/全月视图
- **CSV 导出**：一键导出当月逐日逐模型用量明细
- **窗口置顶**、Esc 隐藏窗口、失焦自动隐藏
- **主题三态**：深色/浅色/跟随系统
- **安全加固**：API Key 与 Token 改用 Windows DPAPI 加密存储

### v1.1.0
- 支持缓存命中、缓存未命中与输出 Token 的明细显示
- 增加亮色 UI 皮肤，支持在主面板一键切换并记住用户选择
- 设置页增加当前版本号显示
- 当前 GitHub Release v1.1.0 已标记为 Latest，安装包为 `DeepSeekMonitorWindows_1.1.0_x64-setup.exe`
- 安装包 SHA256：B13EF28BB7E803D923E1A00BCE4A873B4EB7F2F592AFF690173C2E9291F1D13F
- 历史 Release v1.0.1 和旧安装包继续保留，便于回退和版本追溯

### v1.0.1
- 修复应用单实例缺失导致的重复多开问题，感谢抖音粉丝群烛阴兄弟提出的bug
- 此前在程序已运行的情况下再次点击图标或 exe，会不断启动新的进程；现在再次启动时不再新开窗口，而是将已有主面板唤到前台
- 通过接入 tauri-plugin-single-instance 单实例守卫实现

### v1.0.0
- 首个正式发布版本，提供 DeepSeek API 余额查询、平台用量统计、消费趋势、Windows 托盘入口、API Key 与用量 Token 管理等能力

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