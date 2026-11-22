#![no_std]

use core::{arch::wasm32::unreachable, panic::PanicInfo, slice};

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    unreachable()
}

/// # Safety
/// The buffer holds `len` input words followed by room for two words per cell.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn glyph_instances(buffer: *mut u32, len: usize) -> usize {
    let (cells, instances) =
        unsafe { slice::from_raw_parts_mut(buffer, len * 3) }.split_at_mut(len);
    let mut count = 0;
    for (index, &glyph) in cells.iter().enumerate() {
        if glyph != 0 {
            instances[count * 2] = index as u32;
            instances[count * 2 + 1] = glyph;
            count += 1;
        }
    }
    count
}
