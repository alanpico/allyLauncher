use std::path::Path;

pub fn launch_shortcut(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("Shortcut not found: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let wide: Vec<u16> = p
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let open: Vec<u16> = "open\0".encode_utf16().collect();

        // ShellExecute opens .lnk / .url without spawning a visible console.
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(open.as_ptr()),
                PCWSTR(wide.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if (result.0 as usize) <= 32 {
            return Err(format!("Failed to launch shortcut (code {})", result.0 as usize));
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        open::that(path).map_err(|e| e.to_string())
    }
}
