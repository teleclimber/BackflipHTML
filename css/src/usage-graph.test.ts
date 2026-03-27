import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { parseTemplate, buildPartialInfo } from './parse-dom.js';
function pt(html: string, file: string = 'test.html') { return parseTemplate(html, file, buildPartialInfo(html)); }
import { buildUsageGraph } from './usage-graph.js';

describe('buildUsageGraph', () => {
	it('single partial definition', () => {
		const t = pt('<div b-name="card">content</div>', 'test.html');
		const graph = buildUsageGraph([t]);

		ok(graph.definitions.has('card'));
		strictEqual(graph.definitions.get('card')!.length, 1);
		const def = graph.definitions.get('card')![0];
		strictEqual(def.name, 'card');
		strictEqual(def.file, 'test.html');
		strictEqual(def.rootElement, t.elements[0]);
	});

	it('partial with slots', () => {
		const html = '<div b-name="card"><b-unwrap b-slot></b-unwrap><b-unwrap b-slot="header"></b-unwrap></div>';
		const t = pt(html, 'test.html');
		const graph = buildUsageGraph([t]);

		const def = graph.definitions.get('card')![0];
		strictEqual(def.slotElements.size, 2);
		ok(def.slotElements.has('default'));
		ok(def.slotElements.has('header'));
	});

	it('partial usage', () => {
		const t = pt('<div b-part="card">content</div>', 'test.html');
		const graph = buildUsageGraph([t]);

		ok(graph.usages.has('card'));
		strictEqual(graph.usages.get('card')!.length, 1);
		const usage = graph.usages.get('card')![0];
		strictEqual(usage.partialName, 'card');
		strictEqual(usage.file, 'test.html');
		strictEqual(usage.element, t.elements[0]);
	});

	it('cross-file usage', () => {
		const t = pt('<div b-part="components.html#card"></div>', 'page.html');
		const graph = buildUsageGraph([t]);

		const usage = graph.usages.get('card')![0];
		strictEqual(usage.targetFile, 'components.html');
		strictEqual(usage.partialName, 'card');
	});

	it('slot injection', () => {
		const html = '<div b-part="card"><span b-in="header">Title</span>Default</div>';
		const t = pt(html, 'test.html');
		const graph = buildUsageGraph([t]);

		const usage = graph.usages.get('card')![0];
		ok(usage.slotInjections.has('header'));
		strictEqual(usage.slotInjections.get('header')!.length, 1);
		strictEqual(usage.slotInjections.get('header')![0].tagName, 'span');
	});

	it('multiple files', () => {
		const defTemplate = pt('<div b-name="card">content</div>', 'components.html');
		const useTemplate = pt('<div b-part="card"></div>', 'page.html');
		const graph = buildUsageGraph([defTemplate, useTemplate]);

		ok(graph.definitions.has('card'));
		strictEqual(graph.definitions.get('card')!.length, 1);
		strictEqual(graph.definitions.get('card')![0].file, 'components.html');

		ok(graph.usages.has('card'));
		strictEqual(graph.usages.get('card')!.length, 1);
		strictEqual(graph.usages.get('card')![0].file, 'page.html');
	});

	it('fileElements', () => {
		const t1 = pt('<div><span></span></div>', 'a.html');
		const t2 = pt('<p></p>', 'b.html');
		const graph = buildUsageGraph([t1, t2]);

		ok(graph.fileElements.has('a.html'));
		ok(graph.fileElements.has('b.html'));
		strictEqual(graph.fileElements.get('a.html')!.length, 2);
		strictEqual(graph.fileElements.get('b.html')!.length, 1);
	});

	it('parent element', () => {
		const html = '<div><span b-part="card">content</span></div>';
		const t = pt(html, 'test.html');
		const graph = buildUsageGraph([t]);

		const usage = graph.usages.get('card')![0];
		ok(usage.parentElement);
		strictEqual(usage.parentElement!.tagName, 'div');
	});

	it('no partials', () => {
		const t = pt('<div><span>hello</span></div>', 'test.html');
		const graph = buildUsageGraph([t]);

		strictEqual(graph.definitions.size, 0);
		strictEqual(graph.usages.size, 0);
	});
});
