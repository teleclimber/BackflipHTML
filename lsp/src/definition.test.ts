import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { findDefinition } from './definition.js';
import { makeLoc, makeIndex } from './test-helpers.js';

describe('findDefinition', () => {
	const root = '/workspace';

	it('finds same-file definition when targetFile is null', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'header', loc: makeLoc(2, 5, 2, 30), exported: false }],
			[],
		);
		const result = findDefinition('header', null, 'page.html', index, root);
		deepStrictEqual(result, {
			uri: 'file:///workspace/page.html',
			range: {
				start: { line: 1, character: 4 },
				end: { line: 1, character: 29 },
			},
		});
	});

	it('finds cross-file definition', () => {
		const index = makeIndex(
			[{ file: 'components.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: true }],
			[],
		);
		const result = findDefinition('card', 'components.html', 'page.html', index, root);
		deepStrictEqual(result, {
			uri: 'file:///workspace/components.html',
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 19 },
			},
		});
	});

	it('returns null for unknown partial', () => {
		const index = makeIndex([], []);
		const result = findDefinition('nonexistent', null, 'page.html', index, root);
		strictEqual(result, null);
	});

	it('returns null when partial exists in different file', () => {
		const index = makeIndex(
			[{ file: 'other.html', name: 'header', loc: makeLoc(1, 1, 1, 10), exported: false }],
			[],
		);
		const result = findDefinition('header', null, 'page.html', index, root);
		strictEqual(result, null);
	});

	it('matches correct file when multiple defs exist', () => {
		const index = makeIndex(
			[
				{ file: 'a.html', name: 'card', loc: makeLoc(1, 1, 1, 10), exported: false },
				{ file: 'b.html', name: 'card', loc: makeLoc(3, 5, 3, 25), exported: true },
			],
			[],
		);
		const result = findDefinition('card', 'b.html', 'page.html', index, root);
		deepStrictEqual(result, {
			uri: 'file:///workspace/b.html',
			range: {
				start: { line: 2, character: 4 },
				end: { line: 2, character: 24 },
			},
		});
	});
});
