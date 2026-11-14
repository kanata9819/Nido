// A small property-testing helper: runs a check against many generated inputs from a seeded
// random generator, so a failure can be replayed exactly. Set PROPERTY_SEED to replay a run
// and PROPERTY_RUNS to change how many inputs each property tries.

/** A source of random values for generators. */
export interface Random {
	/** A float in [0, 1). */
	next(): number;
	/** An integer in [min, max]. */
	int(min: number, max: number): number;
	/** A random element of `items`. */
	pick<T>(items: readonly T[]): T;
	/** True with probability `chance`. */
	chance(chance: number): boolean;
	/** An array of `min`..`max` values from `item`. */
	array<T>(min: number, max: number, item: (random: Random) => T): T[];
	/** A string of `min`..`max` characters from `alphabet`. */
	string(min: number, max: number, alphabet: string | readonly string[]): string;
}

/** mulberry32: a tiny, fast seeded generator. */
function generator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function random(seed: number): Random {
	const next = generator(seed);
	const self: Random = {
		next,
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		pick: (items) => items[Math.floor(next() * items.length)],
		chance: (chance) => next() < chance,
		array: (min, max, item) => Array.from({ length: self.int(min, max) }, () => item(self)),
		string: (min, max, alphabet) => {
			const characters = typeof alphabet === 'string' ? [...alphabet] : alphabet;
			return Array.from({ length: self.int(min, max) }, () => self.pick(characters)).join('');
		}
	};
	return self;
}

const baseSeed = Number(process.env.PROPERTY_SEED ?? Date.now() % 2147483647);
const defaultRuns = Number(process.env.PROPERTY_RUNS ?? 300);

/**
 * Check `property` against `runs` inputs from `generate`. A failure reports the input and the
 * seed that produced it.
 */
export function forAll<T>(
	generate: (random: Random) => T,
	property: (value: T) => void,
	runs = defaultRuns
): void {
	for (let run = 0; run < runs; run++) {
		const seed = (baseSeed + run * 7919) >>> 0;
		const value = generate(random(seed));
		try {
			property(value);
		} catch (error) {
			const input = JSON.stringify(value, null, 1)?.slice(0, 2000);
			throw new Error(
				`Property failed for input ${input}\n(replay with PROPERTY_SEED=${baseSeed}, run ${run})\n${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error }
			);
		}
	}
}

/** Async variant of forAll, for properties that await. */
export async function forAllAsync<T>(
	generate: (random: Random) => T,
	property: (value: T) => Promise<void>,
	runs = defaultRuns
): Promise<void> {
	for (let run = 0; run < runs; run++) {
		const seed = (baseSeed + run * 7919) >>> 0;
		const value = generate(random(seed));
		try {
			await property(value);
		} catch (error) {
			const input = JSON.stringify(value, null, 1)?.slice(0, 2000);
			throw new Error(
				`Property failed for input ${input}\n(replay with PROPERTY_SEED=${baseSeed}, run ${run})\n${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error }
			);
		}
	}
}

/** Characters that tend to break text handling: wide, combining, astral, control and CR. */
export const trickyCharacters = [
	'a',
	'b',
	'z',
	'0',
	' ',
	'\t',
	'\r',
	'é',
	'é',
	'日',
	'本',
	'😀',
	'👍🏽',
	'‍',
	'<',
	'>',
	'{',
	'}',
	'\\',
	'/',
	'.',
	'$',
	'*',
	'?',
	'[',
	']',
	'(',
	')',
	'|',
	'^',
	'"',
	"'"
] as const;
