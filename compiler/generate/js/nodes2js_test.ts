import { assertEquals, assertMatch } from "jsr:@std/assert";

import type { RootTNode, RawTNode, CommentTNode, PrintTNode, ForTNode, IfTNode, IfBranch, SlotTNode, PartialRefTNode, CompiledFile } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { nodeToJS, nodeToJsExport, fileToJsModule, sanitizeName } from "./nodes2js.ts";

function makeParsed(code: string) {
	return interpretBackcode(code);
}

function makeRoot(...tnodes: any[]): RootTNode {
	return { type: 'root', kind: 'named' as const, tnodes };
}

Deno.test("raw node", () => {
	const root = makeRoot();
	const node: RawTNode = { type: 'raw', raw: 'hello world' };
	const js = nodeToJS(node);
	assertMatch(js, /type:\s*'raw'/);
	assertMatch(js, /raw:\s*'hello world'/);
});

Deno.test("raw node escapes newlines", () => {
	const root = makeRoot();
	const node: RawTNode = { type: 'raw', raw: 'hello\nworld' };
	const js = nodeToJS(node);
	assertMatch(js, /\\n/);
	// Should not contain a literal newline inside the raw string value
	const rawMatch = js.match(/raw:\s*'([^']*)'/);
	assertEquals(rawMatch![1].includes('\n'), false);
});

Deno.test("comment node", () => {
	const node: CommentTNode = { type: 'comment', text: 'bfid:bf1' };
	const js = nodeToJS(node);
	assertMatch(js, /type:\s*'comment'/);
	assertMatch(js, /text:\s*'bfid:bf1'/);
});

Deno.test("comment node escapes quotes", () => {
	const node: CommentTNode = { type: 'comment', text: "a'b" };
	const js = nodeToJS(node);
	const m = js.match(/text:\s*'([^]*)'\s*\}/);
	assertEquals(m![1], "a\\'b");
});

Deno.test("print node", () => {
	const root = makeRoot();
	const parsed = makeParsed('foo');
	const node: PrintTNode = { type: 'print', data: parsed };
	const js = nodeToJS(node);
	assertMatch(js, /type:\s*'print'/);
	assertMatch(js, /data:/);
	assertMatch(js, /fn:/);
	assertMatch(js, /vars:/);
});

Deno.test("for node", () => {
	const root = makeRoot();
	const parsed = makeParsed('items');
	const innerRaw: RawTNode = { type: 'raw', raw: '<li>hi</li>' };
	const node: ForTNode = {
		type: 'for',
		iterable: parsed,
		valName: 'item',
		tnodes: [innerRaw],
	};
	const js = nodeToJS(node);
	assertMatch(js, /type:\s*'for'/);
	assertMatch(js, /iterable:/);
	assertMatch(js, /valName:\s*'item'/);
	assertMatch(js, /nodes:/);
	// inner raw node should be present
	assertMatch(js, /type:\s*'raw'/);
});

Deno.test("if node with one branch", () => {
	const root = makeRoot();
	const condition = makeParsed('show');
	const innerRaw: RawTNode = { type: 'raw', raw: '<div>yes</div>' };
	const ifNode: IfTNode = {
		type: 'if',
		branches: [],
	};
	const branch: IfBranch = {
		condition,
		tnodes: [innerRaw],
	};
	ifNode.branches.push(branch);
	const js = nodeToJS(ifNode);
	assertMatch(js, /type:\s*'if'/);
	assertMatch(js, /branches:/);
	assertMatch(js, /condition:/);
	assertMatch(js, /fn:/);
});

Deno.test("if node with else branch (no condition)", () => {
	const root = makeRoot();
	const condition = makeParsed('show');
	const raw1: RawTNode = { type: 'raw', raw: 'yes' };
	const raw2: RawTNode = { type: 'raw', raw: 'no' };
	const ifNode: IfTNode = {
		type: 'if',
		branches: [],
	};
	ifNode.branches.push({ condition, tnodes: [raw1] });
	ifNode.branches.push({ condition: undefined, tnodes: [raw2] });
	const js = nodeToJS(ifNode);
	assertMatch(js, /condition: undefined/);
});

Deno.test("root node with children", () => {
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const raw: RawTNode = { type: 'raw', raw: 'hello' };
	const parsed = makeParsed('x');
	const print: PrintTNode = { type: 'print', data: parsed };
	root.tnodes.push(raw, print);
	const js = nodeToJS(root);
	assertMatch(js, /type:\s*"root"/);
	assertMatch(js, /nodes:/);
	assertMatch(js, /type:\s*'raw'/);
	assertMatch(js, /type:\s*'print'/);
});

Deno.test("nodeToJsExport wraps in export", () => {
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const raw: RawTNode = { type: 'raw', raw: 'hi' };
	root.tnodes.push(raw);
	const js = nodeToJsExport(root);
	assertMatch(js, /^export const nodes = /);
	assertMatch(js, /;$/);
});

Deno.test("nested for inside if", () => {
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const ifNode: IfTNode = { type: 'if', branches: [] };
	const branch: IfBranch = { condition: makeParsed('show'), tnodes: [] };
	const forNode: ForTNode = {
		type: 'for',
		iterable: makeParsed('items'),
		valName: 'item',
		tnodes: [],
	};
	forNode.tnodes.push({ type: 'raw', raw: '<li></li>' });
	branch.tnodes.push(forNode);
	ifNode.branches.push(branch);
	root.tnodes.push(ifNode);

	const js = nodeToJS(root);
	assertMatch(js, /type:\s*'if'/);
	assertMatch(js, /type:\s*'for'/);
	assertMatch(js, /type:\s*'raw'/);
});

Deno.test("all TNode types are handled", () => {
	// Verify that nodeToJS doesn't throw for any TNode type
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };

	const raw: RawTNode = { type: 'raw', raw: 'test' };
	assertEquals(typeof nodeToJS(raw), 'string');

	const print: PrintTNode = { type: 'print', data: makeParsed('x') };
	assertEquals(typeof nodeToJS(print), 'string');

	const forNode: ForTNode = {
		type: 'for', iterable: makeParsed('list'), valName: 'v',
		tnodes: [{ type: 'raw', raw: '' } as RawTNode]	};
	assertEquals(typeof nodeToJS(forNode), 'string');

	const ifNode: IfTNode = { type: 'if', branches: [] };
	ifNode.branches.push({ condition: makeParsed('ok'), tnodes: [{ type: 'raw', raw: '' } as RawTNode] });
	assertEquals(typeof nodeToJS(ifNode), 'string');

	assertEquals(typeof nodeToJS(root), 'string');
});

Deno.test("sanitizeName replaces hyphens and dots", () => {
	assertEquals(sanitizeName('pie-chart'), 'pie_chart');
	assertEquals(sanitizeName('my.partial'), 'my_partial');
	assertEquals(sanitizeName('valid_name'), 'valid_name');
});

Deno.test("slot node with undefined name", () => {
	const root = makeRoot();
	const node: SlotTNode = { type: 'slot', name: undefined };
	const js = nodeToJS(node);
	assertMatch(js, /type:\s*'slot'/);
	assertMatch(js, /name:\s*undefined/);
});

Deno.test("slot node with named slot", () => {
	const root = makeRoot();
	const node: SlotTNode = { type: 'slot', name: 'message' };
	const js = nodeToJS(node);
	assertMatch(js, /name:\s*'message'/);
});

Deno.test("partial-ref node with same-file reference", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [],
	};
	const js = nodeToJS(node);
	assertMatch(js, /type:\s*'partial-ref'/);
	assertMatch(js, /partial:\s*notice/);
	assertEquals(/wrapper:/.test(js), false);
});

Deno.test("partial-ref no longer emits a wrapper field", () => {
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [],
	};
	const js = nodeToJS(node);
	assertEquals(/wrapper:/.test(js), false);
});

Deno.test("partial-ref node with default slot content", () => {
	const root = makeRoot();
	const slotRaw: RawTNode = { type: 'raw', raw: 'slot content' };
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: { default: [slotRaw] },
		bindings: [],
	};
	const js = nodeToJS(node);
	assertMatch(js, /slots:/);
	assertMatch(js, /'default':/);
	assertMatch(js, /slot content/);
});

Deno.test("partial-ref node with binding", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [{ kind: 'expr', name: 'mood', data: makeParsed('user.mood') }],
	};
	const js = nodeToJS(node);
	assertMatch(js, /bindings:/);
	assertMatch(js, /name:\s*'mood'/);
	assertMatch(js, /fn:/);
});

Deno.test("partial-ref binding with literal true (bare boolean)", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [{ kind: 'literal', name: 'premium', value: true }],
	};
	const js = nodeToJS(node);
	assertMatch(js, /name:\s*'premium'/);
	assertMatch(js, /literal:\s*true/);
	// Should not have data: for a literal-only binding
	assertEquals(/data:/.test(js.split('bindings:')[1] ?? ''), false);
});

Deno.test("partial-ref binding with literal false", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [{ kind: 'literal', name: 'premium', value: false }],
	};
	const js = nodeToJS(node);
	assertMatch(js, /name:\s*'premium'/);
	assertMatch(js, /literal:\s*false/);
});

Deno.test("partial-ref binding with literal string value", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [{ kind: 'literal', name: 'label', value: "hello" }],
	};
	const js = nodeToJS(node);
	assertMatch(js, /name:\s*'label'/);
	assertMatch(js, /literal:\s*'hello'/);
});

Deno.test("partial-ref binding with literal string escapes single quotes", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [{ kind: 'literal', name: 'label', value: "it's" }],
	};
	const js = nodeToJS(node);
	assertMatch(js, /literal:\s*'it\\'s'/);
});

Deno.test("partial-ref binding with cast=bool", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [{ kind: 'expr', name: 'premium', data: makeParsed('user.isPro'), cast: 'bool' }],
	};
	const js = nodeToJS(node);
	assertMatch(js, /name:\s*'premium'/);
	assertMatch(js, /data:\s*\{\s*fn:/);
	assertMatch(js, /cast:\s*'bool'/);
});

Deno.test("partial-ref binding with cast=string", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		slots: {},
		bindings: [{ kind: 'expr', name: 'label', data: makeParsed('count'), cast: 'string' }],
	};
	const js = nodeToJS(node);
	assertMatch(js, /name:\s*'label'/);
	assertMatch(js, /data:\s*\{\s*fn:/);
	assertMatch(js, /cast:\s*'string'/);
});

Deno.test("custom-element partial-ref binding shapes coexist", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'custom-element' as const,
		file: null,
		partialName: 'my-card',
		slots: {},
		bindings: [
			{ kind: 'expr', name: 'title', data: makeParsed('heading') },
			{ kind: 'literal', name: 'premium', value: true },
			{ kind: 'literal', name: 'badge', value: 'gold' },
			{ kind: 'expr', name: 'active', data: makeParsed('isOn'), cast: 'bool' },
			{ kind: 'expr', name: 'count', data: makeParsed('n'), cast: 'string' }
		],
		callerTagName: 'my-card',
		callerAttrs: [],
	};
	const js = nodeToJS(node);
	assertMatch(js, /name:\s*'title'/);
	assertMatch(js, /name:\s*'premium'/);
	assertMatch(js, /literal:\s*true/);
	assertMatch(js, /name:\s*'badge'/);
	assertMatch(js, /literal:\s*'gold'/);
	assertMatch(js, /cast:\s*'bool'/);
	assertMatch(js, /cast:\s*'string'/);
});

Deno.test("partial-ref with cross-file reference uses import alias", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: 'graphics/charts.html',
		partialName: 'pie-chart',
		slots: {},
		bindings: [],
	};
	const js = nodeToJS(node);
	// Should reference import alias, not the sanitized local name
	assertMatch(js, /graphics_charts__pie_chart/);
});

Deno.test("fileToJsModule emits export for each partial", () => {
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	root.tnodes.push({ type: 'raw', raw: '<p>hello</p>' });
	const file: CompiledFile = {
		partials: new Map([['notice', root]])
	};
	const js = fileToJsModule(file, 'blog/general.html');
	assertMatch(js, /export const notice/);
});

Deno.test("fileToJsModule emits import for cross-file partial-ref", () => {
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const ref: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: 'graphics/charts.html',
		partialName: 'pie-chart',
		slots: {},
		bindings: [],
	};
	root.tnodes.push(ref);
	const file: CompiledFile = {
		partials: new Map([['post', root]])
	};
	const js = fileToJsModule(file, 'blog/general.html');
	assertMatch(js, /import \{/);
	assertMatch(js, /charts\.js/);
});

Deno.test("fileToJsModule same-file dep comes before dependent", () => {
	// 'post' references 'notice', so 'notice' should appear first in output
	const noticeRoot: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	noticeRoot.tnodes.push({ type: 'raw', raw: 'notice' });

	const postRoot: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const ref: PartialRefTNode = {
		type: 'partial-ref', kind: 'b-part', file: null, partialName: 'notice',
		slots: {}, bindings: []
	};
	postRoot.tnodes.push(ref);

	const file: CompiledFile = {
		partials: new Map([['post', postRoot], ['notice', noticeRoot]])
	};
	const js = fileToJsModule(file, 'page.html');
	const noticeIdx = js.indexOf('export const notice');
	const postIdx = js.indexOf('export const post');
	assertEquals(noticeIdx < postIdx, true);
});

Deno.test("generated JS is valid JavaScript", async () => {
	// Build a tree with all node types and verify the output is parseable JS
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const raw: RawTNode = { type: 'raw', raw: '<p>hello</p>' };
	const print: PrintTNode = { type: 'print', data: makeParsed('name') };
	const ifNode: IfTNode = { type: 'if', branches: [] };
	const ifBranch: IfBranch = { condition: makeParsed('show'), tnodes: [] };
	ifBranch.tnodes.push({ type: 'raw', raw: 'yes' });
	ifNode.branches.push(ifBranch);
	const forNode: ForTNode = {
		type: 'for', iterable: makeParsed('items'), valName: 'item',
		tnodes: [{ type: 'raw', raw: '<li></li>' } as RawTNode],
	};
	root.tnodes.push(raw, print, ifNode, forNode);

	const js = nodeToJsExport(root);
	// Should not throw when evaluated as a module-like expression
	// We wrap it to avoid actual export syntax issues in eval
	const evalable = js.replace('export const nodes = ', 'const nodes = ').replace(/;$/, '');
	const fn = new Function(evalable + '; return nodes;');
	const result = fn();
	assertEquals(result.type, 'root');
	assertEquals(result.nodes.length, 4);
	assertEquals(result.nodes[0].type, 'raw');
	assertEquals(result.nodes[1].type, 'print');
	assertEquals(result.nodes[2].type, 'if');
	assertEquals(result.nodes[3].type, 'for');
});

Deno.test("scriptUrl: emitted on a custom-element root when set", () => {
	const root: RootTNode = { type: 'root', kind: 'custom-element', tnodes: [{ type: 'raw', raw: 'x' }], scriptUrl: '/bfdom/widget.js' };
	const js = nodeToJS(root);
	assertMatch(js, /scriptUrl: '\/bfdom\/widget\.js'/);
	assertMatch(js, /customElement: true/);
});

Deno.test("scriptUrl: absent on a custom-element root without it", () => {
	const root: RootTNode = { type: 'root', kind: 'custom-element', tnodes: [{ type: 'raw', raw: 'x' }] };
	const js = nodeToJS(root);
	assertEquals(js.includes('scriptUrl'), false);
});
