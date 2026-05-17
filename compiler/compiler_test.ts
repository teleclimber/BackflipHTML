import { assert, assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert";

import type { RootTNode, RawTNode, PrintTNode, ForTNode, IfTNode, SlotTNode, PartialRefTNode, ElementTNode, TNode, AttrPart, SourceLoc, CompileOptions, CompiledFile, PartialDef } from "./types.ts";
import { resolveAssetRefs } from "./helpers.ts";
import { compilePartial } from "./compiler.ts";
import { interpretBackcode } from "./backcode.ts";
import type { BackflipError } from "./errors.ts";

// ---- test helpers ----

/**
 * Serialize a TNode subtree back to its expected rendered HTML for *static* content
 * (i.e. content with no dynamic expressions). Used to keep regression assertions
 * concise; throws if it encounters anything that requires runtime evaluation.
 */
function renderStatic(tnodes: TNode[]): string {
	let out = '';
	for (const node of tnodes) {
		if (node.type === 'raw') out += (node as RawTNode).raw;
		else if (node.type === 'element') {
			const el = node as ElementTNode;
			out += `<${el.tagName}`;
			for (const p of el.attrs) {
				if (p.type === 'static') out += p.raw;
				else throw new Error(`renderStatic: ${el.tagName} has non-static attr (${p.type})`);
			}
			out += el.selfClosing ? ' />' : '>';
			out += renderStatic(el.tnodes);
			if (!el.isVoid && !el.selfClosing) out += `</${el.tagName}>`;
		} else {
			throw new Error(`renderStatic: cannot render ${node.type}`);
		}
	}
	return out;
}

/** Find the first ElementTNode (depth-first) with the given tag name in a list of TNodes. */
function findElement(tnodes: TNode[], tagName: string): ElementTNode | undefined {
	for (const n of tnodes) {
		if (n.type === 'element' && (n as ElementTNode).tagName === tagName) return n as ElementTNode;
		if (n.type === 'element') {
			const found = findElement((n as ElementTNode).tnodes, tagName);
			if (found) return found;
		}
		if (n.type === 'for') {
			const found = findElement((n as ForTNode).tnodes, tagName);
			if (found) return found;
		}
		if (n.type === 'if') {
			for (const b of (n as IfTNode).branches) {
				const found = findElement(b.tnodes, tagName);
				if (found) return found;
			}
		}
	}
	return undefined;
}

// ---- helpers ----

/**
 * Test helper: compile a single-partial HTML snippet by inferring the partial's
 * name and customElement flag from the source. Mirrors the old `compileFile`
 * signature so test bodies stay terse, but internally drives the new
 * `compilePartial` primitive — i.e. tests in this file exercise compilePartial,
 * not scanPartials. Tests that need multi-partial behavior live in
 * partials_test.ts (where compileDirectory / scanPartials live).
 */
async function compileFile(
	html: string,
	_registry?: unknown,
	filename?: string,
	options?: CompileOptions,
): Promise<{ compiled: CompiledFile, errors: BackflipError[] }> {
	const def = inferPartialDef(html, filename ?? '');
	const { compiled: root, errors } = await compilePartial(html, def, options);
	return { compiled: { partials: new Map([[def.name, root]]) }, errors };
}

function inferPartialDef(html: string, filename: string): PartialDef {
	// Find the first opening tag in the snippet.
	const m = html.match(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/);
	if (!m) throw new Error(`compileFile (test helper): no opening tag in: ${html.slice(0, 80)}`);
	const tagName = m[1];
	const attrText = m[2];
	const bNameMatch = attrText.match(/\bb-name\s*=\s*"([^"]*)"/);
	const exported = /\bb-export(?:\b|=)/.test(attrText);
	const customElement = !bNameMatch && /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(tagName);
	const name = bNameMatch ? bNameMatch[1] : tagName;
	const lines = html.split('\n').length;
	return {
		name,
		exported,
		customElement,
		loc: { filename, from: 1, to: lines },
	};
}

/** Helper: compile a snippet of HTML as a single partial via b-unwrap, returning the root and errors. */
async function compileSnippet(html: string): Promise<{ root: RootTNode, errors: BackflipError[] }> {
	const { compiled, errors } = await compileFile(`<b-unwrap b-name="test">${html}</b-unwrap>`);
	const root = compiled.partials.get('test')!;
	return { root, errors };
}

function findTNode<T extends TNode>(tnodes: TNode[], predicate: (n: TNode) => boolean): T | undefined {
	for (const n of tnodes) {
		if (predicate(n)) return n as T;
		if (n.type === 'element') {
			const found = findTNode<T>((n as ElementTNode).tnodes, predicate);
			if (found) return found;
		}
		if (n.type === 'for') {
			const found = findTNode<T>((n as ForTNode).tnodes, predicate);
			if (found) return found;
		}
		if (n.type === 'if') {
			for (const b of (n as IfTNode).branches) {
				const found = findTNode<T>(b.tnodes, predicate);
				if (found) return found;
			}
		}
	}
	return undefined;
}

function findPartialRef(root: RootTNode): PartialRefTNode {
	const found = findTNode<PartialRefTNode>(root.tnodes, n => n.type === 'partial-ref');
	if (!found) throw new Error("no partial-ref found");
	return found;
}

function findForNode(root: RootTNode): ForTNode {
	const found = findTNode<ForTNode>(root.tnodes, n => n.type === 'for');
	if (!found) throw new Error("no for node found");
	return found;
}

function findIfNode(root: RootTNode): IfTNode {
	const found = findTNode<IfTNode>(root.tnodes, n => n.type === 'if');
	if (!found) throw new Error("no if node found");
	return found;
}

function findSlotNode(root: RootTNode): SlotTNode {
	const found = findTNode<SlotTNode>(root.tnodes, n => n.type === 'slot');
	if (!found) throw new Error("no slot node found");
	return found;
}

// ---- compileSnippet: void elements ----

Deno.test("void elements: do not corrupt tag matching", async () => {
	const { root } = await compileSnippet('<div><br><span>hi</span></div>');
	// Should not throw - if br is pushed to tag_stack without being popped,
	// </span> would try to match <br> and fail
	assertEquals(renderStatic(root.tnodes), '<div><br><span>hi</span></div>');
});

Deno.test("void elements: self-closing slash preserved", async () => {
	const { root } = await compileSnippet('<div><br /><img src="a.png" /></div>');
	assertEquals(renderStatic(root.tnodes), '<div><br /><img src="a.png" /></div>');
});

Deno.test("void elements: self-closing slash preserved on attr-bind", async () => {
	const { compiled } = await compileFile('<div b-name="test"><img :src="url" /></div>');
	const root = compiled.partials.get('test')!;
	const img = findElement(root.tnodes, 'img')!;
	assertEquals(img.type, 'element');
	assertEquals(img.selfClosing, true);
});

Deno.test("void elements: non-self-closing has no selfClosing flag", async () => {
	const { compiled } = await compileFile('<div b-name="test"><img :src="url"></div>');
	const root = compiled.partials.get('test')!;
	const img = findElement(root.tnodes, 'img')!;
	assertEquals(img.type, 'element');
	assertEquals(img.selfClosing, undefined);
});

// ---- compileSnippet: b-for ----

Deno.test("b-for: tag reconstruction has space before attrs", async () => {
	const { root } = await compileSnippet('<div class="x" b-for="item in items">hello</div>');
	const for_node = findForNode(root);
	// The inner element should reconstruct the tag with its attrs
	assertEquals(renderStatic(for_node.tnodes), '<div class="x">hello</div>');
});

Deno.test("b-for: at root followed by more content", async () => {
	const { root } = await compileSnippet('<ul b-for="item in items"><li>hello</li></ul><p>after</p>');
	// Should have: for_node and the <p>after</p> element
	const forIdx = root.tnodes.findIndex(n => n.type === 'for');
	assertEquals(forIdx >= 0, true);
	const after = root.tnodes.slice(forIdx + 1);
	assertEquals(renderStatic(after), '<p>after</p>');
});

Deno.test("b-for: without 'in' keyword reports error", async () => {
	const { errors } = await compileSnippet('<div b-for="items">hello</div>');
	assertEquals(errors.length > 0, true);
});

// ---- compileSnippet: b-if ----

Deno.test("b-if: simple", async () => {
	const { root } = await compileSnippet('<div b-if="show">hello</div>');
	const if_node = findIfNode(root);
	assertEquals(if_node.type, 'if');
	assertEquals(if_node.branches.length, 1);
	assertEquals(if_node.branches[0].condition, interpretBackcode('show'));
	assertEquals(renderStatic(if_node.branches[0].tnodes), '<div>hello</div>');
});

Deno.test("b-if: with b-else", async () => {
	const { root } = await compileSnippet('<div b-if="show">yes</div><div b-else>no</div>');
	const if_node = findIfNode(root);
	assertEquals(if_node.type, 'if');
	assertEquals(if_node.branches.length, 2);
	assertEquals(if_node.branches[0].condition, interpretBackcode('show'));
	assertEquals(if_node.branches[1].condition, undefined);
	assertEquals(renderStatic(if_node.branches[0].tnodes), '<div>yes</div>');
	assertEquals(renderStatic(if_node.branches[1].tnodes), '<div>no</div>');
});

Deno.test("b-if: with b-else-if and b-else", async () => {
	const { root } = await compileSnippet('<p b-if="a">1</p><p b-else-if="b">2</p><p b-else>3</p>');
	const if_node = findIfNode(root);
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
	const outer = findIfNode(root);
	assertEquals(outer.type, 'if');
	assertEquals(outer.branches.length, 1);
	assertEquals(outer.branches[0].condition, interpretBackcode('a'));
	// Outer branch contains a wrapping div ElementTNode; inside the div's tnodes is the inner IfTNode.
	const divEl = findElement(outer.branches[0].tnodes, 'div')!;
	assertExists(divEl);
	const inner_if = divEl.tnodes.find(n => n.type === 'if') as IfTNode;
	assertEquals(inner_if.type, 'if');
	assertEquals(inner_if.branches.length, 1);
	assertEquals(inner_if.branches[0].condition, interpretBackcode('b'));
	assertEquals(renderStatic(inner_if.branches[0].tnodes), '<span>inner</span>');
});

Deno.test("b-if: nested with b-else inside b-if", async () => {
	const { root } = await compileSnippet('<div b-if="a"><p b-if="b">yes</p><p b-else>no</p></div>');
	const outer = findIfNode(root);
	assertEquals(outer.branches.length, 1);
	const divEl = findElement(outer.branches[0].tnodes, 'div')!;
	const inner_if = divEl.tnodes.find(n => n.type === 'if') as IfTNode;
	assertEquals(inner_if.type, 'if');
	assertEquals(inner_if.branches.length, 2);
	assertEquals(inner_if.branches[0].condition, interpretBackcode('b'));
	assertEquals(inner_if.branches[1].condition, undefined);
});

Deno.test("b-if: nested inside b-for", async () => {
	const { root } = await compileSnippet('<div b-for="item in items"><span b-if="item.show">hi</span></div>');
	const for_node = findForNode(root);
	assertEquals(for_node.type, 'for');
	const divEl = findElement(for_node.tnodes, 'div')!;
	const inner_if = divEl.tnodes.find(n => n.type === 'if') as IfTNode;
	assertEquals(inner_if.type, 'if');
	assertEquals(inner_if.branches[0].condition, interpretBackcode('item.show'));
});

Deno.test("b-if: with content after", async () => {
	const { root } = await compileSnippet('<div b-if="show">hello</div><p>after</p>');
	const ifIdx = root.tnodes.findIndex(n => n.type === 'if');
	assertEquals(ifIdx >= 0, true);
	const after = root.tnodes.slice(ifIdx + 1);
	assertEquals(renderStatic(after), '<p>after</p>');
});

// ---- compileFile: partials ----

Deno.test("compileFile: single partial with b-name on a div", async () => {
	const { compiled: result } = await compileFile('<div b-name="hero">Hello</div>');
	assertEquals(result.partials.size, 1);
	const root = result.partials.get("hero")!;
	assertEquals(root.type, 'root');
	// Wrapping div ElementTNode with the body inside.
	const wrap = root.tnodes[0] as ElementTNode;
	assertEquals(wrap.type, 'element');
	assertEquals(wrap.tagName, 'div');
	assertEquals(renderStatic(root.tnodes), '<div>Hello</div>');
});

Deno.test("compileFile: b-name on b-unwrap (partial without wrapper element)", async () => {
	const { compiled: result } = await compileFile('<b-unwrap b-name="inner">content</b-unwrap>');
	assertEquals(result.partials.size, 1);
	const root = result.partials.get("inner")!;
	assertEquals(root.type, 'root');
	// Should have body content but no <b-unwrap> tag emitted.
	assertEquals(renderStatic(root.tnodes), 'content');
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
	assertEquals(root.kind, 'custom-element');
	assertEquals(root.exported, false);
});

Deno.test("compileFile: top-level custom element with b-export is exported", async () => {
	const { compiled, errors } = await compileFile('<my-card b-export>content</my-card>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-card');
	assertExists(root);
	assertEquals(root.exported, true);
	assertEquals(root.kind, 'custom-element');
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

// Multi-partial-per-file tests live in partials_test.ts (compileDirectory / scanPartials).

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
	assertEquals(compiled.partials.get('x')?.kind, 'named');
});

Deno.test("compileFile: nested custom element creates a partial-ref call site", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card>x</my-card></div>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const found = findPartialRef(root);
	if (found.kind !== 'custom-element') throw new Error("expected custom-element call");
	assertEquals(found.partialName, 'my-card');
	assertEquals(found.callerTagName, 'my-card');
});

Deno.test("compileFile: custom element call captures b-data:* bindings", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card b-data:title="post.title">x</my-card></div>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const found = findPartialRef(root);
	assertEquals(found.bindings.length, 1);
	assertEquals(found.bindings[0].name, 'title');
});

Deno.test("compileFile: custom element call captures default slot content from children", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card>hello world</my-card></div>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const found = findPartialRef(root);
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
	const found = findPartialRef(root);
	assertEquals('title' in found.slots, true);
});

Deno.test("compileFile: custom element partial body excludes the wrapping tag", async () => {
	const { compiled, errors } = await compileFile('<my-card class="card">body</my-card>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-card')!;
	// Body content is in root.tnodes; no wrapping `<my-card>` element should appear there.
	const wrapper = root.tnodes.find(n => n.type === 'element' && (n as ElementTNode).tagName === 'my-card');
	assertEquals(wrapper, undefined);
	assertStringIncludes(renderStatic(root.tnodes), 'body');
});

Deno.test("compileFile: custom element partial stores definitionAttrs for attrs", async () => {
	const { compiled, errors } = await compileFile('<my-card class="card" id="main">body</my-card>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-card')!;
	if (root.kind !== 'custom-element') throw new Error("expected custom-element root");
	assertExists(root.definitionAttrs);
	const rendered = root.definitionAttrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertStringIncludes(rendered, 'class="card"');
	assertStringIncludes(rendered, 'id="main"');
});

Deno.test("compileFile: custom element call site stores callerAttrs", async () => {
	const { compiled, errors } = await compileFile('<div b-name="page"><my-card data-x="1"></my-card></div>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	let found: PartialRefTNode | undefined;
	const wrap = root.tnodes[0] as ElementTNode;
	for (const n of wrap.tnodes) {
		if (n.type === 'partial-ref') { found = n as PartialRefTNode; break; }
	}
	assertExists(found);
	if (found.kind !== 'custom-element') throw new Error("expected custom-element call");
	assertExists(found.callerAttrs);
	const rendered = found.callerAttrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertStringIncludes(rendered, 'data-x="1"');
});

// ---- compileFile: b-attr on custom element partial definitions ----

Deno.test("compileFile: b-attr declarations populate partialRoot.bAttrs", async () => {
	const { compiled, errors } = await compileFile('<my-widget b-attr:premium b-attr:checked.bool>body</my-widget>');
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-widget');
	assertExists(root);
	if (root.kind !== 'custom-element') throw new Error("expected custom-element root");
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
	if (root.kind !== 'custom-element') throw new Error("expected custom-element root");
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
	const found = findPartialRef(root);
	if (found.kind !== 'custom-element') throw new Error("expected custom-element call");
	assertExists(found.callerAttrInfos);
	const premium = found.callerAttrInfos!.find(a => a.name === 'premium');
	const foo = found.callerAttrInfos!.find(a => a.name === 'foo');
	assertExists(premium);
	assertExists(foo);
	assertEquals(premium!.kind, 'expr');
	assertEquals(premium!.value, 'isPremium');
	assertExists(premium!.expr);
	assertEquals(foo!.kind, 'plain');
	assertEquals(foo!.value, 'y');
	assertEquals(foo!.expr, undefined);
});

Deno.test("compileFile: call site captures bare attribute as plain with empty value", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-widget premium></my-widget></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const found = findPartialRef(root);
	if (found.kind !== 'custom-element') throw new Error("expected custom-element call");
	assertExists(found.callerAttrInfos);
	const premium = found.callerAttrInfos!.find(a => a.name === 'premium');
	assertExists(premium);
	assertEquals(premium!.kind, 'plain');
	assertEquals(premium!.value, '');
});

Deno.test("compileFile: b-attr declarations are not rendered on definition open tag", async () => {
	const { compiled, errors } = await compileFile(
		'<my-widget b-attr:premium b-attr:checked.bool class="card">body</my-widget>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('my-widget')!;
	if (root.kind !== 'custom-element') throw new Error("expected custom-element root");
	assertExists(root.definitionAttrs);
	const rendered = root.definitionAttrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertEquals(rendered.includes('b-attr'), false);
	assertStringIncludes(rendered, 'class="card"');
});

Deno.test("compileFile: b-attr declarations are not rendered on call-site open tag", async () => {
	// Verify that the call-site's captured attrs do not contain any 'b-attr' text
	// — call sites never carry b-attr declarations.
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-widget data-x="1"></my-widget></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const found = findPartialRef(root);
	if (found.kind !== 'custom-element') throw new Error("expected custom-element call");
	assertExists(found.callerAttrs);
	const rendered = found.callerAttrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertEquals(rendered.includes('b-attr'), false);
});

// ---- compileFile: b-part ----

Deno.test("compileFile: b-part same-file reference creates PartialRefTNode with correct file=null and partialName", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><div b-part="#hero"></div></div>');
	const root = result.partials.get("page")!;
	const found = findPartialRef(root);
	assertEquals(found.file, null);
	assertEquals(found.partialName, "hero");
});

Deno.test("compileFile: b-part with b-unwrap produces no wrapping ElementTNode", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"></b-unwrap></div>');
	const root = result.partials.get("page")!;
	// Outer wrapping div, then directly a partial-ref (no extra wrapping element).
	const pageDiv = root.tnodes[0] as ElementTNode;
	assertEquals(pageDiv.tagName, 'div');
	const directChild = pageDiv.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode | undefined;
	assertExists(directChild);
	if (directChild!.kind !== 'b-part') throw new Error("expected b-part call");
});

Deno.test("compileFile: b-part with regular element produces a wrapping ElementTNode around the partial-ref", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><section class="x" b-part="#card"></section></div>');
	const root = result.partials.get("page")!;
	const pageDiv = root.tnodes[0] as ElementTNode;
	const section = pageDiv.tnodes.find(n => n.type === 'element' && (n as ElementTNode).tagName === 'section') as ElementTNode | undefined;
	assertExists(section);
	// The wrapping <section> carries the source's static attrs, and `b-part` is stripped.
	const staticRaw = section!.attrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertStringIncludes(staticRaw, 'class="x"');
	assertEquals(staticRaw.includes('b-part'), false);
	// Section.tnodes contains exactly one child: the BPartCallTNode.
	assertEquals(section!.tnodes.length, 1);
	assertEquals(section!.tnodes[0].type, 'partial-ref');
});

Deno.test("dynamic attr on b-part wrapper is preserved as ElementTNode.attrs", async () => {
	// compilePartial doesn't resolve cross-partial references, so the page partial here
	// is independent of whether 'card' is also defined.
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><div b-part="#card" :class="cls"></div></div>'
	);
	assertEquals(errors.length, 0);
	const page = compiled.partials.get("page")!;
	const pageDiv = page.tnodes[0] as ElementTNode;
	const wrap = pageDiv.tnodes.find(n => n.type === 'element' && (n as ElementTNode).tagName === 'div') as ElementTNode | undefined;
	assertExists(wrap, "expected a wrapping <div> ElementTNode for the b-part call");
	// The wrapping <div> should carry a dynamic 'class' attr
	const dynClass = wrap!.attrs.find(p => p.type === 'dynamic') as Extract<AttrPart, { type: 'dynamic' }> | undefined;
	assertExists(dynClass, "dynamic :class on b-part wrapper must be preserved");
	assertEquals(dynClass!.name, 'class');
	// Body should contain the partial-ref as a child.
	assertEquals(wrap!.tnodes.length, 1);
	assertEquals(wrap!.tnodes[0].type, 'partial-ref');
});

Deno.test("static attr on b-part wrapper unchanged", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><section class="x" id="y" b-part="#card"></section></div>'
	);
	assertEquals(errors.length, 0);
	const page = compiled.partials.get("page")!;
	const pageDiv = page.tnodes[0] as ElementTNode;
	const wrap = pageDiv.tnodes.find(n => n.type === 'element' && (n as ElementTNode).tagName === 'section') as ElementTNode | undefined;
	assertExists(wrap);
	const staticRaw = wrap!.attrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertStringIncludes(staticRaw, 'class="x"');
	assertStringIncludes(staticRaw, 'id="y"');
	assertEquals(staticRaw.includes('b-part'), false);
});

Deno.test("<b-unwrap b-part> produces no wrapping ElementTNode", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><b-unwrap b-part="#card"></b-unwrap></div>'
	);
	assertEquals(errors.length, 0);
	const page = compiled.partials.get("page")!;
	const pageDiv = page.tnodes[0] as ElementTNode;
	// The partial-ref must be a direct child of the wrapping page-div, with no extra ElementTNode around it.
	const direct = pageDiv.tnodes.find(n => n.type === 'partial-ref');
	assertExists(direct, "expected partial-ref as a direct child of the page wrapper");
	// And no extra element wrapper around it.
	const extraEl = pageDiv.tnodes.find(n => n.type === 'element');
	assertEquals(extraEl, undefined);
});

Deno.test("custom-element call attrs merge unchanged (callerAttrs + definitionAttrs)", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-widget data-x="1" :class="cls"></my-widget></div>'
	);
	assertEquals(errors.length, 0);
	const page = compiled.partials.get("page")!;
	const ref = findPartialRef(page);
	if (ref.kind !== 'custom-element') throw new Error("expected custom-element call");
	// callerAttrs is an AttrPart[] — static parts carry the source's bare HTML attrs,
	// dynamic parts carry the bound ones. No wrapping ElementTNode for the call site itself.
	assertExists(ref.callerAttrs);
	const staticRaw = ref.callerAttrs!.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertStringIncludes(staticRaw, 'data-x="1"');
	const dyn = ref.callerAttrs!.find(p => p.type === 'dynamic') as Extract<AttrPart, { type: 'dynamic' }> | undefined;
	assertExists(dyn);
	assertEquals(dyn!.name, 'class');
});

Deno.test("compileFile: b-data: creates bindings on PartialRefTNode", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><b-unwrap b-part="#card" b-data:title="item.title"></b-unwrap></div>');
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	assertEquals(ref.bindings.length, 1);
	assertEquals(ref.bindings[0].name, "title");
	const titleBinding = ref.bindings[0];
	if (titleBinding.kind !== 'expr') throw new Error("expected expr binding");
	assertEquals(titleBinding.data.vars.includes("item"), true);
});

// ---- compileFile: slots ----

Deno.test("compileFile: b-slot creates SlotTNode", async () => {
	const { compiled: result } = await compileFile('<div b-name="card"><b-unwrap b-slot="title"></b-unwrap></div>');
	const root = result.partials.get("card")!;
	const found = findSlotNode(root);
	assertEquals(found.name, "title");
});

Deno.test("compileFile: b-slot with no value creates SlotTNode with undefined name", async () => {
	const { compiled: result } = await compileFile('<div b-name="card"><b-unwrap b-slot></b-unwrap></div>');
	const root = result.partials.get("card")!;
	const found = findSlotNode(root);
	assertEquals(found.name, undefined);
});

Deno.test("compileFile: non-b-unwrap b-slot followed by text compiles cleanly", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><span b-slot></span>tail</div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get("page")!;
	// The slot is wrapped in a <span> ElementTNode; <span> is in pageDiv.tnodes followed by trailing text.
	const pageDiv = root.tnodes[0] as ElementTNode;
	const spanIdx = pageDiv.tnodes.findIndex(n => n.type === 'element' && (n as ElementTNode).tagName === 'span');
	assertEquals(spanIdx >= 0, true);
	const trailing = pageDiv.tnodes.slice(spanIdx + 1)
		.filter(n => n.type === 'raw').map(n => (n as RawTNode).raw).join('');
	assertStringIncludes(trailing, 'tail');
});

Deno.test("compileFile: default slot content captured", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p>default content</p></b-unwrap></div>');
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	const defaultSlot = ref.slots['default'];
	assertExists(defaultSlot);
	// The slot contains a <p> ElementTNode with text "default content" inside.
	const pEl = findElement(defaultSlot, 'p')!;
	assertExists(pEl);
	assertEquals(renderStatic(pEl.tnodes), 'default content');
});

Deno.test("compileFile: named slot with b-in", async () => {
	const { compiled: result } = await compileFile(
		'<div b-name="page"><b-unwrap b-part="#card"><b-unwrap b-in="header"><h1>Title</h1></b-unwrap></b-unwrap></div>'
	);
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	const headerSlot = ref.slots['header'];
	assertExists(headerSlot);
	const h1 = findElement(headerSlot, 'h1')!;
	assertEquals(renderStatic(h1.tnodes), 'Title');
});

Deno.test("compileFile: div b-part with no content does not create spurious default slot", async () => {
	const { compiled: result } = await compileFile(
		'<div b-name="page"><div class="leaderboard" b-part="#leaderboard"></div></div>'
	);
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	const defaultSlot = ref.slots['default'];
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
	const ref = findPartialRef(root);
	const headerSlot = ref.slots['header'];
	assertExists(headerSlot);
	// In the new model the wrapping <div b-in="header"> is an ElementTNode in the slot,
	// with its own children (an inner <h1> ElementTNode).
	assertEquals(renderStatic(headerSlot), '<div><h1>Title</h1></div>');
});

// ---- compileFile: slot content (interpolation, b-for, b-if) ----

Deno.test("compileFile: interpolation inside nested element within slot content produces PrintTNode in slot", async () => {
	const { compiled: result } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p>{{ name }}</p></b-unwrap></div>');
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	const defaultSlot = ref.slots['default'];
	assertExists(defaultSlot);
	// The slot has a <p> ElementTNode containing a PrintTNode.
	const p = findElement(defaultSlot, 'p')!;
	const hasPrint = p.tnodes.some(n => n.type === 'print');
	assertEquals(hasPrint, true, "slot should contain a PrintTNode for the {{ name }} interpolation");
});

Deno.test("compileFile: b-for inside slot content produces ForTNode in slot array", async () => {
	const { compiled: result, errors } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p b-for="x in items">{{ x }}</p></b-unwrap></div>');
	assertEquals(errors.length, 0);
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	const defaultSlot = ref.slots['default'];
	assertExists(defaultSlot);
	const forNode = defaultSlot.find(n => n.type === 'for') as ForTNode | undefined;
	assertExists(forNode);
	assertEquals(forNode!.valName, "x");
	// The print node lives inside the wrapping <p> ElementTNode inside the for body.
	const pEl = findElement(forNode!.tnodes, 'p')!;
	const hasPrint = pEl.tnodes.some(n => n.type === 'print');
	assertEquals(hasPrint, true, "wrapping <p> should contain the {{ x }} PrintTNode");
});

Deno.test("compileFile: b-if/b-else inside slot content produces IfTNode in slot array", async () => {
	const { compiled: result, errors } = await compileFile('<div b-name="page"><b-unwrap b-part="#card"><p b-if="show">yes</p><p b-else>no</p></b-unwrap></div>');
	assertEquals(errors.length, 0);
	const root = result.partials.get("page")!;
	const ref = findPartialRef(root);
	const defaultSlot = ref.slots['default'];
	assertExists(defaultSlot);
	const ifNode = defaultSlot.find(n => n.type === 'if') as IfTNode | undefined;
	assertExists(ifNode);
	assertEquals(ifNode!.branches.length, 2, "IfTNode should have b-if and b-else branches");
});

// ---- compileFile: bind attrs ----

Deno.test("compileFile: bind attr on b-name root element produces AttrBindTNode", async () => {
	const { compiled: result, errors } = await compileFile('<div b-name="card" :class="cls">Hello</div>');
	assertEquals(errors.length, 0);
	const root = result.partials.get("card")!;
	const first = root.tnodes[0];
	assertEquals(first.type, 'element', "root element with :class should produce an ElementTNode");
	const el = first as ElementTNode;
	assertEquals(el.tagName, 'div');
	const dynamicPart = el.attrs.find(p => p.type === 'dynamic');
	assertEquals(dynamicPart !== undefined, true, "should have a dynamic part for :class");
	assertEquals((dynamicPart as { name: string }).name, 'class');
});

Deno.test("compileFile: bind attr on b-name root element excludes b-name and b-export attrs", async () => {
	const { compiled: result, errors } = await compileFile('<div b-name="card" b-export :class="cls" id="x">Hello</div>');
	assertEquals(errors.length, 0);
	const root = result.partials.get("card")!;
	const first = root.tnodes[0] as ElementTNode;
	assertEquals(first.type, 'element');
	// b-name and b-export should not appear in attrs
	const allStatic = first.attrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
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

Deno.test("meta: each partial is compiled in isolation, so meta is slice-relative", async () => {
	// compilePartial sees only one partial's slice, so meta offsets/lines are local
	// to the slice. Each of these starts at offset 0 within its own slice.
	const headerSlice = '<div b-name="header"><h1>hi</h1></div>';
	const footerSlice = '<div b-name="footer"><p>bye</p></div>';
	const headerDef: PartialDef = { name: 'header', exported: false, customElement: false, loc: { filename: '', from: 1, to: 1 } };
	const footerDef: PartialDef = { name: 'footer', exported: false, customElement: false, loc: { filename: '', from: 2, to: 2 } };
	const { compiled: header } = await compilePartial(headerSlice, headerDef);
	const { compiled: footer } = await compilePartial(footerSlice, footerDef);
	assertEquals(header.meta!.startOffset, 0);
	assertEquals(header.meta!.endOffset, headerSlice.length);
	assertEquals(footer.meta!.startOffset, 0);
	assertEquals(footer.meta!.endOffset, footerSlice.length);
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
	const printNode = findTNode<PrintTNode>(root.tnodes, n => n.type === 'print');
	assertExists(printNode);
	const loc = printNode!.loc!;
	assertExists(loc);
	const expected = src.indexOf('{{ myVar }}');
	assertEquals(loc.startOffset, expected);
	assertEquals(loc.endOffset, expected + '{{ myVar }}'.length);
	assertEquals(loc.startLine, 1);
});

Deno.test("loc: {{ expr }} after newline increments line", async () => {
	const src = '<div b-name="page">line1\n{{ myVar }}</div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const printNode = findTNode<PrintTNode>(root.tnodes, n => n.type === 'print');
	assertExists(printNode);
	const loc = printNode!.loc!;
	assertExists(loc);
	assertEquals(loc.startLine, 2);
	assertEquals(loc.startCol, 1);
	const expected = src.indexOf('{{ myVar }}');
	assertEquals(loc.startOffset, expected);
});

Deno.test("loc: :href bind attr dynamic part location", async () => {
	const src = '<div b-name="page"><a :href="url">link</a></div>';
	const { compiled: result } = await compileFile(src);
	const root = result.partials.get("page")!;
	const aEl = findElement(root.tnodes, 'a')!;
	const dynPart = aEl.attrs.find(p => p.type === 'dynamic');
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
	const spanEl = findElement(root.tnodes, 'span')!;
	const dynPart = spanEl.attrs.find(p => p.type === 'dynamic');
	assertEquals(dynPart !== undefined, true);
	const loc = (dynPart as { loc?: SourceLoc }).loc!;
	assertEquals(loc !== undefined, true);
	const expected = src.indexOf('b-bind:class=');
	assertEquals(loc.startOffset, expected);
	const endExpected = expected + 'b-bind:class="cls"'.length;
	assertEquals(loc.endOffset, endExpected);
});

// ---- includeLocs tests ----

// Helper: gather all static-AttrPart raw text from an element's attrs into a single string.
function staticAttrs(el: ElementTNode): string {
	return el.attrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
}

// Recursively collect every AttrPart from every ElementTNode (including custom-element
// callerAttrs / definitionAttrs) in a tree, depth-first.
function collectAllAttrParts(tnodes: TNode[]): AttrPart[] {
	const out: AttrPart[] = [];
	function walk(ns: TNode[]) {
		for (const n of ns) {
			if (n.type === 'element') {
				const el = n as ElementTNode;
				for (const p of el.attrs) out.push(p);
				walk(el.tnodes);
			} else if (n.type === 'for') walk((n as ForTNode).tnodes);
			else if (n.type === 'if') for (const b of (n as IfTNode).branches) walk(b.tnodes);
			else if (n.type === 'partial-ref') {
				if (n.kind === 'custom-element') {
					if (n.callerAttrs) for (const p of n.callerAttrs) out.push(p);
				}
				for (const sl of Object.values(n.slots)) walk(sl);
			}
		}
	}
	walk(tnodes);
	return out;
}

// Render the static-only portion of a root (with all ElementTNode open/close tags) into a string.
function rootRenderStatic(root: RootTNode): string {
	return renderStatic(root.tnodes);
}

Deno.test("includeLocs: regular element gets data-loc attribute", async () => {
	const src = '<div b-name="card"><p>hello</p></div>';
	const { compiled } = await compileFile(src, undefined, 'test.html', { includeLocs: true });
	const root = compiled.partials.get("card")!;
	const pEl = findElement(root.tnodes, 'p')!;
	assertStringIncludes(staticAttrs(pEl), 'data-loc="test.html#card:1:');
});

Deno.test("includeLocs: b-name root element gets data-loc attribute", async () => {
	const src = '<section b-name="hero"><h1>Title</h1></section>';
	const { compiled } = await compileFile(src, undefined, 'pages.html', { includeLocs: true });
	const root = compiled.partials.get("hero")!;
	const sectionEl = root.tnodes[0] as ElementTNode;
	assertEquals(sectionEl.tagName, 'section');
	assertStringIncludes(staticAttrs(sectionEl), 'data-loc="pages.html#hero:1:');
});

Deno.test("includeLocs: element with bind attr gets data-loc in static part", async () => {
	const src = '<div b-name="card"><a :href="url">link</a></div>';
	const { compiled } = await compileFile(src, undefined, 'test.html', { includeLocs: true });
	const root = compiled.partials.get("card")!;
	const aEl = findElement(root.tnodes, 'a')!;
	assertStringIncludes(staticAttrs(aEl), 'data-loc="test.html#card:1:');
});

Deno.test("includeLocs: b-for element gets data-loc attribute", async () => {
	const src = '<ul b-name="list"><li b-for="item in items">{{ item }}</li></ul>';
	const { compiled } = await compileFile(src, undefined, 'test.html', { includeLocs: true });
	const root = compiled.partials.get("list")!;
	const forNode = findForNode(root);
	const liEl = findElement(forNode.tnodes, 'li')!;
	assertStringIncludes(staticAttrs(liEl), 'data-loc="test.html#list:1:');
});

Deno.test("includeLocs: b-if element gets data-loc attribute", async () => {
	const src = '<div b-name="card"><span b-if="show">visible</span></div>';
	const { compiled } = await compileFile(src, undefined, 'test.html', { includeLocs: true });
	const root = compiled.partials.get("card")!;
	const ifNode = findIfNode(root);
	const spanEl = findElement(ifNode.branches[0].tnodes, 'span')!;
	assertStringIncludes(staticAttrs(spanEl), 'data-loc="test.html#card:1:');
});

Deno.test("includeLocs: disabled by default", async () => {
	const src = '<div b-name="card"><p>hello</p></div>';
	const { compiled } = await compileFile(src, undefined, 'test.html');
	const root = compiled.partials.get("card")!;
	const wrap = root.tnodes[0] as ElementTNode;
	assertEquals(staticAttrs(wrap).includes('data-loc'), false);
	const pEl = findElement(root.tnodes, 'p')!;
	assertEquals(staticAttrs(pEl).includes('data-loc'), false);
});

Deno.test("includeLocs: format is file#partial:line:col", async () => {
	const src = '<div b-name="card"><p>hello</p></div>';
	const { compiled } = await compileFile(src, undefined, 'partials/card.html', { includeLocs: true });
	const root = compiled.partials.get("card")!;
	const wrap = root.tnodes[0] as ElementTNode;
	const match = staticAttrs(wrap).match(/data-loc="partials\/card\.html#card:\d+:\d+"/);
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

Deno.test("asset: static src~ produces 'asset' AttrPart in stage 1", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const assetParts = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset') as Extract<AttrPart, { type: 'asset' }>[];
	assertEquals(assetParts.length, 1);
	assertEquals(assetParts[0].attrName, 'src');
	assertEquals(assetParts[0].originalValue, '@images/photo.jpg');
	assertEquals(assetParts[0].refs.length, 1);
	assertEquals(assetParts[0].refs[0].name, 'images');
	assertEquals(assetParts[0].refs[0].subpath, 'photo.jpg');

	// Stage 2: resolveAssetRefs produces resolved static parts in the same element
	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedRoot = resolved.partials.get("hero")!;
	const out = rootRenderStatic(resolvedRoot);
	assertStringIncludes(out, 'src="/img/photo.jpg"');
	assertEquals(out.includes('~'), false);
	assertEquals(out.includes('@images'), false);
});

Deno.test("asset: static src~ with subpath", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/sub/nested.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const assetParts = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset') as Extract<AttrPart, { type: 'asset' }>[];
	assertEquals(assetParts.length, 1);
	assertEquals(assetParts[0].refs[0].subpath, 'sub/nested.jpg');

	const resolved = resolveAssetRefs(compiled, assetMap);
	assertStringIncludes(rootRenderStatic(resolved.partials.get("hero")!), 'src="/img/sub/nested.jpg"');
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

Deno.test("asset: :src~ (bind) produces isAsset dynamic AttrPart", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { compiled } = await compileFile(
		`<div b-name="hero"><img :src~="'@images/' + file + '.jpg'" /></div>`,
		undefined, 'test.html', { assetMap }
	);
	const root = compiled.partials.get("hero")!;
	const img = findElement(root.tnodes, 'img')!;
	const dynamicPart = img.attrs.find(p => p.type === 'dynamic') as Extract<AttrPart, { type: 'dynamic' }> | undefined;
	assertExists(dynamicPart);
	assertEquals(dynamicPart!.name, 'src');
	assertEquals(dynamicPart!.isAsset, true);
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
	const assetParts = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset') as Extract<AttrPart, { type: 'asset' }>[];
	assertEquals(assetParts.length, 1);
	assertEquals(assetParts[0].attrName, 'srcset');
	assertEquals(assetParts[0].refs.length, 2);
	assertEquals(assetParts[0].refs[0].name, 'images');
	assertEquals(assetParts[0].refs[0].subpath, 'photo.jpg');
	assertEquals(assetParts[0].refs[1].subpath, 'icon.png');

	const resolved = resolveAssetRefs(compiled, assetMap);
	assertStringIncludes(rootRenderStatic(resolved.partials.get("hero")!), 'srcset="/img/photo.jpg 1x, /img/icon.png 2x"');
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
	const img = findElement(root.tnodes, 'img')!;
	const assetPart = img.attrs.find(p => p.type === 'asset') as Extract<AttrPart, { type: 'asset' }> | undefined;
	assertExists(assetPart);
	assertEquals(assetPart!.attrName, 'src');
	assertEquals(assetPart!.originalValue, '@images/photo.jpg');
	assertEquals(assetPart!.refs[0].name, 'images');

	// Stage 2: asset AttrPart resolved to static within the same element.
	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedImg = findElement(resolved.partials.get("hero")!.tnodes, 'img')!;
	assertEquals(resolvedImg.attrs.some(p => p.type === 'asset'), false);
	const staticRaw = resolvedImg.attrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertStringIncludes(staticRaw, 'src="/img/photo.jpg"');
});

Deno.test("asset: resolveAssetRefs does not mutate original", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const beforeCount = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset').length;
	assertEquals(beforeCount, 1);

	resolveAssetRefs(compiled, assetMap);

	// Original should still have its 'asset' AttrPart unresolved.
	const afterCount = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset').length;
	assertEquals(afterCount, 1);
});

// Top-level-element-without-b-name error tests live in partials_test.ts (scanPartials owns this check).

// ---- compileFile: flow directives on custom element call sites ----
// These exercise `<my-elem b-for=...>`, `<my-elem b-if=...>`, `<my-elem b-else-if=...>`,
// `<my-elem b-else>`. The direct form is equivalent to wrapping the call in
// `<b-unwrap b-for|if|...=...>` (which keeps working — see regression test below).

Deno.test("custom element call: b-for wraps the call in a ForTNode", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card b-for="item in items">{{ item }}</my-card></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const for_node = findForNode(root);
	assertEquals(for_node.valName, 'item');
	assertEquals(for_node.iterable, interpretBackcode('items'));
	const ref = for_node.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode | undefined;
	assertExists(ref);
	assertEquals(ref!.partialName, 'my-card');
	assertEquals(ref!.kind, 'custom-element');
});

Deno.test("custom element call: b-for slot content evaluates in the iteration scope", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card b-for="item in items">{{ item.title }}</my-card></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const for_node = findForNode(root);
	const ref = for_node.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	const print = ref.slots['default'].find(n => n.type === 'print') as PrintTNode | undefined;
	assertExists(print);
	assertEquals(print!.data, interpretBackcode('item.title'));
});

Deno.test("custom element call: b-for with b-data:* still captures the binding", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card b-for="item in items" b-data:title="item.title"></my-card></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const for_node = findForNode(root);
	const ref = for_node.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	assertEquals(ref.bindings.length, 1);
	assertEquals(ref.bindings[0].name, 'title');
	const titleBinding2 = ref.bindings[0];
	if (titleBinding2.kind !== 'expr') throw new Error("expected expr binding");
	assertEquals(titleBinding2.data, interpretBackcode('item.title'));
});

Deno.test("custom element call: b-if wraps the call in an IfTNode", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card b-if="show">x</my-card></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const if_node = findIfNode(root);
	assertEquals(if_node.branches.length, 1);
	assertEquals(if_node.branches[0].condition, interpretBackcode('show'));
	const ref = if_node.branches[0].tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode | undefined;
	assertExists(ref);
	assertEquals(ref!.partialName, 'my-card');
});

Deno.test("custom element call: b-if + b-else chain across custom elements", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card b-if="a">A</my-card><my-other b-else>B</my-other></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const if_node = findIfNode(root);
	assertEquals(if_node.branches.length, 2);
	assertEquals(if_node.branches[0].condition, interpretBackcode('a'));
	assertEquals(if_node.branches[1].condition, undefined);
	const a = if_node.branches[0].tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	const b = if_node.branches[1].tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	assertEquals(a.partialName, 'my-card');
	assertEquals(b.partialName, 'my-other');
});

Deno.test("custom element call: b-if / b-else-if / b-else chain across custom elements", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-a b-if="a">A</my-a><my-b b-else-if="b">B</my-b><my-c b-else>C</my-c></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const if_node = findIfNode(root);
	assertEquals(if_node.branches.length, 3);
	assertEquals(if_node.branches[0].condition, interpretBackcode('a'));
	assertEquals(if_node.branches[1].condition, interpretBackcode('b'));
	assertEquals(if_node.branches[2].condition, undefined);
	const refs = if_node.branches.map(b => b.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode);
	assertEquals(refs.map(r => r.partialName), ['my-a', 'my-b', 'my-c']);
});

Deno.test("custom element call: b-else on custom element chains to a preceding b-if on a regular tag", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><p b-if="cond">yes</p><my-card b-else>no</my-card></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const if_node = findIfNode(root);
	assertEquals(if_node.branches.length, 2);
	const ref = if_node.branches[1].tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	assertExists(ref);
	assertEquals(ref.partialName, 'my-card');
});

Deno.test("custom element call: b-else on regular tag chains to a preceding b-if on a custom element", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card b-if="cond">yes</my-card><p b-else>no</p></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const if_node = findIfNode(root);
	assertEquals(if_node.branches.length, 2);
	const ref = if_node.branches[0].tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	assertExists(ref);
	const pEl = findElement(if_node.branches[1].tnodes, 'p');
	assertExists(pEl);
});

Deno.test("custom element call: self-closing with b-if", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card b-if="show" /></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const if_node = findIfNode(root);
	const ref = if_node.branches[0].tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	assertEquals(ref.partialName, 'my-card');
});

Deno.test("custom element call: content after b-for is a sibling, not inside the loop", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-card b-for="x in xs">in</my-card><p>after</p></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const pageWrap = root.tnodes[0] as ElementTNode;
	const idx = pageWrap.tnodes.findIndex(n => n.type === 'for');
	assertEquals(idx >= 0, true);
	const after = pageWrap.tnodes.slice(idx + 1);
	assertEquals(renderStatic(after), '<p>after</p>');
});

Deno.test("custom element call: nested custom-element b-for inside another custom-element b-for slot", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><my-list b-for="row in rows"><my-item b-for="cell in row">x</my-item></my-list></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const outerFor = findForNode(root);
	assertEquals(outerFor.valName, 'row');
	const outerRef = outerFor.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	assertEquals(outerRef.partialName, 'my-list');
	// The inner b-for lives in the outer call's default slot
	const innerFor = outerRef.slots['default'].find(n => n.type === 'for') as ForTNode | undefined;
	assertExists(innerFor);
	assertEquals(innerFor!.valName, 'cell');
	const innerRef = innerFor!.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	assertEquals(innerRef.partialName, 'my-item');
});

Deno.test("custom element call: more than one flow attr reports 'more than one b-attr'", async () => {
	const { errors } = await compileFile(
		'<div b-name="page"><my-card b-for="x in xs" b-if="cond">x</my-card></div>'
	);
	assertEquals(errors.length > 0, true);
	assertStringIncludes(errors.map(e => e.message).join(' | '), 'more than one b-attr');
});

Deno.test("custom element call: existing b-unwrap b-for wrap continues to work (regression)", async () => {
	const { compiled, errors } = await compileFile(
		'<div b-name="page"><b-unwrap b-for="x in xs"><my-card b-data:item="x"></my-card></b-unwrap></div>'
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get('page')!;
	const for_node = findForNode(root);
	const ref = for_node.tnodes.find(n => n.type === 'partial-ref') as PartialRefTNode;
	assertEquals(ref.partialName, 'my-card');
	assertEquals(ref.bindings[0].name, 'item');
});

