/** Neovim's name for an encoding, as people usually write it: UTF-8, Latin-1, Shift_JIS… */
export function encodingLabel(encoding: string | undefined): string {
	const bom = !!encoding?.endsWith('+bom');
	const name = (encoding?.replace(/\+bom$/, '') || 'utf-8').toLowerCase();
	const known: Record<string, string> = {
		'utf-8': 'UTF-8',
		utf8: 'UTF-8',
		latin1: 'Latin-1',
		'iso-8859-1': 'Latin-1',
		cp932: 'Shift_JIS',
		sjis: 'Shift_JIS',
		'shift-jis': 'Shift_JIS',
		'euc-jp': 'EUC-JP',
		'utf-16le': 'UTF-16 LE',
		'utf-16': 'UTF-16 BE',
		'ucs-2le': 'UTF-16 LE',
		'ucs-2': 'UTF-16 BE'
	};
	return `${known[name] ?? name.toUpperCase()}${bom ? ' BOM' : ''}`;
}
