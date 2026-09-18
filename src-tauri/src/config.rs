use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const APP_DIR_NAME: &str = "ally-launcher";
const RECENT_LIMIT: usize = 30;
pub const BRAND_NAME_MAX: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub games_folder: String,
    pub steam_grid_db_api_key: String,
    pub launch_on_startup: bool,
    pub theme: String,
    #[serde(default = "default_brand_name")]
    pub brand_name: String,
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(default)]
    pub cover_map: std::collections::HashMap<String, String>,
}

fn default_brand_name() -> String {
    "Alan".into()
}

/// Trim, cap at 12 chars, fall back to "Alan" if empty.
pub fn sanitize_brand_name(raw: &str) -> String {
    let limited: String = raw.trim().chars().take(BRAND_NAME_MAX).collect();
    let limited = limited.trim().to_string();
    if limited.is_empty() {
        default_brand_name()
    } else {
        limited
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            games_folder: default_games_folder().to_string_lossy().to_string(),
            steam_grid_db_api_key: String::new(),
            launch_on_startup: false,
            theme: "default".into(),
            brand_name: default_brand_name(),
            favorites: Vec::new(),
            recent: Vec::new(),
            cover_map: std::collections::HashMap::new(),
        }
    }
}

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR_NAME)
}

pub fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

fn config_backup_path() -> PathBuf {
    app_data_dir().join("config.json.bak")
}

fn config_tmp_path() -> PathBuf {
    app_data_dir().join("config.json.tmp")
}

/// Preferred location. Older builds used `cache/covers`, which disk cleaners often wipe.
pub fn covers_dir() -> PathBuf {
    app_data_dir().join("covers")
}

fn legacy_covers_dir() -> PathBuf {
    app_data_dir().join("cache").join("covers")
}

/// Cached PNGs of shortcut-associated icons (used for no-art placeholders).
pub fn icons_dir() -> PathBuf {
    app_data_dir().join("icons")
}

pub fn themes_dir() -> PathBuf {
    app_data_dir().join("themes")
}

pub fn default_games_folder() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AllyLauncher")
        .join("Games")
}

pub fn ensure_dirs(config: &AppConfig) -> Result<(), String> {
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    fs::create_dir_all(covers_dir()).map_err(|e| e.to_string())?;
    fs::create_dir_all(icons_dir()).map_err(|e| e.to_string())?;
    fs::create_dir_all(themes_dir()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&config.games_folder).map_err(|e| e.to_string())?;
    Ok(())
}

fn try_load_config(path: &Path) -> Option<AppConfig> {
    let raw = fs::read_to_string(path).ok()?;
    let mut cfg: AppConfig = serde_json::from_str(&raw).ok()?;
    if cfg.games_folder.trim().is_empty() {
        cfg.games_folder = default_games_folder().to_string_lossy().to_string();
    }
    cfg.brand_name = sanitize_brand_name(&cfg.brand_name);
    Some(cfg)
}

/// Move covers out of `cache/` (cleaner bait) and rewrite coverMap paths that still point there.
fn migrate_covers(config: &mut AppConfig) -> bool {
    let legacy = legacy_covers_dir();
    let dest = covers_dir();
    let mut changed = false;

    if legacy.exists() {
        let _ = fs::create_dir_all(&dest);
        if let Ok(entries) = fs::read_dir(&legacy) {
            for entry in entries.flatten() {
                let from = entry.path();
                if !from.is_file() {
                    continue;
                }
                let Some(name) = from.file_name() else {
                    continue;
                };
                let to = dest.join(name);
                if !to.exists() {
                    match fs::rename(&from, &to) {
                        Ok(()) => changed = true,
                        Err(_) => {
                            if fs::copy(&from, &to).is_ok() {
                                let _ = fs::remove_file(&from);
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
        // Best-effort cleanup of empty legacy dirs.
        let _ = fs::remove_dir(&legacy);
        let _ = fs::remove_dir(app_data_dir().join("cache"));
    }

    let mut remapped = std::collections::HashMap::new();
    for (shortcut, cover) in config.cover_map.drain() {
        let cover_path = PathBuf::from(&cover);
        let file_name = cover_path.file_name().map(|n| n.to_owned());
        let under_legacy = cover_path.starts_with(&legacy)
            || cover_path
                .parent()
                .is_some_and(|p| path_eq_ignore_case(p, &legacy));

        if under_legacy {
            if let Some(name) = file_name {
                remapped.insert(shortcut, dest.join(name).to_string_lossy().to_string());
                changed = true;
                continue;
            }
        }
        remapped.insert(shortcut, cover);
    }
    config.cover_map = remapped;

    changed
}

fn path_eq_ignore_case(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    let backup = config_backup_path();
    let tmp = config_tmp_path();

    for (candidate, label) in [(&path, "config"), (&backup, "backup"), (&tmp, "tmp")] {
        if let Some(mut cfg) = try_load_config(candidate) {
            let _ = ensure_dirs(&cfg);
            let migrated = migrate_covers(&mut cfg);
            if label != "config" || migrated {
                eprintln!(
                    "ally-launcher: restored config from {label}{}",
                    if migrated { " (migrated covers)" } else { "" }
                );
                let _ = save_config(&cfg);
            }
            return cfg;
        }
    }

    if path.exists() {
        let corrupt = app_data_dir().join("config.json.corrupt");
        let _ = fs::rename(&path, &corrupt);
        eprintln!(
            "ally-launcher: config.json was unreadable; quarantined as config.json.corrupt and starting fresh"
        );
    }

    let mut cfg = AppConfig::default();
    let _ = ensure_dirs(&cfg);
    let _ = migrate_covers(&mut cfg);
    let _ = save_config(&cfg);
    cfg
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    // On Windows, rename cannot replace an existing destination.
    if to.exists() {
        fs::remove_file(to).map_err(|e| e.to_string())?;
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    ensure_dirs(config)?;
    let path = config_path();
    let tmp = config_tmp_path();
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;

    fs::write(&tmp, &raw).map_err(|e| e.to_string())?;

    // Keep last known-good copy before replacing the primary file.
    if path.exists() && try_load_config(&path).is_some() {
        let _ = fs::copy(&path, config_backup_path());
    }

    replace_file(&tmp, &path)?;
    Ok(())
}

pub fn push_recent(config: &mut AppConfig, path: &str) {
    config.recent.retain(|p| p != path);
    config.recent.insert(0, path.to_string());
    if config.recent.len() > RECENT_LIMIT {
        config.recent.truncate(RECENT_LIMIT);
    }
}

pub fn toggle_favorite(config: &mut AppConfig, path: &str) -> bool {
    if let Some(idx) = config.favorites.iter().position(|p| p == path) {
        config.favorites.remove(idx);
        false
    } else {
        config.favorites.push(path.to_string());
        true
    }
}

pub fn set_cover_mapping(config: &mut AppConfig, shortcut: &str, cover_path: &Path) {
    config
        .cover_map
        .insert(shortcut.to_string(), cover_path.to_string_lossy().to_string());
}
