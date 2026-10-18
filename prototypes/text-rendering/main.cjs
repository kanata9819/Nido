const { app, BrowserWindow } = require('electron');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const profile = resolve(__dirname, '../../test-results/text-rendering', `profile-${process.pid}`);
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

const url = process.argv
    .find((argument) => argument.startsWith('--comparison-url='))
    ?.split('=')
    .slice(1)
    .join('=');
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))
    throw new Error('Expected a local comparison server.');
app.whenReady().then(() => {
    const window = new BrowserWindow({
        width: 1500,
        height: 1000,
        show: !process.argv.includes('--comparison-hidden'),
        backgroundColor: '#121212',
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
    });
    void window.loadURL(url);
});
app.on('window-all-closed', () => app.quit());
