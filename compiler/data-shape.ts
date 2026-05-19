import * as acorn from 'acorn';
import type { RootTNode, TNode, ForTNode, IfTNode, PrintTNode, ElementTNode, PartialRefTNode } from './types.js';
import type { Parsed } from './backcode.js';
import { BackflipError } from './errors.js';

// --- DataShape types ---

/**
 * How a variable's value is consumed at a particular usage site.
 * - `printed`: emitted as text via `{{ ... }}` interpolation.
 * - `attribute`: used as the value of an HTML attribute (e.g. via `b-bind:` / `:`).
 * - `boolean`: evaluated in a boolean context (b-if condition, ternary test, `!x`).
 * - `iterable`: iterated over in a `b-for` loop.
 * - `passed`: forwarded to another partial via a `b-data:` binding.
 */
export type UsageKind = 'printed' | 'attribute' | 'boolean' | 'iterable' | 'passed';

/**
 * Describes how a free variable (or one of its sub-paths) is used inside a partial's
 * TNode tree. Produced by `inferDataShape` and consumed by tooling and validation
 * (e.g. `validateBAttrUsage`).
 *
 * A DataShape is recursive: nested objects, indexed access, and loop element types
 * each carry their own DataShape so the full access pattern of a variable can be
 * reconstructed from the root down.
 */
export interface DataShape {
	/**
	 * The set of ways this particular value (the variable, or this sub-path of it)
	 * is consumed directly. Sub-path usages live on the nested DataShape inside
	 * `properties` / `elementShape`, not here.
	 */
	usages: Set<UsageKind>;

	/**
	 * Named property accesses on this value. For `user.name` the root `user` shape
	 * has `properties: { name: <shape with 'printed' in usages> }`. Property chains
	 * (`user.address.city`) nest DataShapes recursively.
	 */
	properties?: Map<string, DataShape>;

	/**
	 * True when this value is accessed via a computed member expression (e.g.
	 * `items[i]`), indicating it is treated as an array/indexable collection.
	 */
	indexed?: boolean;

	/**
	 * The shape of each element when this value is iterated in a `b-for`. Built by
	 * re-walking the loop body with the loop variable unscoped and lifting that
	 * variable's inferred shape onto the iterable.
	 * Example b-for="user in users", elementShape is the shape of "user".
	 */
	elementShape?: DataShape;

	/**
	 * When this value appears in an `attribute` usage, the set of HTML attribute
	 * names it has been bound to (e.g. `class`, `href`).
	 */
	attributes?: Set<string>;

	/**
	 * When this value is `passed` to another partial via `b-data:`, the list of
	 * `{ partial, as }` records describing which partial received it and under
	 * which binding name.
	 */
	passedTo?: Array<{ partial: string; as: string }>;

	/**
	 * Set only for variables declared on a custom-element partial via `b-attr:NAME`.
	 * Records the declared scalar type — `'bool'` for `.bool`-modified b-attrs,
	 * `'string'` otherwise. Used by `validateBAttrUsage` to flag misuse.
	 */
	scalar?: 'string' | 'bool';
}

// --- Public API ---

/**
 * Infer the data shape of each free variable in a partial's TNode tree.
 * Returns a Map from variable name to its DataShape describing all the
 * ways that variable is used in the partial.
 */
export function inferDataShape(root: RootTNode): Map<string, DataShape> {
	const shapes = new Map<string, DataShape>();
	// Pre-seed b-attr-declared variables with their scalar marker so that the
	// resulting map always has an entry for every b-attr (even unused ones), and
	// so downstream tooling sees that they're scalars.
	if (root.kind === 'custom-element' && root.bAttrs) {
		for (const a of root.bAttrs) {
			const shape = getOrCreateShape(shapes, a.name);
			shape.scalar = a.isBool ? 'bool' : 'string';
		}
	}
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
		case 'ConditionalExpression': {
			const cond = node as acorn.ConditionalExpression;
			collectFromExpr(cond.test, 'boolean', undefined, scoped, shapes, undefined);
			collectFromExpr(cond.consequent, context, attrName, scoped, shapes, passedInfo);
			collectFromExpr(cond.alternate, context, attrName, scoped, shapes, passedInfo);
			break;
		}
		case 'BinaryExpression': {
			const bin = node as acorn.BinaryExpression;
			collectFromExpr(bin.left as acorn.AnyNode, context, attrName, scoped, shapes, undefined);
			collectFromExpr(bin.right, context, attrName, scoped, shapes, undefined);
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
			case 'element': {
				const n = node as ElementTNode;
				for (const part of n.attrs) {
					if (part.type === 'dynamic') {
						collectFromParsed(part.expr, 'attribute', part.name, scoped, shapes);
					}
				}
				walkNodesForShape(n.tnodes, scoped, shapes);
				break;
			}
			case 'partial-ref': {
				const n = node as PartialRefTNode;
				for (const binding of n.bindings) {
					if (binding.kind !== 'expr') continue;
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

// --- b-attr usage validation ---

/**
 * Validate that variables declared via `b-attr:NAME` on a custom element partial
 * definition are used appropriately within the partial body. Returns a list of
 * compiler errors and warnings.
 *
 * Rules 
 * - A b-attr variable is, by definition, a string or boolean (depending on the
 *   `.bool` modifier). Using it as an array, object, indexed, or iterable is a
 *   compilation error.
 * - A bool b-attr variable used as a string (e.g. in `{{ premium }}` or any
 *   other printed-string context) is a compiler warning.
 * - A string b-attr used as a boolean (e.g. `b-if="premium"`) is allowed.
 * - 'attribute' usage means the variable is being used to populate an HTML
 *   attribute value via b-bind/`:`. This is a printable-string context, so it
 *   is fine for both string and bool b-attrs (with the same warning rule for
 *   bool b-attrs being printed).
 * - 'passed' usage (passing the value to another partial via b-data:) is fine.
 */
export function validateBAttrUsage(root: RootTNode, sourceRelPath: string): BackflipError[] {
	const errors: BackflipError[] = [];
	if (root.kind !== 'custom-element' || !root.bAttrs || root.bAttrs.length === 0) return errors;

	const shapes = inferDataShape(root);

	for (const bAttr of root.bAttrs) {
		const shape = shapes.get(bAttr.name);
		if (!shape) continue; // pre-seeded by inferDataShape, but be defensive

		const loc = bAttr.loc ?? root.loc;
		const errLoc = {
			filename: sourceRelPath,
			line: loc?.startLine,
			col: loc?.startCol,
			endLine: loc?.endLine,
			endCol: loc?.endCol,
		};

		// Object/array/iterable usage → error
		const usedAsIterable = shape.usages.has('iterable');
		const usedAsIndexed = shape.indexed === true;
		const usedAsObject = !!(shape.properties && shape.properties.size > 0);
		const usedAsArrayElement = !!shape.elementShape;

		if (usedAsIterable || usedAsIndexed || usedAsObject || usedAsArrayElement) {
			errors.push(new BackflipError(
				`b-attr variable "${bAttr.name}" is used as an object/array/iterable in partial; b-attr values must be string or boolean`,
				errLoc
			));
			// Skip the bool-printed warning when we already have a fatal — the variable
			// is being misused at a more fundamental level.
			continue;
		}

		// Bool b-attr used in a printed/string context → warning
		if (bAttr.isBool && shape.usages.has('printed')) {
			errors.push(new BackflipError(
				`boolean b-attr "${bAttr.name}" is used in interpolation in partial; convert to a string explicitly if you need to print it`,
				{ ...errLoc, severity: 'warning' }
			));
		}
	}

	return errors;
}
