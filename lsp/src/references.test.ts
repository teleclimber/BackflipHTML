import { describe, it } from 'node:test';
import { deepStrictEqual } from 'node:assert';
import { findReferences } from './references.js';
import { makeLoc, makeIndex } from './test-helpers.js';

describe('findReferences', () => {
	const root = '/workspace';

	it('finds same-file references', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 10), exported: false }],
			[{ file: 'page.html', partialName: 'card', targetFile: null, loc: makeLoc(5, 10, 5, 30) }],
		);
		const result = findReferences('card', 'page.html', index, root);
		deepStrictEqual(result, [{
			uri: 'file:///workspace/page.html',
			range: {
				start: { line: 4, character: 9 },
				end: { line: 4, character: 29 },
			},
		}]);
	});

	it('finds cross-file references', () => {
		const index = makeIndex(
			[{ file: 'components.html', name: 'card', loc: makeLoc(1, 1, 1, 10), exported: true }],
			[{ file: 'page.html', partialName: 'card', targetFile: 'components.html', loc: makeLoc(3, 5, 3, 40) }],
		);
		const result = findReferences('card', 'components.html', index, root);
		deepStrictEqual(result, [{
			uri: 'file:///workspace/page.html',
			range: {
				start: { line: 2, character: 4 },
				end: { line: 2, character: 39 },
			},
		}]);
	});

	it('returns empty array when no references match', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 10), exported: false }],
			[{ file: 'page.html', partialName: 'other', targetFile: null, loc: makeLoc(5, 10, 5, 30) }],
		);
		const result = findReferences('card', 'page.html', index, root);
		deepStrictEqual(result, []);
	});
});
