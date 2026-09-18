use std::fs;
use std::path::PathBuf;

const RUN_VALUE_NAME: &str = "AlanGamesLauncher";

pub fn is_launch_on_startup() -> bool {
    #[cfg(target_os = "windows")]
    {
        startup_shortcut_path().map(|p| p.exists()).unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

pub fn set_launch_on_startup(enabled: bool, exe_path: &str) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let shortcut = startup_shortcut_path()?;
        if enabled {
            create_startup_shortcut(&shortcut, exe_path)?;
        } else if shortcut.exists() {
            fs::remove_file(&shortcut).map_err(|e| e.to_string())?;
        }
        // Keep Run key in sync as a secondary mechanism.
        set_run_key(enabled, exe_path)?;
        Ok(enabled)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (enabled, exe_path);
        Err("Startup toggle is only supported on Windows".into())
    }
}

#[cfg(target_os = "windows")]
fn startup_shortcut_path() -> Result<PathBuf, String> {
    let appdata = dirs::data_dir().ok_or_else(|| "No APPDATA".to_string())?;
    // Roaming\Microsoft\Windows\Start Menu\Programs\Startup
    // data_dir on Windows is Roaming
    Ok(appdata
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup")
        .join("Alan Games Launcher.lnk"))
}

#[cfg(target_os = "windows")]
fn create_startup_shortcut(shortcut: &PathBuf, exe_path: &str) -> Result<(), String> {
    if let Some(parent) = shortcut.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Use PowerShell to create a .lnk without extra crates — hidden window.
    let ps = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $s = $ws.CreateShortcut('{}'); \
         $s.TargetPath = '{}'; \
         $s.WorkingDirectory = '{}'; \
         $s.Save()",
        escape_ps(shortcut.to_string_lossy().as_ref()),
        escape_ps(exe_path),
        escape_ps(
            PathBuf::from(exe_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
                .as_str()
        )
    );

    run_powershell_hidden(&ps)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_run_key(enabled: bool, exe_path: &str) -> Result<(), String> {
    let ps = if enabled {
        format!(
            "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' \
             -Name '{}' -Value '\"{}\"' -PropertyType String -Force | Out-Null",
            RUN_VALUE_NAME,
            escape_ps(exe_path)
        )
    } else {
        format!(
            "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' \
             -Name '{}' -ErrorAction SilentlyContinue",
            RUN_VALUE_NAME
        )
    };

    run_powershell_hidden(&ps)
}

#[cfg(target_os = "windows")]
fn run_powershell_hidden(script: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "PowerShell failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn escape_ps(s: &str) -> String {
    s.replace('\'', "''")
}
