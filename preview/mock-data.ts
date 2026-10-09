import type { DataShape } from '../compiler/data-shape.js';
import { inferDataShape, cloneShape, mergeShapeInto } from '../compiler/data-shape.js';
import { collectPartialRefs } from '../compiler/walk.js';
import type { CompiledFile, RootTNode } from '../compiler/types.js';

export interface PartialLookup {
	compiledFile: CompiledFile;
	allFiles?: Map<string, CompiledFile>;
	fileName?: string;
}

const MAX_DEPTH = 5;
const ITEMS_COUNT = 3;

const ATTR_DEFAULTS: Record<string, string> = {
	class: 'sample-class',
	href: '#',
	src: 'https://placehold.co/300x200',
	id: 'sample-id',
	alt: 'Sample image',
	title: 'Sample title',
	placeholder: 'Sample placeholder',
	value: 'sample',
	action: '#',
	method: 'post',
	type: 'text',
	name: 'sample',
};

const BOOLEAN_ATTRS = new Set([
	'disabled', 'hidden', 'checked', 'selected', 'readonly', 'required',
	'open', 'autofocus', 'autoplay', 'controls', 'loop', 'muted', 'novalidate',
]);

// What generating one partial's mock values needs: the partial lookup for passed
// values, the passed shapes already resolved (to stop cycles), and the mock key for
// an index variable (see generateKeyed).
interface GenCtx {
	lookup?: PartialLookup;
	visited: Set<string>;
	keyFor: (indexVar: string) => string;
}

/**
 * Generate mock data from a DataShape map, optionally resolving shapes
 * of called partials for `passed` variables.
 */
export function generateMockData(
	shapes: Map<string, DataShape>,
	partialLookup?: PartialLookup,
	overrides?: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const ctx = genCtx(shapes, partialLookup, overrides);

	for (const [name, shape] of shapes) {
		result[name] = generateValue(shape, name, 0, ctx);
	}

	if (overrides) {
		deepMerge(result, overrides);
	}

	return result;
}

/**
 * Mock data for every store declared by `root` or a partial reachable from it, by
 * store name: generated from the shapes the declaring partials read under
 * `NAME.data`, merged. A store none of them reads under `data` is null. `overrides`
 * deep-merge in by store name.
 */
export function generateStoreMocks(
	root: RootTNode,
	partialLookup: PartialLookup,
	overrides?: Record<string, unknown>,
): Record<string, unknown> {
	const dataShapes = new Map<string, DataShape | null>();
	// An index variable is keyed by its mock value in the partial that declares it.
	const keys = new Map<string, string>();
	for (const partial of reachablePartials(root, partialLookup)) {
		if (!partial.stores) continue;
		const shapes = inferDataShape(partial);
		const ctx = genCtx(shapes, partialLookup);
		for (const { name } of partial.stores) {
			const data = shapes.get(name)?.properties?.get('data');
			const merged = dataShapes.get(name) ?? null;
			if (data) {
				if (merged) mergeShapeInto(merged, data);
				else dataShapes.set(name, cloneShape(data));
				for (const v of allIndexVars(data)) if (!keys.has(v)) keys.set(v, ctx.keyFor(v));
			} else if (!dataShapes.has(name)) {
				dataShapes.set(name, null);
			}
		}
	}

	const ctx: GenCtx = { lookup: partialLookup, visited: new Set(), keyFor: v => keys.get(v) ?? v };
	const result: Record<string, unknown> = {};
	for (const [name, data] of dataShapes) {
		result[name] = data ? generateValue(data, 'data', 0, ctx) : null;
	}
	if (overrides) deepMerge(result, overrides);
	return result;
}

// `root` and every partial reachable from it through calls, each once.
function reachablePartials(root: RootTNode, lookup: PartialLookup): RootTNode[] {
	const out: RootTNode[] = [];
	const visit = (partial: RootTNode, file: CompiledFile | undefined) => {
		if (out.includes(partial)) return;
		out.push(partial);
		for (const ref of collectPartialRefs(partial.tnodes)) {
			const refFile = ref.file === null ? file : lookup.allFiles?.get(ref.file);
			const target = refFile?.partials.get(ref.partialName) ?? findPartial(ref.partialName, lookup);
			if (target) visit(target, refFile ?? undefined);
		}
	};
	visit(root, lookup.compiledFile);
	return out;
}

function allIndexVars(shape: DataShape): string[] {
	return [
		...(shape.indexVars ?? []),
		...[...shape.properties?.values() ?? []].flatMap(allIndexVars),
		...(shape.elementShape ? allIndexVars(shape.elementShape) : []),
	];
}

// The mock key of an index variable is its mock value: the override when there is
// one, else what its own shape generates.
function genCtx(shapes: Map<string, DataShape>, lookup?: PartialLookup, overrides?: Record<string, unknown>): GenCtx {
	const resolving = new Set<string>();
	const ctx: GenCtx = {
		lookup,
		visited: new Set(),
		keyFor: (v) => {
			const o = overrides?.[v];
			if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') return String(o);
			const shape = shapes.get(v);
			if (!shape || resolving.has(v)) return v;
			resolving.add(v);
			try {
				return String(generateValue(shape, v, 0, ctx));
			} finally {
				resolving.delete(v);
			}
		},
	};
	return ctx;
}

function generateValue(
	shape: DataShape,
	name: string,
	depth: number,
	ctx: GenCtx,
	index?: number,
): unknown {
	if (depth >= MAX_DEPTH) return `${name}`;

	// Iteration needs an array; so does an index that is not one variable.
	if (shape.usages.has('iterable') || (shape.indexed && !shape.indexVars?.length)) {
		return generateArray(shape, name, depth, ctx);
	}
	if (shape.indexed) return generateKeyed(shape, name, depth, ctx);

	// Resolve shape from called partial if this value is passed via b-data
	const passedShape = resolvePassedShape(shape, ctx);
	const hasProperties = shape.properties && shape.properties.size > 0;
	const passedHasProperties = passedShape?.properties && passedShape.properties.size > 0;

	if (hasProperties || passedHasProperties) {
		const obj: Record<string, unknown> = {};

		// Generate from own properties
		if (shape.properties) {
			for (const [prop, propShape] of shape.properties) {
				obj[prop] = generateValue(propShape, prop, depth + 1, ctx);
			}
		}

		// Merge in properties from called partial's shape
		if (passedShape?.properties) {
			for (const [prop, propShape] of passedShape.properties) {
				if (!(prop in obj)) {
					obj[prop] = generateValue(propShape, prop, depth + 1, ctx);
				}
			}
		}

		return obj;
	}

	// Passed value resolved to a simple shape (no properties) — use its usages
	if (passedShape) {
		return generateValue(passedShape, name, depth, ctx, index);
	}

	// Boolean
	if (shape.usages.has('boolean')) {
		return true;
	}

	// Attribute — pick value based on attribute name
	if (shape.usages.has('attribute') && shape.attributes) {
		return generateAttributeValue(shape.attributes);
	}

	// Printed — use the variable name (with index for array elements)
	if (shape.usages.has('printed')) {
		if (index !== undefined) {
			return `${name} ${index + 1}`;
		}
		return name;
	}

	// Passed but no shape resolved — use name as string
	if (shape.usages.has('passed')) {
		return name;
	}

	// Fallback
	return name;
}

function generateArray(
	shape: DataShape,
	name: string,
	depth: number,
	ctx: GenCtx,
): unknown[] {
	const items: unknown[] = [];
	for (let i = 0; i < ITEMS_COUNT; i++) {
		if (shape.elementShape) {
			items.push(generateValue(shape.elementShape, name, depth + 1, ctx, i));
		} else {
			items.push(`${name} ${i + 1}`);
		}
	}
	return items;
}

// A value indexed by variables (`widgets[widget_id].name`): an object with one entry
// per index variable, keyed by that variable's mock value, so the lookup finds it.
// An indexed shape carries its entries' usages and properties itself.
function generateKeyed(
	shape: DataShape,
	name: string,
	depth: number,
	ctx: GenCtx,
): Record<string, unknown> {
	const entry: DataShape = { usages: shape.usages };
	if (shape.properties) entry.properties = shape.properties;
	if (shape.attributes) entry.attributes = shape.attributes;
	if (shape.passedTo) entry.passedTo = shape.passedTo;
	const obj: Record<string, unknown> = {};
	for (const v of shape.indexVars!) {
		obj[ctx.keyFor(v)] = generateValue(entry, name, depth + 1, ctx);
	}
	return obj;
}

/**
 * Resolve the shape of a variable from the called partial's DataShape.
 * If the variable has passedTo entries, look up each called partial and
 * merge their shapes for the bound variable name.
 */
function resolvePassedShape(
	shape: DataShape,
	{ lookup, visited }: GenCtx,
): DataShape | null {
	if (!shape.passedTo || shape.passedTo.length === 0 || !lookup) return null;

	let merged: DataShape | null = null;

	for (const { partial, as } of shape.passedTo) {
		const key = `${partial}:${as}`;
		if (visited.has(key)) continue;
		visited.add(key);

		const calledRoot = findPartial(partial, lookup);
		if (!calledRoot) continue;

		const calledShape = inferDataShape(calledRoot).get(as);
		if (!calledShape) continue;

		if (!merged) {
			merged = cloneShape(calledShape);
		} else {
			mergeShapeInto(merged, calledShape);
		}
	}

	return merged;
}

function findPartial(partialName: string, lookup: PartialLookup) {
	// Try same-file first
	const sameFile = lookup.compiledFile.partials.get(partialName);
	if (sameFile) return sameFile;

	// Try cross-file: partialName might be in any file
	if (lookup.allFiles) {
		for (const file of lookup.allFiles.values()) {
			const root = file.partials.get(partialName);
			if (root) return root;
		}
	}

	return null;
}

function generateAttributeValue(attributes: Set<string>): string | boolean {
	for (const attr of attributes) {
		if (BOOLEAN_ATTRS.has(attr)) return true;
		if (attr in ATTR_DEFAULTS) return ATTR_DEFAULTS[attr];
	}
	// Use first attribute name as fallback
	const first = attributes.values().next().value;
	return `sample-${first}`;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const key of Object.keys(source)) {
		const sv = source[key];
		const tv = target[key];
		if (isPlainObject(sv) && isPlainObject(tv)) {
			deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
		} else {
			target[key] = sv;
		}
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
