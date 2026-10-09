import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import { compileFiles } from "../compiler/partials.ts";
import { previewPartial } from "./preview.ts";

// widgets is served from the `static` asset dir.
const STORE_FILES = new Map([['/p/static/stores/widgets.js', `export default new BackflipStore('widgets');\n`]]);
const ASSET_DIRS = new Map([['static', '/p/static']]);
const ASSET_MAP = new Map([['static', '/__assets/static/']]);

async function compile(html: string) {
	const { directory, errors } = await compileFiles(new Map([['t.html', html]]), { storeFiles: STORE_FILES, assetDirs: ASSET_DIRS });
	const fatal = errors.filter(e => e.severity !== 'warning');
	if (fatal.length > 0) throw new Error(fatal.map(e => e.message).join('\n'));
	return directory.files;
}

async function preview(html: string, partialName: string, extra: Partial<Parameters<typeof previewPartial>[0]> = {}) {
	const files = await compile(html);
	return await previewPartial({ partialName, compiledFile: files.get('t.html')!, allFiles: files, fileName: 't.html', assetMap: ASSET_MAP, ...extra });
}

const WIDGET = `<my-widget b-store:widgets b-attr:widget_id b-generate="full">
	<h3>{{ widgets.data[widget_id].name }}</h3>
</my-widget>
`;

Deno.test("preview stores: the motivating widgets.data[widget_id].name example renders", async () => {
	const result = await preview(WIDGET, 'my-widget');
	assertEquals(result.errors, []);
	assertEquals(result.mockData, { widget_id: 'widget_id' });
	assertEquals(result.mockStores, { widgets: { widget_id: { name: 'name' } } });
	assertStringIncludes(result.html, '-->name<!--');
});

Deno.test("preview stores: a reachable partial's stores are mocked and shipped", async () => {
	const result = await preview(WIDGET + `<b-unwrap b-name="page"><body><my-widget widget_id="widget_id"></my-widget></body></b-unwrap>\n`, 'page');
	assertEquals(result.errors, []);
	assertEquals(result.mockStores, { widgets: { widget_id: { name: 'name' } } });
	assertStringIncludes(result.html, '<script type="application/json" data-bf-store="widgets">{"widget_id":{"name":"name"}}</script>');
	assertStringIncludes(result.html, '<link rel="modulepreload" href="/__assets/static/stores/widgets.js">');
});

Deno.test("preview stores: a store the previewed partial declares is not in its context mock", async () => {
	const result = await preview(`<b-unwrap b-name="page" b-store:widgets><p>{{ widgets.data.title }} {{ heading }}</p></b-unwrap>\n`, 'page');
	assertEquals(result.errors, []);
	assertEquals(result.mockData, { heading: 'heading' });
	assertEquals(result.mockStores, { widgets: { title: 'title' } });
	assertStringIncludes(result.html, '<p>title heading</p>');
});

Deno.test("preview stores: store mocks can be overridden", async () => {
	const result = await preview(`<b-unwrap b-name="page" b-store:widgets><p>{{ widgets.data.title }}</p></b-unwrap>\n`, 'page', { storeOverrides: { widgets: { title: 'Mine' } } });
	assertStringIncludes(result.html, '<p>Mine</p>');
});

Deno.test("preview stores: the generated module imports the store file at its preview URL", async () => {
	const tmp = await Deno.makeTempDir({ dir: '/tmp/claude-1000' });
	try {
		const result = await preview(WIDGET, 'my-widget', { domPatchOutputDirs: ['/p/static/bfdom'], domPatchOutDir: tmp });
		const js = await Deno.readTextFile(path.join(tmp, 'my-widget.js'));
		assertStringIncludes(js, `import bfstore_widgets from "/__assets/static/stores/widgets.js";`);
		assertEquals(Object.keys(result.domPatchAssets!).includes('/p/static/bfdom/runtime/dom-patch/stores.js'), true);
	} finally {
		await Deno.remove(tmp, { recursive: true });
	}
});

Deno.test("preview: a b-data map looked up by a variable finds its entry", async () => {
	const result = await preview(`<b-unwrap b-name="row"><p>{{ prices[sku].amount }}</p></b-unwrap>\n`, 'row');
	assertEquals(result.errors, []);
	assertEquals(result.mockData, { prices: { sku: { amount: 'amount' } }, sku: 'sku' });
	assertStringIncludes(result.html, '<p>amount</p>');
});
