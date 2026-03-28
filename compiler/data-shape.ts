import * as acorn from 'acorn';
import type { RootTNode, TNode, ForTNode, IfTNode, PrintTNode, AttrBindTNode, PartialRefTNode } from './compiler.js';
import type { Parsed } from './backcode.js';

// --- DataShape types ---

export type UsageKind = 'printed' | 'attribute' | 'boolean' | 'iterable' | 'passed';

export interface DataShape {
	usages: Set<UsageKind>;
	properties?: Map<string, DataShape>;
	indexed?: boolean;
	elementShape?: DataShape;
	attributes?: Set<string>;
	passedTo?: Array<{ partial: string; as: string }>;
}

// --- Public API ---

/**
 * Infer the data shape of each free variable in a partial's TNode tree.
 * Returns a Map from variable name to its DataShape describing all the
 * ways that variable is used in the partial.
 */
export function inferDataShape(root: RootTNode): Map<string, DataShape> {
	const shapes = new Map<string, DataShape>();
	walkNodesForShape(root.tnodes, new Set(), shapes);
	return shapes;
}

/**
 * Infer the free variables used in a partial's TNode tree.
 * Derived from inferDataShape for backward compatibility.
 */
export function inferFreeVars(root: RootTNode): string[] {
	return [...inferDataShape(root).keys()].sort();
}

// --- Shape helpers ---

function getOrCreateShape(shapes: Map<string, DataShape>, name: string): DataShape {
	let shape = shapes.get(name);
	if (!shape) {
		shape = { usages: new Set() };
		shapes.set(name, shape);
	}
	return shape;
}

function mergeShapeInto(target: DataShape, source: DataShape): void {
	for (const u of source.usages) target.usages.add(u);

	if (source.attributes) {
		if (!target.attributes) target.attributes = new Set();
		for (const a of source.attributes) target.attributes.add(a);
	}

	if (source.indexed) target.indexed = true;

	if (source.passedTo) {
		if (!target.passedTo) target.passedTo = [];
		target.passedTo.push(...source.passedTo);
	}

	if (source.properties) {
		if (!target.properties) target.properties = new Map();
		for (const [key, srcProp] of source.properties) {
			const existing = target.properties.get(key);
			if (existing) {
				mergeShapeInto(existing, srcProp);
			} else {
				target.properties.set(key, srcProp);
			}
		}
	}

	if (source.elementShape) {
		if (target.elementShape) {
			mergeShapeInto(target.elementShape, source.elementShape);
		} else {
			target.elementShape = source.elementShape;
		}
	}
}

// --- Acorn AST expression walking ---

/**
 * Walk an acorn expression and record shape information on the appropriate
 * variable in the shapes map. `context` describes how the expression result
 * is used. `attrName` is set when context is 'attribute'.
 */
function collectFromExpr(
	node: acorn.AnyNode,
	context: UsageKind,
	attrName: string | undefined,
	scoped: Set<string>,
	shapes: Map<string, DataShape>,
	passedInfo?: { partial: string; as: string },
): void {
	switch (node.type) {
		case 'Identifier': {
			const id = node as acorn.Identifier;
			if (scoped.has(id.name)) return;
			const shape = getOrCreateShape(shapes, id.name);
			shape.usages.add(context);
			if (context === 'attribute' && attrName) {
				if (!shape.attributes) shape.attributes = new Set();
				shape.attributes.add(attrName);
			}
			if (passedInfo) {
				if (!shape.passedTo) shape.passedTo = [];
				shape.passedTo.push(passedInfo);
			}
			break;
		}
		case 'Literal':
			// No variables to track
			break;
		case 'MemberExpression': {
			const mem = node as acorn.MemberExpression;
			if (mem.computed) {
				// items[idx] — mark the object as indexed, walk both sides
				collectFromExprIndexed(mem.object, context, attrName, scoped, shapes, passedInfo);
				collectFromExpr(mem.property, context, attrName, scoped, shapes, undefined);
			} else {
				// user.name — build property chain
				const propName = (mem.property as acorn.Identifier).name;
				collectFromExprProperty(mem.object, propName, context, attrName, scoped, shapes, passedInfo);
			}
			break;
		}
		case 'UnaryExpression': {
			const un = node as acorn.UnaryExpression;
			if (un.operator === '!') {
				collectFromExpr(un.argument, 'boolean', undefined, scoped, shapes, passedInfo);
			} else {
				// + or - operators — treat as printed
				collectFromExpr(un.argument, context, attrName, scoped, shapes, passedInfo);
			}
			break;
		}
	}
}

/**
 * Handle non-computed member expression: build a property shape on the root variable.
 * For `user.name`: rootVar=user, gets properties: { name: {usages: {context}} }
 * For `user.address.city`: recursively builds nested properties.
 */
function collectFromExprProperty(
	objectNode: acorn.AnyNode,
	propName: string,
	context: UsageKind,
	attrName: string | undefined,
	scoped: Set<string>,
	shapes: Map<string, DataShape>,
	passedInfo?: { partial: string; as: string },
): void {
	const leafShape: DataShape = { usages: new Set([context]) };
	if (context === 'attribute' && attrName) {
		leafShape.attributes = new Set([attrName]);
	}
	if (passedInfo) {
		leafShape.passedTo = [passedInfo];
	}
	const propShape: DataShape = {
		usages: new Set(),
		properties: new Map([[propName, leafShape]]),
	};

	// Walk up the chain
	applyShapeToObject(objectNode, propShape, scoped, shapes);
}

/**
 * Apply a shape (with properties/usages) to the object expression, handling
 * nested member expressions by wrapping in additional property layers.
 */
function applyShapeToObject(
	objectNode: acorn.AnyNode,
	shapeToApply: DataShape,
	scoped: Set<string>,
	shapes: Map<string, DataShape>,
): void {
	switch (objectNode.type) {
		case 'Identifier': {
			const id = objectNode as acorn.Identifier;
			if (scoped.has(id.name)) return;
			const existing = getOrCreateShape(shapes, id.name);
			mergeShapeInto(existing, shapeToApply);
			break;
		}
		case 'MemberExpression': {
			const mem = objectNode as acorn.MemberExpression;
			if (mem.computed) {
				// e.g. items[0].name — items is indexed, and we apply property shape
				const wrapper: DataShape = {
					usages: new Set(),
					indexed: true,
				};
				mergeShapeInto(wrapper, shapeToApply);
				applyShapeToObject(mem.object, wrapper, scoped, shapes);
			} else {
				const parentPropName = (mem.property as acorn.Identifier).name;
				const wrapper: DataShape = {
					usages: new Set(),
					properties: new Map([[parentPropName, shapeToApply]]),
				};
				applyShapeToObject(mem.object, wrapper, scoped, shapes);
			}
			break;
		}
	}
}

/**
 * Handle computed member expression object side: mark as indexed.
 */
function collectFromExprIndexed(
	objectNode: acorn.AnyNode,
	context: UsageKind,
	attrName: string | undefined,
	scoped: Set<string>,
	shapes: Map<string, DataShape>,
	passedInfo?: { partial: string; as: string },
): void {
	const indexedShape: DataShape = { usages: new Set([context]), indexed: true };
	if (context === 'attribute' && attrName) {
		indexedShape.attributes = new Set([attrName]);
	}
	if (passedInfo) {
		indexedShape.passedTo = [passedInfo];
	}
	applyShapeToObject(objectNode, indexedShape, scoped, shapes);
}

// --- Parsed expression helper ---

function collectFromParsed(
	parsed: Parsed,
	context: UsageKind,
	attrName: string | undefined,
	scoped: Set<string>,
	shapes: Map<string, DataShape>,
	passedInfo?: { partial: string; as: string },
): void {
	if (!parsed.expr) {
		// No AST available — fall back to vars list
		for (const v of parsed.vars) {
			if (scoped.has(v)) continue;
			const shape = getOrCreateShape(shapes, v);
			shape.usages.add(context);
			if (context === 'attribute' && attrName) {
				if (!shape.attributes) shape.attributes = new Set();
				shape.attributes.add(attrName);
			}
			if (passedInfo) {
				if (!shape.passedTo) shape.passedTo = [];
				shape.passedTo.push(passedInfo);
			}
		}
		return;
	}
	collectFromExpr(parsed.expr.expression, context, attrName, scoped, shapes, passedInfo);
}

// --- TNode tree walking ---

function walkNodesForShape(
	tnodes: TNode[],
	scoped: Set<string>,
	shapes: Map<string, DataShape>,
): void {
	for (const node of tnodes) {
		switch (node.type) {
			case 'print': {
				const n = node as PrintTNode;
				collectFromParsed(n.data, 'printed', undefined, scoped, shapes);
				break;
			}
			case 'for': {
				const n = node as ForTNode;
				// Mark the iterable variable(s) with 'iterable' usage
				collectFromParsed(n.iterable, 'iterable', undefined, scoped, shapes);

				// Walk loop body with valName scoped — collects free var shapes
				const childScope = new Set(scoped);
				childScope.add(n.valName);
				walkNodesForShape(n.tnodes, childScope, shapes);

				// Walk again into temp map with valName NOT scoped to extract its shape
				const tempShapes = new Map<string, DataShape>();
				walkNodesForShape(n.tnodes, scoped, tempShapes);
				const valShape = tempShapes.get(n.valName);
				if (valShape) {
					// Apply as elementShape on the iterable variable(s)
					for (const v of n.iterable.vars) {
						if (scoped.has(v)) continue;
						const iterShape = getOrCreateShape(shapes, v);
						if (iterShape.elementShape) {
							mergeShapeInto(iterShape.elementShape, valShape);
						} else {
							iterShape.elementShape = valShape;
						}
					}
				}
				break;
			}
			case 'if': {
				const n = node as IfTNode;
				for (const branch of n.branches) {
					if (branch.condition) {
						collectFromParsed(branch.condition, 'boolean', undefined, scoped, shapes);
					}
					walkNodesForShape(branch.tnodes, scoped, shapes);
				}
				break;
			}
			case 'attr-bind': {
				const n = node as AttrBindTNode;
				for (const part of n.parts) {
					if (part.type === 'dynamic') {
						collectFromParsed(part.expr, 'attribute', part.name, scoped, shapes);
					}
				}
				break;
			}
			case 'partial-ref': {
				const n = node as PartialRefTNode;
				for (const binding of n.bindings) {
					const passedInfo = { partial: n.partialName, as: binding.name };
					collectFromParsed(binding.data, 'passed', undefined, scoped, shapes, passedInfo);
				}
				// Slot content is evaluated in the caller's scope
				for (const slotNodes of Object.values(n.slots)) {
					walkNodesForShape(slotNodes as TNode[], scoped, shapes);
				}
				break;
			}
			// 'raw' and 'slot' nodes have no expressions
			default:
				break;
		}
	}
}
