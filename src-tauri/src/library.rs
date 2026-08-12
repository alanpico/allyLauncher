use serde::Serialize;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEntry {
    pub id: String,
    pub title: String,
    pub path: String,
    pub folder: String,
    pub extension: String,
    pub cover_path: Option<String>,
    pub favorite: bool,
}

pub fn scan_games(
    root: &Path,
    favorites: &[String],
    cover_map: &std::collections::HashMap<String, String>,
) -> Result<Vec<GameEntry>, String> {
    if !root.exists() {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    }

    let mut games = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "lnk" && ext != "url" {
            continue;
        }

        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();

        let folder = relative_folder(root, path);
        let path_str = path.to_string_lossy().to_string();
        let cover_path = cover_map.get(&path_str).cloned().filter(|p| Path::new(p).exists());

        games.push(GameEntry {
            id: path_str.clone(),
            title,
            path: path_str.clone(),
            folder,
            extension: ext,
            cover_path,
            favorite: favorites.iter().any(|f| f == &path_str),
        });
    }

    games.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(games)
}

fn relative_folder(root: &Path, file: &Path) -> String {
    let parent = file.parent().unwrap_or(root);
    match parent.strip_prefix(root) {
        Ok(rel) if rel.as_os_str().is_empty() => String::new(),
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => String::new(),
    }
}

pub fn list_folders(games: &[GameEntry]) -> Vec<String> {
    let mut folders: Vec<String> = games
        .iter()
        .map(|g| g.folder.clone())
        .filter(|f| !f.is_empty())
        .collect();
    folders.sort();
    folders.dedup();
    folders
}
