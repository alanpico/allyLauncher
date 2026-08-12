use std::path::Path;
use std::process::Command;

pub fn launch_shortcut(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("Shortcut not found: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        // `start` opens .lnk / .url with the associated handler.
        let status = Command::new("cmd")
            .args(["/C", "start", "", path])
            .spawn()
            .map_err(|e| e.to_string())?;
        let _ = status;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        open::that(path).map_err(|e| e.to_string())
    }
}
