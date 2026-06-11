#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use serde::{Deserialize, Serialize};
    use std::{
        fs,
        io::Read,
        os::windows::fs::OpenOptionsExt,
        path::{Path, PathBuf},
        process::Command,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex, OnceLock,
        },
        thread,
        time::Duration,
    };
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
        webview::PageLoadEvent,
        Emitter, Manager, PhysicalPosition, Position, WebviewWindow,
    };

    #[derive(Debug, Clone, Default, Deserialize, Serialize)]
    struct StoredConfig {
        api_key: Option<String>,
        #[serde(default)]
        usage_token: Option<String>,
        refresh_interval_seconds: u64,
        #[serde(default)]
        auto_refresh_enabled: bool,
        autostart: bool,
        #[serde(default)]
        balance_alert_threshold: Option<f64>,
        #[serde(default)]
        monthly_budget: Option<f64>,
        #[serde(default)]
        hide_on_blur: bool,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AppConfig {
        api_key_configured: bool,
        api_key_preview: Option<String>,
        usage_token_configured: bool,
        refresh_interval_seconds: u64,
        auto_refresh_enabled: bool,
        autostart: bool,
        balance_alert_threshold: Option<f64>,
        monthly_budget: Option<f64>,
        hide_on_blur: bool,
        config_path: String,
    }

    fn http_client() -> &'static reqwest::Client {
        static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
        HTTP.get_or_init(reqwest::Client::new)
    }

    fn config_path() -> Result<PathBuf, String> {
        let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not available")?;
        Ok(PathBuf::from(appdata)
            .join("DeepSeekMonitorWindows")
            .join("config.json"))
    }

    // ---------- DPAPI 凭据加密：密文绑定当前 Windows 用户，换机/换用户无法解出 ----------
    const DPAPI_PREFIX: &str = "dpapi:";

    fn dpapi_encrypt(plain: &str) -> Result<String, String> {
        use base64::Engine;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{
            CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };

        let bytes = plain.as_bytes();
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("DPAPI 加密失败".to_string());
        }
        let encoded = unsafe {
            let data = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let encoded = base64::engine::general_purpose::STANDARD.encode(data);
            LocalFree(output.pbData as _);
            encoded
        };
        Ok(format!("{DPAPI_PREFIX}{encoded}"))
    }

    fn dpapi_decrypt(stored: &str) -> Result<String, String> {
        use base64::Engine;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };

        let encoded = stored.strip_prefix(DPAPI_PREFIX).ok_or("不是加密凭据")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("凭据解码失败：{error}"))?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("DPAPI 解密失败".to_string());
        }
        let plain = unsafe {
            let data = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let plain = String::from_utf8_lossy(data).to_string();
            LocalFree(output.pbData as _);
            plain
        };
        Ok(plain)
    }

    fn write_stored_config(config: &StoredConfig) -> Result<(), String> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        // 落盘前加密敏感字段；内存中的 config 始终保持明文
        let mut disk = config.clone();
        if let Some(value) = disk.api_key.as_deref().filter(|v| !v.is_empty()) {
            if !value.starts_with(DPAPI_PREFIX) {
                disk.api_key = Some(dpapi_encrypt(value)?);
            }
        }
        if let Some(value) = disk.usage_token.as_deref().filter(|v| !v.is_empty()) {
            if !value.starts_with(DPAPI_PREFIX) {
                disk.usage_token = Some(dpapi_encrypt(value)?);
            }
        }

        let text = serde_json::to_string_pretty(&disk).map_err(|error| error.to_string())?;
        fs::write(path, text).map_err(|error| error.to_string())
    }

    fn read_stored_config() -> Result<StoredConfig, String> {
        let path = config_path()?;
        if !path.exists() {
            return Ok(StoredConfig {
                refresh_interval_seconds: 60,
                ..StoredConfig::default()
            });
        }

        let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let mut config: StoredConfig =
            serde_json::from_str(&text).map_err(|error| error.to_string())?;
        config.refresh_interval_seconds =
            normalize_refresh_interval_seconds(config.refresh_interval_seconds);

        let mut needs_migration = false;
        for secret in [&mut config.api_key, &mut config.usage_token] {
            if let Some(value) = secret.as_deref() {
                if value.starts_with(DPAPI_PREFIX) {
                    match dpapi_decrypt(value) {
                        Ok(plain) => *secret = Some(plain),
                        // 换机/换用户导致解不开：当作未配置，让用户重新录入
                        Err(_) => *secret = None,
                    }
                } else if !value.is_empty() {
                    // 旧版明文配置，标记迁移为加密存储
                    needs_migration = true;
                }
            }
        }
        if needs_migration {
            let _ = write_stored_config(&config);
        }
        Ok(config)
    }

    fn normalize_refresh_interval_seconds(value: u64) -> u64 {
        match value {
            60 | 300 | 1800 | 3600 => value,
            _ => 60,
        }
    }

    fn api_key_preview(api_key: &str) -> String {
        let chars: Vec<char> = api_key.chars().collect();
        if chars.len() <= 12 {
            return "已保存".to_string();
        }

        let start: String = chars.iter().take(7).collect();
        let end: String = chars
            .iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{start}...{end}")
    }

    fn to_app_config(config: StoredConfig) -> Result<AppConfig, String> {
        let path = config_path()?;
        let api_key_preview = config
            .api_key
            .as_ref()
            .filter(|value| !value.is_empty())
            .map(|value| api_key_preview(value));

        let usage_token_configured = config
            .usage_token
            .as_ref()
            .map(|value| !value.is_empty())
            .unwrap_or(false);

        Ok(AppConfig {
            api_key_configured: api_key_preview.is_some(),
            api_key_preview,
            usage_token_configured,
            refresh_interval_seconds: config.refresh_interval_seconds,
            auto_refresh_enabled: config.auto_refresh_enabled,
            autostart: config.autostart,
            balance_alert_threshold: config.balance_alert_threshold,
            monthly_budget: config.monthly_budget,
            hide_on_blur: config.hide_on_blur,
            config_path: path.to_string_lossy().to_string(),
        })
    }

    fn position_near_tray(window: &WebviewWindow) -> tauri::Result<()> {
        let cursor = window.cursor_position()?;
        let monitor = window
            .monitor_from_point(cursor.x, cursor.y)?
            .or(window.current_monitor()?)
            .or(window.primary_monitor()?)
            .ok_or_else(|| tauri::Error::WindowNotFound)?;

        let work_area = monitor.work_area();
        let scale_factor = monitor.scale_factor();
        let size = window.outer_size()?;
        let margin = (12.0 * scale_factor).round() as i32;
        let width = size.width as i32;
        let height = size.height as i32;
        let right = work_area.position.x + work_area.size.width as i32;
        let bottom = work_area.position.y + work_area.size.height as i32;
        let x = right - width - margin;
        let y = bottom - height - margin;

        window.set_position(Position::Physical(PhysicalPosition::new(
            x.max(work_area.position.x),
            y.max(work_area.position.y),
        )))
    }

    fn show_main_window(window: &WebviewWindow) {
        let _ = position_near_tray(window);
        let _ = window.show();
        let _ = window.set_focus();
    }

    #[tauri::command]
    fn hide_main_window(window: WebviewWindow) -> Result<(), String> {
        window.hide().map_err(|error| error.to_string())
    }

    #[tauri::command]
    fn get_app_config() -> Result<AppConfig, String> {
        to_app_config(read_stored_config()?)
    }

    #[tauri::command]
    fn save_api_key(api_key: String) -> Result<AppConfig, String> {
        let value = api_key.trim().to_string();
        if value.is_empty() {
            return Err("API Key 不能为空".to_string());
        }

        let mut config = read_stored_config()?;
        config.api_key = Some(value);
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn clear_api_key() -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.api_key = None;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn save_refresh_interval(refresh_interval_seconds: u64) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.refresh_interval_seconds =
            normalize_refresh_interval_seconds(refresh_interval_seconds);
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn save_auto_refresh_enabled(auto_refresh_enabled: bool) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.auto_refresh_enabled = auto_refresh_enabled;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn save_alert_settings(
        balance_alert_threshold: Option<f64>,
        monthly_budget: Option<f64>,
    ) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.balance_alert_threshold = balance_alert_threshold.filter(|value| *value > 0.0);
        config.monthly_budget = monthly_budget.filter(|value| *value > 0.0);
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn save_hide_on_blur(hide_on_blur: bool) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.hide_on_blur = hide_on_blur;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    fn apply_autostart(enabled: bool) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        // 不带此标志，GUI 程序派生 reg.exe 会闪现一个控制台黑框
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let run_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let value_name = "DeepSeekMonitorWindows";

        if enabled {
            let exe = std::env::current_exe().map_err(|error| error.to_string())?;
            // 路径含空格时必须加引号，否则 Run 键按空格截断路径（unquoted path 问题）
            let exe_arg = format!("\"{}\"", exe.to_string_lossy());
            let status = Command::new("reg")
                .args(["add", run_key, "/v", value_name, "/t", "REG_SZ", "/d"])
                .arg(exe_arg)
                .args(["/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map_err(|error| format!("写入开机自启失败：{error}"))?;
            if !status.success() {
                return Err("写入开机自启失败".to_string());
            }
            return Ok(());
        }

        let status = Command::new("reg")
            .args(["delete", run_key, "/v", value_name, "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|error| format!("关闭开机自启失败：{error}"))?;
        if !status.success() {
            return Ok(());
        }
        Ok(())
    }

    #[tauri::command]
    fn save_autostart(autostart: bool) -> Result<AppConfig, String> {
        apply_autostart(autostart)?;
        let mut config = read_stored_config()?;
        config.autostart = autostart;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BalanceResult {
        is_available: bool,
        currency: String,
        total_balance: String,
        granted_balance: String,
        topped_up_balance: String,
    }

    // 实时查询 DeepSeek 账户余额。DeepSeek 官方仅提供余额接口，无用量接口。
    #[tauri::command]
    async fn fetch_balance() -> Result<BalanceResult, String> {
        let config = read_stored_config()?;
        let api_key = config
            .api_key
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "未配置 API Key".to_string())?;

        let response = http_client()
            .get("https://api.deepseek.com/user/balance")
            .bearer_auth(&api_key)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| format!("网络请求失败：{error}"))?;

        match response.status().as_u16() {
            200 => {}
            401 => return Err("API Key 无效或已过期".to_string()),
            429 => return Err("请求过于频繁，请稍后再试".to_string()),
            code if code >= 500 => return Err(format!("DeepSeek 服务器错误：{code}")),
            code => return Err(format!("请求失败：HTTP {code}")),
        }

        #[derive(Deserialize)]
        struct BalanceInfo {
            currency: String,
            total_balance: String,
            granted_balance: String,
            topped_up_balance: String,
        }
        #[derive(Deserialize)]
        struct BalanceResponse {
            is_available: bool,
            balance_infos: Vec<BalanceInfo>,
        }

        let data: BalanceResponse = response
            .json()
            .await
            .map_err(|error| format!("解析余额数据失败：{error}"))?;

        // 优先取 CNY，其次取第一条（账户可能同时有 CNY/USD 两条余额）
        let mut infos = data.balance_infos;
        if infos.is_empty() {
            return Err("余额信息为空".to_string());
        }
        let index = infos
            .iter()
            .position(|info| info.currency == "CNY")
            .unwrap_or(0);
        let info = infos.swap_remove(index);

        Ok(BalanceResult {
            is_available: data.is_available,
            currency: info.currency,
            total_balance: info.total_balance,
            granted_balance: info.granted_balance,
            topped_up_balance: info.topped_up_balance,
        })
    }

    #[tauri::command]
    fn save_usage_token(usage_token: String) -> Result<AppConfig, String> {
        let value = usage_token.trim().to_string();
        if value.is_empty() {
            return Err("用量 Token 不能为空".to_string());
        }
        let mut config = read_stored_config()?;
        config.usage_token = Some(value);
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn clear_usage_token() -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.usage_token = None;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    const USAGE_TOKEN_TITLE_PREFIX: &str = "DSM_USAGE_TOKEN:";

    fn capture_usage_token(app: &tauri::AppHandle, token: String) -> Result<AppConfig, String> {
        let value = token.trim().to_string();
        if value.is_empty() {
            return Err("用量 Token 为空".to_string());
        }
        let mut config = read_stored_config()?;
        config.usage_token = Some(value);
        write_stored_config(&config)?;
        let app_config = to_app_config(config)?;

        // 标记本次同步已成功，避免 watcher 在窗口关闭后误发"结束等待"事件
        if let Some(flag) = app.try_state::<Arc<AtomicBool>>() {
            flag.store(true, Ordering::SeqCst);
        }

        if let Some(window) = app.get_webview_window("login-sync") {
            let _ = window.close();
        }

        let _ = app.emit("usage-token-captured", &app_config);

        Ok(app_config)
    }

    // 用 token 试调平台用量接口，验证它确实是有效的用量 token。
    async fn verify_usage_token(token: &str, month: u32, year: u32) -> Result<(), String> {
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
        let url =
            format!("https://platform.deepseek.com/api/v0/usage/amount?month={month}&year={year}");
        let resp = http_client()
            .get(&url)
            .bearer_auth(token)
            .header("x-app-version", "1.0.0")
            .header("Accept", "*/*")
            .header("User-Agent", ua)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| format!("验证 token 失败：{error}"))?;
        if resp.status().as_u16() == 200 {
            Ok(())
        } else {
            Err(format!("token 无效：HTTP {}", resp.status().as_u16()))
        }
    }

    fn read_shared_text(path: &Path) -> Option<String> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2 | 0x4)
            .open(path)
            .ok()?;
        let metadata = file.metadata().ok()?;
        if metadata.len() == 0 || metadata.len() > 20 * 1024 * 1024 {
            return None;
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes).ok()?;
        Some(String::from_utf8_lossy(&bytes).replace('\0', ""))
    }

    fn extract_user_api_token(text: &str) -> Option<String> {
        let mut search_from = 0;
        let marker = "\"token\":\"";
        while let Some(relative_index) = text[search_from..].find(marker) {
            let token_start = search_from + relative_index + marker.len();
            let token_end = token_start + text[token_start..].find('"')?;
            let token = &text[token_start..token_end];
            let context_end = (token_end + 1800).min(text.len());
            let context = &text[token_end..context_end];
            if token.len() > 20
                && context.contains("\"id_profile\"")
                && context.contains("\"feature_gates\"")
            {
                return Some(token.to_string());
            }
            search_from = token_end + 1;
        }
        None
    }

    fn find_webview_cached_usage_token() -> Option<String> {
        let local_app_data = std::env::var_os("LOCALAPPDATA")?;
        let cache_dir = PathBuf::from(local_app_data)
            .join("com.deepseek.monitor.windows")
            .join("EBWebView")
            .join("Default")
            .join("Cache")
            .join("Cache_Data");
        let entries = fs::read_dir(cache_dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Some(text) = read_shared_text(&path) {
                if let Some(token) = extract_user_api_token(&text) {
                    return Some(token);
                }
            }
        }
        None
    }

    fn start_usage_title_watcher(app: tauri::AppHandle) {
        thread::spawn(move || {
            // 登录页加载并触发平台 API 请求需要时间，等待后再开始扫缓存
            thread::sleep(Duration::from_secs(3));
            // 500ms 一轮 × 3600 ≈ 30 分钟超时。轮询间隔越短，token 在窗口
            // 标题里的暴露时间越短（读到后立即复原标题）。
            for _ in 0..3600 {
                if let Some(token) = find_webview_cached_usage_token() {
                    let _ = capture_usage_token(&app, token);
                    return;
                }

                let Some(window) = app.get_webview_window("login-sync") else {
                    // 窗口已关闭：若不是因成功捕获而关闭，才通知前端结束等待
                    let captured = app
                        .try_state::<Arc<AtomicBool>>()
                        .map(|flag| flag.load(Ordering::SeqCst))
                        .unwrap_or(false);
                    if !captured {
                        let _ = app.emit("usage-sync-ended", ());
                    }
                    return;
                };

                if let Ok(title) = window.title() {
                    if let Some(rest) = title.strip_prefix(USAGE_TOKEN_TITLE_PREFIX) {
                        // 立即复原标题，尽量缩短 token 在标题栏/任务切换器可见的时间
                        let _ = window.eval("document.title = 'DeepSeek 账号登录';");
                        // 注入脚本写入的格式：{year}:{month}:{token}
                        let mut parts = rest.splitn(3, ':');
                        if let (Some(y), Some(m), Some(tok)) =
                            (parts.next(), parts.next(), parts.next())
                        {
                            if let (Ok(year), Ok(month)) = (y.parse::<u32>(), m.parse::<u32>()) {
                                let token = tok.to_string();
                                // 验证 token 真能调用用量接口，过滤登录中途的临时 token
                                let verified = tauri::async_runtime::block_on(
                                    verify_usage_token(&token, month, year),
                                );
                                if verified.is_ok() {
                                    let _ = capture_usage_token(&app, token);
                                    return;
                                }
                            }
                        }
                    }
                }

                thread::sleep(Duration::from_millis(500));
            }
            // 30 分钟超时，若仍未成功则通知前端结束等待
            let captured = app
                .try_state::<Arc<AtomicBool>>()
                .map(|flag| flag.load(Ordering::SeqCst))
                .unwrap_or(false);
            if !captured {
                let _ = app.emit("usage-sync-ended", ());
            }
        });
    }

    // 在登录窗口注入，hook fetch / XMLHttpRequest，主动从平台 API 请求的
    // Authorization 头里抓 Bearer token，写入 document.title 供原生侧轮询读取。
    // 远程页面不暴露任何 Tauri IPC（capability 已不覆盖 login-sync 窗口），
    // title 是唯一的回传通道，原生侧读到后会立即复原标题。
    const USAGE_SYNC_POLL_JS: &str = r#"
    (function() {
      if (window.__dsm_token_hook__) return;
      window.__dsm_token_hook__ = true;

      function deliver(token) {
        if (!token || typeof token !== 'string') return;
        token = token.trim();
        if (token.length < 20) return;
        var now = new Date();
        var y = now.getFullYear();
        var m = now.getMonth() + 1;
        try { document.title = 'DSM_USAGE_TOKEN:' + y + ':' + m + ':' + token; } catch (e) {}
      }

      function fromAuth(value) {
        if (!value) return;
        var m = /Bearer\s+(\S+)/i.exec(String(value));
        if (m && m[1]) deliver(m[1]);
      }

      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function(input, init) {
          try {
            var headers = (init && init.headers) || (input && input.headers);
            if (headers) {
              if (typeof Headers !== 'undefined' && headers instanceof Headers) {
                fromAuth(headers.get('authorization'));
              } else if (Array.isArray(headers)) {
                for (var i = 0; i < headers.length; i++) {
                  if (headers[i] && String(headers[i][0]).toLowerCase() === 'authorization') {
                    fromAuth(headers[i][1]);
                  }
                }
              } else if (typeof headers === 'object') {
                for (var k in headers) {
                  if (k.toLowerCase() === 'authorization') fromAuth(headers[k]);
                }
              }
            }
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
      }

      var origSet = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        try {
          if (name && String(name).toLowerCase() === 'authorization') fromAuth(value);
        } catch (e) {}
        return origSet.apply(this, arguments);
      };
    })();
    "#;

    #[tauri::command]
    async fn start_usage_sync(app: tauri::AppHandle) -> Result<bool, String> {
        // 重置本次同步的成功标志
        if let Some(flag) = app.try_state::<Arc<AtomicBool>>() {
            flag.store(false, Ordering::SeqCst);
        }

        // 先扫一次缓存：登录完成后重复点击本命令，缓存落盘后即可命中
        if let Some(token) = find_webview_cached_usage_token() {
            capture_usage_token(&app, token)?;
            return Ok(true);
        }

        // 登录窗口已存在：刷新它，促使用量页重新请求接口、把响应写入缓存，
        // 用户随后再点一次本按钮即可命中。不重复弹新窗口、不死等。
        if app.get_webview_window("login-sync").is_some() {
            if let Some(window) = app.get_webview_window("login-sync") {
                let _ = window.eval("location.reload();");
            }
            return Ok(false);
        }

        let url = tauri::WebviewUrl::External("https://platform.deepseek.com".parse().unwrap());
        tauri::WebviewWindowBuilder::new(&app, "login-sync", url)
            .title("DeepSeek 账号登录")
            .inner_size(480.0, 720.0)
            .min_inner_size(360.0, 480.0)
            .resizable(true)
            .center()
            .visible(true)
            .initialization_script(USAGE_SYNC_POLL_JS)
            .on_page_load(|window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished)
                    && payload
                        .url()
                        .host_str()
                        .is_some_and(|host| host == "platform.deepseek.com")
                {
                    // 双保险：万一 initialization_script 未注入，页面加载完再装一次 hook
                    let _ = window.eval(USAGE_SYNC_POLL_JS);
                }
            })
            .build()
            .map_err(|error| format!("打开登录窗口失败：{error}"))?;
        start_usage_title_watcher(app);
        Ok(false)
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UsageModelSummary {
        key: String,
        name: String,
        total_tokens: u64,
        request_count: u64,
        cache_hit_tokens: u64,
        cache_miss_tokens: u64,
        response_tokens: u64,
        cost: f64,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DayModelBreakdown {
        tokens: u64,
        cache_hit: u64,
        cache_miss: u64,
        response: u64,
        cost: f64,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UsageDaySummary {
        date: String,
        total_tokens: u64,
        total_cost: f64,
        models: std::collections::HashMap<String, DayModelBreakdown>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UsageResult {
        models: Vec<UsageModelSummary>,
        days: Vec<UsageDaySummary>,
        month_cost: f64,
    }

    fn model_display_name(model: &str) -> String {
        match model {
            "deepseek-v4-flash" => "V4 Flash".to_string(),
            "deepseek-v4-pro" => "V4 Pro".to_string(),
            "deepseek-chat" => "Chat".to_string(),
            "deepseek-reasoner" => "Reasoner".to_string(),
            other => other.strip_prefix("deepseek-").unwrap_or(other).to_string(),
        }
    }

    fn model_priority(model: &str) -> u8 {
        match model {
            "deepseek-v4-flash" => 0,
            "deepseek-v4-pro" => 1,
            _ => 2,
        }
    }

    // 通过 DeepSeek 平台内部接口拉取用量与费用（需网页登录 token，非官方 API Key）。
    // 动态返回接口中出现的所有模型，不再硬编码 flash/pro。
    async fn load_usage(month: u32, year: u32) -> Result<UsageResult, String> {
        let config = read_stored_config()?;
        let token = config
            .usage_token
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "未配置用量 Token".to_string())?;

        #[derive(Deserialize)]
        struct Entry {
            #[serde(rename = "type")]
            kind: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct ModelUsage {
            model: String,
            usage: Vec<Entry>,
        }
        #[derive(Deserialize)]
        struct DayUsage {
            date: String,
            data: Vec<ModelUsage>,
        }
        #[derive(Deserialize)]
        struct AmountBiz {
            total: Vec<ModelUsage>,
            days: Vec<DayUsage>,
        }
        #[derive(Deserialize)]
        struct AmountData {
            biz_data: AmountBiz,
        }
        #[derive(Deserialize)]
        struct AmountResp {
            data: AmountData,
        }
        #[derive(Deserialize)]
        struct CostBiz {
            total: Vec<ModelUsage>,
            days: Vec<DayUsage>,
        }
        #[derive(Deserialize)]
        struct CostData {
            biz_data: Vec<CostBiz>,
        }
        #[derive(Deserialize)]
        struct CostResp {
            data: CostData,
        }

        async fn get_json<T: serde::de::DeserializeOwned>(
            client: &reqwest::Client,
            url: &str,
            token: &str,
        ) -> Result<T, String> {
            let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                      (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
            let resp = client
                .get(url)
                .bearer_auth(token)
                .header("x-app-version", "1.0.0")
                .header("Accept", "*/*")
                .header("User-Agent", ua)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|error| format!("用量请求失败：{error}"))?;
            match resp.status().as_u16() {
                200 => {}
                401 => return Err("用量 Token 无效或已过期，请重新获取".to_string()),
                429 => return Err("请求过于频繁，请稍后再试".to_string()),
                code => return Err(format!("用量接口错误：HTTP {code}")),
            }
            resp.json::<T>()
                .await
                .map_err(|error| format!("解析用量数据失败：{error}"))
        }

        fn token_breakdown(usage: &[Entry]) -> (u64, u64, u64, u64, u64) {
            // 返回 (总 token, 请求数, 缓存命中, 缓存未命中, 输出 token)
            let mut total = 0u64;
            let mut request = 0u64;
            let mut hit = 0u64;
            let mut miss = 0u64;
            let mut response = 0u64;
            for entry in usage {
                let value = entry.amount.parse::<f64>().unwrap_or(0.0).round() as u64;
                match entry.kind.as_str() {
                    "REQUEST" => request = value,
                    "PROMPT_CACHE_HIT_TOKEN" => {
                        hit = value;
                        total += value;
                    }
                    "PROMPT_CACHE_MISS_TOKEN" => {
                        miss = value;
                        total += value;
                    }
                    "RESPONSE_TOKEN" => {
                        response = value;
                        total += value;
                    }
                    "PROMPT_TOKEN" => total += value,
                    _ => {}
                }
            }
            (total, request, hit, miss, response)
        }

        fn cost_sum(usage: &[Entry]) -> f64 {
            usage
                .iter()
                .filter(|entry| entry.kind != "REQUEST")
                .map(|entry| entry.amount.parse::<f64>().unwrap_or(0.0))
                .sum()
        }

        let client = http_client();
        let amount_url =
            format!("https://platform.deepseek.com/api/v0/usage/amount?month={month}&year={year}");
        let cost_url =
            format!("https://platform.deepseek.com/api/v0/usage/cost?month={month}&year={year}");

        let amount: AmountResp = get_json(client, &amount_url, &token).await?;
        let cost: CostResp = get_json(client, &cost_url, &token).await?;

        let cost_total = cost.data.biz_data.first();
        let cost_for_model = |model: &str| -> f64 {
            cost_total
                .and_then(|item| item.total.iter().find(|m| m.model == model))
                .map(|m| cost_sum(&m.usage))
                .unwrap_or(0.0)
        };

        let mut models = Vec::new();
        for model_usage in &amount.data.biz_data.total {
            let (total, request, hit, miss, response) = token_breakdown(&model_usage.usage);
            models.push(UsageModelSummary {
                key: model_usage.model.clone(),
                name: model_display_name(&model_usage.model),
                total_tokens: total,
                request_count: request,
                cache_hit_tokens: hit,
                cache_miss_tokens: miss,
                response_tokens: response,
                cost: cost_for_model(&model_usage.model),
            });
        }
        models.sort_by(|a, b| {
            model_priority(&a.key).cmp(&model_priority(&b.key)).then(
                b.cost
                    .partial_cmp(&a.cost)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
        });

        // (日期, 模型) -> 当日该模型费用；日期 -> 当日总费用
        let mut cost_by_date: std::collections::HashMap<String, f64> =
            std::collections::HashMap::new();
        let mut cost_by_date_model: std::collections::HashMap<(String, String), f64> =
            std::collections::HashMap::new();
        if let Some(item) = cost_total {
            for day in &item.days {
                let mut day_cost = 0.0;
                for model_usage in &day.data {
                    let value = cost_sum(&model_usage.usage);
                    day_cost += value;
                    cost_by_date_model
                        .insert((day.date.clone(), model_usage.model.clone()), value);
                }
                cost_by_date.insert(day.date.clone(), day_cost);
            }
        }

        let mut days = Vec::new();
        for day in &amount.data.biz_data.days {
            let mut total = 0u64;
            let mut day_models = std::collections::HashMap::new();
            for model_usage in &day.data {
                let (tokens, _, hit, miss, response) = token_breakdown(&model_usage.usage);
                total += tokens;
                day_models.insert(
                    model_usage.model.clone(),
                    DayModelBreakdown {
                        tokens,
                        cache_hit: hit,
                        cache_miss: miss,
                        response,
                        cost: cost_by_date_model
                            .get(&(day.date.clone(), model_usage.model.clone()))
                            .copied()
                            .unwrap_or(0.0),
                    },
                );
            }
            days.push(UsageDaySummary {
                date: day.date.clone(),
                total_tokens: total,
                total_cost: cost_by_date.get(&day.date).copied().unwrap_or(0.0),
                models: day_models,
            });
        }

        let month_cost: f64 = cost_total
            .map(|item| item.total.iter().map(|m| cost_sum(&m.usage)).sum())
            .unwrap_or(0.0);

        Ok(UsageResult {
            models,
            days,
            month_cost,
        })
    }

    #[tauri::command]
    async fn fetch_usage(month: u32, year: u32) -> Result<UsageResult, String> {
        load_usage(month, year).await
    }

    // 导出指定月份的逐日逐模型用量到 CSV（带 BOM，Excel 可直接打开中文）。
    #[tauri::command]
    async fn export_usage_csv(month: u32, year: u32) -> Result<String, String> {
        let usage = load_usage(month, year).await?;
        let mut csv =
            String::from("\u{FEFF}日期,模型,总Tokens,缓存命中,缓存未命中,输出Tokens,费用(元)\n");
        for day in &usage.days {
            let mut keys: Vec<&String> = day.models.keys().collect();
            keys.sort();
            for key in keys {
                let m = &day.models[key];
                csv.push_str(&format!(
                    "{},{},{},{},{},{},{:.4}\n",
                    day.date, key, m.tokens, m.cache_hit, m.cache_miss, m.response, m.cost
                ));
            }
        }
        for model in &usage.models {
            csv.push_str(&format!(
                "本月合计,{},{},{},{},{},{:.4}\n",
                model.key,
                model.total_tokens,
                model.cache_hit_tokens,
                model.cache_miss_tokens,
                model.response_tokens,
                model.cost
            ));
        }

        let home = std::env::var_os("USERPROFILE").ok_or("USERPROFILE 不可用")?;
        let dir = PathBuf::from(home).join("Downloads");
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let path = dir.join(format!("deepseek-usage-{year}-{month:02}.csv"));
        fs::write(&path, csv).map_err(|error| format!("写入 CSV 失败：{error}"))?;
        Ok(path.to_string_lossy().to_string())
    }

    // 发送 Windows 系统通知（低余额、超预算提醒由前端判断后调用）。
    #[tauri::command]
    fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }

    struct TrayHandle(Mutex<Option<TrayIcon>>);

    // 更新托盘图标悬停提示（余额/今日消耗），让用户不开窗口也能看到概况。
    #[tauri::command]
    fn set_tray_tooltip(state: tauri::State<'_, TrayHandle>, text: String) -> Result<(), String> {
        let guard = state.0.lock().map_err(|_| "托盘状态不可用".to_string())?;
        if let Some(tray) = guard.as_ref() {
            tray.set_tooltip(Some(text.as_str()))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    tauri::Builder::default()
        // 单实例守卫：必须作为第一个注册的插件。
        // 程序已运行时再次启动 exe，第二个进程不会新开窗口，
        // 而是触发此回调把已有主窗口显示并聚焦，随后第二个进程自行退出。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                show_main_window(&window);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            hide_main_window,
            get_app_config,
            save_api_key,
            clear_api_key,
            save_refresh_interval,
            save_auto_refresh_enabled,
            save_alert_settings,
            save_hide_on_blur,
            save_autostart,
            fetch_balance,
            save_usage_token,
            clear_usage_token,
            fetch_usage,
            export_usage_csv,
            start_usage_sync,
            set_tray_tooltip,
            notify
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let show_item = MenuItem::with_id(app, "show", "显示主面板", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("DeepSeek Monitor")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_main_window(&window);
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 仅在左键“抬起”时切换；否则按下+抬起各触发一次，窗口会闪现后立即隐藏
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            if is_visible {
                                let _ = window.hide();
                            } else {
                                show_main_window(&window);
                            }
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let tray = tray_builder.build(app)?;
            app.manage(TrayHandle(Mutex::new(Some(tray))));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
