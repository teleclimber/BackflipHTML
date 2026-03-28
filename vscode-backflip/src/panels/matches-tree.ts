import * as vscode from 'vscode';
import * as path from 'node:path';

export interface MatchInfo {
	file: string;
	partialName: string;
	startLine: number;
	startCol: number;
	matchType: string;
}

type TreeItem = FileNode | PartialNode | MatchNode;

interface FileNode {
	kind: 'file';
	file: string;
	partials: PartialNode[];
}

interface PartialNode {
	kind: 'partial';
	file: string;
	partialName: string;
	matches: MatchNode[];
}

interface MatchNode {
	kind: 'match';
	file: string;
	partialName: string;
	startLine: number;
	startCol: number;
	matchType: string;
}

export class MatchesTreeProvider implements vscode.TreeDataProvider<TreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private tree: FileNode[] = [];
	private selectorLabel = '';
	private templateRoot = '';

	setData(matches: MatchInfo[], selectorLabel: string, templateRoot: string): void {
		this.selectorLabel = selectorLabel;
		this.templateRoot = templateRoot;
		this.tree = buildTree(matches);
		this._onDidChangeTreeData.fire();
	}

	clear(): void {
		this.tree = [];
		this.selectorLabel = '';
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeItem): vscode.TreeItem {
		switch (element.kind) {
			case 'file': {
				const totalMatches = element.partials.reduce((sum, p) => sum + p.matches.length, 0);
				const item = new vscode.TreeItem(element.file, vscode.TreeItemCollapsibleState.Expanded);
				item.description = `(${totalMatches})`;
				item.iconPath = vscode.ThemeIcon.File;
				return item;
			}
			case 'partial': {
				const item = new vscode.TreeItem(element.partialName, vscode.TreeItemCollapsibleState.Expanded);
				item.description = `(${element.matches.length})`;
				item.iconPath = new vscode.ThemeIcon('symbol-function');
				return item;
			}
			case 'match': {
				const label = `line ${element.startLine}`;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				if (element.matchType !== 'definite') {
					item.description = element.matchType;
				}
				item.iconPath = new vscode.ThemeIcon('symbol-field');
				item.command = {
					command: 'backflipHTML.openCssRule',
					title: 'Go to element',
					arguments: [{
						path: this.templateRoot ? path.join(this.templateRoot, element.file) : element.file,
						line: element.startLine - 1,
						col: element.startCol - 1,
					}],
				};
				return item;
			}
		}
	}

	getChildren(element?: TreeItem): TreeItem[] {
		if (!element) return this.tree;
		if (element.kind === 'file') return element.partials;
		if (element.kind === 'partial') return element.matches;
		return [];
	}
}

function buildTree(matches: MatchInfo[]): FileNode[] {
	const fileMap = new Map<string, Map<string, MatchNode[]>>();

	for (const m of matches) {
		let partials = fileMap.get(m.file);
		if (!partials) {
			partials = new Map();
			fileMap.set(m.file, partials);
		}
		let nodes = partials.get(m.partialName);
		if (!nodes) {
			nodes = [];
			partials.set(m.partialName, nodes);
		}
		nodes.push({
			kind: 'match',
			file: m.file,
			partialName: m.partialName,
			startLine: m.startLine,
			startCol: m.startCol,
			matchType: m.matchType,
		});
	}

	const tree: FileNode[] = [];
	for (const [file, partials] of fileMap) {
		const partialNodes: PartialNode[] = [];
		for (const [partialName, matchNodes] of partials) {
			partialNodes.push({ kind: 'partial', file, partialName, matches: matchNodes });
		}
		tree.push({ kind: 'file', file, partials: partialNodes });
	}
	return tree;
}
