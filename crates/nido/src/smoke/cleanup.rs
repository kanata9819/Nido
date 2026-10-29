use super::*;

pub(crate) fn remove_test_dir(root: &Path) -> Result<()> {
    let start = Instant::now();
    loop {
        match fs::remove_dir_all(root) {
            Ok(()) => return Ok(()),
            // Child processes can release Windows file handles after they exit.
            Err(error)
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(32 | 33 | 145))
                    && start.elapsed() < Duration::from_secs(10) =>
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Remove test data at {}", root.display()));
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{os::windows::fs::OpenOptionsExt, thread};

    #[test]
    fn waits_for_windows_file_handles() -> Result<()> {
        let root = std::env::temp_dir().join(format!("nido-cleanup-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root)?;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(root.join("locked.txt"))?;
        assert_eq!(
            fs::remove_dir_all(&root).unwrap_err().raw_os_error(),
            Some(32)
        );
        let unlock = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            drop(file);
        });
        let result = remove_test_dir(&root);
        unlock.join().unwrap();
        if result.is_err() {
            fs::remove_dir_all(&root)?;
        }
        result?;
        assert!(!root.exists());
        Ok(())
    }

    #[test]
    fn preserves_other_cleanup_errors() {
        let missing = std::env::temp_dir().join(format!("nido-missing-{}", uuid::Uuid::new_v4()));
        let error = remove_test_dir(&missing).unwrap_err();
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::NotFound
        );
    }
}
