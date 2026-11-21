use core::{arch::wasm32::*, slice};

/// # Safety
/// The buffer contains two rows of `stride` words followed by room for their
/// changed column indices. The first `columns` words in each row are compared.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn grid_line_changes(
    buffer: *mut u32,
    stride: usize,
    columns: usize,
) -> usize {
    let (before, rest) =
        unsafe { slice::from_raw_parts_mut(buffer, stride * 3) }.split_at_mut(stride);
    let (after, changed) = rest.split_at_mut(stride);
    let mut columns_written = 0;
    let vector_end = columns & !3;
    for column in (0..vector_end).step_by(4) {
        let old = unsafe { v128_load(before.as_ptr().add(column).cast()) };
        let new = unsafe { v128_load(after.as_ptr().add(column).cast()) };
        let mut mask = i32x4_bitmask(i32x4_ne(old, new));
        while mask != 0 {
            changed[columns_written] = (column + mask.trailing_zeros() as usize) as u32;
            columns_written += 1;
            mask &= mask - 1;
        }
    }
    for column in vector_end..columns {
        if before[column] != after[column] {
            changed[columns_written] = column as u32;
            columns_written += 1;
        }
    }
    columns_written
}
