import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { errorsToDiagnostics, cssFailuresToDiagnostics } from './diagnostics.js';
import { BackflipError } from '@backflip/html';
import type { AnalysisFailure } from '@backflip/css';

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

	it('uses endLine/endCol for full-width range when provided', () => {
		const err = new BackflipError('bad b-part');
		err.filename = 'page.html';
		err.line = 3;
		err.col = 5;
		err.endLine = 3;
		err.endCol = 25;

		const result = errorsToDiagnostics([err]);
		const diag = result.get('page.html')![0];
		deepStrictEqual(diag.range, {
			start: { line: 2, character: 4 },
			end: { line: 2, character: 24 },
		});
	});

	it('uses endLine/endCol spanning multiple lines', () => {
		const err = new BackflipError('multiline');
		err.filename = 'page.html';
		err.line = 3;
		err.col = 5;
		err.endLine = 4;
		err.endCol = 10;

		const result = errorsToDiagnostics([err]);
		const diag = result.get('page.html')![0];
		deepStrictEqual(diag.range, {
			start: { line: 2, character: 4 },
			end: { line: 3, character: 9 },
		});
	});
});

describe('cssFailuresToDiagnostics', () => {
	const failure = (over: Partial<AnalysisFailure> = {}): AnalysisFailure => ({
		reason: 'stylesheet-parse',
		sourceFile: '/w/styles.css',
		message: 'Identifier is expected',
		sourceLine: 2,
		sourceCol: 5,
		lostStartLine: 2,
		lostStartCol: 1,
		lostEndLine: 3,
		lostEndCol: 21,
		...over,
	});

	it('returns an empty map for no failures', () => {
		strictEqual(cssFailuresToDiagnostics([]).size, 0);
	});

	it('keys diagnostics by the stylesheet they came from', () => {
		const byFile = cssFailuresToDiagnostics([
			failure(),
			failure({ sourceFile: '/w/other.css' }),
		]);
		deepStrictEqual([...byFile.keys()].sort(), ['/w/other.css', '/w/styles.css']);
	});

	it('warns rather than errors — the CSS itself still works', () => {
		const [diag] = cssFailuresToDiagnostics([failure()]).get('/w/styles.css')!;
		strictEqual(diag.severity, DiagnosticSeverity.Warning);
		strictEqual(diag.source, 'backflip');
	});

	it('spans the whole discarded region, converted to 0-based', () => {
		// The underline is the point: it shows exactly which CSS stopped being
		// analyzed, rather than pointing at the character that broke the parse.
		const [diag] = cssFailuresToDiagnostics([failure()]).get('/w/styles.css')!;
		deepStrictEqual(diag.range, {
			start: { line: 1, character: 0 },   // lost 2:1
			end: { line: 2, character: 20 },    // lost 3:21
		});
	});

	it('spans a region that runs to the end of the file', () => {
		const [diag] = cssFailuresToDiagnostics([failure({ lostEndLine: 400, lostEndCol: 1 })]).get('/w/styles.css')!;
		strictEqual(diag.range.start.line, 1);
		strictEqual(diag.range.end.line, 399);
	});

	it('spans a single-line region', () => {
		const one = failure({ lostStartLine: 1, lostStartCol: 3, lostEndLine: 1, lostEndCol: 10 });
		const [diag] = cssFailuresToDiagnostics([one]).get('/w/styles.css')!;
		deepStrictEqual(diag.range, {
			start: { line: 0, character: 2 },
			end: { line: 0, character: 9 },
		});
		ok(diag.message.includes('(1 line)'), diag.message);
	});

	it('never emits a zero-width range, which would render as no underline', () => {
		const empty = failure({ lostStartLine: 2, lostStartCol: 5, lostEndLine: 2, lostEndCol: 5 });
		const [diag] = cssFailuresToDiagnostics([empty]).get('/w/styles.css')!;
		strictEqual(diag.range.start.character, 4);
		strictEqual(diag.range.end.character, 5);
	});

	it('states the consequence, not just the parser complaint', () => {
		const [diag] = cssFailuresToDiagnostics([failure()]).get('/w/styles.css')!;
		ok(diag.message.startsWith('Identifier is expected'), 'leads with the cause');
		ok(diag.message.includes('2 lines'), `should say how much was lost: ${diag.message}`);
		ok(diag.message.includes('will not report matches'), 'should say what that means');
	});
});
