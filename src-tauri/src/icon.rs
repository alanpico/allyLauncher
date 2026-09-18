use crate::config::icons_dir;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Bump when icon extraction semantics change.
const ICON_CACHE_VERSION: &str = "v3";

static FAILED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn cache_path_for(shortcut_path: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(ICON_CACHE_VERSION.as_bytes());
    hasher.update(shortcut_path.as_bytes());
    let hash = hex::encode(hasher.finalize());
    icons_dir().join(format!("{}_{}.png", ICON_CACHE_VERSION, &hash[..16]))
}

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn remember_failure(key: &str) {
    if let Ok(mut failed) = FAILED.lock() {
        if !failed.iter().any(|k| k == key) {
            failed.push(key.to_string());
        }
    }
}

fn known_failure(key: &str) -> bool {
    FAILED
        .lock()
        .map(|failed| failed.iter().any(|k| k == key))
        .unwrap_or(false)
}

fn clear_failure(key: &str) {
    if let Ok(mut failed) = FAILED.lock() {
        failed.retain(|k| k != key);
    }
}

pub fn clear_failure_cache() {
    if let Ok(mut failed) = FAILED.lock() {
        failed.clear();
    }
}

/// Return a previously generated icon cache path, if present and still fresh.
pub fn cached_icon(shortcut: &Path) -> Option<PathBuf> {
    let key = shortcut.to_string_lossy().to_string();
    let out = cache_path_for(&key);
    if !out.exists() {
        return None;
    }
    match (mtime(shortcut), mtime(&out)) {
        (Some(src), Some(cached)) if src > cached => None,
        _ => Some(out),
    }
}

/// Extract the Windows shell-associated icon for a shortcut into the icons cache.
pub fn ensure_icon(shortcut: &Path) -> Result<PathBuf, String> {
    if !shortcut.exists() {
        return Err("Shortcut not found".into());
    }

    let key = shortcut.to_string_lossy().to_string();
    if let Some(existing) = cached_icon(shortcut) {
        return Ok(existing);
    }
    if known_failure(&key) {
        return Err("Icon extraction previously failed".into());
    }

    let out = cache_path_for(&key);
    fs::create_dir_all(icons_dir()).map_err(|e| e.to_string())?;

    match extract_associated_icon(shortcut, &out) {
        Ok(()) if out.exists() => {
            clear_failure(&key);
            Ok(out)
        }
        Ok(()) => {
            remember_failure(&key);
            Err("Icon extraction produced no file".into())
        }
        Err(e) => {
            remember_failure(&key);
            let _ = fs::remove_file(&out);
            Err(e)
        }
    }
}

/// Shell icon for the shortcut (includes the Windows shortcut overlay arrow).
#[cfg(target_os = "windows")]
fn extract_associated_icon(shortcut: &Path, dest: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL};

    const SIZE: i32 = 64;

    let wide: Vec<u16> = shortcut
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut shfi = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            Default::default(),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 || shfi.hIcon.is_invalid() {
        return Err("SHGetFileInfo returned no icon".into());
    }

    let hicon = shfi.hIcon;
    let result = (|| -> Result<(), String> {
        unsafe {
            let screen_dc = GetDC(Some(HWND::default()));
            if screen_dc.is_invalid() {
                return Err("GetDC failed".into());
            }
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            if mem_dc.is_invalid() {
                ReleaseDC(Some(HWND::default()), screen_dc);
                return Err("CreateCompatibleDC failed".into());
            }

            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: SIZE,
                    biHeight: -SIZE,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0 as u32,
                    ..Default::default()
                },
                ..Default::default()
            };

            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let dib = CreateDIBSection(Some(mem_dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
                .map_err(|e| e.to_string())?;

            let old = SelectObject(mem_dc, HGDIOBJ(dib.0));
            if !bits.is_null() {
                let px = std::slice::from_raw_parts_mut(bits as *mut u8, (SIZE * SIZE * 4) as usize);
                px.fill(0);
            }

            let drawn = DrawIconEx(mem_dc, 0, 0, hicon, SIZE, SIZE, 0, None, DI_NORMAL);
            if drawn.is_err() {
                SelectObject(mem_dc, old);
                let _ = DeleteObject(HGDIOBJ(dib.0));
                let _ = DeleteDC(mem_dc);
                ReleaseDC(Some(HWND::default()), screen_dc);
                return Err("DrawIconEx failed".into());
            }

            let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
            if !bits.is_null() {
                let bgra = std::slice::from_raw_parts(bits as *const u8, rgba.len());
                for (dst, src) in rgba.chunks_exact_mut(4).zip(bgra.chunks_exact(4)) {
                    dst[0] = src[2];
                    dst[1] = src[1];
                    dst[2] = src[0];
                    dst[3] = src[3];
                }
            }

            SelectObject(mem_dc, old);
            let _ = DeleteObject(HGDIOBJ(dib.0));
            let _ = DeleteDC(mem_dc);
            ReleaseDC(Some(HWND::default()), screen_dc);

            let img = image::RgbaImage::from_raw(SIZE as u32, SIZE as u32, rgba)
                .ok_or_else(|| "Invalid RGBA buffer".to_string())?;
            img.save(dest).map_err(|e| e.to_string())?;
            Ok(())
        }
    })();

    unsafe {
        let _ = DestroyIcon(hicon);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn extract_associated_icon(_shortcut: &Path, _dest: &Path) -> Result<(), String> {
    Err("Shortcut icon extraction is only supported on Windows".into())
}
