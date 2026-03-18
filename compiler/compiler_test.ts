import { assertEquals, assertRejects } from "jsr:@std/assert";

import type { RootTNode, RawTNode, ForTNode, IfTNode, SlotTNode, PartialRefTNode, AttrBindTNode, SourceLoc } from "./compiler.ts";
import { generateStringStack, compileFile, onText, pushRaw } from "./compiler.ts";
import { interpretBackcode } from "./backcode.ts";

Deno.test( "pushRaw", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: 'hello', parent: root	};
	root.tnodes.push(child_node);

	const ret_node = pushRaw(root.tnodes[0], "world");
	const ret_raw = ret_node.type === 'raw' ? ret_node.raw : '';
	assertEquals(ret_raw, 'helloworld');
});

Deno.test( "onText-Raw", () => {
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

Deno.test( "onText-PrintOne", () => {
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

Deno.test( "onText-Raw+PrintOne", () => {
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

Deno.test( "onText-Raw+PrintOne+Raw", () => {
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


Deno.test( "onText-Raw+PrintTwo+Raw", () => {
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

	console.log(root);
});

// Fix 1: Missing space in tag reconstruction
Deno.test("b-for tag reconstruction has space before attrs", async () => {
	const root = await generateStringStack('<div class="x" b-for="item in items">hello</div>');
	const for_node = root.tnodes[1] as ForTNode;
	const inner_raw = for_node.tnodes[0] as RawTNode;
	// The inner raw starts with the reconstructed opening tag
	assertEquals(inner_raw.raw.startsWith('<div class="x">'), true);
});

// Fix 2: Void elements should not corrupt tag stack
Deno.test("void elements do not corrupt tag matching", async () => {
	const root = await generateStringStack('<div><br><span>hi</span></div>');
	// Should not throw - if br is pushed to tag_stack without being popped,
	// </span> would try to match <br> and fail
	const raw = root.tnodes[0] as RawTNode;
	assertEquals(raw.raw, '<div><br><span>hi</span></div>');
});

// Fix 4: top-level b-for followed by more content
Deno.test("b-for at root followed by more content", async () => {
	const root = await generateStringStack('<ul b-for="item in items"><li>hello</li></ul><p>after</p>');
	// Should have: empty raw, for_node, raw with <p>after</p>
	assertEquals(root.tnodes.length, 3);
	assertEquals(root.tnodes[1].type, 'for');
	const last = root.tnodes[2] as RawTNode;
	assertEquals(last.raw, '<p>after</p>');
});

// Fix 5: parentheses in template expressions should work
Deno.test("onText-ParensInExpression", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], '{{ func() }}');

	assertEquals(root.tnodes.length, 2);
	assertEquals(root.tnodes[1].type, 'print');
});

// Fix 7: empty {{ }} should be skipped
Deno.test("onText-EmptyBraces", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'before{{  }}after');

	// Should skip the empty expression, treating it as raw text
	assertEquals(root.tnodes.length, 1);
	assertEquals((root.tnodes[0] as RawTNode).raw, 'before{{  }}after');
});

// Fix 3: b-for without "in" keyword should error
Deno.test("b-for without 'in' keyword throws", async () => {
	let threw = false;
	try {
		await generateStringStack('<div b-for="items">hello</div>');
	} catch (e) {
		threw = true;
	}
	assertEquals(threw, true);
});

// b-if tests
Deno.test("simple b-if", async () => {
	const root = await generateStringStack('<div b-if="show">hello</div>');
	assertEquals(root.tnodes.length, 2); // empty raw + if_node
	const if_node = root.tnodes[1] as IfTNode;
	assertEquals(if_node.type, 'if');
	assertEquals(if_node.branches.length, 1);
	assertEquals(if_node.branches[0].condition, interpretBackcode('show'));
	const inner = if_node.branches[0].tnodes[0] as RawTNode;
	assertEquals(inner.raw, '<div>hello</div>');
});

Deno.test("b-if + b-else", async () => {
	const root = await generateStringStack('<div b-if="show">yes</div><div b-else>no</div>');
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

Deno.test("b-if + b-else-if + b-else", async () => {
	const root = await generateStringStack('<p b-if="a">1</p><p b-else-if="b">2</p><p b-else>3</p>');
	const if_node = root.tnodes[1] as IfTNode;
	assertEquals(if_node.branches.length, 3);
	assertEquals(if_node.branches[0].condition, interpretBackcode('a'));
	assertEquals(if_node.branches[1].condition, interpretBackcode('b'));
	assertEquals(if_node.branches[2].condition, undefined);
});

Deno.test("b-else without preceding b-if throws", async () => {
	let threw = false;
	try {
		await generateStringStack('<div b-else>no</div>');
	} catch (_e) {
		threw = true;
	}
	assertEquals(threw, true);
});

Deno.test("b-else-if without preceding b-if throws", async () => {
	let threw = false;
	try {
		await generateStringStack('<div b-else-if="x">no</div>');
	} catch (_e) {
		threw = true;
	}
	assertEquals(threw, true);
});

Deno.test("nested b-if inside b-if", async () => {
	const root = await generateStringStack('<div b-if="a"><span b-if="b">inner</span></div>');
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

Deno.test("nested b-if with b-else inside b-if", async () => {
	const root = await generateStringStack('<div b-if="a"><p b-if="b">yes</p><p b-else>no</p></div>');
	const outer = root.tnodes[1] as IfTNode;
	assertEquals(outer.branches.length, 1);
	const inner_if = outer.branches[0].tnodes[1] as IfTNode;
	assertEquals(inner_if.type, 'if');
	assertEquals(inner_if.branches.length, 2);
	assertEquals(inner_if.branches[0].condition, interpretBackcode('b'));
	assertEquals(inner_if.branches[1].condition, undefined);
});

Deno.test("b-if nested inside b-for", async () => {
	const root = await generateStringStack('<div b-for="item in items"><span b-if="item.show">hi</span></div>');
	const for_node = root.tnodes[1] as ForTNode;
	assertEquals(for_node.type, 'for');
	// for tnodes: raw "<div>", IfTNode, raw "</div>"
	assertEquals(for_node.tnodes.length, 3);
	const inner_if = for_node.tnodes[1] as IfTNode;
	assertEquals(inner_if.type, 'if');
	assertEquals(inner_if.branches[0].condition, interpretBackcode('item.show'));
});

Deno.test("b-if with content after", async () => {
	const root = await generateStringStack('<div b-if="show">hello</div><p>after</p>');
	assertEquals(root.tnodes.length, 3); // empty raw, if_node, raw with <p>after</p>
	assertEquals(root.tnodes[1].type, 'if');
	const last = root.tnodes[2] as RawTNode;
	assertEquals(last.raw, '<p>after</p>');
});

// ---- compileFile tests ----

Deno.test("compileFile: single partial with b-name on a div", async () => {
	const result = await compileFile('<div b-name="hero">Hello</div>');
	assertEquals(result.partials.size, 1);
	const root = result.partials.get("hero")!;
	assertEquals(root.type, 'root');
	// First tnode should be raw starting with '<div>'
	const first = root.tnodes[0] as RawTNode;
	assertEquals(first.type, 'raw');
	assertEquals(first.raw.startsWith('<div>'), true);
});

Deno.test("compileFile: b-name on b-unwrap (partial without wrapper element)", async () => {
	const result = await compileFile('<b-unwrap b-name="inner">content</b-unwrap>');
	assertEquals(result.partials.size, 1);
	const root = result.partials.get("inner")!;
	assertEquals(root.type, 'root');
	// Should have some raw content but no <b-unwrap> tag emitted
	const allRaw = root.tnodes.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertEquals(allRaw.includes('b-unwrap'), false);
	assertEquals(allRaw.includes('content'), true);
});

Deno.test("compileFile: b-name not at top level throws error", async () => {
	await assertRejects(
		() => compileFile('<div b-name="outer"><span b-name="inner">text</span></div>'),
		Error,
		"b-name is only allowed on top-level elements"
	);
});

Deno.test("compileFile: multiple partials in one file", async () => {
	const result = await compileFile('<div b-name="first">A</div><div b-name="second">B</div>');
	assertEquals(result.partials.size, 2);
	assertEquals(result.partials.has("first"), true);
	assertEquals(result.partials.has("second"), true);
});

Deno.test("compileFile: b-part same-file reference creates PartialRefTNode with correct file=null and partialName", async () => {
	const result = await compileFile('<div b-name="page"><div b-part="#hero"></div></div>');
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
	const result = await compileFile('<div b-name="page"><b-unwrap b-part="#card"></b-unwrap></div>');
	const root = result.partials.get("page")!;
	let found: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertEquals(found !== undefined, true);
	assertEquals(found!.wrapper, null);
});

Deno.test("compileFile: b-part with regular element creates wrapper with open/close tags", async () => {
	const result = await compileFile('<div b-name="page"><section class="x" b-part="#card"></section></div>');
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

Deno.test("compileFile: b-slot creates SlotTNode", async () => {
	const result = await compileFile('<div b-name="card"><b-unwrap b-slot="title"></b-unwrap></div>');
	const root = result.partials.get("card")!;
	let found: SlotTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'slot') { found = n as SlotTNode; break; }
	}
	assertEquals(found !== undefined, true);
	assertEquals(found!.name, "title");
});

Deno.test("compileFile: b-slot with no value creates SlotTNode with undefined name", async () => {
	const result = await compileFile('<div b-name="card"><b-unwrap b-slot></b-unwrap></div>');
	const root = result.partials.get("card")!;
	let found: SlotTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'slot') { found = n as SlotTNode; break; }
	}
	assertEquals(found !== undefined, true);
	assertEquals(found!.name, undefined);
});

Deno.test("compileFile: default slot content captured", async () => {
	const result = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p>default content</p></b-unwrap></div>');
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
	const result = await compileFile(
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

Deno.test("compileFile: b-data: creates bindings on PartialRefTNode", async () => {
	const result = await compileFile('<div b-name="page"><b-unwrap b-part="#card" b-data:title="item.title"></b-unwrap></div>');
	const root = result.partials.get("page")!;
	let ref: PartialRefTNode | undefined;
	for (const n of root.tnodes) {
		if (n.type === 'partial-ref') { ref = n as PartialRefTNode; break; }
	}
	assertEquals(ref !== undefined, true);
	assertEquals(ref!.bindings.length, 1);
	assertEquals(ref!.bindings[0].name, "title");
	assertEquals(ref!.bindings[0].data.vars.includes("item"), true);
});

// ---- Source location tests ----

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

Deno.test("loc: b-name attribute location on RootTNode", async () => {
	const src = '<div b-name="hero">Hello</div>';
	const result = await compileFile(src);
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
	const result = await compileFile(src);
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
	const result = await compileFile(src);
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
	const result = await compileFile(src);
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
	const result = await compileFile(src);
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
	const result = await compileFile(src);
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
	const result = await compileFile(src);
	const root = result.partials.get("page")!;
	const ifNode = findIfNode(root);
	const loc = ifNode.branches[2].loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-else>');
	assertEquals(loc.startOffset, expected);
});

Deno.test("loc: b-slot attribute location on SlotTNode", async () => {
	const src = '<div b-name="card"><b-unwrap b-slot="title"></b-unwrap></div>';
	const result = await compileFile(src);
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
	const result = await compileFile(src);
	const root = result.partials.get("card")!;
	const slotNode = findSlotNode(root);
	const loc = slotNode.loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-slot');
	assertEquals(loc.startOffset, expected);
});

Deno.test("loc: {{ expr }} interpolation in text", async () => {
	const src = '<div b-name="page">hello {{ myVar }} world</div>';
	const result = await compileFile(src);
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
	const result = await compileFile(src);
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
	const result = await compileFile(src);
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
	const result = await compileFile(src);
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