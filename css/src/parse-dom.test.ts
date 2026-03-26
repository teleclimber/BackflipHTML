import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { parseTemplate } from './parse-dom.js';

describe('parseTemplate', () => {
	it('parses simple HTML elements', () => {
		const t = parseTemplate('<div class="card"><span>hi</span></div>', 'test.html');
		strictEqual(t.elements.length, 2);
		strictEqual(t.elements[0].tagName, 'div');
		strictEqual(t.elements[1].tagName, 'span');
	});

	it('detects b-name', () => {
		const t = parseTemplate('<div b-name="card">content</div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		strictEqual(info?.bName, 'card');
	});

	it('detects b-export', () => {
		const t = parseTemplate('<div b-name="card" b-export>content</div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		strictEqual(info?.bExport, true);
	});

	it('parses b-part same-file (no hash)', () => {
		const t = parseTemplate('<div b-part="card"></div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		strictEqual(info?.bPart, 'card');
		deepStrictEqual(info?.bPartParsed, { partialName: 'card', targetFile: null });
	});

	it('parses b-part with hash-only', () => {
		const t = parseTemplate('<div b-part="#card"></div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		deepStrictEqual(info?.bPartParsed, { partialName: 'card', targetFile: null });
	});

	it('parses b-part cross-file', () => {
		const t = parseTemplate('<div b-part="components.html#card"></div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		deepStrictEqual(info?.bPartParsed, { partialName: 'card', targetFile: 'components.html' });
	});

	it('detects b-if, b-else-if, b-else', () => {
		const html = '<div b-if="a">A</div><div b-else-if="b">B</div><div b-else>C</div>';
		const t = parseTemplate(html, 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bIf, 'a');
		strictEqual(t.directives.get(t.elements[1])?.bElseIf, 'b');
		strictEqual(t.directives.get(t.elements[2])?.bElse, true);
	});

	it('detects b-for', () => {
		const t = parseTemplate('<div b-for="item in items">{{ item }}</div>', 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bFor, 'item in items');
	});

	it('detects b-slot bare (default)', () => {
		const t = parseTemplate('<b-unwrap b-slot></b-unwrap>', 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bSlot, 'default');
	});

	it('detects b-slot named', () => {
		const t = parseTemplate('<b-unwrap b-slot="header"></b-unwrap>', 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bSlot, 'header');
	});

	it('detects b-in bare and named', () => {
		const html = '<div b-in>default</div><div b-in="footer">footer</div>';
		const t = parseTemplate(html, 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bIn, 'default');
		strictEqual(t.directives.get(t.elements[1])?.bIn, 'footer');
	});

	it('detects dynamic attrs (b-bind: and : prefix)', () => {
		const t = parseTemplate('<div :class="expr" b-bind:id="expr2"></div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		deepStrictEqual(info?.dynamicAttrs.sort(), ['class', 'id']);
	});

	it('detects b-unwrap', () => {
		const t = parseTemplate('<b-unwrap b-name="x">content</b-unwrap>', 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bUnwrap, true);
	});

	it('preserves source locations', () => {
		const t = parseTemplate('<div>hi</div>', 'test.html');
		const loc = t.elements[0].sourceCodeLocation;
		ok(loc, 'sourceCodeLocation should exist');
		strictEqual(loc.startLine, 1);
		strictEqual(loc.startCol, 1);
	});

	it('collects nested elements', () => {
		const html = '<div><p><span>deep</span></p></div>';
		const t = parseTemplate(html, 'test.html');
		strictEqual(t.elements.length, 3);
		strictEqual(t.elements[0].tagName, 'div');
		strictEqual(t.elements[1].tagName, 'p');
		strictEqual(t.elements[2].tagName, 'span');
	});

	it('stores filePath', () => {
		const t = parseTemplate('<div></div>', 'pages/index.html');
		strictEqual(t.filePath, 'pages/index.html');
	});
});
