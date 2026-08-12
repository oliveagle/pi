/**
 * Default themes for TUI tests using chalk
 */

import { Chalk } from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "../src/index.ts";

const chalk = new Chalk({ level: 3 });

export const defaultSelectListTheme: SelectListTheme = {
	selectedPrefix: (text: string) => chalk.blue(text),
	selectedText: (text: string) => pc.bold(text),
	description: (text: string) => pc.dim(text),
	scrollInfo: (text: string) => pc.dim(text),
	noMatch: (text: string) => pc.dim(text),
};

export const defaultMarkdownTheme: MarkdownTheme = {
	heading: (text: string) => pc.bold.cyan(text),
	link: (text: string) => chalk.blue(text),
	linkUrl: (text: string) => pc.dim(text),
	code: (text: string) => pc.yellow(text),
	codeBlock: (text: string) => pc.green(text),
	codeBlockBorder: (text: string) => pc.dim(text),
	quote: (text: string) => pc.italic(text),
	quoteBorder: (text: string) => pc.dim(text),
	hr: (text: string) => pc.dim(text),
	listBullet: (text: string) => pc.cyan(text),
	bold: (text: string) => pc.bold(text),
	italic: (text: string) => pc.italic(text),
	strikethrough: (text: string) => pc.strikethrough(text),
	underline: (text: string) => pc.underline(text),
};

export const defaultEditorTheme: EditorTheme = {
	borderColor: (text: string) => pc.dim(text),
	selectList: defaultSelectListTheme,
};
