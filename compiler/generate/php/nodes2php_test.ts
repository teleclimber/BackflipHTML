import { assertEquals, assertMatch } from "jsr:@std/assert";

import type { RootTNode, RawTNode, PrintTNode, ForTNode, IfTNode, IfBranch, SlotTNode, PartialRefTNode, CompiledFile } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { nodeToPhp, fileToPhpFile, backcodeToPhp, sanitizeName } from "./nodes2php.ts";

function makeParsed(code: string) {
	return interpretBackcode(code);
}

function makeRoot(...tnodes: any[]): RootTNode {
	return { type: 'root', kind: 'named' as const, tnodes };
}

Deno.test("raw node", () => {
	const root = makeRoot();
	const node: RawTNode = { type: 'raw', raw: 'hello world', parent: root };
	const php = nodeToPhp(node);
	assertMatch(php, /'type' => 'raw'/);
	assertMatch(php, /'raw' => 'hello world'/);
});

Deno.test("raw node with single quote escaped", () => {
	const root = makeRoot();
	const node: RawTNode = { type: 'raw', raw: "it's", parent: root };
	const php = nodeToPhp(node);
	assertMatch(php, /it\\'s/);
});

Deno.test("raw node with backslash escaped", () => {
	const root = makeRoot();
	const node: RawTNode = { type: 'raw', raw: 'a\\b', parent: root };
	const php = nodeToPhp(node);
	assertMatch(php, /a\\\\b/);
});

Deno.test("raw node allows literal newlines", () => {
	const root = makeRoot();
	const node: RawTNode = { type: 'raw', raw: 'hello\nworld', parent: root };
	const php = nodeToPhp(node);
	// PHP single-quoted strings allow literal newlines
	assertMatch(php, /hello\nworld/);
});

Deno.test("print node", () => {
	const root = makeRoot();
	const parsed = makeParsed('foo');
	const node: PrintTNode = { type: 'print', data: parsed, parent: root };
	const php = nodeToPhp(node);
	assertMatch(php, /'type' => 'print'/);
	assertMatch(php, /'fn' =>/);
	assertMatch(php, /'vars' =>/);
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
	const php = nodeToPhp(node);
	assertMatch(php, /'type' => 'for'/);
	assertMatch(php, /'iterable' =>/);
	assertMatch(php, /'valName' => 'item'/);
	assertMatch(php, /'nodes' =>/);
	assertMatch(php, /'type' => 'raw'/);
});

Deno.test("if node with condition branch", () => {
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
	const php = nodeToPhp(ifNode);
	assertMatch(php, /'type' => 'if'/);
	assertMatch(php, /'branches' =>/);
	assertMatch(php, /'condition' =>/);
	assertMatch(php, /'fn' =>/);
});

Deno.test("if node with else branch (no condition) emits null", () => {
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
	const php = nodeToPhp(ifNode);
	assertMatch(php, /'condition' => null/);
});

Deno.test("root node with children", () => {
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const raw: RawTNode = { type: 'raw', raw: 'hello', parent: root };
	const parsed = makeParsed('x');
	const print: PrintTNode = { type: 'print', data: parsed, parent: root };
	root.tnodes.push(raw, print);
	const php = nodeToPhp(root);
	assertMatch(php, /'type' => 'root'/);
	assertMatch(php, /'nodes' =>/);
	assertMatch(php, /'type' => 'raw'/);
	assertMatch(php, /'type' => 'print'/);
});

Deno.test("slot node with name", () => {
	const root = makeRoot();
	const node: SlotTNode = { type: 'slot', name: 'message', parent: root };
	const php = nodeToPhp(node);
	assertMatch(php, /'type' => 'slot'/);
	assertMatch(php, /'name' => 'message'/);
});

Deno.test("slot node without name (undefined) emits null", () => {
	const root = makeRoot();
	const node: SlotTNode = { type: 'slot', name: undefined, parent: root };
	const php = nodeToPhp(node);
	assertMatch(php, /'type' => 'slot'/);
	assertMatch(php, /'name' => null/);
});

Deno.test("backcodeToPhp for simple identifier", () => {
	const parsed = makeParsed('name');
	const php = backcodeToPhp(parsed);
	assertMatch(php, /\['fn' => function\(\$name\) \{ return \$name; \}, 'vars' => \['name'\]\]/);
});

Deno.test("partial-ref node with same-file reference", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: {},
		bindings: [],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'type' => 'partial-ref'/);
	assertMatch(php, /'partial' => \$notice/);
	assertMatch(php, /'wrapper' => null/);
});

Deno.test("partial-ref node with cross-file reference uses variable alias", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: 'graphics/charts.html',
		partialName: 'pie-chart',
		wrapper: null,
		slots: {},
		bindings: [],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /\$graphics_charts__pie_chart/);
});

Deno.test("partial-ref node with wrapper", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: { open: '<div class="x">', close: '</div>' },
		slots: {},
		bindings: [],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'open' =>/);
	assertMatch(php, /'close' =>/);
});

Deno.test("partial-ref node with default slot content", () => {
	const root = makeRoot();
	const slotRaw: RawTNode = { type: 'raw', raw: 'slot content', parent: root };
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: { default: [slotRaw] },
		bindings: [],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'slots' =>/);
	assertMatch(php, /'default' =>/);
	assertMatch(php, /slot content/);
});

Deno.test("partial-ref node with binding", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: {},
		bindings: [{ kind: 'expr', name: 'mood', data: makeParsed('user.mood') }],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'bindings' =>/);
	assertMatch(php, /'name' => 'mood'/);
	assertMatch(php, /'fn' =>/);
});

Deno.test("partial-ref binding with literal true (bare boolean)", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: {},
		bindings: [{ kind: 'literal', name: 'premium', value: true }],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'name' => 'premium'/);
	assertMatch(php, /'literal' => true/);
	// Should not include 'data' for a literal-only binding
	assertEquals(/'data' =>/.test(php.split("'bindings' =>")[1] ?? ''), false);
});

Deno.test("partial-ref binding with literal false", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: {},
		bindings: [{ kind: 'literal', name: 'premium', value: false }],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'name' => 'premium'/);
	assertMatch(php, /'literal' => false/);
});

Deno.test("partial-ref binding with literal string value", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: {},
		bindings: [{ kind: 'literal', name: 'label', value: 'hello' }],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'name' => 'label'/);
	assertMatch(php, /'literal' => 'hello'/);
});

Deno.test("partial-ref binding with literal string escapes single quotes", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: {},
		bindings: [{ kind: 'literal', name: 'label', value: "it's" }],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'literal' => 'it\\'s'/);
});

Deno.test("partial-ref binding with cast=bool", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: {},
		bindings: [{ kind: 'expr', name: 'premium', data: makeParsed('user.isPro'), cast: 'bool' }],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'name' => 'premium'/);
	assertMatch(php, /'data' => \['fn' =>/);
	assertMatch(php, /'cast' => 'bool'/);
});

Deno.test("partial-ref binding with cast=string", () => {
	const root = makeRoot();
	const node: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'notice',
		wrapper: null,
		slots: {},
		bindings: [{ kind: 'expr', name: 'label', data: makeParsed('count'), cast: 'string' }],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'name' => 'label'/);
	assertMatch(php, /'data' => \['fn' =>/);
	assertMatch(php, /'cast' => 'string'/);
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
		callerOpenTag: [],
		parent: root
	};
	const php = nodeToPhp(node);
	assertMatch(php, /'name' => 'title'/);
	assertMatch(php, /'name' => 'premium'/);
	assertMatch(php, /'literal' => true/);
	assertMatch(php, /'name' => 'badge'/);
	assertMatch(php, /'literal' => 'gold'/);
	assertMatch(php, /'cast' => 'bool'/);
	assertMatch(php, /'cast' => 'string'/);
});

Deno.test("sanitizeName replaces hyphens and dots", () => {
	assertEquals(sanitizeName('pie-chart'), 'pie_chart');
	assertEquals(sanitizeName('my.partial'), 'my_partial');
	assertEquals(sanitizeName('valid_name'), 'valid_name');
});

Deno.test("fileToPhpFile starts with <?php and ends with return compact(", () => {
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	root.tnodes.push({ type: 'raw', raw: '<p>hello</p>', parent: root });
	const file: CompiledFile = {
		partials: new Map([['notice', root]])
	};
	const php = fileToPhpFile(file, 'blog/general.html');
	assertMatch(php, /^<\?php/);
	assertMatch(php, /return compact\(/);
	assertMatch(php, /notice/);
});

Deno.test("fileToPhpFile contains all partial names", () => {
	const root1: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	root1.tnodes.push({ type: 'raw', raw: '<p>notice</p>', parent: root1 });
	const root2: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	root2.tnodes.push({ type: 'raw', raw: '<article>post</article>', parent: root2 });
	const file: CompiledFile = {
		partials: new Map([['notice', root1], ['post', root2]])
	};
	const php = fileToPhpFile(file, 'blog/general.html');
	assertMatch(php, /\$notice\s*=/);
	assertMatch(php, /\$post\s*=/);
	assertMatch(php, /return compact\('notice', 'post'\)|return compact\('post', 'notice'\)/);
});

Deno.test("fileToPhpFile emits backflip_require for cross-file partial-ref", () => {
	const root: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const ref: PartialRefTNode = {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: 'graphics/charts.html',
		partialName: 'pie-chart',
		wrapper: null,
		slots: {},
		bindings: [],
		parent: root
	};
	root.tnodes.push(ref);
	const file: CompiledFile = {
		partials: new Map([['post', root]])
	};
	const php = fileToPhpFile(file, 'blog/general.html');
	assertMatch(php, /backflip_require/);
	assertMatch(php, /charts\.php/);
	assertMatch(php, /graphics_charts__pie_chart/);
});

Deno.test("fileToPhpFile same-file dep comes before dependent", () => {
	const noticeRoot: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	noticeRoot.tnodes.push({ type: 'raw', raw: 'notice', parent: noticeRoot });

	const postRoot: RootTNode = { type: 'root', kind: 'named' as const, tnodes: [] };
	const ref: PartialRefTNode = {
		type: 'partial-ref', kind: 'b-part', file: null, partialName: 'notice',
		wrapper: null, slots: {}, bindings: [], parent: postRoot
	};
	postRoot.tnodes.push(ref);

	const file: CompiledFile = {
		partials: new Map([['post', postRoot], ['notice', noticeRoot]])
	};
	const php = fileToPhpFile(file, 'page.html');
	const noticeIdx = php.indexOf('$notice =');
	const postIdx = php.indexOf('$post =');
	assertEquals(noticeIdx < postIdx, true);
});
