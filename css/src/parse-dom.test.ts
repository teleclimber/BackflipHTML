import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { parseTemplate, buildPartialInfo } from './parse-dom.js';

function pt(html: string, filePath: string = 'test.html') {
	return parseTemplate(html, filePath, buildPartialInfo(html));
}

describe('parseTemplate', () => {
	it('parses simple HTML elements', () => {
		const t = pt('<div class="card"><span>hi</span></div>', 'test.html');
		strictEqual(t.elements.length, 2);
		strictEqual(t.elements[0].tagName, 'div');
		strictEqual(t.elements[1].tagName, 'span');
	});

	it('detects b-name', () => {
		const t = pt('<div b-name="card">content</div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		strictEqual(info?.bName, 'card');
	});

	it('detects b-export', () => {
		const t = pt('<div b-name="card" b-export>content</div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		strictEqual(info?.bExport, true);
	});

	it('parses b-part same-file (no hash)', () => {
		const t = pt('<div b-part="card"></div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		strictEqual(info?.bPart, 'card');
		deepStrictEqual(info?.bPartParsed, { partialName: 'card', targetFile: null });
	});

	it('parses b-part with hash-only', () => {
		const t = pt('<div b-part="#card"></div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		deepStrictEqual(info?.bPartParsed, { partialName: 'card', targetFile: null });
	});

	it('parses b-part cross-file', () => {
		const t = pt('<div b-part="components.html#card"></div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		deepStrictEqual(info?.bPartParsed, { partialName: 'card', targetFile: 'components.html' });
	});

	it('detects b-if, b-else-if, b-else', () => {
		const html = '<div b-if="a">A</div><div b-else-if="b">B</div><div b-else>C</div>';
		const t = pt(html, 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bIf, 'a');
		strictEqual(t.directives.get(t.elements[1])?.bElseIf, 'b');
		strictEqual(t.directives.get(t.elements[2])?.bElse, true);
	});

	it('detects b-for', () => {
		const t = pt('<div b-for="item in items">{{ item }}</div>', 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bFor, 'item in items');
	});

	it('detects b-slot bare (default)', () => {
		const t = pt('<b-unwrap b-slot></b-unwrap>', 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bSlot, 'default');
	});

	it('detects b-slot named', () => {
		const t = pt('<b-unwrap b-slot="header"></b-unwrap>', 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bSlot, 'header');
	});

	it('detects b-in bare and named', () => {
		const html = '<div b-in>default</div><div b-in="footer">footer</div>';
		const t = pt(html, 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bIn, 'default');
		strictEqual(t.directives.get(t.elements[1])?.bIn, 'footer');
	});

	it('detects dynamic attrs (b-bind: and : prefix)', () => {
		const t = pt('<div :class="expr" b-bind:id="expr2"></div>', 'test.html');
		const info = t.directives.get(t.elements[0]);
		deepStrictEqual(info?.dynamicAttrs.sort(), ['class', 'id']);
	});

	it('detects b-unwrap', () => {
		const t = pt('<b-unwrap b-name="x">content</b-unwrap>', 'test.html');
		strictEqual(t.directives.get(t.elements[0])?.bUnwrap, true);
	});

	it('preserves source locations', () => {
		const t = pt('<div>hi</div>', 'test.html');
		const loc = t.elements[0].sourceCodeLocation;
		ok(loc, 'sourceCodeLocation should exist');
		strictEqual(loc.startLine, 1);
		strictEqual(loc.startCol, 1);
	});

	it('collects nested elements', () => {
		const html = '<div><p><span>deep</span></p></div>';
		const t = pt(html, 'test.html');
		strictEqual(t.elements.length, 3);
		strictEqual(t.elements[0].tagName, 'div');
		strictEqual(t.elements[1].tagName, 'p');
		strictEqual(t.elements[2].tagName, 'span');
	});

	it('stores filePath', () => {
		const t = pt('<div></div>', 'pages/index.html');
		strictEqual(t.filePath, 'pages/index.html');
	});

	it('parses document-level partial with html/head/body using parse()', () => {
		const html = '<html b-name="page"><head><title>Hi</title></head><body><div class="main">content</div></body></html>';
		const info = new Map([['page', {
			startOffset: 0,
			endOffset: html.length,
			startLine: 1,
			startCol: 1,
			isDocumentLevel: true,
		}]]);
		const t = parseTemplate(html, 'test.html', info);
		// Should find html, head, title, body, div elements
		const tagNames = t.elements.map(e => e.tagName);
		ok(tagNames.includes('html'), 'should find html element');
		ok(tagNames.includes('head'), 'should find head element');
		ok(tagNames.includes('body'), 'should find body element');
		ok(tagNames.includes('div'), 'should find div element');
		// Verify the b-name directive is detected
		const htmlEl = t.elements.find(e => e.tagName === 'html')!;
		strictEqual(t.directives.get(htmlEl)?.bName, 'page');
	});

	it('fragment-level partial does NOT find html/body when using parseFragment()', () => {
		const html = '<html b-name="page"><body><div>content</div></body></html>';
		const info = new Map([['page', {
			startOffset: 0,
			endOffset: html.length,
			startLine: 1,
			startCol: 1,
			isDocumentLevel: false,  // Force fragment parsing
		}]]);
		const t = parseTemplate(html, 'test.html', info);
		const tagNames = t.elements.map(e => e.tagName);
		// parseFragment treats html/body specially — they won't appear
		strictEqual(tagNames.includes('html'), false, 'parseFragment should not produce html element');
		strictEqual(tagNames.includes('body'), false, 'parseFragment should not produce body element');
	});
});
