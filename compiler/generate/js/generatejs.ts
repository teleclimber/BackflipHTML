import { visitBackcode, type BackcodeVisitor, type Parsed } from '../../backcode.js';
import * as acorn from 'acorn';

export function generateFunction(name:string, parsed :Parsed) :string {
	return `function ${name}( ${parsed.vars.join(", ")} ) { return ${generateStatement(parsed.expr!)}; }`;
}
export function generateStatement(node :acorn.ExpressionStatement) :string {
	return generateNode(node.expression);
}

function generateNode(node: acorn.AnyNode): string {
	return visitBackcode(node, jsGenerator);
}

const jsGenerator: BackcodeVisitor<string> = {
	Identifier: (node) => node.name,
	Literal: (node) => node.raw!,
	MemberExpression: (node) => node.computed
		? generateNode(node.object) + '[' + generateNode(node.property) + ']'
		: generateNode(node.object) + '.' + (node.property as acorn.Identifier).name,
	UnaryExpression: (node) => node.operator + generateNode(node.argument),
	ConditionalExpression: (node) =>
		'(' + generateNode(node.test) + ' ? ' + generateNode(node.consequent) + ' : ' + generateNode(node.alternate) + ')',
	BinaryExpression: (node) =>
		'(' + generateNode(node.left) + ' ' + node.operator + ' ' + generateNode(node.right) + ')',
	LogicalExpression: (node) =>
		'(' + generateNode(node.left) + ' ' + node.operator + ' ' + generateNode(node.right) + ')',
	unsupported: (node) => {
		throw new Error(`invalid node: ${node.type}`);
	},
};
