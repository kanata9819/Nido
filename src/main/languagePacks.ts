import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
	LanguagePackConfiguration,
	LanguagePackDefinition,
	LanguagePackManifest
} from '../shared/languagePacks';

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 4000 &&
		!value.includes('\0')
	);
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(text);
}

/** schemaVersion, id, version, title, description, filetypes and serverName. */
function hasValidIdentity(value: Record<string, unknown>): boolean {
	return (
		value.schemaVersion === 1 &&
		text(value.id) &&
		/^[a-z][a-z0-9-]{0,63}$/.test(value.id) &&
		text(value.version) &&
		/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version) &&
		text(value.title) &&
		text(value.description) &&
		strings(value.filetypes) &&
		value.filetypes.every((type) => /^[\w-]+$/.test(type)) &&
		text(value.serverName) &&
		/^[a-zA-Z][\w-]{0,63}$/.test(value.serverName) &&
		(value.category === undefined ||
			value.category === 'language' ||
			value.category === 'other')
	);
}

/**
 * A pack starts its server with `command`, per-platform `commands`, or a Lua adapter. Only
 * bundled packs can select an adapter.
 */
function hasValidServerCommand(value: Record<string, unknown>, bundled: boolean): boolean {
	if (
		value.adapter !== undefined &&
		(!bundled || !['typescript', 'deno', 'rust'].includes(String(value.adapter)))
	) {
		return false;
	}
	if (value.command !== undefined && !strings(value.command)) {
		return false;
	}
	if (
		value.commands !== undefined &&
		(!object(value.commands) ||
			Object.entries(value.commands).some(
				([platform, args]) => !['win32', 'linux'].includes(platform) || !strings(args)
			))
	) {
		return false;
	}
	return !!(value.adapter || value.command || value.commands);
}

/** rootMarkers, settings, initOptions and setup. */
function hasValidOptions(value: Record<string, unknown>): boolean {
	if (
		value.rootMarkers !== undefined &&
		(!strings(value.rootMarkers) ||
			value.rootMarkers.some((marker) => /[/\\]/.test(marker) || marker === '..'))
	) {
		return false;
	}
	if (
		['settings', 'initOptions'].some((key) => value[key] !== undefined && !object(value[key]))
	) {
		return false;
	}
	return value.setup === undefined || text(value.setup);
}

/** The optional list of languages that the Extensions page shows for the pack. */
function hasValidLanguages(value: Record<string, unknown>): boolean {
	return (
		value.languages === undefined ||
		(Array.isArray(value.languages) &&
			value.languages.length <= 30 &&
			value.languages.every(
				(language) =>
					object(language) &&
					['tools', 'runtimes'].includes(String(language.category)) &&
					['id', 'title', 'mark', 'extensions', 'description'].every((key) =>
						text(language[key])
					) &&
					['keywords', 'requirement', 'setup', 'command'].every(
						(key) => language[key] === undefined || text(language[key])
					)
			))
	);
}

const manifestKeys = [
	'schemaVersion',
	'id',
	'version',
	'title',
	'description',
	'category',
	'filetypes',
	'serverName',
	'command',
	'commands',
	'rootMarkers',
	'settings',
	'initOptions',
	'setup',
	'languages',
	'adapter'
];

export function validateLanguagePack(value: unknown, bundled = false): LanguagePackManifest {
	if (
		!object(value) ||
		!hasValidIdentity(value) ||
		!hasValidServerCommand(value, bundled) ||
		!hasValidOptions(value) ||
		!hasValidLanguages(value)
	) {
		throw new Error(
			'Invalid language pack. Check schemaVersion, id, version, filetypes and command.'
		);
	}
	// Keep only known keys. Additional packs contribute configuration; only bundled packs can
	// select a Lua adapter.
	return Object.fromEntries(
		manifestKeys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])
	) as unknown as LanguagePackManifest;
}

export async function discoverLanguagePacks(
	resources: string,
	directory?: string
): Promise<LanguagePackConfiguration> {
	const packs: LanguagePackDefinition[] = [];
	const errors: string[] = [];
	for (const [folder, bundled] of [
		[join(resources, 'nido/language-packs'), true],
		[directory, false]
	] as const) {
		if (!folder) {
			continue;
		}
		let entries;
		try {
			entries = await readdir(folder, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				errors.push(String(error));
			}
			continue;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory() && !entry.name.endsWith('.json')) {
				continue;
			}
			const path = entry.isDirectory()
				? join(folder, entry.name, 'pack.json')
				: join(folder, entry.name);
			try {
				if ((await stat(path)).size > 128_000) {
					throw new Error('Language pack exceeds 128 KB.');
				}
				const pack = validateLanguagePack(
					JSON.parse(await readFile(path, 'utf8')),
					bundled
				);
				if (
					packs.some(
						(other) => other.id === pack.id || other.serverName === pack.serverName
					)
				) {
					throw new Error('Duplicate pack id or language server name.');
				}
				packs.push({ ...pack, bundled });
			} catch (error) {
				errors.push(`${entry.name}: ${String(error)}`);
			}
		}
	}
	return { packs, disabled: [], errors };
}

export class LanguagePacks {
	readonly directory: string;
	private readonly settingsPath: string;
	private writing: Promise<unknown> = Promise.resolve();

	constructor(
		private resources: string,
		userData: string
	) {
		this.directory = join(userData, 'language-packs');
		this.settingsPath = join(userData, 'language-packs-state.json');
	}

	load(): Promise<LanguagePackConfiguration> {
		return this.enqueue(() => this.read());
	}

	private async read(): Promise<LanguagePackConfiguration> {
		const config = await discoverLanguagePacks(this.resources, this.directory);
		try {
			const saved: unknown = JSON.parse(await readFile(this.settingsPath, 'utf8'));
			if (
				!object(saved) ||
				!Array.isArray(saved.disabled) ||
				!saved.disabled.every((id) => typeof id === 'string')
			) {
				throw new Error('Invalid language pack settings.');
			}
			config.disabled = saved.disabled;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				config.errors.push(String(error));
			}
		}
		return config;
	}

	private enqueue<T>(action: () => Promise<T>): Promise<T> {
		const next = this.writing.then(action);
		this.writing = next.catch(() => {});
		return next;
	}

	setEnabled(id: string, enabled: boolean): Promise<void> {
		return this.enqueue(async () => {
			const config = await this.read();
			if (!config.packs.some((pack) => pack.id === id)) {
				throw new Error('Unknown language pack.');
			}
			const disabled = new Set(config.disabled);
			if (enabled) {
				disabled.delete(id);
			} else {
				disabled.add(id);
			}
			await mkdir(dirname(this.settingsPath), { recursive: true });
			await writeFile(
				this.settingsPath + '.tmp',
				JSON.stringify({ disabled: [...disabled] }),
				'utf8'
			);
			await rename(this.settingsPath + '.tmp', this.settingsPath);
		});
	}

	install(path: string): Promise<void> {
		return this.enqueue(async () => {
			if ((await stat(path)).size > 128_000) {
				throw new Error('Language pack exceeds 128 KB.');
			}
			const pack = validateLanguagePack(JSON.parse(await readFile(path, 'utf8')));
			const config = await this.read();
			if (
				config.packs.some(
					(other) => other.id === pack.id || other.serverName === pack.serverName
				)
			) {
				throw new Error('A pack with this id or language server is already installed.');
			}
			await mkdir(this.directory, { recursive: true });
			const target = join(this.directory, `${pack.id}.json`);
			await writeFile(target, JSON.stringify(pack, null, 4) + '\n', {
				encoding: 'utf8',
				flag: 'wx'
			});
		});
	}
}
