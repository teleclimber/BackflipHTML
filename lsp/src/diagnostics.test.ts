import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { errorsToDiagnostics } from './diagnostics.js';
import { BackflipError } from '@backflip/html';

describe('errorsToDiagnostics', () => {
	it('converts error with location to diagnostic', () => {
		const err = new BackflipError('test error');
		err.filename = 'page.html';
		err.line = 5;
		err.col = 10;

		const result = errorsToDiagnostics([err]);
		const diags = result.get('page.html');
		strictEqual(diags?.length, 1);
		deepStrictEqual(diags![0].range, {
			start: { line: 4, character: 9 },
			end: { line: 4, character: 10 },
		});
		strictEqual(diags![0].message, 'test error');
		strictEqual(diags![0].source, 'backflip');
	});

	it('defaults to line 0, col 0 when location is missing', () => {
		const err = new BackflipError('no location');

		const result = errorsToDiagnostics([err]);
		const diags = result.get('');
		strictEqual(diags?.length, 1);
		deepStrictEqual(diags![0].range, {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		});
	});

	it('groups errors by file', () => {
		const err1 = new BackflipError('error 1');
		err1.filename = 'a.html';
		err1.line = 1;
		err1.col = 1;
		const err2 = new BackflipError('error 2');
		err2.filename = 'b.html';
		err2.line = 2;
		err2.col = 3;
		const err3 = new BackflipError('error 3');
		err3.filename = 'a.html';
		err3.line = 5;
		err3.col = 1;

		const result = errorsToDiagnostics([err1, err2, err3]);
		strictEqual(result.get('a.html')?.length, 2);
		strictEqual(result.get('b.html')?.length, 1);
	});

	it('diagnostic end is after start (non-zero-width)', () => {
		const err = new BackflipError('test');
		err.filename = 'page.html';
		err.line = 1;
		err.col = 1;

		const result = errorsToDiagnostics([err]);
		const diag = result.get('page.html')![0];
		const endIsAfterStart =
			diag.range.end.line > diag.range.start.line ||
			(diag.range.end.line === diag.range.start.line && diag.range.end.character > diag.range.start.character);
		strictEqual(endIsAfterStart, true);
	});
});
