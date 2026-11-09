import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionInteraction } from '../src/main/sessionInteraction';
import type { SessionClient } from '../src/main/sessionClient';
import type { SessionEvents } from '../src/main/sessionEvents';

test('input split inside a UTF-8 character delivers the remaining bytes unchanged', async () => {
	const keys = 'aあい';
	const received: Buffer[] = [];
	const client = {
		request: async (name: string, args: unknown[]) => {
			assert.equal(name, 'nvim_input');
			const value = args[0] as string | Buffer;
			const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
			// Neovim's input queue is nearly full: it takes 'a' and the first byte of 'あ'.
			const accepted = received.length === 0 ? 2 : bytes.length;
			received.push(bytes.subarray(0, accepted));
			return accepted;
		}
	} as unknown as SessionClient;
	const events = { hasInputPrompt: false } as unknown as SessionEvents;
	const interaction = new SessionInteraction(
		client,
		events,
		{ id: 'test', root: '/test', name: 'test' },
		() => false
	);
	await interaction.input(keys);
	assert.equal(received.length, 2);
	assert.equal(Buffer.concat(received).toString(), keys);
});
