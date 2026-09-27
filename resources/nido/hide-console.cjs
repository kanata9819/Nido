// Node-based LSP launchers may spawn native helpers without hiding their Windows console.
// Preload only in language-server processes; keep the installed server packages untouched.
if (process.platform === 'win32') {
  const childProcess = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    const original = childProcess[name];
    childProcess[name] = function (file, ...args) {
      const index = Array.isArray(args[0]) ? 1 : 0;
      if (args[index] && typeof args[index] === 'object') {
        args[index] = { ...args[index], windowsHide: true };
      } else if (typeof args[index] === 'function') {
        args.splice(index, 0, { windowsHide: true });
      } else {
        args[index] = { windowsHide: true };
      }
      return original.call(this, file, ...args);
    };
  }
  require('node:module').syncBuiltinESMExports();
}
