mod config;
mod cover;
mod icon;
mod launch;
mod library;
mod startup;

use config::{
    ensure_dirs, load_config, sanitize_brand_name, save_config, themes_dir, toggle_favorite,
    AppConfig,
};
use library::{list_folders, scan_games, GameEntry};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub games: Mutex<Vec<GameEntry>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub games: Vec<GameEntry>,
    pub folders: Vec<String>,
    pub favorites: Vec<String>,
    pub recent: Vec<String>,
    pub games_folder: String,
    pub launch_on_startup: bool,
    pub theme: String,
    pub themes: Vec<String>,
    pub brand_name: String,
    pub has_api_key: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub games_folder: String,
    pub launch_on_startup: bool,
    pub theme: String,
    pub themes: Vec<String>,
    pub brand_name: String,
    pub has_api_key: bool,
    pub steam_grid_db_api_key_set: bool,
}

const BUILTIN_THEMES: &[&str] = &["default", "ornate-grid", "hero-deck"];

fn list_theme_names() -> Vec<String> {
    let mut names: Vec<String> = BUILTIN_THEMES.iter().map(|s| (*s).to_string()).collect();
    if let Ok(entries) = std::fs::read_dir(themes_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("css") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    names.push(stem.to_string());
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

fn is_builtin_theme(name: &str) -> bool {
    BUILTIN_THEMES.iter().any(|t| *t == name)
}

fn snapshot_from(config: &AppConfig, games: &[GameEntry]) -> LibrarySnapshot {
    LibrarySnapshot {
        folders: list_folders(games),
        games: games.to_vec(),
        favorites: config.favorites.clone(),
        recent: config.recent.clone(),
        games_folder: config.games_folder.clone(),
        launch_on_startup: config.launch_on_startup,
        theme: config.theme.clone(),
        themes: list_theme_names(),
        brand_name: config.brand_name.clone(),
        has_api_key: !config.steam_grid_db_api_key.trim().is_empty(),
    }
}

fn refresh_library(state: &AppState) -> Result<LibrarySnapshot, String> {
    let config = state.config.lock();
    ensure_dirs(&config)?;
    let games = scan_games(
        &PathBuf::from(&config.games_folder),
        &config.favorites,
        &config.cover_map,
    )?;
    *state.games.lock() = games.clone();
    Ok(snapshot_from(&config, &games))
}

fn emit_library(app: &AppHandle, snap: &LibrarySnapshot) {
    let _ = app.emit("library-updated", snap);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn get_library(state: State<'_, AppState>) -> Result<LibrarySnapshot, String> {
    refresh_library(&state)
}

#[tauri::command]
fn launch_game(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    launch::launch_shortcut(&path)?;
    {
        let mut config = state.config.lock();
        config::push_recent(&mut config, &path);
        save_config(&config)?;
    }
    hide_main_window(&app);
    let snap = refresh_library(&state)?;
    emit_library(&app, &snap);
    Ok(())
}

#[tauri::command]
fn toggle_favorite_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<LibrarySnapshot, String> {
    {
        let mut config = state.config.lock();
        toggle_favorite(&mut config, &path);
        save_config(&config)?;
    }
    let snap = refresh_library(&state)?;
    emit_library(&app, &snap);
    Ok(snap)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let config = state.config.lock();
    Ok(SettingsView {
        games_folder: config.games_folder.clone(),
        launch_on_startup: startup::is_launch_on_startup(),
        theme: config.theme.clone(),
        themes: list_theme_names(),
        brand_name: config.brand_name.clone(),
        has_api_key: !config.steam_grid_db_api_key.trim().is_empty(),
        steam_grid_db_api_key_set: !config.steam_grid_db_api_key.trim().is_empty(),
    })
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    games_folder: Option<String>,
    launch_on_startup: Option<bool>,
    theme: Option<String>,
    brand_name: Option<String>,
    steam_grid_db_api_key: Option<String>,
) -> Result<SettingsView, String> {
    {
        let mut config = state.config.lock();
        if let Some(folder) = games_folder {
            if !folder.trim().is_empty() {
                config.games_folder = folder;
            }
        }
        if let Some(theme_name) = theme {
            config.theme = theme_name;
        }
        if let Some(name) = brand_name {
            config.brand_name = sanitize_brand_name(&name);
        }
        if let Some(key) = steam_grid_db_api_key {
            config.steam_grid_db_api_key = key.trim().to_string();
        }
        if let Some(enabled) = launch_on_startup {
            // Only touch startup registration when the value actually changes —
            // otherwise saving brand/theme alone would flash PowerShell windows.
            if enabled != config.launch_on_startup {
                let exe = std::env::current_exe()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                startup::set_launch_on_startup(enabled, &exe)?;
                config.launch_on_startup = enabled;
            }
        }
        ensure_dirs(&config)?;
        save_config(&config)?;
    }

    let snap = refresh_library(&state)?;
    emit_library(&app, &snap);
    get_settings(state)
}

#[tauri::command]
fn fetch_missing_covers(app: AppHandle, state: State<'_, AppState>) -> Result<LibrarySnapshot, String> {
    {
        let mut config = state.config.lock();
        let mut games = state.games.lock();
        cover::ensure_covers_for_missing(&mut config, &mut games);
    }
    let snap = refresh_library(&state)?;
    emit_library(&app, &snap);
    Ok(snap)
}

#[tauri::command]
fn get_theme_css(name: String) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let path = themes_dir().join(format!("{}.css", trimmed));
    if path.exists() {
        return std::fs::read_to_string(path).map_err(|e| e.to_string());
    }
    // Built-in layout themes ship their styles in the app CSS via data-layout.
    if is_builtin_theme(trimmed) {
        return Ok(String::new());
    }
    Err(format!("Theme not found: {}", trimmed))
}

#[tauri::command]
fn open_games_folder(state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.lock();
    ensure_dirs(&config)?;
    open::that(&config.games_folder).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_themes_folder() -> Result<(), String> {
    let dir = themes_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open::that(dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_cover_data_url(path: String) -> Result<String, String> {
    let cover_root = config::covers_dir()
        .canonicalize()
        .unwrap_or_else(|_| config::covers_dir());
    let requested = PathBuf::from(&path);
    let canon = requested
        .canonicalize()
        .map_err(|_| "Cover not found".to_string())?;
    if !canon.starts_with(&cover_root) {
        return Err("Cover path not allowed".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    let mime = match canon
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    use base64::Engine;
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn get_icon_data_url(path: String) -> Result<String, String> {
    // Only serve icons that were already generated (settings action) — never extract here.
    let icon_root = config::icons_dir()
        .canonicalize()
        .unwrap_or_else(|_| config::icons_dir());
    let requested = PathBuf::from(&path);
    let canon = requested
        .canonicalize()
        .map_err(|_| "Icon not found".to_string())?;
    if !canon.starts_with(&icon_root) {
        return Err("Icon path not allowed".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    use base64::Engine;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceholderGenerateResult {
    generated: u32,
    failed: u32,
    snapshot: LibrarySnapshot,
}

#[tauri::command]
fn generate_placeholder_cards(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PlaceholderGenerateResult, String> {
    let games = state.games.lock().clone();
    let mut generated = 0u32;
    let mut failed = 0u32;

    icon::clear_failure_cache();
    for game in &games {
        if game.cover_path.is_some() {
            continue;
        }
        let path = PathBuf::from(&game.path);
        match icon::ensure_icon(&path) {
            Ok(_) => generated += 1,
            Err(_) => failed += 1,
        }
    }

    let snap = refresh_library(&state)?;
    emit_library(&app, &snap);
    Ok(PlaceholderGenerateResult {
        generated,
        failed,
        snapshot: snap,
    })
}

#[tauri::command]
fn show_window(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    hide_main_window(&app);
    Ok(())
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &settings_i, &quit_i])?;

    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Alan Games Launcher")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                show_main_window(app);
                let _ = app.emit("open-settings", false);
            }
            "settings" => {
                show_main_window(app);
                let _ = app.emit("open-settings", true);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn start_folder_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel::<DebounceEventResult>();
        let mut debouncer = match new_debouncer(Duration::from_millis(400), tx) {
            Ok(d) => d,
            Err(_) => return,
        };

        let mut watched = String::new();
        loop {
            let folder = {
                let state = app.state::<AppState>();
                let folder = state.config.lock().games_folder.clone();
                folder
            };

            if folder != watched {
                if !watched.is_empty() {
                    let _ = debouncer.watcher().unwatch(std::path::Path::new(&watched));
                }
                if std::path::Path::new(&folder).exists()
                    || std::fs::create_dir_all(&folder).is_ok()
                {
                    let _ = debouncer.watcher().watch(
                        std::path::Path::new(&folder),
                        notify::RecursiveMode::Recursive,
                    );
                    watched = folder;
                    let state = app.state::<AppState>();
                    if let Ok(snap) = refresh_library(&state) {
                        emit_library(&app, &snap);
                    }
                }
            }

            while let Ok(events) = rx.try_recv() {
                if events.is_ok() {
                    let state = app.state::<AppState>();
                    if let Ok(snap) = refresh_library(&state) {
                        emit_library(&app, &snap);
                    }
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        let state = app2.state::<AppState>();
                        {
                            let mut config = state.config.lock();
                            let mut games = state.games.lock();
                            cover::ensure_covers_for_missing(&mut config, &mut games);
                        }
                        if let Ok(snap) = refresh_library(&state) {
                            emit_library(&app2, &snap);
                        }
                    });
                }
            }

            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = load_config();
    let _ = ensure_dirs(&config);
    let games = scan_games(
        &PathBuf::from(&config.games_folder),
        &config.favorites,
        &config.cover_map,
    )
    .unwrap_or_default();

    let state = AppState {
        config: Mutex::new(config),
        games: Mutex::new(games),
    };

    let mut builder = tauri::Builder::default();
    // Must be registered first so a second launch is blocked before other setup runs.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_library,
            launch_game,
            toggle_favorite_cmd,
            get_settings,
            update_settings,
            fetch_missing_covers,
            get_theme_css,
            open_games_folder,
            open_themes_folder,
            get_cover_data_url,
            get_icon_data_url,
            generate_placeholder_cards,
            show_window,
            hide_window
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
            start_folder_watcher(app.handle().clone());

            let app2 = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                let state = app2.state::<AppState>();
                {
                    let mut config = state.config.lock();
                    let mut games = state.games.lock();
                    cover::ensure_covers_for_missing(&mut config, &mut games);
                }
                if let Ok(snap) = refresh_library(&state) {
                    emit_library(&app2, &snap);
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
