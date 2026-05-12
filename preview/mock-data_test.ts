import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { generateMockData, type PartialLookup } from './mock-data.ts';
import type { DataShape } from '../compiler/data-shape.ts';
import type { RootTNode, CompiledFile, PartialDef, CompileOptions } from '../compiler/compiler.ts';
import { compilePartial } from '../compiler/compiler.ts';
import type { BackflipError } from '../compiler/errors.ts';

// Test helper: compile a single-partial HTML snippet by inferring the partial's name from the
// source. Mirrors the old `compileFile` signature and drives `compilePartial` under the hood.
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

function shape(usages: string[], extra?: Partial<DataShape>): DataShape {
	return { usages: new Set(usages as any[]), ...extra };
}

// --- Basic usage kinds ---

Deno.test("printed variable generates the variable name as string", () => {
	const shapes = new Map([['title', shape(['printed'])]]);
	const result = generateMockData(shapes);
	assertEquals(result.title, 'title');
});

Deno.test("boolean variable generates true", () => {
	const shapes = new Map([['visible', shape(['boolean'])]]);
	const result = generateMockData(shapes);
	assertEquals(result.visible, true);
});

Deno.test("iterable variable generates an array of 3 items", () => {
	const shapes = new Map([['items', shape(['iterable'])]]);
	const result = generateMockData(shapes);
	assertEquals(Array.isArray(result.items), true);
	assertEquals((result.items as unknown[]).length, 3);
});

Deno.test("iterable with elementShape generates shaped elements", () => {
	const shapes = new Map([['items', shape(['iterable'], {
		elementShape: shape(['printed']),
	})]]);
	const result = generateMockData(shapes);
	const arr = result.items as string[];
	assertEquals(arr[0], 'items 1');
	assertEquals(arr[1], 'items 2');
	assertEquals(arr[2], 'items 3');
});

Deno.test("iterable with object elementShape generates array of objects", () => {
	const shapes = new Map([['posts', shape(['iterable'], {
		elementShape: shape([], {
			properties: new Map([
				['title', shape(['printed'])],
				['active', shape(['boolean'])],
			]),
		}),
	})]]);
	const result = generateMockData(shapes);
	const arr = result.posts as Record<string, unknown>[];
	assertEquals(arr.length, 3);
	assertEquals(arr[0].title, 'title');
	assertEquals(arr[0].active, true);
});

Deno.test("indexed variable generates an array", () => {
	const shapes = new Map([['data', shape([], { indexed: true })]]);
	const result = generateMockData(shapes);
	assertEquals(Array.isArray(result.data), true);
	assertEquals((result.data as unknown[]).length, 3);
});

// --- Attribute values ---

Deno.test("attribute with class generates 'sample-class'", () => {
	const shapes = new Map([['cls', shape(['attribute'], {
		attributes: new Set(['class']),
	})]]);
	const result = generateMockData(shapes);
	assertEquals(result.cls, 'sample-class');
});

Deno.test("attribute with href generates '#'", () => {
	const shapes = new Map([['url', shape(['attribute'], {
		attributes: new Set(['href']),
	})]]);
	const result = generateMockData(shapes);
	assertEquals(result.url, '#');
});

Deno.test("attribute with src generates placeholder URL", () => {
	const shapes = new Map([['img', shape(['attribute'], {
		attributes: new Set(['src']),
	})]]);
	const result = generateMockData(shapes);
	assertEquals(result.img, 'https://placehold.co/300x200');
});

Deno.test("boolean attribute generates true", () => {
	const shapes = new Map([['dis', shape(['attribute'], {
		attributes: new Set(['disabled']),
	})]]);
	const result = generateMockData(shapes);
	assertEquals(result.dis, true);
});

Deno.test("unknown attribute generates sample-{name}", () => {
	const shapes = new Map([['custom', shape(['attribute'], {
		attributes: new Set(['data-foo']),
	})]]);
	const result = generateMockData(shapes);
	assertEquals(result.custom, 'sample-data-foo');
});

// --- Properties ---

Deno.test("properties generate nested object", () => {
	const shapes = new Map([['user', shape([], {
		properties: new Map([
			['name', shape(['printed'])],
			['email', shape(['printed'])],
		]),
	})]]);
	const result = generateMockData(shapes);
	const user = result.user as Record<string, unknown>;
	assertEquals(user.name, 'name');
	assertEquals(user.email, 'email');
});

Deno.test("deeply nested properties", () => {
	const shapes = new Map([['user', shape([], {
		properties: new Map([
			['address', shape([], {
				properties: new Map([
					['city', shape(['printed'])],
				]),
			})],
		]),
	})]]);
	const result = generateMockData(shapes);
	const user = result.user as any;
	assertEquals(user.address.city, 'city');
});

// --- Passed values with partial lookup ---

Deno.test("passed variable resolves shape from called partial", async () => {
	// Called partial 'card' expects 'user' with properties name and active
	const html = `<div b-name="card">{{ user.name }}<div b-if="user.active"></div></div>`;
	const { compiled: compiledFile } = await compileFile(html);
	const lookup: PartialLookup = { compiledFile };

	// Caller passes currentUser to card as 'user'
	const callerShapes = new Map([
		['currentUser', shape(['passed'], {
			passedTo: [{ partial: 'card', as: 'user' }],
		})],
	]);

	const result = generateMockData(callerShapes, lookup);
	const user = result.currentUser as Record<string, unknown>;
	assertEquals(user.name, 'name');
	assertEquals(user.active, true);
});

Deno.test("passed variable merges caller properties with called partial shape", async () => {
	const html = `<div b-name="card">{{ user.name }}</div>`;
	const { compiled: compiledFile } = await compileFile(html);
	const lookup: PartialLookup = { compiledFile };

	// Caller also accesses currentUser.id directly
	const callerShapes = new Map([
		['currentUser', shape(['passed'], {
			passedTo: [{ partial: 'card', as: 'user' }],
			properties: new Map([
				['id', shape(['printed'])],
			]),
		})],
	]);

	const result = generateMockData(callerShapes, lookup);
	const user = result.currentUser as Record<string, unknown>;
	assertEquals(user.id, 'id');       // from caller's own shape
	assertEquals(user.name, 'name');   // from called partial's shape
});

Deno.test("passed to multiple partials merges shapes", async () => {
	const { compiled: cardFile } = await compileFile(`<div b-name="card">{{ data.title }}</div>`);
	const { compiled: badgeFile } = await compileFile(`<div b-name="badge" :class="data.color"></div>`);
	const compiledFile: CompiledFile = {
		partials: new Map([
			['card', cardFile.partials.get('card')!],
			['badge', badgeFile.partials.get('badge')!],
		]),
	};
	const lookup: PartialLookup = { compiledFile };

	const callerShapes = new Map([
		['item', shape(['passed'], {
			passedTo: [
				{ partial: 'card', as: 'data' },
				{ partial: 'badge', as: 'data' },
			],
		})],
	]);

	const result = generateMockData(callerShapes, lookup);
	const item = result.item as Record<string, unknown>;
	assertEquals(item.title, 'title');
	assertEquals(item.color, 'sample-class');
});

Deno.test("passed without lookup falls back to name string", () => {
	const shapes = new Map([
		['val', shape(['passed'], {
			passedTo: [{ partial: 'card', as: 'data' }],
		})],
	]);
	const result = generateMockData(shapes); // no lookup
	assertEquals(result.val, 'val');
});

Deno.test("cross-file partial lookup resolves from allFiles", async () => {
	const html = `<div b-name="card">{{ user.name }}</div>`;
	const { compiled: otherFile } = await compileFile(html);
	const mainFile: CompiledFile = { partials: new Map() };

	const lookup: PartialLookup = {
		compiledFile: mainFile,
		allFiles: new Map([['components.html', otherFile]]),
	};

	const shapes = new Map([
		['u', shape(['passed'], {
			passedTo: [{ partial: 'card', as: 'user' }],
		})],
	]);

	const result = generateMockData(shapes, lookup);
	const u = result.u as Record<string, unknown>;
	assertEquals(u.name, 'name');
});

// --- Overrides ---

Deno.test("overrides replace generated values", () => {
	const shapes = new Map([['title', shape(['printed'])]]);
	const result = generateMockData(shapes, undefined, { title: 'Custom Title' });
	assertEquals(result.title, 'Custom Title');
});

Deno.test("overrides deep merge into generated objects", () => {
	const shapes = new Map([['user', shape([], {
		properties: new Map([
			['name', shape(['printed'])],
			['email', shape(['printed'])],
		]),
	})]]);
	const result = generateMockData(shapes, undefined, { user: { name: 'Alice' } });
	const user = result.user as Record<string, unknown>;
	assertEquals(user.name, 'Alice');
	assertEquals(user.email, 'email');
});

// --- Depth limit ---

Deno.test("depth limit prevents infinite recursion", () => {
	// Create a deeply nested shape
	let inner: DataShape = shape(['printed']);
	for (let i = 0; i < 10; i++) {
		inner = shape([], { properties: new Map([['nested', inner]]) });
	}
	const shapes = new Map([['deep', inner]]);
	// Should not throw
	const result = generateMockData(shapes);
	assertNotEquals(result.deep, undefined);
});

// --- Edge cases ---

Deno.test("empty shape map returns empty object", () => {
	const result = generateMockData(new Map());
	assertEquals(result, {});
});

Deno.test("shape with no usages and no properties returns name string", () => {
	const shapes = new Map([['unknown', shape([])]]);
	const result = generateMockData(shapes);
	assertEquals(result.unknown, 'unknown');
});

Deno.test("variable with both printed and properties generates object", () => {
	const shapes = new Map([['user', shape(['printed'], {
		properties: new Map([['name', shape(['printed'])]]),
	})]]);
	const result = generateMockData(shapes);
	const user = result.user as Record<string, unknown>;
	assertEquals(user.name, 'name');
});
