import { assertEquals, assertMatch } from "jsr:@std/assert";

import type { RootTNode, RawTNode, PrintTNode, ForTNode, IfTNode, IfBranch } from "../../compiler.ts";
import { interpretBackcode } from "../../backcode.ts";
import { nodeToJS, nodeToJsExport } from "./nodes2js.ts";

function makeParsed(code: string) {
	return interpretBackcode(code);
}

function makeRoot(...tnodes: any[]): RootTNode {
	return { type: 'root', tnodes };
}

Deno.test("raw node", () => {
	const root = makeRoot();
	const node: RawTNode = { type: 'raw', raw: 'hello world', parent: root };
	const js = nodeToJS(node);
	assertMatch(js, /type:\s*'raw'/);
	assertMatch(js, /raw:\s*'hello world'/);
});

Deno.test("raw node escapes newlines", () => {
	const root = makeRoot();
	const node: RawTNode = { type: 'raw', raw: 'hello\nworld', parent: root };
	const js = nodeToJS(node);
	assertMatch(js, /\\n/);
	// Should not contain a literal newline inside the raw string value
	const rawMatch = js.match(/raw:\s*'([^']*)'/);
	assertEquals(rawMatch![1].includes('\n'), false);
});

Deno.test("print node", () => {
	const root = makeRoot();
	const parsed = makeParsed('foo');
	const node: PrintTNode = { type: 'print', data: parsed, parent: root };
	const js = nodeToJS(node);
	assertMatch(js, /type:\s*'print'/);
	assertMatch(js, /data:/);
	assertMatch(js, /fn:/);
	assertMatch(js, /vars:/);
});

Deno.test("for node", () => {
	const root = makeRoot();
	const parsed = makeParsed('items');
	const innerRaw: RawTNode = { type: 'raw', raw: '<li>hi</li>', parent: root };
	const node: ForTNode = {
		type: 'for',
		iterable: parsed,
		valName: 'item',
		tnodes: [innerRaw],
		parent: root
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
	const innerRaw: RawTNode = { type: 'raw', raw: '<div>yes</div>', parent: root };
	const ifNode: IfTNode = {
		type: 'if',
		branches: [],
		parent: root
	};
	const branch: IfBranch = {
		condition,
		tnodes: [innerRaw],
		ifNode
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
	const raw1: RawTNode = { type: 'raw', raw: 'yes', parent: root };
	const raw2: RawTNode = { type: 'raw', raw: 'no', parent: root };
	const ifNode: IfTNode = {
		type: 'if',
		branches: [],
		parent: root
	};
	ifNode.branches.push({ condition, tnodes: [raw1], ifNode });
	ifNode.branches.push({ condition: undefined, tnodes: [raw2], ifNode });
	const js = nodeToJS(ifNode);
	assertMatch(js, /condition: undefined/);
});

Deno.test("root node with children", () => {
	const root: RootTNode = { type: 'root', tnodes: [] };
	const raw: RawTNode = { type: 'raw', raw: 'hello', parent: root };
	const parsed = makeParsed('x');
	const print: PrintTNode = { type: 'print', data: parsed, parent: root };
	root.tnodes.push(raw, print);
	const js = nodeToJS(root);
	assertMatch(js, /type:\s*"root"/);
	assertMatch(js, /nodes:/);
	assertMatch(js, /type:\s*'raw'/);
	assertMatch(js, /type:\s*'print'/);
});

Deno.test("nodeToJsExport wraps in export", () => {
	const root: RootTNode = { type: 'root', tnodes: [] };
	const raw: RawTNode = { type: 'raw', raw: 'hi', parent: root };
	root.tnodes.push(raw);
	const js = nodeToJsExport(root);
	assertMatch(js, /^export const nodes = /);
	assertMatch(js, /;$/);
});

Deno.test("nested for inside if", () => {
	const root: RootTNode = { type: 'root', tnodes: [] };
	const ifNode: IfTNode = { type: 'if', branches: [], parent: root };
	const forNode: ForTNode = {
		type: 'for',
		iterable: makeParsed('items'),
		valName: 'item',
		tnodes: [{ type: 'raw', raw: '<li></li>', parent: ifNode } as RawTNode],
		parent: ifNode
	};
	const branch: IfBranch = {
		condition: makeParsed('show'),
		tnodes: [forNode],
		ifNode
	};
	ifNode.branches.push(branch);
	root.tnodes.push(ifNode);

	const js = nodeToJS(root);
	assertMatch(js, /type:\s*'if'/);
	assertMatch(js, /type:\s*'for'/);
	assertMatch(js, /type:\s*'raw'/);
});

Deno.test("all TNode types are handled", () => {
	// Verify that nodeToJS doesn't throw for any TNode type
	const root: RootTNode = { type: 'root', tnodes: [] };

	const raw: RawTNode = { type: 'raw', raw: 'test', parent: root };
	assertEquals(typeof nodeToJS(raw), 'string');

	const print: PrintTNode = { type: 'print', data: makeParsed('x'), parent: root };
	assertEquals(typeof nodeToJS(print), 'string');

	const forNode: ForTNode = {
		type: 'for', iterable: makeParsed('list'), valName: 'v',
		tnodes: [{ type: 'raw', raw: '', parent: root } as RawTNode], parent: root
	};
	assertEquals(typeof nodeToJS(forNode), 'string');

	const ifNode: IfTNode = { type: 'if', branches: [], parent: root };
	ifNode.branches.push({ condition: makeParsed('ok'), tnodes: [{ type: 'raw', raw: '', parent: root } as RawTNode], ifNode });
	assertEquals(typeof nodeToJS(ifNode), 'string');

	assertEquals(typeof nodeToJS(root), 'string');
});

Deno.test("generated JS is valid JavaScript", async () => {
	// Build a tree with all node types and verify the output is parseable JS
	const root: RootTNode = { type: 'root', tnodes: [] };
	const raw: RawTNode = { type: 'raw', raw: '<p>hello</p>', parent: root };
	const print: PrintTNode = { type: 'print', data: makeParsed('name'), parent: root };
	const ifNode: IfTNode = { type: 'if', branches: [], parent: root };
	ifNode.branches.push({
		condition: makeParsed('show'),
		tnodes: [{ type: 'raw', raw: 'yes', parent: ifNode } as RawTNode],
		ifNode
	});
	const forNode: ForTNode = {
		type: 'for', iterable: makeParsed('items'), valName: 'item',
		tnodes: [{ type: 'raw', raw: '<li></li>', parent: root } as RawTNode],
		parent: root
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
