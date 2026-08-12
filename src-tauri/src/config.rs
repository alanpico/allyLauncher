use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const APP_DIR_NAME: &str = "ally-launcher";
const RECENT_LIMIT: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub games_folder: String,
    pub steam_grid_db_api_key: String,
    pub launch_on_startup: bool,
    pub theme: String,
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(default)]
    pub cover_map: std::collections::HashMap<String, String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            games_folder: default_games_folder().to_string_lossy().to_string(),
            steam_grid_db_api_key: String::new(),
            launch_on_startup: false,
            theme: "default".into(),
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

pub fn covers_dir() -> PathBuf {
    app_data_dir().join("cache").join("covers")
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
    fs::create_dir_all(themes_dir()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&config.games_folder).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<AppConfig>(&raw) {
                Ok(mut cfg) => {
                    if cfg.games_folder.trim().is_empty() {
                        cfg.games_folder = default_games_folder().to_string_lossy().to_string();
                    }
                    let _ = ensure_dirs(&cfg);
                    return cfg;
                }
                Err(_) => {}
            },
            Err(_) => {}
        }
    }

    let cfg = AppConfig::default();
    let _ = ensure_dirs(&cfg);
    let _ = save_config(&cfg);
    cfg
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    ensure_dirs(config)?;
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_path(), raw).map_err(|e| e.to_string())
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
