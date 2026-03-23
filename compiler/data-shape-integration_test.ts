import { assertEquals } from "jsr:@std/assert";
import { compileFile } from './compiler.ts';

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
