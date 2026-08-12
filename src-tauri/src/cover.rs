use crate::config::{covers_dir, set_cover_mapping, AppConfig};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct SearchResponse {
    success: bool,
    data: Option<Vec<SearchItem>>,
}

#[derive(Debug, Deserialize)]
struct SearchItem {
    id: u64,
    name: String,
}

#[derive(Debug, Deserialize)]
struct GridsResponse {
    success: bool,
    data: Option<Vec<GridItem>>,
}

#[derive(Debug, Deserialize)]
struct GridItem {
    url: String,
    #[serde(default)]
    score: i64,
}

pub fn resolve_cover(config: &mut AppConfig, title: &str, shortcut_path: &str) -> Option<PathBuf> {
    if let Some(existing) = config.cover_map.get(shortcut_path) {
        let path = PathBuf::from(existing);
        if path.exists() {
            return Some(path);
        }
    }

    if config.steam_grid_db_api_key.trim().is_empty() {
        return None;
    }

    match fetch_and_cache(config, title, shortcut_path) {
        Ok(path) => Some(path),
        Err(_) => None,
    }
}

fn fetch_and_cache(
    config: &mut AppConfig,
    title: &str,
    shortcut_path: &str,
) -> Result<PathBuf, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("AlanGamesLauncher/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let key = config.steam_grid_db_api_key.trim();
    let search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        urlencoding::encode(title)
    );

    let search: SearchResponse = client
        .get(&search_url)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    if !search.success {
        return Err("SteamGridDB search failed".into());
    }

    let game_id = search
        .data
        .as_ref()
        .and_then(|items| {
            items
                .iter()
                .find(|i| i.name.eq_ignore_ascii_case(title))
                .or_else(|| items.first())
        })
        .map(|i| i.id)
        .ok_or_else(|| "No SteamGridDB match".to_string())?;

    let grids_url = format!(
        "https://www.steamgriddb.com/api/v2/grids/game/{}?dimensions=600x900&types=static",
        game_id
    );

    let grids: GridsResponse = client
        .get(&grids_url)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    if !grids.success {
        return Err("SteamGridDB grids failed".into());
    }

    let mut items = grids.data.unwrap_or_default();
    items.sort_by(|a, b| b.score.cmp(&a.score));
    let grid = items
        .first()
        .ok_or_else(|| "No grid art found".to_string())?;

    let bytes = client
        .get(&grid.url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;

    let ext = extension_from_url(&grid.url);
    let hash = {
        let mut hasher = Sha256::new();
        hasher.update(shortcut_path.as_bytes());
        hex::encode(hasher.finalize())
    };
    let filename = format!("{}_{}.{}", game_id, &hash[..12], ext);
    let out = covers_dir().join(filename);
    fs::create_dir_all(covers_dir()).map_err(|e| e.to_string())?;
    fs::write(&out, &bytes).map_err(|e| e.to_string())?;

    set_cover_mapping(config, shortcut_path, &out);
    crate::config::save_config(config)?;
    Ok(out)
}

fn extension_from_url(url: &str) -> &'static str {
    let lower = url.to_ascii_lowercase();
    if lower.contains(".webp") {
        "webp"
    } else if lower.contains(".jpg") || lower.contains(".jpeg") {
        "jpg"
    } else {
        "png"
    }
}

pub fn ensure_covers_for_missing(config: &mut AppConfig, games: &mut [crate::library::GameEntry]) {
    for game in games.iter_mut() {
        if game.cover_path.is_some() {
            continue;
        }
        if let Some(path) = resolve_cover(config, &game.title, &game.path) {
            game.cover_path = Some(path.to_string_lossy().to_string());
        }
    }
}
