import type { DataShape } from '../compiler/data-shape.js';
import type { CompiledFile } from '../compiler/compiler.js';

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
	const visited = new Set<string>(); // prevent circular resolution

	for (const [name, shape] of shapes) {
		result[name] = generateValue(shape, name, 0, partialLookup, visited);
	}

	if (overrides) {
		deepMerge(result, overrides);
	}

	return result;
}

function generateValue(
	shape: DataShape,
	name: string,
	depth: number,
	lookup?: PartialLookup,
	visited?: Set<string>,
	index?: number,
): unknown {
	if (depth >= MAX_DEPTH) return `${name}`;

	// Iterable takes priority — need to generate an array
	if (shape.usages.has('iterable') || shape.indexed) {
		return generateArray(shape, name, depth, lookup, visited);
	}

	// Resolve shape from called partial if this value is passed via b-data
	const passedShape = resolvePassedShape(shape, lookup, visited);
	const hasProperties = shape.properties && shape.properties.size > 0;
	const passedHasProperties = passedShape?.properties && passedShape.properties.size > 0;

	if (hasProperties || passedHasProperties) {
		const obj: Record<string, unknown> = {};

		// Generate from own properties
		if (shape.properties) {
			for (const [prop, propShape] of shape.properties) {
				obj[prop] = generateValue(propShape, prop, depth + 1, lookup, visited);
			}
		}

		// Merge in properties from called partial's shape
		if (passedShape?.properties) {
			for (const [prop, propShape] of passedShape.properties) {
				if (!(prop in obj)) {
					obj[prop] = generateValue(propShape, prop, depth + 1, lookup, visited);
				}
			}
		}

		return obj;
	}

	// Passed value resolved to a simple shape (no properties) — use its usages
	if (passedShape) {
		return generateValue(passedShape, name, depth, lookup, visited, index);
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
	lookup?: PartialLookup,
	visited?: Set<string>,
): unknown[] {
	const items: unknown[] = [];
	for (let i = 0; i < ITEMS_COUNT; i++) {
		if (shape.elementShape) {
			items.push(generateValue(shape.elementShape, name, depth + 1, lookup, visited, i));
		} else {
			items.push(`${name} ${i + 1}`);
		}
	}
	return items;
}

/**
 * Resolve the shape of a variable from the called partial's DataShape.
 * If the variable has passedTo entries, look up each called partial and
 * merge their shapes for the bound variable name.
 */
function resolvePassedShape(
	shape: DataShape,
	lookup?: PartialLookup,
	visited?: Set<string>,
): DataShape | null {
	if (!shape.passedTo || shape.passedTo.length === 0 || !lookup) return null;

	let merged: DataShape | null = null;

	for (const { partial, as } of shape.passedTo) {
		const key = `${partial}:${as}`;
		if (visited?.has(key)) continue;
		visited?.add(key);

		const calledRoot = findPartial(partial, lookup);
		if (!calledRoot?.dataShape) continue;

		const calledShape = calledRoot.dataShape.get(as);
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

function cloneShape(shape: DataShape): DataShape {
	const clone: DataShape = { usages: new Set(shape.usages) };
	if (shape.properties) {
		clone.properties = new Map();
		for (const [k, v] of shape.properties) {
			clone.properties.set(k, cloneShape(v));
		}
	}
	if (shape.indexed) clone.indexed = true;
	if (shape.elementShape) clone.elementShape = cloneShape(shape.elementShape);
	if (shape.attributes) clone.attributes = new Set(shape.attributes);
	if (shape.passedTo) clone.passedTo = [...shape.passedTo];
	return clone;
}

function mergeShapeInto(target: DataShape, source: DataShape): void {
	for (const u of source.usages) target.usages.add(u);
	if (source.attributes) {
		if (!target.attributes) target.attributes = new Set();
		for (const a of source.attributes) target.attributes.add(a);
	}
	if (source.indexed) target.indexed = true;
	if (source.properties) {
		if (!target.properties) target.properties = new Map();
		for (const [key, srcProp] of source.properties) {
			const existing = target.properties.get(key);
			if (existing) {
				mergeShapeInto(existing, srcProp);
			} else {
				target.properties.set(key, cloneShape(srcProp));
			}
		}
	}
	if (source.elementShape) {
		if (target.elementShape) {
			mergeShapeInto(target.elementShape, source.elementShape);
		} else {
			target.elementShape = cloneShape(source.elementShape);
		}
	}
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
