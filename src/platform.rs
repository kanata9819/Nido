use raw_window_handle::HasWindowHandle;

pub fn backdrop(window: &impl HasWindowHandle, acrylic: bool) -> bool {
    #[cfg(windows)]
    {
        use raw_window_handle::RawWindowHandle;
        use windows::Win32::{Foundation::HWND, Graphics::Dwm::*, UI::Controls::MARGINS};
        let Ok(handle) = window.window_handle() else {
            return false;
        };
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return false;
        };
        let hwnd = HWND(handle.hwnd.get() as *mut _);
        let kind = if acrylic {
            DWMSBT_TRANSIENTWINDOW
        } else {
            DWMSBT_NONE
        };
        // shortcut: system acrylic needs Windows 11; older Windows keeps the solid theme.
        unsafe {
            let dark = 1u32;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                (&dark as *const u32).cast(),
                4,
            );
            if DwmSetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE,
                (&kind.0 as *const i32).cast(),
                4,
            )
            .is_err()
            {
                return false;
            }
            let margins = MARGINS {
                cxLeftWidth: if acrylic { -1 } else { 0 },
                ..Default::default()
            };
            DwmExtendFrameIntoClientArea(hwnd, &margins).is_ok() && acrylic
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, acrylic);
        false
    }
}
