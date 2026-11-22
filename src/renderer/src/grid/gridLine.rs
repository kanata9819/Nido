use core::{arch::wasm32::*, slice};

// Match the packed text IDs used by gridTextIds.ts.
const TEXT_MASK: u32 = (1 << 17) - 1;
const FIRST_GRAPHEME: u32 = 0x10002;

/// # Safety
/// The buffer contains three rows of `stride` words, followed by the interleaved
/// cell words and repeat counts, then the transport-to-grid grapheme ID table.
/// The expanded words are written into the second row.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn grid_line_expand(
    buffer: *mut u32,
    stride: usize,
    run_words: usize,
    graphemes: usize,
) -> usize {
    let (rows, input) =
        unsafe { slice::from_raw_parts_mut(buffer, stride * 3 + run_words + graphemes) }
            .split_at_mut(stride * 3);
    let target = &mut rows[stride..2 * stride];
    let (runs, ids) = input.split_at(run_words);
    let mut written = 0;
    for [word, repeat] in runs.as_chunks::<2>().0 {
        let mut word = *word;
        if word & TEXT_MASK >= FIRST_GRAPHEME {
            let index = ((word & TEXT_MASK) - FIRST_GRAPHEME) as usize;
            match ids.get(index) {
                Some(&id) if id != 0 => word = (word & !TEXT_MASK) | id,
                _ => return 0,
            }
        }
        if *repeat == 1 {
            target[written] = word;
            written += 1;
        } else {
            let end = written + (*repeat as usize).min(stride - written);
            target[written..end].fill(word);
            written = end;
        }
        if written == stride {
            break;
        }
    }
    written
}

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
