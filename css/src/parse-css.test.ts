import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { parseCssFile } from './parse-css.js';

describe('parseCssFile', () => {
	it('parses a simple rule', () => {
		const { rules } = parseCssFile('.card { color: red; }');
		strictEqual(rules.length, 1);
		strictEqual(rules[0].selectorText, '.card');
		deepStrictEqual(rules[0].selectors, ['.card']);
		deepStrictEqual(rules[0].properties, [{ name: 'color', value: 'red' }]);
		deepStrictEqual(rules[0].mediaConditions, []);
	});

	it('parses multiple selectors (comma-separated)', () => {
		const { rules } = parseCssFile('.card, .panel { color: red; }');
		strictEqual(rules.length, 1);
		deepStrictEqual(rules[0].selectors, ['.card', '.panel']);
	});

	it('parses multiple rules', () => {
		const { rules } = parseCssFile('.card { color: red; } .panel { color: blue; }');
		strictEqual(rules.length, 2);
		strictEqual(rules[0].selectors[0], '.card');
		strictEqual(rules[1].selectors[0], '.panel');
	});

	it('parses @media wrapping', () => {
		const { rules } = parseCssFile('@media (min-width:768px) { .card { color: red; } }');
		strictEqual(rules.length, 1);
		deepStrictEqual(rules[0].mediaConditions, ['(min-width:768px)']);
		strictEqual(rules[0].selectors[0], '.card');
	});

	it('parses nested @media', () => {
		const css = '@media screen { @media (min-width:768px) { .card { color: red; } } }';
		const { rules } = parseCssFile(css);
		strictEqual(rules.length, 1);
		deepStrictEqual(rules[0].mediaConditions, ['screen', '(min-width:768px)']);
	});

	it('tracks source locations', () => {
		const css = '.card { color: red; }\n.panel { color: blue; }';
		const { rules } = parseCssFile(css);
		strictEqual(rules[0].sourceLine, 1);
		strictEqual(rules[0].sourceCol, 1);
		strictEqual(rules[1].sourceLine, 2);
		strictEqual(rules[1].sourceCol, 1);
	});

	it('returns empty array for empty file', () => {
		deepStrictEqual(parseCssFile('').rules, []);
	});

	it('returns empty array for comments only', () => {
		deepStrictEqual(parseCssFile('/* just a comment */').rules, []);
	});

	it('skips @keyframes and @font-face', () => {
		const css = `
			@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
			@font-face { font-family: MyFont; src: url(font.woff2); }
			.card { color: red; }
		`;
		const { rules } = parseCssFile(css);
		strictEqual(rules.length, 1);
		strictEqual(rules[0].selectors[0], '.card');
	});

	it('extracts multiple properties', () => {
		const { rules } = parseCssFile('.card { color: red; font-size: 14px; margin: 0 auto; }');
		strictEqual(rules[0].properties.length, 3);
		strictEqual(rules[0].properties[0].name, 'color');
		strictEqual(rules[0].properties[1].name, 'font-size');
		strictEqual(rules[0].properties[2].name, 'margin');
	});

	it('resolves nested rules against their parent, with or without a leading &', () => {
		const css = '.card {\n  color: red;\n  .direct { color: teal }\n  & .ok { color: blue }\n}\n.after { color: green }';
		const { rules, failures } = parseCssFile(css, '/w/styles.css');

		deepStrictEqual(failures, []);
		// A bare nested selector means a descendant of the parent, which is the
		// same thing `&` in that position means.
		deepStrictEqual(rules.map(r => r.selectorText), ['.card', '.card .direct', '.card .ok', '.after']);
	});

	it('resolves & in a compound onto the parent element itself', () => {
		const { rules } = parseCssFile('.card { &:hover { color: teal } &.featured { color: blue } }');
		deepStrictEqual(rules.map(r => r.selectorText), ['.card', '.card:hover', '.card.featured']);
	});

	it('resolves & wherever it appears, including more than once', () => {
		const { rules } = parseCssFile('.card { .outer & { color: teal } & + & { color: blue } }');
		deepStrictEqual(rules.map(r => r.selectorText), ['.card', '.outer .card', '.card + .card']);
	});

	it('wraps a multi-selector parent in :is()', () => {
		// `:is()` keeps one nested rule as one rule, and takes the specificity of
		// its most specific argument — which is what the nesting spec says `&`
		// scores. Expanding into one rule per parent would get both wrong.
		const { rules } = parseCssFile('.card, .panel { .direct { color: teal } &:hover { color: blue } }');
		deepStrictEqual(rules.map(r => r.selectorText), [
			'.card,.panel',
			':is(.card,.panel) .direct',
			':is(.card,.panel):hover',
		]);
	});

	it('resolves each selector of a nested selector list', () => {
		const { rules } = parseCssFile('.card { .a, .b { color: teal } }');
		deepStrictEqual(rules[1].selectors, ['.card .a', '.card .b']);
		strictEqual(rules[1].selectorText, '.card .a,.card .b');
	});

	it('resolves nesting to any depth, one level at a time', () => {
		const { rules } = parseCssFile('.a, .b { .c { .d { color: teal } } }');
		// The parent is already absolute, so `.d` resolves against `:is(.a,.b) .c`
		// as a whole rather than re-expanding the grandparent.
		deepStrictEqual(rules.map(r => r.selectorText), ['.a,.b', ':is(.a,.b) .c', ':is(.a,.b) .c .d']);
	});

	it('leaves an ampersand that is only text alone', () => {
		// Substitution is on the AST, where `&` is a NestingSelector node. A
		// string replace would corrupt this attribute value.
		const { rules } = parseCssFile('.card { [data-q="a&b"] { color: teal } }');
		strictEqual(rules[1].selectorText, '.card [data-q="a&b"]');
	});

	it('combines a nested rule with an enclosing @media', () => {
		const css = '.card { @media (min-width:700px) { .inner { color: teal } } }';
		const { rules } = parseCssFile(css);
		strictEqual(rules[1].selectorText, '.card .inner');
		deepStrictEqual(rules[1].mediaConditions, ['(min-width:700px)']);
	});

	it('resolves nested rules inside an @media block', () => {
		const { rules } = parseCssFile('@media print { .card { .inner { color: teal } } }');
		deepStrictEqual(rules.map(r => r.selectorText), ['.card', '.card .inner']);
		deepStrictEqual(rules[1].mediaConditions, ['print']);
	});

	it('leaves a top-level & alone, having no parent to resolve against', () => {
		const { rules } = parseCssFile('& .ok { color: teal }');
		deepStrictEqual(rules.map(r => r.selectorText), ['& .ok']);
	});

	it('keeps the selector stack balanced across a skipped at-rule', () => {
		// @keyframes is skipped wholesale; its `from`/`to` are Rule nodes that
		// must not be pushed, or every later rule would resolve against them.
		const css = '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }\n.card { .x { color: red } }';
		const { rules } = parseCssFile(css);
		deepStrictEqual(rules.map(r => r.selectorText), ['.card', '.card .x']);
	});

	it('rules outside @media have empty mediaConditions', () => {
		const css = '.a { color: red; } @media print { .b { color: blue; } } .c { color: green; }';
		const { rules } = parseCssFile(css);
		strictEqual(rules.length, 3);
		deepStrictEqual(rules[0].mediaConditions, []);
		deepStrictEqual(rules[1].mediaConditions, ['print']);
		deepStrictEqual(rules[2].mediaConditions, []);
	});
});

describe('parseCssFile failures', () => {
	it('reports nothing for a clean stylesheet', () => {
		const { failures } = parseCssFile('.card { color: red; }\n.panel { color: blue; }');
		deepStrictEqual(failures, []);
	});

	it('reports a malformed selector, and says what it swallowed', () => {
		const css = '.first { color: red }\n.a[ { color: red }\n.last { color: blue }';
		const { rules, failures } = parseCssFile(css, '/w/styles.css');

		// The damage: css-tree stops at the bad bracket, so .last never parses.
		deepStrictEqual(rules.map(r => r.selectorText), ['.first']);

		strictEqual(failures.length, 1);
		strictEqual(failures[0].reason, 'stylesheet-parse');
		strictEqual(failures[0].sourceFile, '/w/styles.css');
		strictEqual(failures[0].message, 'Identifier is expected');
		strictEqual(failures[0].sourceLine, 2);
		strictEqual(failures[0].sourceCol, 5);
		// The lost region reaches the end of the file — that is why .last is gone.
		strictEqual(failures[0].lostStartLine, 2);
		strictEqual(failures[0].lostEndLine, 3);
	});

	it('collapses the several errors one bad construct raises into one region', () => {
		// One malformed media feature raises three errors: what the parser
		// wanted, the unexpected input, and the ')' never found. Two of them
		// arrive with no fallback node at all — nothing was identified as
		// discarded — and the third covers the whole prelude, bridging them.
		const css = '@media (min-width:) { .a { color: red } }\n.two { color: blue }';
		const { rules, failures } = parseCssFile(css, '/w/styles.css');

		strictEqual(failures.length, 1);
		// The first message reported names what the parser was actually after.
		strictEqual(failures[0].message, 'Number, dimension, ratio or identifier is expected');
		// The region covers the prelude, not just the point of the last complaint.
		strictEqual(failures[0].lostStartLine, 1);
		strictEqual(failures[0].lostStartCol, 8);
		// Damage is contained to the at-rule: everything after it still parses.
		ok(rules.some(r => r.selectorText === '.two'));
	});

	it('merges overlapping regions, keeping the cause and the widest extent', () => {
		// With a trailing newline this raises two errors whose regions overlap:
		// 2:1-3:23 then 2:1-4:1. They are one piece of damage, and reporting both
		// would underline the same CSS twice.
		const css = '.card { color: red }\n.a[ { color: red }\n.title { color: blue }\n';
		const { failures } = parseCssFile(css, '/w/styles.css');

		strictEqual(failures.length, 1);
		// The first message names the actual cause, not the knock-on complaint.
		strictEqual(failures[0].message, 'Identifier is expected');
		// The region grows to everything that was dropped.
		strictEqual(failures[0].lostStartLine, 2);
		strictEqual(failures[0].lostStartCol, 1);
		strictEqual(failures[0].lostEndLine, 4);
	});

	it('keeps disjoint regions apart', () => {
		// Two independent breakages are two real failures. Each empty pseudo
		// costs only its own prelude, so parsing recovers in between.
		const css = [
			'.a:: { color: red }',
			'.b { color: blue }',
			'.c:: { color: teal }',
			'.d { color: pink }',
		].join('\n');
		const { rules, failures } = parseCssFile(css, '/w/styles.css');
		strictEqual(failures.length, 2);
		strictEqual(failures[0].lostStartLine, 1);
		strictEqual(failures[1].lostStartLine, 3);
		// The rules between and after the breakages survive.
		ok(rules.some(r => r.selectorText === '.b'));
		ok(rules.some(r => r.selectorText === '.d'));
	});

	it('reports an unparseable selector prelude', () => {
		const { failures } = parseCssFile('.a:: { color: red }', '/w/styles.css');
		strictEqual(failures.length, 1);
		strictEqual(failures[0].reason, 'stylesheet-parse');
		strictEqual(failures[0].sourceLine, 1);
	});

	it('reports failures per file, with no position when the file is unnamed', () => {
		const { failures } = parseCssFile('.a[ { color: red }');
		strictEqual(failures.length, 1);
		strictEqual(failures[0].sourceFile, '');
	});

	it('tags every rule with the file it was parsed from', () => {
		const { rules } = parseCssFile('.a { color: red }', '/w/site.css');
		strictEqual(rules[0].sourceFile, '/w/site.css');
	});
});

describe('parseCssFile selector text', () => {
	// Selector text is sliced from the source, not regenerated. These cases are
	// the ones where `csstree.generate` produces something different from what
	// the author wrote — and, in the first group, something css-select refuses.

	it('keeps the space after `of` in :nth-child(An+B of S)', () => {
		// `csstree.generate` emits `of.x`, which is legal CSS but which
		// css-select's nthOfRegex (/^(.+?)\s+of\s+(.+)$/is) will not match, so
		// the whole selector was silently dropped from analysis.
		const cases = [
			'li:nth-child(2 of .x)',
			'li:nth-child(2 of #x)',
			'li:nth-child(2 of [data-x])',
			'li:nth-child(2 of :hover)',
			'li:nth-child(2n + 1 of .x)',
			'li:nth-last-child(1 of .x)',
			'li:nth-child(2 of .x, li)',
			'li:nth-child(2 of li)',
		];
		for (const selector of cases) {
			const { rules } = parseCssFile(`${selector} { color: red }`);
			strictEqual(rules[0].selectorText, selector, `authored text preserved for ${selector}`);
		}
	});

	it('keeps authored whitespace around combinators', () => {
		const { rules } = parseCssFile('.field:checked + .lbl { color: red }\n.a > .b { color: red }\n.c ~ .d { color: red }');
		deepStrictEqual(rules.map(r => r.selectorText), ['.field:checked + .lbl', '.a > .b', '.c ~ .d']);
	});

	it('keeps a selector that spans lines, and splits a list on its commas', () => {
		const { rules } = parseCssFile('.a,\n   .b   ,\n.c { color: red }');
		deepStrictEqual(rules[0].selectors, ['.a', '.b', '.c']);
	});

	it('drops comments from selector text, as the parser does', () => {
		// A comment is not a separator in CSS, so removing it must not add one:
		// `.a/* x */.b` is the compound `.a.b`, `.a /* x */ .b` is a descendant.
		// The whitespace that surrounded the comment is authored text and stays;
		// collapsing it would be the normalization this whole path avoids.
		const { rules } = parseCssFile('.a /* mid */ .b { color: red }\n.a/* x */.b { color: red }');
		deepStrictEqual(rules.map(r => r.selectorText), ['.a  .b', '.a.b']);
	});

	it('drops a comment from a nested selector, and from the parent it resolves against', () => {
		const { rules } = parseCssFile('.card /* p */ .outer { & /* n */ .inner { color: red } }');
		deepStrictEqual(rules.map(r => r.selectorText), ['.card  .outer', '.card  .outer  .inner']);
	});

	it('leaves a comment-like attribute value alone', () => {
		// Comment bounds come from the parser, which never sees `/*` inside a
		// string. A regex over the source slice would eat the attribute.
		const { rules } = parseCssFile('[data-q="/* not a comment */"] { color: red }');
		deepStrictEqual(rules.map(r => r.selectorText), ['[data-q="/* not a comment */"]']);
	});

	it('keeps authored text on both sides of a nesting substitution', () => {
		const { rules } = parseCssFile('.a  +  .b { & > .c { color: red } }');
		deepStrictEqual(rules.map(r => r.selectorText), ['.a  +  .b', '.a  +  .b > .c']);
	});

	it('substitutes & inside a functional pseudo without regenerating the rest', () => {
		const { rules } = parseCssFile('.card { :is(& .x, .y  +  .z) { color: red } }');
		deepStrictEqual(rules[1].selectors, [':is(.card .x, .y  +  .z)']);
	});
});

describe('parseCssFile selector locations', () => {
	/** `'startLine:startCol-endLine:endCol'` per selector, parallel to `selectors`. */
	function locs(css: string): string[] {
		const { rules } = parseCssFile(css);
		return rules.flatMap(r => r.selectorLocs.map(
			l => `${l.startLine}:${l.startCol}-${l.endLine}:${l.endCol}`));
	}

	it('locates a single selector at the text it was written as', () => {
		deepStrictEqual(locs('.card { color: red }'), ['1:1-1:6']);
	});

	it('locates each selector of a list separately, across lines', () => {
		deepStrictEqual(locs('.a,\n  .b:hover { color: red }'), ['1:1-1:3', '2:3-2:11']);
	});

	it('locates a nested selector at the text authored, not the resolved form', () => {
		// `selectors` carries `.card.featured`; the extent is the `&.featured`
		// the author can actually see underlined.
		const { rules } = parseCssFile('.card { &.featured { color: red } }');
		deepStrictEqual(rules[1].selectors, ['.card.featured']);
		deepStrictEqual(rules[1].selectorLocs, [
			{ startLine: 1, startCol: 9, endLine: 1, endCol: 19 },
		]);
	});

	it('keeps one location per selector, parallel to the list', () => {
		const { rules } = parseCssFile('.a, .b, .c { color: red }');
		strictEqual(rules[0].selectorLocs.length, rules[0].selectors.length);
	});
});
