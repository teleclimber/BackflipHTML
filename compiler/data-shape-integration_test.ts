import { assertEquals } from "jsr:@std/assert";
import { compileFile } from './compiler.ts';
import type { DataShape } from './data-shape.ts';

Deno.test("compileFile sets freeVars on compiled partial", async () => {
	const html = `
<div b-name="card">
  <h1>{{ title }}</h1>
  <p>{{ description }}</p>
</div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('card')!;
	assertEquals(root.freeVars, ['description', 'title']);
});

Deno.test("compileFile excludes b-for loop variable", async () => {
	const html = `
<ul b-name="list">
  <li b-for="item in items">{{ item }}</li>
</ul>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('list')!;
	assertEquals(root.freeVars, ['items']);
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
	assertEquals(root.freeVars, ['globalSuffix', 'headerClass', 'heading', 'items', 'showHeader']);
});

Deno.test("compileFile returns empty freeVars for partial with no expressions", async () => {
	const html = `<div b-name="static"><p>Hello world</p></div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('static')!;
	assertEquals(root.freeVars, []);
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
	assertEquals(root.dataShape instanceof Map, true);
	assertEquals(root.dataShape!.size, 2);
	assertEquals(root.dataShape!.get('title')!.usages.has('printed'), true);
	assertEquals(root.dataShape!.get('description')!.usages.has('printed'), true);
});

Deno.test("compileFile dataShape tracks property access", async () => {
	const html = `<p b-name="profile">{{ user.name }} ({{ user.email }})</p>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('profile')!;
	const userShape = root.dataShape!.get('user')!;
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
	const itemsShape = root.dataShape!.get('items')!;
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
	assertEquals(root.dataShape!.get('visible')!.usages.has('boolean'), true);
});

Deno.test("compileFile dataShape tracks attribute usage", async () => {
	const html = `<a b-name="link" :href="url" :class="cls">Click</a>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('link')!;
	const urlShape = root.dataShape!.get('url')!;
	assertEquals(urlShape.usages.has('attribute'), true);
	assertEquals(urlShape.attributes!.has('href'), true);
	const clsShape = root.dataShape!.get('cls')!;
	assertEquals(clsShape.attributes!.has('class'), true);
});

Deno.test("compileFile dataShape returns empty map for static partial", async () => {
	const html = `<div b-name="static"><p>Hello</p></div>`;
	const { compiled } = await compileFile(html);
	const root = compiled.partials.get('static')!;
	assertEquals(root.dataShape!.size, 0);
});
