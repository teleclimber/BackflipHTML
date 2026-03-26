import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { parseCssFile } from './parse-css.js';

describe('parseCssFile', () => {
	it('parses a simple rule', () => {
		const rules = parseCssFile('.card { color: red; }');
		strictEqual(rules.length, 1);
		strictEqual(rules[0].selectorText, '.card');
		deepStrictEqual(rules[0].selectors, ['.card']);
		deepStrictEqual(rules[0].properties, [{ name: 'color', value: 'red' }]);
		deepStrictEqual(rules[0].mediaConditions, []);
	});

	it('parses multiple selectors (comma-separated)', () => {
		const rules = parseCssFile('.card, .panel { color: red; }');
		strictEqual(rules.length, 1);
		deepStrictEqual(rules[0].selectors, ['.card', '.panel']);
	});

	it('parses multiple rules', () => {
		const rules = parseCssFile('.card { color: red; } .panel { color: blue; }');
		strictEqual(rules.length, 2);
		strictEqual(rules[0].selectors[0], '.card');
		strictEqual(rules[1].selectors[0], '.panel');
	});

	it('parses @media wrapping', () => {
		const rules = parseCssFile('@media (min-width:768px) { .card { color: red; } }');
		strictEqual(rules.length, 1);
		deepStrictEqual(rules[0].mediaConditions, ['(min-width:768px)']);
		strictEqual(rules[0].selectors[0], '.card');
	});

	it('parses nested @media', () => {
		const css = '@media screen { @media (min-width:768px) { .card { color: red; } } }';
		const rules = parseCssFile(css);
		strictEqual(rules.length, 1);
		deepStrictEqual(rules[0].mediaConditions, ['screen', '(min-width:768px)']);
	});

	it('tracks source locations', () => {
		const css = '.card { color: red; }\n.panel { color: blue; }';
		const rules = parseCssFile(css);
		strictEqual(rules[0].sourceLine, 1);
		strictEqual(rules[0].sourceCol, 1);
		strictEqual(rules[1].sourceLine, 2);
		strictEqual(rules[1].sourceCol, 1);
	});

	it('returns empty array for empty file', () => {
		deepStrictEqual(parseCssFile(''), []);
	});

	it('returns empty array for comments only', () => {
		deepStrictEqual(parseCssFile('/* just a comment */'), []);
	});

	it('skips @keyframes and @font-face', () => {
		const css = `
			@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
			@font-face { font-family: MyFont; src: url(font.woff2); }
			.card { color: red; }
		`;
		const rules = parseCssFile(css);
		strictEqual(rules.length, 1);
		strictEqual(rules[0].selectors[0], '.card');
	});

	it('extracts multiple properties', () => {
		const rules = parseCssFile('.card { color: red; font-size: 14px; margin: 0 auto; }');
		strictEqual(rules[0].properties.length, 3);
		strictEqual(rules[0].properties[0].name, 'color');
		strictEqual(rules[0].properties[1].name, 'font-size');
		strictEqual(rules[0].properties[2].name, 'margin');
	});

	it('rules outside @media have empty mediaConditions', () => {
		const css = '.a { color: red; } @media print { .b { color: blue; } } .c { color: green; }';
		const rules = parseCssFile(css);
		strictEqual(rules.length, 3);
		deepStrictEqual(rules[0].mediaConditions, []);
		deepStrictEqual(rules[1].mediaConditions, ['print']);
		deepStrictEqual(rules[2].mediaConditions, []);
	});
});
