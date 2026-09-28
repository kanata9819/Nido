// Run with: pnpm icons (uses the project's Electron, no extra dependencies).
import { app, BrowserWindow, nativeImage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));

app.whenReady().then(async () => {
    try {
        const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
        await window.loadURL('data:text/html,<html></html>');
        const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8');
        const png = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1024;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png');
    })()`);
        const source = nativeImage.createFromDataURL(png);
        writeFileSync(join(root, 'build/icon.png'), source.toPNG());
        writeFileSync(join(root, 'resources/icon.png'), source.toPNG());

        const sizes = [16, 24, 32, 48, 64, 128, 256];
        const images = sizes.map((size) =>
            source.resize({ width: size, height: size, quality: 'best' }).toPNG()
        );
        const header = Buffer.alloc(6 + sizes.length * 16);
        header.writeUInt16LE(1, 2);
        header.writeUInt16LE(sizes.length, 4);
        let offset = header.length;
        images.forEach((image, i) => {
            const entry = 6 + i * 16;
            header[entry] = header[entry + 1] = sizes[i] % 256;
            header.writeUInt16LE(1, entry + 4);
            header.writeUInt16LE(32, entry + 6);
            header.writeUInt32LE(image.length, entry + 8);
            header.writeUInt32LE(offset, entry + 12);
            offset += image.length;
        });
        writeFileSync(join(root, 'build/icon.ico'), Buffer.concat([header, ...images]));
        const chunks = [128, 256, 512, 1024].map((size, i) => {
            const image = source.resize({ width: size, height: size, quality: 'best' }).toPNG();
            const chunk = Buffer.alloc(8);
            chunk.write(['ic07', 'ic08', 'ic09', 'ic10'][i]);
            chunk.writeUInt32BE(image.length + 8, 4);
            return Buffer.concat([chunk, image]);
        });
        const icnsHeader = Buffer.alloc(8);
        icnsHeader.write('icns');
        icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
        writeFileSync(join(root, 'build/icon.icns'), Buffer.concat([icnsHeader, ...chunks]));
        console.log('Generated Nido PNG, ICO (16–256px), and ICNS.');
        window.destroy();
        app.quit();
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
