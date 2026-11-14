// Shown when a workspace cannot be saved for recovery because its untitled buffers are too big.
// Shared so the main process can recognize the error raised in Neovim and show it as is.
export const untitledRecoveryLimitMessage =
	'Workspace recovery supports up to 100 untitled buffers, 8 MiB each and 16 MiB total. Save large untitled buffers to resume checkpoints.';
