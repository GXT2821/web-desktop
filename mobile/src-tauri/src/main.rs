// Windows 端不需要控制台窗口；Android 用不到这个入口，但 Tauri 要求有 main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    docvault_mobile_lib::run()
}