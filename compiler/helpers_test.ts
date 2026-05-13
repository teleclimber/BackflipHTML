import { assertEquals } from "jsr:@std/assert";

import type { RootTNode, RawTNode } from "./types.ts";
import { effectiveAttrNames, isCustomElementTagName, onText, parseBPartValue, pushRaw } from "./helpers.ts";
import { interpretBackcode } from "./backcode.ts";

// ---- isCustomElementTagName unit tests ----

Deno.test("isCustomElementTagName: empty string is not a custom element", () => {
	assertEquals(isCustomElementTagName(''), false);
});

Deno.test("isCustomElementTagName: plain HTML tag without hyphen is not a custom element", () => {
	assertEquals(isCustomElementTagName('div'), false);
	assertEquals(isCustomElementTagName('span'), false);
	assertEquals(isCustomElementTagName('h1'), false);
});

Deno.test("isCustomElementTagName: hyphenated lowercase tag is a custom element", () => {
	assertEquals(isCustomElementTagName('my-element'), true);
	assertEquals(isCustomElementTagName('app-header'), true);
	assertEquals(isCustomElementTagName('a-b-c'), true);
});

Deno.test("isCustomElementTagName: backflip directive tags (b-*) are excluded", () => {
	assertEquals(isCustomElementTagName('b-name'), false);
	assertEquals(isCustomElementTagName('b-unwrap'), false);
	assertEquals(isCustomElementTagName('b-foo'), false);
});

Deno.test("isCustomElementTagName: must start with a lowercase letter", () => {
	assertEquals(isCustomElementTagName('My-Element'), false);
	assertEquals(isCustomElementTagName('1my-element'), false);
	assertEquals(isCustomElementTagName('-my-element'), false);
});

Deno.test("isCustomElementTagName: hyphen is required", () => {
	assertEquals(isCustomElementTagName('myelement'), false);
});

Deno.test("isCustomElementTagName: digits allowed after the leading letter", () => {
	assertEquals(isCustomElementTagName('h1-header'), true);
	assertEquals(isCustomElementTagName('foo2-bar'), true);
});

// ---- parseBPartValue unit tests ----

Deno.test("parseBPartValue: same-file reference with #", () => {
	assertEquals(parseBPartValue('#header'), { partialName: 'header', file: null });
});

Deno.test("parseBPartValue: cross-file reference", () => {
	assertEquals(parseBPartValue('components.html#header'), { partialName: 'header', file: 'components.html' });
});

Deno.test("parseBPartValue: cross-file reference with subdirectory path", () => {
	assertEquals(parseBPartValue('path/to/file.html#card'), { partialName: 'card', file: 'path/to/file.html' });
});

Deno.test("parseBPartValue: bare name is same-file reference", () => {
	assertEquals(parseBPartValue('header'), { partialName: 'header', file: null });
});

Deno.test("parseBPartValue: empty string", () => {
	assertEquals(parseBPartValue(''), { partialName: '', file: null });
});

// ---- effectiveAttrNames unit tests ----

Deno.test("effectiveAttrNames: empty attrs yields empty list", () => {
	assertEquals(effectiveAttrNames([]), []);
});

Deno.test("effectiveAttrNames: plain attributes pass through unchanged", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'class', value: 'foo' }, { name: 'id', value: 'bar' }]),
		['class', 'id']
	);
});

Deno.test("effectiveAttrNames: b-name and b-export are excluded", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'b-name', value: 'x' }, { name: 'b-export', value: '' }, { name: 'class', value: 'c' }]),
		['class']
	);
});

Deno.test("effectiveAttrNames: control-flow directives are excluded", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-if', value: 'cond' },
			{ name: 'b-for', value: 'x in xs' },
			{ name: 'b-else', value: '' },
			{ name: 'b-else-if', value: 'cond' },
			{ name: 'class', value: 'c' },
		]),
		['class']
	);
});

Deno.test("effectiveAttrNames: partial/slot directives are excluded", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-part', value: 'foo' },
			{ name: 'b-slot', value: 'name' },
			{ name: 'b-in', value: 'name' },
			{ name: 'class', value: 'c' },
		]),
		['class']
	);
});

Deno.test("effectiveAttrNames: b-data: bindings are excluded", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-data:name', value: '' },
			{ name: 'b-data:title', value: 'expr' },
			{ name: 'class', value: 'c' },
		]),
		['class']
	);
});

Deno.test("effectiveAttrNames: b-bind:foo resolves to foo", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'b-bind:href', value: 'url' }]),
		['href']
	);
});

Deno.test("effectiveAttrNames: b-bind:foo~ resolves to foo (asset suffix stripped)", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'b-bind:src~', value: 'asset' }]),
		['src']
	);
});

Deno.test("effectiveAttrNames: :foo shorthand resolves to foo", () => {
	assertEquals(
		effectiveAttrNames([{ name: ':href', value: 'url' }]),
		['href']
	);
});

Deno.test("effectiveAttrNames: :foo~ shorthand resolves to foo (asset suffix stripped)", () => {
	assertEquals(
		effectiveAttrNames([{ name: ':src~', value: 'asset' }]),
		['src']
	);
});

Deno.test("effectiveAttrNames: foo~ asset shorthand resolves to foo", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'src~', value: '@images/x.png' }]),
		['src']
	);
});

Deno.test("effectiveAttrNames: mixed attrs preserve order and apply all rules", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-name', value: 'p' },
			{ name: 'class', value: 'c' },
			{ name: 'b-bind:href', value: 'url' },
			{ name: 'b-data:x', value: '1' },
			{ name: ':title', value: 't' },
			{ name: 'src~', value: '@a.png' },
			{ name: 'b-if', value: 'cond' },
			{ name: 'id', value: 'i' },
		]),
		['class', 'href', 'title', 'src', 'id']
	);
});

// ---- pushRaw unit tests ----

Deno.test("pushRaw: appends to existing raw node", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: 'hello', parent: root	};
	root.tnodes.push(child_node);

	const ret_node = pushRaw(root.tnodes[0], "world");
	const ret_raw = ret_node.type === 'raw' ? ret_node.raw : '';
	assertEquals(ret_raw, 'helloworld');
});

// ---- onText unit tests ----

Deno.test("onText: plain text appended to raw node", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'world');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: 'world',
			parent: root
		}]
	});
});

Deno.test("onText: single interpolation", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], '{{ g }}');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: '',
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('g'),
			parent: root
		}]
	});
});

Deno.test("onText: text before interpolation", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'hello {{ g }}');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: 'hello ',
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('g'),
			parent: root
		}]
	});
});

Deno.test("onText: text around interpolation", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'hello {{ g }} world');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: 'hello ',
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('g'),
			parent: root
		}, {
			type: 'raw',
			raw: ' world',
			parent: root
		}]
	});
});

Deno.test("onText: two interpolations with surrounding text", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'hello {{ g }}{{ k }} world');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: 'hello ',
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('g'),
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('k'),
			parent: root
		}, {
			type: 'raw',
			raw: ' world',
			parent: root
		}]
	});
});

Deno.test("onText: parentheses in expression", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], '{{ func() }}');

	assertEquals(root.tnodes.length, 2);
	assertEquals(root.tnodes[1].type, 'print');
});

Deno.test("onText: empty braces skipped", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'before{{  }}after');

	// Should skip the empty expression, treating it as raw text
	assertEquals(root.tnodes.length, 1);
	assertEquals((root.tnodes[0] as RawTNode).raw, 'before{{  }}after');
});
