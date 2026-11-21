#![no_std]

use core::{arch::wasm32::*, panic::PanicInfo, slice};

const BLOCKED: u32 = 1 << 31;
const STALE: u32 = 1 << 30;
const ITALIC: u32 = 1 << 29;
const TEXT_MASK: u32 = (1 << 17) - 1;
const CONTINUATION: u32 = 1;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    unreachable()
}

fn crosses_edge(cells: &[u32], column: usize) -> bool {
    let cell = cells[column];
    cell & ITALIC != 0
        || cell & TEXT_MASK == CONTINUATION
        || cells
            .get(column + 1)
            .is_some_and(|next| next & TEXT_MASK == CONTINUATION)
}

/// # Safety
/// The buffer holds columns current words, columns previous words, and room for
/// columns output spans (two words each). The shift is smaller than the window
/// width and the window fits within both rows.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn horizontal_spans(
    buffer: *mut u32,
    columns: usize,
    left: usize,
    right: usize,
    shift: i32,
    margin: usize,
) -> i32 {
    let (current, rest) =
        unsafe { slice::from_raw_parts_mut(buffer, columns * 4) }.split_at_mut(columns);
    let (previous, spans) = rest.split_at_mut(columns);
    let keep_from = (left + margin).max(left.saturating_add_signed(-(shift as isize)));
    let keep_to = right
        .saturating_sub(margin)
        .min(right.saturating_add_signed(-(shift as isize)));
    let special = u32x4_splat(STALE | BLOCKED);
    let mut count = 0;
    let mut width = 0;
    let mut last_end = 0;
    let mut column = 0;
    while column < columns {
        // Inside each range, four adjacent cells share the same offset into the old row.
        let (end, offset) = if column < left {
            (left, 0)
        } else if column >= right {
            (columns, 0)
        } else if column >= keep_from && column < keep_to {
            (keep_to, shift)
        } else {
            (column, 0)
        };
        let from = column.wrapping_add_signed(offset as isize);
        let lanes = if end >= column + 4 {
            let now = unsafe { v128_load(current.as_ptr().add(column).cast()) };
            let old = unsafe { v128_load(previous.as_ptr().add(from).cast()) };
            let unequal = v128_or(
                i32x4_ne(now, old),
                i32x4_ne(v128_and(now, special), u32x4_splat(0)),
            );
            i32x4_bitmask(unequal)
        } else {
            u8::from(
                column == end
                    || current[column] != previous[from]
                    || current[column] & (STALE | BLOCKED) != 0,
            )
        };
        let mut dirty = lanes;
        while dirty != 0 {
            let cell = column + dirty.trailing_zeros() as usize;
            dirty &= dirty - 1;
            if current[cell] & BLOCKED != 0 {
                return -1;
            }
            let mut start = cell.saturating_sub(margin);
            let mut stop = (cell + 1 + margin).min(columns);
            // The previous span already covers this edge, including any glyph crossing it.
            if count > 0 && stop <= last_end {
                continue;
            }
            while stop < columns && (crosses_edge(current, stop - 1) || crosses_edge(current, stop))
            {
                stop += 1;
            }
            while start > last_end
                && (crosses_edge(current, start - 1) || crosses_edge(current, start))
            {
                start -= 1;
            }
            if count > 0 && start <= last_end {
                width += stop - last_end;
                spans[count - 1] = stop as u32;
            } else {
                width += stop - start;
                spans[count] = start as u32;
                spans[count + 1] = stop as u32;
                count += 2;
            }
            last_end = stop;
            if width * 2 > columns {
                return -1;
            }
        }
        column += if end >= column + 4 { 4 } else { 1 };
    }
    (count / 2) as i32
}
