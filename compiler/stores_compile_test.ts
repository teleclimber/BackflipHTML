import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { compileFiles } from './partials.ts';
import { applyDomPatch } from './generate/dom-patch/nodes2patch.ts';
import { fileToJsModule } from './generate/js/nodes2js.ts';
import { fileToPhpFile } from './generate/php/nodes2php.ts';
import { resolveAssetRefs } from './helpers.ts';
import type { CustomElementPartialRoot, NamedPartialRoot } from './types.ts';

// Two stores: `widgets` is served (inside the `static` asset dir), `users` is not.
const STORE_FILES = new Map([
	['/p/static/stores/widgets.js', `export default new BackflipStore('widgets');\n`],
	['/p/server/stores/users.js', `export default new BackflipStore('users');\n`],
]);
const ASSET_DIRS = new Map([['static', '/p/static']]);

async function compile(html: string, extra: Record<string, string> = {}) {
	const files = new Map([['t.html', html], ...Object.entries(extra)]);
	return await compileFiles(files, { storeFiles: STORE_FILES, assetDirs: ASSET_DIRS, includeLocs: true });
}

async function errorsFor(html: string) {
	const { errors } = await compile(html);
	return errors.filter(e => e.severity !== 'warning');
}

function messages(errors: { message: string }[]): string {
	return errors.map(e => e.message).join('\n');
}

// --- declaring stores --------------------------------------------------------

Deno.test("b-store: declared on a b-name partial, recorded on its root", async () => {
	const { directory, errors } = await compile(`<b-unwrap b-name="page" b-store:widgets b-store:users>{{ widgets.data.a }}{{ users.data.b }}</b-unwrap>\n`);
	assertEquals(errors, []);
	const root = directory.files.get('t.html')!.partials.get('page') as NamedPartialRoot;
	assertEquals(root.stores!.map(s => ({ name: s.name, src: s.src })), [
		{ name: 'widgets', src: '@static/stores/widgets.js' },
		{ name: 'users', src: undefined },
	]);
});

Deno.test("b-store: declared on a custom element partial, recorded on its root with its location", async () => {
	const { directory, errors } = await compile(`<my-widget b-store:widgets>{{ widgets.data.a }}</my-widget>\n`);
	assertEquals(errors, []);
	const root = directory.files.get('t.html')!.partials.get('my-widget') as CustomElementPartialRoot;
	assertEquals(root.stores!.length, 1);
	assertEquals(root.stores![0].name, 'widgets');
	assertEquals(root.stores![0].loc!.startCol, 12);
	assertEquals(root.stores![0].loc!.endCol, 27);
});

Deno.test("b-store: is never rendered as an attribute", async () => {
	const { directory } = await compile(`<section b-name="page" b-store:widgets>{{ widgets.data.a }}</section>\n<my-widget b-store:widgets>{{ widgets.data.a }}</my-widget>\n`);
	const json = JSON.stringify([...directory.files.get('t.html')!.partials.values()].map(r => r.tnodes));
	assertEquals(json.includes('b-store'), false, json);
});

Deno.test("b-store: an undeclared store is an error on the attribute", async () => {
	const errors = await errorsFor(`<b-unwrap b-name="page" b-store:gadgets>x</b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'b-store:gadgets names no declared store');
	assertEquals([errors[0].line, errors[0].col], [1, 25]);
});

Deno.test("b-store: a value is an error", async () => {
	const errors = await errorsFor(`<b-unwrap b-name="page" b-store:widgets="x">x</b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'b-store does not accept a value');
});

Deno.test("b-store: uppercase letters in the name are a warning", async () => {
	const { errors } = await compile(`<b-unwrap b-name="page" b-store:Widgets>{{ widgets.data.a }}</b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertEquals(errors[0].severity, 'warning');
	assertStringIncludes(errors[0].message, 'contains uppercase letters');
});

Deno.test("b-store: on a nested element is an error", async () => {
	const errors = await errorsFor(`<b-unwrap b-name="page"><div b-store:widgets>x</div></b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'b-store is only allowed on partial definitions');
});

Deno.test("b-store: on a custom element call site is an error", async () => {
	const errors = await errorsFor(`<my-widget>x</my-widget>\n<b-unwrap b-name="page"><my-widget b-store:widgets></my-widget></b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'b-store is only allowed on partial definitions');
});

Deno.test("b-store: on a b-part call is an error", async () => {
	const errors = await errorsFor(`<b-unwrap b-name="hero">x</b-unwrap>\n<b-unwrap b-name="page"><div b-part="#hero" b-store:widgets></div></b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'b-store is only allowed on partial definitions');
});

// --- collisions ------------------------------------------------------------

Deno.test("b-store: the same store twice on one tag declares it once", async () => {
	// HTML parsers drop duplicate attributes, so the second b-store never arrives.
	const { directory, errors } = await compile(`<b-unwrap b-name="page" b-store:widgets b-store:widgets>{{ widgets.data.a }}</b-unwrap>\n`);
	assertEquals(errors, []);
	assertEquals(directory.files.get('t.html')!.partials.get('page')!.stores!.map(s => s.name), ['widgets']);
});

Deno.test("b-store: b-store and b-attr with the same name is an error", async () => {
	const errors = await errorsFor(`<my-widget b-store:widgets b-attr:widgets b-generate="full">{{ widgets }}</my-widget>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'b-store:widgets conflicts with b-attr:widgets');
});

Deno.test("b-store: b-data at a call to a partial that declares the store is an error", async () => {
	const errors = await errorsFor(`<b-unwrap b-name="card" b-store:widgets>{{ widgets.data.a }}</b-unwrap>\n<b-unwrap b-name="page"><div b-part="#card" b-data:widgets="x"></div></b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'b-data:widgets is not allowed: <card> declares b-store:widgets');
	assertEquals(errors[0].line, 2);
});

Deno.test("b-store: b-data at a custom element call to a partial that declares the store is an error", async () => {
	const errors = await errorsFor(`<my-card b-store:widgets>{{ widgets.data.a }}</my-card>\n<b-unwrap b-name="page"><my-card b-data:widgets="x"></my-card></b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'b-data:widgets is not allowed: <my-card> declares b-store:widgets');
});

// --- scope -----------------------------------------------------------------

Deno.test("b-store: a called partial that declares its store needs nothing at the call site", async () => {
	const errors = await errorsFor(`<b-unwrap b-name="card" b-store:widgets>{{ widgets.data.a }}</b-unwrap>\n<b-unwrap b-name="page"><div b-part="#card"></div><my-card></my-card></b-unwrap>\n<my-card b-store:users>{{ users.data.b }}</my-card>\n`);
	assertEquals(errors, []);
});

Deno.test("b-store: a called partial that uses a store without declaring it is the 'not passed' error", async () => {
	const errors = await errorsFor(`<b-unwrap b-name="card">{{ widgets.data.a }}</b-unwrap>\n<b-unwrap b-name="page" b-store:widgets><div b-part="#card"></div></b-unwrap>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'variable widgets used in partial <card> but not passed at this call site');
});

Deno.test("b-store: slot content sees the caller's stores", async () => {
	const ok = await errorsFor(`<my-card><b-unwrap b-slot /></my-card>\n<b-unwrap b-name="dash" b-store:widgets><my-card><p>{{ widgets.data.a }}</p></my-card></b-unwrap>\n<b-unwrap b-name="page"><div b-part="#dash"></div></b-unwrap>\n`);
	assertEquals(ok, []);
	const bad = await errorsFor(`<my-card b-store:widgets><b-unwrap b-slot /></my-card>\n<b-unwrap b-name="dash"><my-card><p>{{ widgets.data.a }}</p></my-card></b-unwrap>\n<b-unwrap b-name="page"><div b-part="#dash"></div></b-unwrap>\n`);
	assertStringIncludes(messages(bad), 'variable widgets used in partial <dash> but not passed at this call site');
});

// --- generating partials -----------------------------------------------------

Deno.test("b-store: a generating partial may read a declared served store", async () => {
	const errors = await errorsFor(`<my-widget b-store:widgets b-attr:widget_id b-generate="full"><h3>{{ widgets.data[widget_id].name }}</h3></my-widget>\n`);
	assertEquals(errors, []);
});

Deno.test("b-store: a generating partial using an undeclared store is the 'not declared' error", async () => {
	const errors = await errorsFor(`<my-widget b-attr:widget_id b-generate="full"><h3>{{ widgets.data[widget_id].name }}</h3></my-widget>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, 'variable widgets cannot be supplied to <my-widget>');
	assertStringIncludes(errors[0].message, 'b-store:NAME');
});

Deno.test("b-store: a generating partial may not declare an unserved store", async () => {
	const errors = await errorsFor(`<my-widget b-store:users b-generate="full">{{ users.data.a }}</my-widget>\n`);
	assertEquals(errors.length, 1, messages(errors));
	assertStringIncludes(errors[0].message, '<my-widget> generates client JS, so it may only declare stores the browser can load');
	assertStringIncludes(errors[0].message, '/p/server/stores/users.js');
	assertEquals([errors[0].line, errors[0].col], [1, 12]);
});

Deno.test("b-store: a non-generating custom element may declare an unserved store", async () => {
	const errors = await errorsFor(`<my-widget b-store:users>{{ users.data.a }}</my-widget>\n`);
	assertEquals(errors, []);
});

Deno.test("b-store: a store with a b-attr name is not used as an object error", async () => {
	// b-attr usage rules apply to b-attrs only; store data is any JSON.
	const errors = await errorsFor(`<my-widget b-store:widgets b-attr:id b-generate="full">{{ widgets.data[id].owner.name }}</my-widget>\n`);
	assertEquals(errors, []);
});

// --- the shipped flag ----------------------------------------------------------

async function shippedAfterDomPatch(html: string): Promise<Record<string, Record<string, boolean>>> {
	const { directory, errors } = await compile(html);
	assertEquals(errors.filter(e => e.severity !== 'warning'), []);
	const file = directory.files.get('t.html')!;
	applyDomPatch(file);
	const out: Record<string, Record<string, boolean>> = {};
	for (const [name, root] of file.partials) {
		if (root.stores) out[name] = Object.fromEntries(root.stores.map(s => [s.name, !!s.shipped]));
	}
	return out;
}

Deno.test("shipped: a store read by a patched print site", async () => {
	assertEquals(await shippedAfterDomPatch(`<my-widget b-store:widgets b-attr:id b-generate="full"><h3>{{ widgets.data[id].name }}</h3></my-widget>\n`),
		{ 'my-widget': { widgets: true } });
});

Deno.test("shipped: a store-only site in a partial with no b-attr", async () => {
	assertEquals(await shippedAfterDomPatch(`<my-widget b-store:widgets b-generate="full"><h3>{{ widgets.data.title }}</h3></my-widget>\n`),
		{ 'my-widget': { widgets: true } });
});

Deno.test("shipped: a store read by a patched attribute", async () => {
	assertEquals(await shippedAfterDomPatch(`<my-widget b-store:widgets b-generate="full"><h3 :title="widgets.data.title">x</h3></my-widget>\n`),
		{ 'my-widget': { widgets: true } });
});

Deno.test("shipped: a store driving a reactive b-if condition", async () => {
	assertEquals(await shippedAfterDomPatch(`<my-widget b-store:widgets b-generate="full"><b-unwrap b-if="widgets.data.on"><p>on</p></b-unwrap></my-widget>\n`),
		{ 'my-widget': { widgets: true } });
});

Deno.test("shipped: a store read only inside a reactive b-if branch", async () => {
	assertEquals(await shippedAfterDomPatch(`<my-widget b-store:widgets b-attr:on.bool b-generate="full"><b-unwrap b-if="on"><p>{{ widgets.data.label }}</p></b-unwrap></my-widget>\n`),
		{ 'my-widget': { widgets: true } });
});

Deno.test("shipped: not for a store read only inside a b-for", async () => {
	assertEquals(await shippedAfterDomPatch(`<my-widget b-store:widgets b-attr:id b-generate="full"><p>{{ id }}</p><b-unwrap b-for="w in widgets.data.list"><p>{{ w }}</p></b-unwrap></my-widget>\n`),
		{ 'my-widget': { widgets: false } });
});

Deno.test("shipped: not for a declared store the partial never reads", async () => {
	assertEquals(await shippedAfterDomPatch(`<my-widget b-store:widgets b-attr:id b-generate="full"><p>{{ id }}</p></my-widget>\n`),
		{ 'my-widget': { widgets: false } });
});

Deno.test("shipped: not for a store read by a partial that generates no client JS", async () => {
	assertEquals(await shippedAfterDomPatch(`<my-widget b-store:widgets><p>{{ widgets.data.a }}</p></my-widget>\n<b-unwrap b-name="page" b-store:users>{{ users.data.a }}</b-unwrap>\n`),
		{ 'my-widget': { widgets: false }, page: { users: false } });
});

// --- render nodes --------------------------------------------------------------

Deno.test("render nodes: JS and PHP roots carry their name and { name, shipped, src } per store", async () => {
	const { directory } = await compile(`<my-widget b-store:widgets b-generate="full"><h3>{{ widgets.data.title }}</h3></my-widget>\n<b-unwrap b-name="page" b-store:users b-store:widgets>{{ users.data.a }}</b-unwrap>\n`);
	const file = directory.files.get('t.html')!;
	applyDomPatch(file);
	const resolved = resolveAssetRefs(file, new Map([['static', '/static/']]));
	const js = fileToJsModule(resolved, 't.html');
	assertStringIncludes(js, `stores: [{ name: 'widgets', shipped: true, src: '/static/stores/widgets.js' }]`);
	assertStringIncludes(js, `{ type:"root", name: 'page', stores: [{ name: 'users', shipped: false }, { name: 'widgets', shipped: false, src: '/static/stores/widgets.js' }], nodes:`);
	const php = fileToPhpFile(resolved, 't.html');
	assertStringIncludes(php, `'stores' => [['name' => 'widgets', 'shipped' => true, 'src' => '/static/stores/widgets.js']]`);
	assertStringIncludes(php, `['type' => 'root', 'name' => 'page', 'stores' => [['name' => 'users', 'shipped' => false], ['name' => 'widgets', 'shipped' => false, 'src' => '/static/stores/widgets.js']], 'nodes' =>`);
});
