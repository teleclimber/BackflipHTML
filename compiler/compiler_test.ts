import { assert, assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert";

import type { RootTNode, RawTNode, PrintTNode, ForTNode, IfTNode, SlotTNode, PartialRefTNode, AttrBindTNode, AssetRefTNode, SourceLoc, CompileOptions } from "./compiler.ts";
import { compileFile, effectiveAttrNames, isCustomElementTagName, onText, pushRaw, resolveAssetRefs } from "./compiler.ts";
import { interpretBackcode } from "./backcode.ts";

// ---- helpers ----

/** Helper: compile a snippet of HTML as a single partial via b-unwrap, returning the root and errors. */
async function compileSnippet(html: string): Promise<{ root: RootTNode, errors: import("./errors.ts").BackflipError[] }> {
	const { compiled, errors } = await compileFile(`<b-unwrap b-name="test">${html}</b-unwrap>`);
	const root = compiled.partials.get('test')!;
	return { root, errors };
}

function findPartialRef(root: RootTNode): PartialRefTNode {
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') return n as PartialRefTNode;
	}
	throw new Error("no partial-ref found");
}

function findForNode(root: RootTNode): ForTNode {
	for (const n of root.tnodes) {
		if (n.type === 'for') return n as ForTNode;
	}
	throw new Error("no for node found");
}

function findIfNode(root: RootTNode): IfTNode {
	for (const n of root.tnodes) {
		if (n.type === 'if') return n as IfTNode;
	}
	throw new Error("no if node found");
}

function findSlotNode(root: RootTNode): SlotTNode {
	for (const n of root.tnodes) {
		if (n.type === 'slot') return n as SlotTNode;
	}
	throw new Error("no slot node found");
}

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
			{ name: 'b-else-if', value: 'cond2' },
			{ name: 'class', value: 'c' },
		]),
		['class']
	);
});

Deno.test("effectiveAttrNames: partial/slot directives are excluded", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-part', value: 'x' },
			{ name: 'b-slot', value: 'header' },
			{ name: 'b-in', value: 'parent' },
			{ name: 'class', value: 'c' },
		]),
		['class']
	);
});

Deno.test("effectiveAttrNames: b-data: bindings are excluded", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-data:user', value: 'currentUser' },
			{ name: 'b-data:items', value: 'xs' },
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

// ---- compileSnippet: void elements ----

Deno.test("void elements: do not corrupt tag matching", async () => {
	const { root } = await compileSnippet('<div><br><span>hi</span></div>');
	// Should not throw - if br is pushed to tag_stack without being popped,
	// </span> would try to match <br> and fail
	const raw = root.tnodes[0] as RawTNode;
	assertEquals(raw.raw, '<div><br><span>hi</span></div>');
});

Deno.test("void elements: self-closing slash preserved", async () => {
	const { root } = await compileSnippet('<div><br /><img src="a.png" /></div>');
	const raw = root.tnodes[0] as RawTNode;
	assertEquals(raw.raw, '<div><br /><img src="a.png" /></div>');
});

Deno.test("void elements: self-closing slash preserved on attr-bind", async () => {
	const { compiled } = await compileFile('<div b-name="test"><img :src="url" /></div>');
	const root = compiled.partials.get('test')!;
	const node = root.tnodes[1] as AttrBindTNode;
	assertEquals(node.type, 'attr-bind');
	assertEquals(node.selfClosing, true);
});

Deno.test("void elements: non-self-closing has no selfClosing flag", async () => {
	const { compiled } = await compileFile('<div b-name="test"><img :src="url"></div>');
	const root = compiled.partials.get('test')!;
	const node = root.tnodes[1] as AttrBindTNode;
	assertEquals(node.type, 'attr-bind');
	assertEquals(node.selfClosing, undefined);
});

// ---- compileSnippet: b-for ----

Deno.test("b-for: tag reconstruction has space before attrs", async () => {
	const { root } = await compileSnippet('<div class="x" b-for="item in items">hello</div>');
	const for_node = root.tnodes[1] as ForTNode;
	const inner_raw = for_node.tnodes[0] as RawTNode;
	// The inner raw starts with the reconstructed opening tag
	assertEquals(inner_raw.raw.startsWith('<div class="x">'), true);
});

Deno.test("b-for: at root followed by more content", async () => {
	const { root } = await compileSnippet('<ul b-for="item in items"><li>hello</li></ul><p>after</p>');
	// Should have: empty raw, for_node, raw with <p>after</p>
	assertEquals(root.tnodes.length, 3);
	assertEquals(root.tnodes[1].type, 'for');
	const last = root.tnodes[2] as RawTNode;
	assertEquals(last.raw, '<p>after</p>');
});

Deno.test("b-for: without 'in' keyword reports error", async () => {
	const { errors } = await compileSnippet('<div b-for="items">hello</div>');
	assertEquals(errors.length > 0, true);
});

// ---- compileSnippet: b-if ----

Deno.test("b-if: simple", async () => {
	const { root } = await compileSnippet('<div b-if="show">hello</div>');
	assertEquals(root.tnodes.length, 2); // empty raw + if_node
	const if_node = root.tnodes[1] as IfTNode;
	assertEquals(if_node.type, 'if');
	assertEquals(if_node.branches.length, 1);
	assertEquals(if_node.branches[0].condition, interpretBackcode('show'));
	const inner = if_node.branches[0].tnodes[0] as RawTNode;
	assertEquals(inner.raw, '<div>hello</div>');
});

Deno.test("b-if: with b-else", async () => {
	const { root } = await compileSnippet('<div b-if="show">yes</div><div b-else>no</div>');
	const if_node = root.tnodes[1] as IfTNode;
	assertEquals(if_node.type, 'if');
	assertEquals(if_node.branches.length, 2);
	assertEquals(if_node.branches[0].condition, interpretBackcode('show'));
	assertEquals(if_node.branches[1].condition, undefined);
	const branch0 = if_node.branches[0].tnodes[0] as RawTNode;
	assertEquals(branch0.raw, '<div>yes</div>');
	const branch1 = if_node.branches[1].tnodes[0] as RawTNode;
	assertEquals(branch1.raw, '<div>no</div>');
});

Deno.test("b-if: with b-else-if and b-else", async () => {
	const { root } = await compileSnippet('<p b-if="a">1</p><p b-else-if="b">2</p><p b-else>3</p>');
	const if_node = root.tnodes[1] as IfTNode;
	assertEquals(if_node.branches.length, 3);
	assertEquals(if_node.branches[0].condition, interpretBackcode('a'));
	assertEquals(if_node.branches[1].condition, interpretBackcode('b'));
	assertEquals(if_node.branches[2].condition, undefined);
});

Deno.test("b-if: b-else without preceding b-if reports error", async () => {
	const { errors } = await compileSnippet('<div b-else>no</div>');
	assertEquals(errors.length > 0, true);
});

Deno.test("b-if: b-else-if without preceding b-if reports error", async () => {
	const { errors } = await compileSnippet('<div b-else-if="x">no</div>');
	assertEquals(errors.length > 0, true);
});

Deno.test("b-if: nested inside b-if", async () => {
	const { root } = await compileSnippet('<div b-if="a"><span b-if="b">inner</span></div>');
	const outer = root.tnodes[1] as IfTNode;
	assertEquals(outer.type, 'if');
	assertEquals(outer.branches.length, 1);
	assertEquals(outer.branches[0].condition, interpretBackcode('a'));
	// branch tnodes: raw "<div>", inner IfTNode, raw "</div>"
	assertEquals(outer.branches[0].tnodes.length, 3);
	const inner_if = outer.branches[0].tnodes[1] as IfTNode;
	assertEquals(inner_if.type, 'if');
	assertEquals(inner_if.branches.length, 1);
	assertEquals(inner_if.branches[0].condition, interpretBackcode('b'));
	const inner_raw = inner_if.branches[0].tnodes[0] as RawTNode;
	assertEquals(inner_raw.raw, '<span>inner</span>');
});

Deno.test("b-if: nested with b-else inside b-if", async () => {
	const { root } = await compileSnippet('<div b-if="a"><p b-if="b">yes</p><p b-else>no</p></div>');
	const outer = root.tnodes[1] as IfTNode;
	assertEquals(outer.branches.length, 1);
	const inner_if = outer.branches[0].tnodes[1] as IfTNode;
	assertEquals(inner_if.type, 'if');
	assertEquals(inner_if.branches.length, 2);
	assertEquals(inner_if.branches[0].condition, interpretBackcode('b'));
	assertEquals(inner_if.branches[1].condition, undefined);
});

Deno.test("b-if: nested inside b-for", async () => {
	const { root } = await compileSnippet('<div b-for="item in items"><span b-if="item.show">hi</span></div>');
	const for_node = root.tnodes[1] as ForTNode;
	assertEquals(for_node.type, 'for');
	// for tnodes: raw "<div>", IfTNode, raw "</div>"
	assertEquals(for_node.tnodes.length, 3);
	const inner_if = for_node.tnodes[1] as IfTNode;
	assertEquals(inner_if.type, 'if');
	assertEquals(inner_if.branches[0].condition, interpretBackcode('item.show'));
});

Deno.test("b-if: with content after", async () => {
	const { root } = await compileSnippet('<div b-if="show">hello</div><p>after</p>');
	assertEquals(root.tnodes.length, 3); // empty raw, if_node, raw with <p>after</p>
	assertEquals(root.tnodes[1].type, 'if');
	const last = root.tnodes[2] as RawTNode;
	assertEquals(last.raw, '<p>after</p>');
});

// ---- compileFile: partials ----

Deno.test("compileFile: single partial with b-name on a div", async () => {
	const { compiled: result } = await compileFile('<div b-name="hero">Hello</div>');
	assertEquals(result.partials.size, 1);
	const root = result.partials.get("hero")!;
	assertEquals(root.type, 'root');
	// First tnode should be raw starting with '<div>'
	const first = root.tnodes[0] as RawTNode;
	assertEquals(first.type, 'raw');
	assertEquals(first.raw.startsWith('<div>'), true);
});

Deno.test("compileFile: b-name on b-unwrap (partial without wrapper element)", async () => {
	const { compiled: result } = await compileFile('<b-unwrap b-name="inner">content</b-unwrap>');
	assertEquals(result.partials.size, 1);
	const root = result.partials.get("inner")!;
	assertEquals(root.type, 'root');
	// Should have some raw content but no <b-unwrap> tag emitted
	const allRaw = root.tnodes.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertEquals(allRaw.includes('b-unwrap'), false);
	assertEquals(allRaw.includes('content'), true);
});

Deno.test("compileFile: b-name not at top level reports error", async () => {
	const { errors } = await compileFile('<div b-name="outer"><span b-name="inner">text</span></div>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "b-name is only allowed on top-level elements");
});

Deno.test("compileFile: b-if on partial definition reports error", async () => {
	const { errors } = await compileFile('<div b-name="x" b-if="cond">A</div>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "b-if is not allowed on a partial definition");
});

Deno.test("compileFile: b-for on partial definition reports error", async () => {
	const { errors } = await compileFile('<div b-name="x" b-for="i in items">A</div>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "b-for is not allowed on a partial definition");
});

Deno.test("compileFile: b-else on partial definition reports error", async () => {
	const { errors } = await compileFile('<div b-name="x" b-else>A</div>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "b-else is not allowed on a partial definition");
});

Deno.test("compileFile: top-level custom element is treated as a partial definition", async () => {
	const { compiled, errors } = await compileFile('<my-card>content</my-card>');
	assertEquals(errors.length, 0);
	assertEquals(compiled.partials.size, 1);
	const root = compiled.partials.get('my-card');
	assertExists(root);
	assertEquals(root.customElement, true);
	assertEquals(root.exported, false);
});

Deno.test("compileFile: top-level custom element with b-export is exported", async () => {
	const { compiled, errors } = await compileFile('<my-card b-export>content</my-card>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-card');
	assertExists(root);
	assertEquals(root.exported, true);
	assertEquals(root.customElement, true);
});

Deno.test("compileFile: top-level custom element with b-if reports error", async () => {
	const { errors } = await compileFile('<my-card b-if="cond">x</my-card>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "b-if is not allowed on a partial definition");
});

Deno.test("compileFile: top-level custom element with b-for reports error", async () => {
	const { errors } = await compileFile('<my-card b-for="i in items">x</my-card>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "b-for is not allowed on a partial definition");
});

Deno.test("compileFile: mixing b-name partials and custom element partials in one file", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page">A</div><my-card>B</my-card>');
	assertEquals(errors.length, 0);
	assertEquals(compiled.partials.size, 2);
	assertEquals(compiled.partials.get('page')?.customElement, undefined);
	assertEquals(compiled.partials.get('my-card')?.customElement, true);
});

Deno.test("compileFile: cross-style same-file collision reports error", async () => {
	const { errors } = await compileFile('<my-card>A</my-card><div b-name="my-card">B</div>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, 'my-card');
	assertStringIncludes(errors[0].message, 'already defined');
});

Deno.test("compileFile: duplicate b-name in same file reports error", async () => {
	const { errors } = await compileFile('<div b-name="card">A</div><div b-name="card">B</div>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, 'card');
	assertStringIncludes(errors[0].message, 'already defined');
});

Deno.test("compileFile: nested custom element is not treated as a partial definition", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card>x</my-card></div>');
	assertEquals(errors.length, 0);
	assertEquals(compiled.partials.size, 1);
	assertEquals(compiled.partials.has('page'), true);
	assertEquals(compiled.partials.has('my-card'), false);
});

Deno.test("compileFile: b-* directive tag (e.g. b-unwrap) is not a custom element partial", async () => {
	const { compiled, errors } = await compileFile('<b-unwrap b-name="x">y</b-unwrap>');
	assertEquals(errors.length, 0);
	assertEquals(compiled.partials.size, 1);
	assertEquals(compiled.partials.get('x')?.customElement, undefined);
});

Deno.test("compileFile: nested custom element creates a partial-ref call site", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card>x</my-card></div>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	assertEquals(found.customElement, true);
	assertEquals(found.partialName, 'my-card');
	assertEquals(found.callerTagName, 'my-card');
});

Deno.test("compileFile: custom element call captures b-data:* bindings", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card b-data:title="post.title">x</my-card></div>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	assertEquals(found.bindings.length, 1);
	assertEquals(found.bindings[0].name, 'title');
});

Deno.test("compileFile: custom element call captures default slot content from children", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card>hello world</my-card></div>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	const defaultSlot = found.slots['default'];
	assertExists(defaultSlot);
	const txt = defaultSlot.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertStringIncludes(txt, 'hello world');
});

Deno.test("compileFile: custom element call captures named slot via b-in", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card><b-unwrap b-in="title">Hi</b-unwrap></my-card></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	assertEquals('title' in found.slots, true);
});

Deno.test("compileFile: custom element partial body excludes the wrapping tag", async () => {
	const { compiled, errors } = await compileFile('<my-card class="card">body</my-card>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-card')!;
	// Body should not include `<my-card>` open or `</my-card>` close
	const allRaw = root.tnodes.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertEquals(allRaw.includes('<my-card'), false);
	assertEquals(allRaw.includes('</my-card>'), false);
	assertStringIncludes(allRaw, 'body');
});

Deno.test("compileFile: custom element partial stores definitionAttrNodes for attrs", async () => {
	const { compiled, errors } = await compileFile('<my-card class="card" id="main">body</my-card>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-card')!;
	assertExists(root.definitionAttrNodes);
	const rendered = root.definitionAttrNodes.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertStringIncludes(rendered, 'class="card"');
	assertStringIncludes(rendered, 'id="main"');
	assertEquals(rendered.includes('<my-card'), false);
	assertEquals(rendered.endsWith('>'), false);
});

Deno.test("compileFile: custom element call site stores callerOpenTag in attrs-only form", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card data-x="1"></my-card></div>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	assertExists(found.callerOpenTag);
	const rendered = found.callerOpenTag.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertStringIncludes(rendered, 'data-x="1"');
	assertEquals(rendered.includes('<my-card'), false);
	assertEquals(rendered.endsWith('>'), false);
});

// ---- compileFile: b-attr on custom element partial definitions ----

Deno.test("compileFile: b-attr declarations populate partialRoot.bAttrs", async () => {
	const { compiled, errors } = await compileFile('<my-widget b-attr:premium b-attr:checked.bool>body</my-widget>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-widget');
	assertExists(root);
	assertExists(root.bAttrs);
	assertEquals(root.bAttrs.length, 2);
	assertEquals(root.bAttrs[0].name, 'premium');
	assertEquals(root.bAttrs[0].isBool, false);
	assertEquals(root.bAttrs[1].name, 'checked');
	assertEquals(root.bAttrs[1].isBool, true);
});

Deno.test("compileFile: b-attr with a value reports error", async () => {
	const { errors } = await compileFile('<my-widget b-attr:premium="x">body</my-widget>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "does not accept a value");
});

Deno.test("compileFile: b-attr with unknown modifier reports error", async () => {
	const { errors } = await compileFile('<my-widget b-attr:premium.weird>body</my-widget>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "unknown b-attr modifier");
	assertStringIncludes(errors[0].message, "weird");
});

Deno.test("compileFile: b-attr conflicts with plain attribute on definition tag", async () => {
	const { errors } = await compileFile('<my-widget b-attr:premium premium="x">body</my-widget>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "premium");
	assertStringIncludes(errors[0].message, "conflicts with b-attr:premium");
});

Deno.test("compileFile: b-attr conflicts with bind attribute on definition tag", async () => {
	const { errors } = await compileFile('<my-widget b-attr:premium :premium="x">body</my-widget>');
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors[0].message, "premium");
	assertStringIncludes(errors[0].message, "conflicts with b-attr:premium");
});

Deno.test("compileFile: b-attr on b-name partial definition is an error", async () => {
	const { errors } = await compileFile('<article b-name="post" b-attr:foo>body</article>');
	assertEquals(errors.length > 0, true);
	const msgs = errors.map(e => e.message).join(' | ');
	assertStringIncludes(msgs, "b-attr is only allowed on custom element partial definitions");
});

Deno.test("compileFile: b-attr on a custom element call site is an error", async () => {
	const { errors } = await compileFile('<div b-name="page"><my-widget b-attr:foo></my-widget></div>');
	assertEquals(errors.length > 0, true);
	const msgs = errors.map(e => e.message).join(' | ');
	assertStringIncludes(msgs, "b-attr is only allowed on custom element partial definitions");
});

Deno.test("compileFile: b-attr on a nested element is an error", async () => {
	const { errors } = await compileFile('<my-widget><span b-attr:foo>x</span></my-widget>');
	assertEquals(errors.length > 0, true);
	const msgs = errors.map(e => e.message).join(' | ');
	assertStringIncludes(msgs, "b-attr is only allowed on custom element partial definitions");
});

Deno.test("compileFile: b-attr on a b-part call is an error", async () => {
	const { errors } = await compileFile('<div b-name="page"><div b-part="#hero" b-attr:foo></div></div>');
	assertEquals(errors.length > 0, true);
	const msgs = errors.map(e => e.message).join(' | ');
	assertStringIncludes(msgs, "b-attr is only allowed on custom element partial definitions");
});

Deno.test("compileFile: b-attr with uppercase letters in name produces warning", async () => {
	const { errors } = await compileFile('<my-widget b-attr:fooBar>body</my-widget>');
	const warnings = errors.filter(e => e.severity === 'warning');
	const fatal = errors.filter(e => e.severity !== 'warning');
	assertEquals(fatal.length, 0);
	assertEquals(warnings.length, 1);
	assertStringIncludes(warnings[0].message, 'fooBar');
	assertStringIncludes(warnings[0].message, 'uppercase');
});

Deno.test("compileFile: b-attr with all uppercase letters in name produces warning", async () => {
	const { errors } = await compileFile('<my-widget b-attr:PREMIUM>body</my-widget>');
	const warnings = errors.filter(e => e.severity === 'warning');
	assertEquals(warnings.length, 1);
	assertStringIncludes(warnings[0].message, 'PREMIUM');
});

Deno.test("compileFile: b-attr with uppercase letters and .bool modifier produces warning", async () => {
	const { errors } = await compileFile('<my-widget b-attr:isPremium.bool>body</my-widget>');
	const warnings = errors.filter(e => e.severity === 'warning');
	const fatal = errors.filter(e => e.severity !== 'warning');
	assertEquals(fatal.length, 0);
	assertEquals(warnings.length, 1);
	assertStringIncludes(warnings[0].message, 'isPremium');
});

Deno.test("compileFile: b-attr with all-lowercase name produces no uppercase warning", async () => {
	const { errors } = await compileFile('<my-widget b-attr:premium b-attr:foo-bar.bool>body</my-widget>');
	assertEquals(errors.length, 0);
});

Deno.test("compileFile: b-attr declared name is excluded from definitionAttrNames", async () => {
	const { compiled, errors } = await compileFile('<my-widget b-attr:premium class="card">body</my-widget>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-widget');
	assertExists(root);
	assertExists(root.definitionAttrNames);
	assertEquals(root.definitionAttrNames.includes('premium'), false);
	assertEquals(root.definitionAttrNames.includes('class'), true);
});

Deno.test("compileFile: call site captures callerAttrInfos for plain and bind attrs", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-widget :premium="isPremium" foo="y"></my-widget></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	assertExists(found.callerAttrInfos);
	const premium = found.callerAttrInfos.find(a => a.name === 'premium');
	const foo = found.callerAttrInfos.find(a => a.name === 'foo');
	assertExists(premium);
	assertExists(foo);
	assertEquals(premium.kind, 'expr');
	assertEquals(premium.value, 'isPremium');
	assertExists(premium.expr);
	assertEquals(foo.kind, 'plain');
	assertEquals(foo.value, 'y');
	assertEquals(foo.expr, undefined);
});

Deno.test("compileFile: call site captures bare attribute as plain with empty value", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-widget premium></my-widget></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	assertExists(found.callerAttrInfos);
	const premium = found.callerAttrInfos.find(a => a.name === 'premium');
	assertExists(premium);
	assertEquals(premium.kind, 'plain');
	assertEquals(premium.value, '');
});

Deno.test("compileFile: b-attr declarations are not rendered on definition open tag", async () => {
	const { compiled, errors } = await compileFile(
		'<my-widget b-attr:premium b-attr:checked.bool class="card">body</my-widget>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-widget')!;
	assertExists(root.definitionAttrNodes);
	const rendered = root.definitionAttrNodes.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertEquals(rendered.includes('b-attr'), false);
	assertStringIncludes(rendered, 'class="card"');
});

Deno.test("compileFile: b-attr declarations are not rendered on call-site open tag", async () => {
	// b-attr on the call site is an error, but we also want to confirm that even
	// when downstream code rebuilds the rendered open-tag from a definition that
	// has b-attr declarations, the call-site does not reflect them. This test uses
	// the call site of a custom element with no b-attr on it; it just confirms
	// that callerOpenTag never contains 'b-attr' text.
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-widget data-x="1"></my-widget></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	assertExists(found.callerOpenTag);
	const rendered = found.callerOpenTag.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertEquals(rendered.includes('b-attr'), false);
});

Deno.test("compileFile: multiple partials in one file", async () => {
	const { compiled: result } = await compileFile('<div b-name="first">A</div><div b-name="second">B</div>');
	assertEquals(result.partials.size, 2);
	assertEquals(result.partials.has("first"), true);
	assertEquals(result.partials.has("second"), true);
});

// ---- compileFile: b-part ----

Deno.test("compileFile: b-part same-file reference creates PartialRefTNode with correct file=null and partialName", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><div b-part="#hero"></div></div>');
	const root = result.partials.get("page")!;
	// Find the PartialRefTNode
	const ref = root.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode | undefined;
	// it might be nested inside the opening raw node; search all tnodes
	const allNodes = root.tnodes;
	let found: PartialRefTNode | undefined;
	for (const n of allNodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertEquals(found !== undefined, true);
	assertEquals(found!.file, null);
	assertEquals(found!.partialName, "hero");
});

Deno.test("compileFile: b-part with b-unwrap creates wrapper=null", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"></b-unwrap></div>');
	const root = result.partials.get("page")!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertEquals(found !== undefined, true);
	assertEquals(found!.wrapper, null);
});

Deno.test("compileFile: b-part with regular element creates wrapper with open/close tags", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><section class="x" b-part="#card"></section></div>');
	const root = result.partials.get("page")!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertEquals(found !== undefined, true);
	assertEquals(found!.wrapper !== null, true);
	assertEquals(found!.wrapper!.open.includes('<section'), true);
	assertEquals(found!.wrapper!.close, '</section>');
	// b-part attr should NOT be in open tag
	assertEquals(found!.wrapper!.open.includes('b-part'), false);
});

Deno.test("compileFile: b-data: creates bindings on PartialRefTNode", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><b-unwrap b-part="#card" b-data:title="item.title"></b-unwrap></div>');
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	assertEquals(ref!.bindings.length, 1);
	assertEquals(ref!.bindings[0].name, "title");
	assertEquals(ref!.bindings[0].data!.vars.includes("item"), true);
});

// ---- compileFile: slots ----

Deno.test("compileFile: b-slot creates SlotTNode", async () => {
	const { compiled: result } = await compileFile('<div b-name="card"><b-unwrap b-slot="title"></b-unwrap></div>');
	const root = result.partials.get("card")!;
	let found: SlotTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'slot') { found = n as SlotTNode; break; }
	}
	assertEquals(found !== undefined, true);
	assertEquals(found!.name, "title");
});

Deno.test("compileFile: b-slot with no value creates SlotTNode with undefined name", async () => {
	const { compiled: result } = await compileFile('<div b-name="card"><b-unwrap b-slot></b-unwrap></div>');
	const root = result.partials.get("card")!;
	let found: SlotTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'slot') { found = n as SlotTNode; break; }
	}
	assertEquals(found !== undefined, true);
	assertEquals(found!.name, undefined);
});

Deno.test("compileFile: non-b-unwrap b-slot followed by text compiles cleanly", async () => {
	// Regression: closing tag of a non-b-unwrap b-slot used to leave cur_tnode pointing
	// at the partial RootTNode; the next text token then threw "expected tnodes here".
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><span b-slot></span>tail</div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get("page")!;
	const slotIdx = root.tnodes.findIndex(n => n.type === 'slot');
	assertEquals(slotIdx >= 0, true);
	// The trailing "tail" must land as a sibling of the slot inside the root.
	const trailing = root.tnodes.slice(slotIdx + 1)
		.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertEquals(trailing.includes('tail'), true);
});

Deno.test("compileFile: default slot content captured", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p>default content</p></b-unwrap></div>');
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	const defaultSlot = ref!.slots['default'];
	assertEquals(defaultSlot !== undefined, true);
	// Should contain raw node with <p>default content</p>
	const allRaw = defaultSlot.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertEquals(allRaw.includes('<p>'), true);
	assertEquals(allRaw.includes('default content'), true);
});

Deno.test("compileFile: named slot with b-in", async () => {
	const { compiled: result } = await compileFile(
		'<div b-name="page"><b-unwrap b-part="#card"><b-unwrap b-in="header"><h1>Title</h1></b-unwrap></b-unwrap></div>'
	);
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	const headerSlot = ref!.slots['header'];
	assertEquals(headerSlot !== undefined, true);
	const allRaw = headerSlot.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertEquals(allRaw.includes('Title'), true);
});

Deno.test("compileFile: div b-part with no content does not create spurious default slot", async () => {
	const { compiled: result } = await compileFile(
		'<div b-name="page"><div class="leaderboard" b-part="#leaderboard"></div></div>'
	);
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	// The default slot should have no content (or be empty raw nodes)
	const defaultSlot = ref!.slots['default'];
	if (defaultSlot) {
		const allRaw = defaultSlot.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
		assertEquals(allRaw.trim(), '');
	}
});

Deno.test("compileFile: named slot with b-in on regular element", async () => {
	const { compiled: result } = await compileFile(
		'<div b-name="page"><b-unwrap b-part="#card"><div b-in="header"><h1>Title</h1></div></b-unwrap></div>'
	);
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	const headerSlot = ref!.slots['header'];
	assertEquals(headerSlot !== undefined, true);
	const allRaw = headerSlot.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	// The wrapping <div> should be preserved in slot content
	assertEquals(allRaw.includes('<div>'), true);
	assertEquals(allRaw.includes('</div>'), true);
	assertEquals(allRaw.includes('Title'), true);
});

// ---- compileFile: slot content (interpolation, b-for, b-if) ----

Deno.test("compileFile: interpolation inside nested element within slot content produces PrintTNode in slot", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p>{{ name }}</p></b-unwrap></div>');
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	const defaultSlot = ref!.slots['default'];
	assertEquals(defaultSlot !== undefined, true);
	const hasPrint = defaultSlot.some(n => n.type === 'print');
	assertEquals(hasPrint, true, "slot should contain a PrintTNode for the {{ name }} interpolation");
});

Deno.test("compileFile: b-for inside slot content produces ForTNode in slot array", async () => {
	const { compiled: result, errors } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p b-for="x in items">{{ x }}</p></b-unwrap></div>');
	assertEquals(errors.length, 0);
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	const defaultSlot = ref!.slots['default'];
	assertEquals(defaultSlot !== undefined, true);
	const forNode = defaultSlot.find(n => n.type === 'for') as ForTNode | undefined;
	assertEquals(forNode !== undefined, true, "slot should contain a ForTNode");
	assertEquals(forNode!.valName, "x");
	// The print node should be inside the for body, not a sibling in the slot array
	const hasPrint = forNode!.tnodes.some(n => n.type === 'print');
	assertEquals(hasPrint, true, "ForTNode should contain the {{ x }} PrintTNode");
});

Deno.test("compileFile: b-if/b-else inside slot content produces IfTNode in slot array", async () => {
	const { compiled: result, errors } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p b-if="show">yes</p><p b-else>no</p></b-unwrap></div>');
	assertEquals(errors.length, 0);
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	const defaultSlot = ref!.slots['default'];
	assertEquals(defaultSlot !== undefined, true);
	const ifNode = defaultSlot.find(n => n.type === 'if') as IfTNode | undefined;
	assertEquals(ifNode !== undefined, true, "slot should contain an IfTNode");
	assertEquals(ifNode!.branches.length, 2, "IfTNode should have b-if and b-else branches");
});

// ---- compileFile: bind attrs ----

Deno.test("compileFile: bind attr on b-name root element produces AttrBindTNode", async () => {
	const { compiled: result, errors } = await compileFile('<div b-name="card" :class="cls">Hello</div>');
	assertEquals(errors.length, 0);
	const root = result.partials.get("card")!;
	const first = root.tnodes[0];
	assertEquals(first.type, 'attr-bind', "root element with :class should produce an attr-bind node, not raw");
	const ab = first as AttrBindTNode;
	assertEquals(ab.tagOpen, '<div');
	const dynamicPart = ab.parts.find(p => p.type === 'dynamic');
	assertEquals(dynamicPart !== undefined, true, "should have a dynamic part for :class");
	assertEquals(dynamicPart!.name, 'class');
});

Deno.test("compileFile: bind attr on b-name root element excludes b-name and b-export attrs", async () => {
	const { compiled: result, errors } = await compileFile('<div b-name="card" b-export :class="cls" id="x">Hello</div>');
	assertEquals(errors.length, 0);
	const root = result.partials.get("card")!;
	const first = root.tnodes[0] as AttrBindTNode;
	assertEquals(first.type, 'attr-bind');
	// b-name and b-export should not appear in parts
	const allStatic = first.parts.filter(p => p.type === 'static').map(p => p.raw).join('');
	assertEquals(allStatic.includes('b-name'), false, "b-name should be excluded");
	assertEquals(allStatic.includes('b-export'), false, "b-export should be excluded");
	assertEquals(allStatic.includes('id="x"'), true, "static attrs should be preserved");
});

// ---- PartialMeta tests ----

Deno.test("meta: fragment-level partial has correct startOffset, endOffset, isDocumentLevel=false", async () => {
	const src = '<div b-name="card"><p>hello</p></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("card")!;
	const meta = root.meta!;
	assertEquals(meta.startOffset, 0);
	assertEquals(meta.endOffset, src.length);
	assertEquals(meta.startLine, 1);
	assertEquals(meta.startCol, 1);
	assertEquals(meta.isDocumentLevel, false);
});

Deno.test("meta: document-level partial (html tag) has isDocumentLevel=true", async () => {
	const src = '<html b-name="page"><head><title>Hi</title></head><body><div>content</div></body></html>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const meta = root.meta!;
	assertEquals(meta.isDocumentLevel, true);
	assertEquals(meta.startOffset, 0);
	assertEquals(meta.endOffset, src.length);
});

Deno.test("meta: document-level partial (body tag as b-name element)", async () => {
	const src = '<body b-name="page"><div>content</div></body>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	assertEquals(root.meta!.isDocumentLevel, true);
});

Deno.test("meta: document-level partial (contains body as descendant)", async () => {
	const src = '<b-unwrap b-name="page"><html><body><div>content</div></body></html></b-unwrap>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	assertEquals(root.meta!.isDocumentLevel, true);
});

Deno.test("meta: multiple partials in one file have separate meta", async () => {
	const src = '<div b-name="header"><h1>hi</h1></div>\n<div b-name="footer"><p>bye</p></div>';
	const { compiled: result } = await compileFile(src);
	const header = result.partials.get("header")!;
	const footer = result.partials.get("footer")!;
	assertEquals(header.meta!.startOffset, 0);
	assertEquals(header.meta!.endOffset, src.indexOf('</div>') + '</div>'.length);
	assertEquals(footer.meta!.startOffset, src.indexOf('<div b-name="footer">'));
	assertEquals(footer.meta!.endOffset, src.length);
	assertEquals(header.meta!.isDocumentLevel, false);
	assertEquals(footer.meta!.isDocumentLevel, false);
});

Deno.test("meta: partial on second line has correct startLine/startCol", async () => {
	const src = '\n<div b-name="card"><p>hello</p></div>';
	const { compiled: result } = await compileFile(src);
	const meta = result.partials.get("card")!.meta!;
	assertEquals(meta.startLine, 2);
	assertEquals(meta.startCol, 1);
});

// ---- Source location tests ----

Deno.test("loc: b-name attribute location on RootTNode", async () => {
	const src = '<div b-name="hero">Hello</div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("hero")!;
	const loc = root.loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-name=');
	assertEquals(loc.startOffset, expected);
	assertEquals(loc.startLine, 1);
	assertEquals(loc.startCol, expected + 1); // 1-based
	// endOffset should point past the closing quote of b-name="hero"
	const endExpected = src.indexOf('b-name=') + 'b-name="hero"'.length;
	assertEquals(loc.endOffset, endExpected);
});

Deno.test("loc: b-part same-file PartialRefTNode location", async () => {
	const src = '<div b-name="page"><div b-part="#hero"></div></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	const loc = ref.loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-part=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + 'b-part="#hero"'.length;
	assertEquals(loc.endOffset, endExpected);
});

Deno.test("loc: b-part cross-file PartialRefTNode location", async () => {
	const src = '<div b-name="page"><div b-part="other.html#bar"></div></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	const loc = ref.loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-part=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + 'b-part="other.html#bar"'.length;
	assertEquals(loc.endOffset, endExpected);
});

Deno.test("loc: b-for attribute location on ForTNode", async () => {
	const src = '<div b-name="page"><div b-for="item in items">hi</div></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const forNode = findForNode(root);
	const loc = forNode.loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-for=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + 'b-for="item in items"'.length;
	assertEquals(loc.endOffset, endExpected);
});

Deno.test("loc: b-if attribute location on first IfBranch", async () => {
	const src = '<div b-name="page"><div b-if="cond">yes</div></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const ifNode = findIfNode(root);
	const loc = ifNode.branches[0].loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-if=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + 'b-if="cond"'.length;
	assertEquals(loc.endOffset, endExpected);
});

Deno.test("loc: b-else-if attribute location on second IfBranch", async () => {
	const src = '<div b-name="page"><div b-if="cond">yes</div><div b-else-if="cond2">maybe</div></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const ifNode = findIfNode(root);
	const loc = ifNode.branches[1].loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-else-if=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + 'b-else-if="cond2"'.length;
	assertEquals(loc.endOffset, endExpected);
});

Deno.test("loc: b-else attribute location on third IfBranch", async () => {
	const src = '<div b-name="page"><div b-if="cond">yes</div><div b-else-if="cond2">maybe</div><div b-else>no</div></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const ifNode = findIfNode(root);
	const loc = ifNode.branches[2].loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-else>');
	assertEquals(loc.startOffset, expected);
});

Deno.test("loc: b-slot attribute location on SlotTNode", async () => {
	const src = '<div b-name="card"><b-unwrap b-slot="title"></b-unwrap></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("card")!;
	const slotNode = findSlotNode(root);
	const loc = slotNode.loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-slot=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + 'b-slot="title"'.length;
	assertEquals(loc.endOffset, endExpected);
});

Deno.test("loc: b-slot with no value attribute location", async () => {
	const src = '<div b-name="card"><b-unwrap b-slot></b-unwrap></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("card")!;
	const slotNode = findSlotNode(root);
	const loc = slotNode.loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-slot');
	assertEquals(loc.startOffset, expected);
});

Deno.test("loc: {{ expr }} interpolation in text", async () => {
	const src = '<div b-name="page">hello {{ myVar }} world</div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	// Find PrintTNode
	let printNode: { type: string; loc?: SourceLoc } | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'print') { printNode = n; break; }
	}
	assertEquals(printNode !== undefined, true);
	const loc = printNode!.loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('{{ myVar }}');
	assertEquals(loc.startOffset, expected);
	assertEquals(loc.endOffset, expected + '{{ myVar }}'.length);
	assertEquals(loc.startLine, 1);
});

Deno.test("loc: {{ expr }} after newline increments line", async () => {
	const src = '<div b-name="page">line1\n{{ myVar }}</div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	let printNode: { type: string; loc?: SourceLoc } | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'print') { printNode = n; break; }
	}
	assertEquals(printNode !== undefined, true);
	const loc = printNode!.loc!;
	assertEquals(loc !== undefined, true);
	assertEquals(loc.startLine, 2);
	assertEquals(loc.startCol, 1);
	const expected = src.indexOf('{{ myVar }}');
	assertEquals(loc.startOffset, expected);
});

Deno.test("loc: :href bind attr dynamic part location", async () => {
	const src = '<div b-name="page"><a :href="url">link</a></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	let attrBindNode: AttrBindTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'attr-bind') { attrBindNode = n as AttrBindTNode; break; }
	}
	assertEquals(attrBindNode !== undefined, true);
	const dynPart = attrBindNode!.parts.find(p => p.type === 'dynamic');
	assertEquals(dynPart !== undefined, true);
	const loc = (dynPart as { loc?: SourceLoc }).loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf(':href=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + ':href="url"'.length;
	assertEquals(loc.endOffset, endExpected);
});

Deno.test("loc: b-bind:class bind attr dynamic part location", async () => {
	const src = '<div b-name="page"><span b-bind:class="cls">text</span></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	let attrBindNode: AttrBindTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'attr-bind') { attrBindNode = n as AttrBindTNode; break; }
	}
	assertEquals(attrBindNode !== undefined, true);
	const dynPart = attrBindNode!.parts.find(p => p.type === 'dynamic');
	assertEquals(dynPart !== undefined, true);
	const loc = (dynPart as { loc?: SourceLoc }).loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-bind:class=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + 'b-bind:class="cls"'.length;
	assertEquals(loc.endOffset, endExpected);
});

// ---- includeLocs tests ----

Deno.test("includeLocs: regular element gets data-loc attribute", async () => {
	const src = '<div b-name="card"><p>hello</p></div>';
	const { compiled } = await compileFile(src, undefined, 'test.html', { includeLocs: true });
	const root = compiled.partials.get("card")!;
	// All raw content merges into tnodes[0] — check for <p with data-loc
	const rawNode = root.tnodes[0] as RawTNode;
	assertEquals(rawNode.type, 'raw');
	assertStringIncludes(rawNode.raw, '<p data-loc="test.html#card:1:');
});

Deno.test("includeLocs: b-name root element gets data-loc attribute", async () => {
	const src = '<section b-name="hero"><h1>Title</h1></section>';
	const { compiled } = await compileFile(src, undefined, 'pages.html', { includeLocs: true });
	const root = compiled.partials.get("hero")!;
	const rawNode = root.tnodes[0] as RawTNode;
	assertEquals(rawNode.type, 'raw');
	assertStringIncludes(rawNode.raw, '<section data-loc="pages.html#hero:1:');
});

Deno.test("includeLocs: element with bind attr gets data-loc in static part", async () => {
	const src = '<div b-name="card"><a :href="url">link</a></div>';
	const { compiled } = await compileFile(src, undefined, 'test.html', { includeLocs: true });
	const root = compiled.partials.get("card")!;
	// tnodes[0] is the div open tag (raw), tnodes[1] is the <a> (attr-bind)
	const aNode = root.tnodes[1] as AttrBindTNode;
	assertEquals(aNode.type, 'attr-bind');
	const staticParts = aNode.parts.filter(p => p.type === 'static');
	const hasLoc = staticParts.some(p => p.raw.includes('data-loc="test.html#card:1:'));
	assertEquals(hasLoc, true);
});

Deno.test("includeLocs: b-for element gets data-loc attribute", async () => {
	const src = '<ul b-name="list"><li b-for="item in items">{{ item }}</li></ul>';
	const { compiled } = await compileFile(src, undefined, 'test.html', { includeLocs: true });
	const root = compiled.partials.get("list")!;
	// tnodes[0] is <ul> raw, tnodes[1] is for node
	const forNode = root.tnodes[1] as ForTNode;
	assertEquals(forNode.type, 'for');
	const liNode = forNode.tnodes[0] as RawTNode;
	assertEquals(liNode.type, 'raw');
	assertStringIncludes(liNode.raw, 'data-loc="test.html#list:1:');
});

Deno.test("includeLocs: b-if element gets data-loc attribute", async () => {
	const src = '<div b-name="card"><span b-if="show">visible</span></div>';
	const { compiled } = await compileFile(src, undefined, 'test.html', { includeLocs: true });
	const root = compiled.partials.get("card")!;
	// tnodes[0] is <div> raw, tnodes[1] is if node
	const ifNode = root.tnodes[1] as IfTNode;
	assertEquals(ifNode.type, 'if');
	const spanNode = ifNode.branches[0].tnodes[0] as RawTNode;
	assertEquals(spanNode.type, 'raw');
	assertStringIncludes(spanNode.raw, 'data-loc="test.html#card:1:');
});

Deno.test("includeLocs: disabled by default", async () => {
	const src = '<div b-name="card"><p>hello</p></div>';
	const { compiled } = await compileFile(src, undefined, 'test.html');
	const root = compiled.partials.get("card")!;
	const rawNode = root.tnodes[0] as RawTNode;
	assertEquals(rawNode.raw.includes('data-loc'), false);
});

Deno.test("includeLocs: format is file#partial:line:col", async () => {
	const src = '<div b-name="card"><p>hello</p></div>';
	const { compiled } = await compileFile(src, undefined, 'partials/card.html', { includeLocs: true });
	const root = compiled.partials.get("card")!;
	const rawNode = root.tnodes[0] as RawTNode;
	// Should match pattern: partials/card.html#card:line:col
	const match = rawNode.raw.match(/data-loc="partials\/card\.html#card:\d+:\d+"/);
	assertEquals(match !== null, true);
});

// ---- asset attribute tests ----

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const ASSET_TMPDIR = '/tmp/claude-1000/';

async function makeAssetFixture(): Promise<{ assetMap: Map<string, string>, assetDirs: Map<string, string>, dir: string }> {
	const dir = path.join(ASSET_TMPDIR, `asset_test_${Date.now()}`);
	const imgDir = path.join(dir, 'images');
	await fs.mkdir(imgDir, { recursive: true });
	await fs.writeFile(path.join(imgDir, 'photo.jpg'), 'fake-image');
	await fs.writeFile(path.join(imgDir, 'icon.png'), 'fake-icon');
	await fs.mkdir(path.join(imgDir, 'sub'), { recursive: true });
	await fs.writeFile(path.join(imgDir, 'sub', 'nested.jpg'), 'fake-nested');
	const assetMap = new Map([['images', '/img/']]);
	const assetDirs = new Map([['images', imgDir]]);
	return { assetMap, assetDirs, dir };
}

Deno.test("asset: static src~ produces AssetRefTNode in stage 1", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const assetRefs = root.tnodes.filter(n => n.type === 'asset-ref') as AssetRefTNode[];
	assertEquals(assetRefs.length, 1);
	assertEquals(assetRefs[0].attrName, 'src');
	assertEquals(assetRefs[0].originalValue, '@images/photo.jpg');
	assertEquals(assetRefs[0].refs.length, 1);
	assertEquals(assetRefs[0].refs[0].name, 'images');
	assertEquals(assetRefs[0].refs[0].subpath, 'photo.jpg');

	// Stage 2: resolveAssetRefs produces correct raw output
	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedRoot = resolved.partials.get("hero")!;
	const allRaw = resolvedRoot.tnodes.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertStringIncludes(allRaw, 'src="/img/photo.jpg"');
	assertEquals(allRaw.includes('~'), false);
	assertEquals(allRaw.includes('@images'), false);
});

Deno.test("asset: static src~ with subpath", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/sub/nested.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const assetRefs = root.tnodes.filter(n => n.type === 'asset-ref') as AssetRefTNode[];
	assertEquals(assetRefs.length, 1);
	assertEquals(assetRefs[0].refs[0].subpath, 'sub/nested.jpg');

	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedRoot = resolved.partials.get("hero")!;
	const allRaw = resolvedRoot.tnodes.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertStringIncludes(allRaw, 'src="/img/sub/nested.jpg"');
});

Deno.test("asset: error when @name not in asset map", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="@unknown/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'unknown asset directory "@unknown"');
});

Deno.test("asset: error when value doesn't start with @", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="photo.jpg" /></div>',
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'must start with @name');
});

Deno.test("asset: error on path traversal in subpath", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="@images/../../../etc/passwd" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'path traversal');
});

Deno.test("asset: style~ is an error", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		'<div b-name="hero"><div style~="@images/bg.jpg"></div></div>',
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'style~ is not supported');
});

Deno.test("asset: :src~ (bind) produces isAsset part", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { compiled } = await compileFile(
		`<div b-name="hero"><img :src~="'@images/' + file + '.jpg'" /></div>`,
		undefined, 'test.html', { assetMap }
	);
	const root = compiled.partials.get("hero")!;
	const attrBind = root.tnodes.find(n => n.type === 'attr-bind') as AttrBindTNode | undefined;
	assertEquals(attrBind !== undefined, true);
	const dynamicPart = attrBind!.parts.find(p => p.type === 'dynamic');
	assertEquals(dynamicPart!.type, 'dynamic');
	if (dynamicPart!.type === 'dynamic') {
		assertEquals(dynamicPart!.name, 'src');
		assertEquals(dynamicPart!.isAsset, true);
	}
});

Deno.test("asset: :style~ (bind) is an error", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		`<div b-name="hero"><div :style~="'@images/bg.jpg'"></div></div>`,
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'style~ is not supported');
});

Deno.test("asset: srcset~ validates multiple entries", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled, errors } = await compileFile(
		'<div b-name="hero"><img srcset~="@images/photo.jpg 1x, @images/icon.png 2x" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get("hero")!;
	const assetRefs = root.tnodes.filter(n => n.type === 'asset-ref') as AssetRefTNode[];
	assertEquals(assetRefs.length, 1);
	assertEquals(assetRefs[0].attrName, 'srcset');
	assertEquals(assetRefs[0].refs.length, 2);
	assertEquals(assetRefs[0].refs[0].name, 'images');
	assertEquals(assetRefs[0].refs[0].subpath, 'photo.jpg');
	assertEquals(assetRefs[0].refs[1].subpath, 'icon.png');

	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedRoot = resolved.partials.get("hero")!;
	const allRaw = resolvedRoot.tnodes.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertStringIncludes(allRaw, 'srcset="/img/photo.jpg 1x, /img/icon.png 2x"');
});

Deno.test("asset: no asset map produces error for ~ attribute", async () => {
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="@images/photo.jpg" /></div>',
		undefined, 'test.html', {}
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'no asset directories');
});

Deno.test("asset: error when using :bind~ attribute with no assets configured", async () => {
	const { errors } = await compileFile(
		`<div b-name="hero"><img :src~="'@images/' + f" /></div>`,
		undefined, 'test.html'
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'no asset directories');
});

Deno.test("asset: error location spans the full attribute", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="@unknown/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	// The error should have endLine/endCol spanning the full src~="..." attribute
	assertExists(errors[0].endLine);
	assertExists(errors[0].endCol);
	assert(errors[0].endCol! > errors[0].col! + 1, `endCol (${errors[0].endCol}) should be greater than col+1 (${errors[0].col! + 1})`);
});

Deno.test("asset: mixed static asset + bind produces asset AttrPart", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { compiled } = await compileFile(
		`<div b-name="hero"><img src~="@images/photo.jpg" :alt="desc" /></div>`,
		undefined, 'test.html', { assetMap }
	);
	const root = compiled.partials.get("hero")!;
	const attrBind = root.tnodes.find(n => n.type === 'attr-bind') as AttrBindTNode;
	assertEquals(attrBind !== undefined, true);
	const assetPart = attrBind.parts.find(p => p.type === 'asset');
	assertEquals(assetPart !== undefined, true);
	if (assetPart?.type === 'asset') {
		assertEquals(assetPart.attrName, 'src');
		assertEquals(assetPart.originalValue, '@images/photo.jpg');
		assertEquals(assetPart.refs[0].name, 'images');
	}

	// Stage 2: asset AttrPart resolved to static
	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedRoot = resolved.partials.get("hero")!;
	const resolvedBind = resolvedRoot.tnodes.find(n => n.type === 'attr-bind') as AttrBindTNode;
	assertEquals(resolvedBind.parts.some(p => p.type === 'asset'), false);
	const staticParts = resolvedBind.parts.filter(p => p.type === 'static');
	const staticRaw = staticParts.map(p => p.type === 'static' ? p.raw : '').join('');
	assertStringIncludes(staticRaw, 'src="/img/photo.jpg"');
});

Deno.test("asset: resolveAssetRefs does not mutate original", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const assetRefsBefore = root.tnodes.filter(n => n.type === 'asset-ref').length;
	assertEquals(assetRefsBefore, 1);

	resolveAssetRefs(compiled, assetMap);

	// Original should still have the AssetRefTNode
	const assetRefsAfter = root.tnodes.filter(n => n.type === 'asset-ref').length;
	assertEquals(assetRefsAfter, 1);
});

// --- top-level element without b-name in a partial file ---

Deno.test("compileFile - error when top-level element lacks b-name in a file with partials", async () => {
	const html = `
		<div b-name="card"><p>Card</p></div>
		<footer>Site Footer</footer>
	`;
	const { errors } = await compileFile(html);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'b-name');
});

Deno.test("compileFile - error for multiple top-level elements without b-name", async () => {
	const html = `
		<header>Header</header>
		<div b-name="card"><p>Card</p></div>
		<footer>Footer</footer>
	`;
	const { errors } = await compileFile(html);
	assertEquals(errors.length, 2);
});

Deno.test("compileFile - no error when all top-level elements have b-name", async () => {
	const html = `
		<div b-name="header"><h1>Header</h1></div>
		<div b-name="footer"><p>Footer</p></div>
	`;
	const { errors } = await compileFile(html);
	assertEquals(errors.length, 0);
});

Deno.test("compileFile - error when file has top-level elements but no partials", async () => {
	const html = `
		<header>Header</header>
		<footer>Footer</footer>
	`;
	const { errors } = await compileFile(html);
	assertEquals(errors.length, 2);
	assertStringIncludes(errors[0].message, 'b-name');
	assertStringIncludes(errors[1].message, 'b-name');
});

Deno.test("compileFile - error includes source location for unnamed top-level element", async () => {
	const html = '<div b-name="card"><p>Card</p></div><span>oops</span>';
	const { errors } = await compileFile(html, undefined, 'test.html');
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'test.html');
	assertEquals(typeof errors[0].line, 'number');
});

