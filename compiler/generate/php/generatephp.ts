import type { Parsed } from '../../backcode.js';
import * as acorn from 'acorn';

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
		case 'ConditionalExpression':
			return '(' + generatePhpNode(node.test, true) + ' ? ' + generatePhpNode(node.consequent, true) + ' : ' + generatePhpNode(node.alternate, true) + ')';
		case 'BinaryExpression': {
			const left = generatePhpNode(node.left, true);
			const right = generatePhpNode(node.right, true);
			if (node.operator === '+') {
				return `((is_string(${left}) || is_string(${right})) ? (${left} . ${right}) : (${left} + ${right}))`;
			}
			return '(' + left + ' ' + node.operator + ' ' + right + ')';
		}
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
