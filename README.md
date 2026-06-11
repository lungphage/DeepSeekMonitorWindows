# DeepSeek Monitor Windows (Enhanced Fork)

基于 [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows) 的增强版本，Windows 桌面端 DeepSeek API 用量监控工具。

## 本次 Fork 更新内容 (v1.2.0)

### 功能新增
- **动态模型支持**：自动展示所有返回的模型，新模型自动配色
- **托盘悬停提示**：鼠标悬停即可查看余额、今日消耗与本月消费
- **提醒与预算**：余额提醒阈值和月度预算，触发系统通知
- **余额可用天数预测**：按近 7 日日均消耗估算
- **当日消耗环比**：显示与昨日相比的涨跌百分比
- **历史月份查看**：详情页可切换任意月份，支持近 7 天/全月视图
- **CSV 导出**：一键导出当月逐日逐模型用量明细
- **窗口置顶**、Esc 隐藏窗口、失焦自动隐藏
- **主题三态**：深色/浅色/跟随系统

### 修复与安全加固
- 修复自动刷新时界面闪烁问题
- 修复开机自启注册表路径安全问题
- API Key 与 Token 改用 **Windows DPAPI 加密存储**
- 收紧 Tauri capability，配置生产 CSP
- 修复余额接口多币种、时区、并发请求等问题

## 页面截图

![DeepSeek Monitor Windows](screenshots/overview.png)

## 核心功能

- DeepSeek API 账户余额查询
- 当月消费、模型 Token 总量、请求数统计
- 缓存命中/未命中、输出 Token 明细
- 最近 7 天消费趋势图
- Windows 托盘入口
- API Key 与用量 Token 管理（网页登录自动同步/手动粘贴）

## 快速开始

### 直接安装
下载 Release 中的 `DeepSeekMonitorWindows_1.2.0_x64-setup.exe` 安装即可。

### 从源码构建
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

原项目：[JayHome137/deepseek-monitor](https://github.com/JayHome137/DeepSeekMonitor)
上游 Fork：[Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows)
