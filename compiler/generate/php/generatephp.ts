import type { Parsed } from '../../backcode.ts';
import * as acorn from 'npm:acorn';

export function generatePhpFunction(name: string, parsed: Parsed): string {
	const params = parsed.vars.map(v => `$${v}`).join(', ');
	return `function(${params}) { return ${generatePhpStatement(parsed.expr!)}; }`;
}

export function generatePhpStatement(node: acorn.ExpressionStatement): string {
	return generatePhpNode(node.expression, true);
}

function generatePhpNode(node: acorn.AnyNode, computed: boolean): string {
	switch (node.type) {
		case 'Identifier':
			if (computed) {
				return `$${node.name}`;
			} else {
				return node.name;
			}
		case 'Literal':
			return node.raw!;
		case 'MemberExpression':
			return generatePhpMemberExpression(node);
		case 'UnaryExpression':
			return node.operator + generatePhpNode(node.argument, true);
		default:
			throw new Error(`invalid node: ${node.type}`);
	}
}

function generatePhpMemberExpression(node: acorn.MemberExpression): string {
	const object = generatePhpNode(node.object, true);
	if (node.computed) {
		const property = generatePhpNode(node.property, true);
		return `${object}[${property}]`;
	} else {
		const property = generatePhpNode(node.property, false);
		return `${object}['${property}']`;
	}
}
