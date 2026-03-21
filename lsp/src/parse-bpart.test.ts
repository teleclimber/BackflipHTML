import { describe, it } from 'node:test';
import { deepStrictEqual } from 'node:assert';
import { parseBPartValue } from './parse-bpart.js';

describe('parseBPartValue', () => {
	it('parses same-file reference with #', () => {
		deepStrictEqual(parseBPartValue('#header'), {
			partialName: 'header',
			targetFile: null,
		});
	});

	it('parses cross-file reference', () => {
		deepStrictEqual(parseBPartValue('components.html#header'), {
			partialName: 'header',
			targetFile: 'components.html',
		});
	});

	it('parses cross-file reference with subdirectory path', () => {
		deepStrictEqual(parseBPartValue('path/to/file.html#card'), {
			partialName: 'card',
			targetFile: 'path/to/file.html',
		});
	});

	it('parses bare name as same-file reference', () => {
		deepStrictEqual(parseBPartValue('header'), {
			partialName: 'header',
			targetFile: null,
		});
	});

	it('handles empty string', () => {
		deepStrictEqual(parseBPartValue(''), {
			partialName: '',
			targetFile: null,
		});
	});
});
