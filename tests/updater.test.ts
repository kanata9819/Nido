import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Updates, type UpdateBackend } from '../src/main/updater';
import type { UpdateState } from '../src/shared/types';

class Backend extends EventEmitter implements UpdateBackend {
    autoDownload = true;
    autoInstallOnAppQuit = true;
    allowPrerelease = true;
    allowDowngrade = true;
    checks = 0;
    downloads = 0;
    installs = 0;
    check = async (): Promise<null> => null;
    download = async (): Promise<string[]> => [];
    install = (): void => {};
    async checkForUpdates(): Promise<null> {
        this.checks++;
        return this.check();
    }
    async downloadUpdate(): Promise<string[]> {
        this.downloads++;
        return this.download();
    }
    quitAndInstall(silent: boolean, restart: boolean): void {
        assert.equal(silent, true);
        assert.equal(restart, true);
        this.installs++;
        this.install();
    }
}

function fixture(enabled = true): {
    backend: Backend;
    updates: Updates;
    states: UpdateState[];
    notices: { message: string; severity: string }[];
    allow: () => void;
    prepared: () => number;
    recovered: () => number;
} {
    const backend = new Backend();
    const states: UpdateState[] = [];
    const notices: { message: string; severity: string }[] = [];
    let permit = false;
    let prepared = 0;
    let recovered = 0;
    const updates = new Updates(backend, {
        currentVersion: '0.2.0',
        enabled,
        publish: (state) => states.push(state),
        notify: (message, severity) => notices.push({ message, severity }),
        prepareToQuit: async () => {
            prepared++;
            return permit;
        },
        recover: () => {
            recovered++;
        }
    });
    return {
        backend,
        updates,
        states,
        notices,
        allow: (): void => {
            permit = true;
        },
        prepared: (): number => prepared,
        recovered: (): number => recovered
    };
}

test('updates serialize checks and downloads, expose progress, and wait for save confirmation', async () => {
    const f = fixture();
    assert.equal(f.backend.autoDownload, false);
    assert.equal(f.backend.autoInstallOnAppQuit, false);
    assert.equal(f.backend.allowPrerelease, false);
    assert.equal(f.backend.allowDowngrade, false);
    await f.updates.install();
    assert.equal(f.prepared(), 0);
    let release!: () => void;
    f.backend.check = async () => {
        await new Promise<void>((resolve) => {
            release = resolve;
        });
        f.backend.emit('update-available', { version: '0.2.1' });
        return null;
    };
    const checking = f.updates.check();
    assert.equal(f.updates.check(), checking);
    assert.equal(f.updates.download(), checking);
    assert.equal(f.updates.snapshot().status, 'checking');
    release();
    assert.equal((await checking).status, 'available');
    assert.equal(f.backend.checks, 1);
    f.backend.download = async () => {
        f.backend.emit('download-progress', { percent: 42 });
        await new Promise<void>((resolve) => {
            release = resolve;
        });
        f.backend.emit('update-downloaded', { version: '0.2.1' });
        return ['installer.exe'];
    };
    const downloading = f.updates.download();
    assert.equal(f.updates.snapshot().percent, 42);
    assert.equal(f.updates.download(), downloading);
    release();
    assert.equal((await downloading).status, 'downloaded');
    assert.equal(f.backend.downloads, 1);
    await f.updates.check();
    assert.equal(f.backend.checks, 1);
    assert.equal((await f.updates.install()).status, 'downloaded');
    assert.equal(f.backend.installs, 0);
    f.allow();
    assert.equal((await f.updates.install()).status, 'installing');
    assert.equal(f.backend.installs, 1);
    assert.equal(f.prepared(), 2);
    assert.equal(f.notices.length, 0);
});

test('failed downloads report once, remain retryable, and never start the installer', async () => {
    const f = fixture();
    f.backend.check = async () => {
        f.backend.emit('update-available', { version: '0.2.1' });
        return null;
    };
    await f.updates.check();
    f.backend.download = async () => {
        const error = new Error('Checksum mismatch');
        f.backend.emit('error', error);
        throw error;
    };
    assert.equal((await f.updates.download()).status, 'error');
    assert.deepEqual(f.notices, [{ message: 'Checksum mismatch', severity: 'error' }]);
    await f.updates.install();
    assert.equal(f.backend.installs, 0);
    assert.equal(f.prepared(), 0);
    assert.equal((await f.updates.check()).status, 'available');
});

test('background checks are quiet, while an empty release repository gives a useful notice', async () => {
    const f = fixture();
    f.backend.check = async () => {
        throw new Error('Offline');
    };
    assert.equal((await f.updates.check(false)).status, 'error');
    assert.equal(f.notices.length, 0);
    f.backend.check = async () => {
        const error = Object.assign(new Error('No published versions on GitHub'), {
            code: 'ERR_UPDATER_INVALID_RELEASE_FEED'
        });
        f.backend.emit('error', error);
        throw error;
    };
    assert.equal((await f.updates.check()).status, 'current');
    assert.deepEqual(f.notices, [
        { message: 'No updates have been published yet.', severity: 'info' }
    ]);
});

test('GitHub connection failures are not mistaken for an empty release repository', async () => {
    const f = fixture();
    f.backend.check = async () => {
        throw Object.assign(new Error('Unable to find latest version: 403 rate limit'), {
            code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
        });
    };
    assert.equal((await f.updates.check()).status, 'error');
    assert.equal(f.notices[0].severity, 'error');
});

test('development and unpacked builds cannot check, download, or install updates', async () => {
    const f = fixture(false);
    f.backend.emit('update-downloaded', { version: '0.2.1' });
    for (const action of [f.updates.check(), f.updates.download(), f.updates.install()]) {
        assert.equal((await action).status, 'disabled');
    }
    assert.equal(f.backend.checks + f.backend.downloads + f.backend.installs, 0);
});

test('installer launch errors recover the saved workspaces after shutdown', async () => {
    const f = fixture();
    f.allow();
    f.backend.emit('update-downloaded', { version: '0.2.1' });
    f.backend.install = () => {
        f.backend.emit('error', new Error('Installer could not start'));
    };
    assert.equal((await f.updates.install()).status, 'error');
    assert.equal(f.recovered(), 1);
    assert.equal(f.notices.length, 1);
});
