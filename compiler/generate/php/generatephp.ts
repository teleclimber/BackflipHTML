import { visitBackcode, type BackcodeVisitor, type Parsed } from '../../backcode.js';
import * as acorn from 'acorn';

export function generatePhpFunction(name: string, parsed: Parsed): string {
	const params = parsed.vars.map(v => `$${v}`).join(', ');
	return `function(${params}) { return ${generatePhpStatement(parsed.expr!)}; }`;
}

export function generatePhpStatement(node: acorn.ExpressionStatement): string {
	return generatePhpNode(node.expression);
}

function generatePhpNode(node: acorn.AnyNode): string {
	return visitBackcode(node, phpGenerator);
}

const phpGenerator: BackcodeVisitor<string> = {
	Identifier: (node) => `$${node.name}`,
	Literal: (node) => node.raw!,
	MemberExpression: (node) => {
		const object = generatePhpNode(node.object);
		if (node.computed) return `${object}[${generatePhpNode(node.property)}]`;
		return `${object}['${(node.property as acorn.Identifier).name}']`;
	},
	UnaryExpression: (node) => {
		const arg = generatePhpNode(node.argument);
		if (node.operator === '!') return '!backflip_isTruthy(' + arg + ')';
		return node.operator + arg;
	},
	ConditionalExpression: (node) =>
		'(backflip_isTruthy(' + generatePhpNode(node.test) + ') ? ' + generatePhpNode(node.consequent) + ' : ' + generatePhpNode(node.alternate) + ')',
	BinaryExpression: (node) => {
		const left = generatePhpNode(node.left);
		const right = generatePhpNode(node.right);
		if (node.operator === '+') return `backflip_jsPlus(${left}, ${right})`;
		if (node.operator === '==') return `backflip_jsLooseEq(${left}, ${right})`;
		if (node.operator === '!=') return `!backflip_jsLooseEq(${left}, ${right})`;
		if (node.operator === '<') return `backflip_jsLessThan(${left}, ${right})`;
		if (node.operator === '>') return `backflip_jsLessThan(${right}, ${left})`;
		if (node.operator === '<=') return `backflip_jsLessOrEq(${left}, ${right})`;
		if (node.operator === '>=') return `backflip_jsLessOrEq(${right}, ${left})`;
		return '(' + left + ' ' + node.operator + ' ' + right + ')';
	},
	unsupported: (node) => {
		throw new Error(`invalid node: ${node.type}`);
	},
};
