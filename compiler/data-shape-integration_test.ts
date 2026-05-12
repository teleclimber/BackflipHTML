import { assertEquals } from "jsr:@std/assert";
import { compilePartial } from './compiler.ts';
import type { CompiledFile, PartialDef, CompileOptions } from './types.ts';
import type { BackflipError } from './errors.ts';
import { inferDataShape, inferFreeVars, type DataShape } from './data-shape.ts';

// Test helper: compile a single-partial HTML snippet by inferring the partial's name from the source.
// Mirrors the old `compileFile` signature so the existing test bodies stay terse, but drives the
// new `compilePartial` primitive under the hood. Multi-partial behavior lives in partials_test.ts.
async function compileFile(
	html: string,
	_registry?: unknown,
	filename?: string,
	options?: CompileOptions,
): Promise<{ compiled: CompiledFile, errors: BackflipError[] }> {
	const m = html.match(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/);
	if (!m) throw new Error(`compileFile (test helper): no opening tag in: ${html.slice(0, 80)}`);
	const tagName = m[1];
	const attrText = m[2];
	const bNameMatch = attrText.match(/\bb-name\s*=\s*"([^"]*)"/);
	const exported = /\bb-export(?:\b|=)/.test(attrText);
	const customElement = !bNameMatch && /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(tagName);
	const name = bNameMatch ? bNameMatch[1] : tagName;
	const lines = html.split('\n').length;
	const def: PartialDef = { name, exported, customElement, loc: { filename: filename ?? '', from: 1, to: lines } };
	const { compiled: root, errors } = await compilePartial(html, def, options);
	return { compiled: { partials: new Map([[def.name, root]]) }, errors };
}

Deno.test("compileFile sets freeVars on compiled partial", async () => {
	const html = `
<div b-name="card">
  <h1>{{ title }}</h1>
  <p>{{ description }}</p>
</div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('card')!;
	assertEquals(inferFreeVars(root), ['description', 'title']);
});

Deno.test("compileFile excludes b-for loop variable", async () => {
	const html = `
<ul b-name="list">
  <li b-for="item in items">{{ item }}</li>
</ul>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('list')!;
	assertEquals(inferFreeVars(root), ['items']);
});

Deno.test("compileFile sets exported to true when b-export is present", async () => {
	const html = `<div b-name="card" b-export>{{ title }}</div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('card')!;
	assertEquals(root.exported, true);
});

Deno.test("compileFile sets exported to false when b-export is absent", async () => {
	const html = `<div b-name="card">{{ title }}</div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('card')!;
	assertEquals(root.exported, false);
});

Deno.test("compileFile collects vars from b-if, b-bind, and nested b-for", async () => {
	const html = `
<div b-name="complex">
  <div b-if="showHeader">
    <h1 :class="headerClass">{{ heading }}</h1>
  </div>
  <ul>
    <li b-for="item in items">
      <span>{{ item }}</span>
      <span>{{ globalSuffix }}</span>
    </li>
  </ul>
</div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('complex')!;
	assertEquals(inferFreeVars(root), ['globalSuffix', 'headerClass', 'heading', 'items', 'showHeader']);
});

Deno.test("compileFile returns empty freeVars for partial with no expressions", async () => {
	const html = `<div b-name="static"><p>Hello world</p></div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('static')!;
	assertEquals(inferFreeVars(root), []);
});

// --- dataShape integration tests ---

Deno.test("compileFile sets dataShape on compiled partial", async () => {
	const html = `
<div b-name="card">
  <h1>{{ title }}</h1>
  <p>{{ description }}</p>
</div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('card')!;
	assertEquals(inferDataShape(root) instanceof Map, true);
	assertEquals(inferDataShape(root).size, 2);
	assertEquals(inferDataShape(root).get('title')!.usages.has('printed'), true);
	assertEquals(inferDataShape(root).get('description')!.usages.has('printed'), true);
});

Deno.test("compileFile dataShape tracks property access", async () => {
	const html = `<p b-name="profile">{{ user.name }} ({{ user.email }})</p>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('profile')!;
	const userShape = inferDataShape(root).get('user')!;
	assertEquals(userShape.properties!.size, 2);
	assertEquals(userShape.properties!.get('name')!.usages.has('printed'), true);
	assertEquals(userShape.properties!.get('email')!.usages.has('printed'), true);
});

Deno.test("compileFile dataShape tracks iterable with elementShape", async () => {
	const html = `
<ul b-name="list">
  <li b-for="item in items">{{ item.label }}</li>
</ul>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('list')!;
	const itemsShape = inferDataShape(root).get('items')!;
	assertEquals(itemsShape.usages.has('iterable'), true);
	assertEquals(itemsShape.elementShape!.properties!.get('label')!.usages.has('printed'), true);
});

Deno.test("compileFile dataShape tracks boolean from b-if", async () => {
	const html = `
<div b-name="toggle">
  <span b-if="visible">Visible</span>
</div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('toggle')!;
	assertEquals(inferDataShape(root).get('visible')!.usages.has('boolean'), true);
});

Deno.test("compileFile dataShape tracks attribute usage", async () => {
	const html = `<a b-name="link" :href="url" :class="cls">Click</a>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('link')!;
	const urlShape = inferDataShape(root).get('url')!;
	assertEquals(urlShape.usages.has('attribute'), true);
	assertEquals(urlShape.attributes!.has('href'), true);
	const clsShape = inferDataShape(root).get('cls')!;
	assertEquals(clsShape.attributes!.has('class'), true);
});

Deno.test("compileFile dataShape returns empty map for static partial", async () => {
	const html = `<div b-name="static"><p>Hello</p></div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('static')!;
	assertEquals(inferDataShape(root).size, 0);
});
