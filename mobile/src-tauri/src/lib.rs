// Android 端入口：只做三件事 —— 打开外部浏览器、加载前端、把配置带上
//
// 桌面端用 Electron 的 BrowserWindow + webview 做内嵌浏览；Android 上第三方网页
// 没法内嵌（X-Frame-Options / CSP 会拦），所以文档统一交给系统浏览器打开，
// 登录态也就留在浏览器里，不会丢。

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// 打开一个 http/https 链接（交给系统浏览器）
///
/// 只放行 http/https：这个命令是前端唯一能触发"离开应用"的入口，
/// 放宽到任意 scheme 就等于把 Intent 的调用权交给了页面内容。
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("只支持 http/https 链接".into());
    }
    app.opener()
        .open_url(trimmed.to_string(), None::<&str>)
        .map_err(|err| format!("打开链接失败：{err}"))
}

/// 应用版本号（来自 Cargo.toml），界面底部的 "v1.2.0" 用它
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_url, app_version])
        .setup(|app| {
            // Android 上系统返回键默认会直接退出应用，这里保留默认行为；
            // 只是为了将来要拦截时有个明确的入口。
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}