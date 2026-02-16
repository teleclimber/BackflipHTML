import { assertEquals } from "jsr:@std/assert";

import type { RootTNode, RawTNode, ForTNode, IfTNode } from "./compiler.ts";
import { generateStringStack, onText, pushRaw } from "./compiler.ts";
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