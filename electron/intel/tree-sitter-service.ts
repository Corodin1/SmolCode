import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

export interface AstSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'struct' | 'enum' | 'const';
  signature: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ParsedFileAst {
  language: string;
  symbols: AstSymbol[];
  imports: string[];
}

export interface SyntaxIssue {
  line: number;
  column: number;
  message: string;
  snippet: string;
}

const EXT_TO_WASM: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'tsx',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.css': 'css',
  '.html': 'html',
  '.json': 'json',
};

const tsRequire = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSParser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLanguage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSNode = any;

export class TreeSitterService {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ParserCtor: any = null;
  private parser: TSParser = null;
  private languages = new Map<string, TSLanguage>();
  private wasmDir: string | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const mod = await import('web-tree-sitter');
        const Parser = mod.default ?? mod;
        const rawTsPkgDir = dirname(tsRequire.resolve('web-tree-sitter/package.json'));
        const treeSitterPkgDir = existsSync(rawTsPkgDir.replace('app.asar', 'app.asar.unpacked'))
          ? rawTsPkgDir.replace('app.asar', 'app.asar.unpacked')
          : rawTsPkgDir;
        await Parser.init({
          locateFile: (scriptName: string) => join(treeSitterPkgDir, scriptName),
        });
        this.ParserCtor = Parser;
        this.parser = new Parser();

        const rawWasmsPkgDir = dirname(tsRequire.resolve('tree-sitter-wasms/package.json'));
        const wasmsPkgDir = existsSync(rawWasmsPkgDir.replace('app.asar', 'app.asar.unpacked'))
          ? rawWasmsPkgDir.replace('app.asar', 'app.asar.unpacked')
          : rawWasmsPkgDir;
        const outDir = join(wasmsPkgDir, 'out');
        this.wasmDir = existsSync(outDir) ? outDir : wasmsPkgDir;
        this.initialized = true;
      } catch {
        this.initialized = false;
      }
    })();

    return this.initPromise;
  }

  private async getLanguage(langName: string): Promise<TSLanguage | null> {
    await this.init();
    if (!this.initialized || !this.ParserCtor || !this.wasmDir) return null;
    const cached = this.languages.get(langName);
    if (cached) return cached;

    const wasmPath = join(this.wasmDir, `tree-sitter-${langName}.wasm`);
    if (!existsSync(wasmPath)) return null;

    try {
      const lang = await this.ParserCtor.Language.load(wasmPath);
      this.languages.set(langName, lang);
      return lang;
    } catch {
      return null;
    }
  }

  detectLanguage(filePath: string): string | null {
    return EXT_TO_WASM[extname(filePath).toLowerCase()] ?? null;
  }

  async extractSymbolsAndImports(
    filePath: string,
    content: string,
  ): Promise<ParsedFileAst> {
    const langName = this.detectLanguage(filePath);
    if (!langName) {
      return { language: 'text', symbols: [], imports: [] };
    }
    const lang = await this.getLanguage(langName);
    if (!lang || !this.parser) {
      return this.fallbackExtract(langName, content);
    }

    try {
      this.parser.setLanguage(lang);
      const tree = this.parser.parse(content);
      const symbols: AstSymbol[] = [];
      const imports: string[] = [];
      const lines = content.split(/\r?\n/);

      const visit = (node: TSNode, parentClass?: string) => {
        const type = String(node.type);

        // Imports
        if (
          type === 'import_statement' ||
          type === 'import_from_statement' ||
          type === 'use_declaration' ||
          type === 'import_declaration' ||
          type === 'preproc_include'
        ) {
          const text = node.text.trim();
          const strMatch = text.match(/["'<]([^"'>]+)["'>]/);
          if (strMatch) {
            imports.push(strMatch[1]);
          } else {
            imports.push(text.slice(0, 80));
          }
        }

        // Functions / methods / classes / types
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const rawLine = (lines[node.startPosition.row] ?? '').trim();
        const exported =
          rawLine.startsWith('export ') ||
          rawLine.startsWith('pub ') ||
          node.parent?.type === 'export_statement';

        const nameNode = node.childForFieldName?.('name') ?? node.childForFieldName?.('declarator');
        const nameText = nameNode?.text?.split(/[(<\s]/)[0];

        if (
          (type === 'function_declaration' ||
            type === 'function_definition' ||
            type === 'function_item') &&
          nameText
        ) {
          symbols.push({
            name: nameText,
            kind: 'function',
            signature: rawLine.slice(0, 110),
            startLine,
            endLine,
            exported,
          });
        } else if (
          (type === 'method_definition' || type === 'method_declaration') &&
          nameText
        ) {
          symbols.push({
            name: parentClass ? `${parentClass}.${nameText}` : nameText,
            kind: 'method',
            signature: rawLine.slice(0, 110),
            startLine,
            endLine,
            exported,
          });
        } else if (
          (type === 'class_declaration' ||
            type === 'class_definition' ||
            type === 'struct_item' ||
            type === 'struct_specifier') &&
          nameText
        ) {
          symbols.push({
            name: nameText,
            kind: type.includes('struct') ? 'struct' : 'class',
            signature: rawLine.slice(0, 110),
            startLine,
            endLine,
            exported,
          });
          for (let i = 0; i < node.namedChildCount; i++) {
            visit(node.namedChild(i), nameText);
          }
          return;
        } else if (
          (type === 'interface_declaration' ||
            type === 'type_alias_declaration' ||
            type === 'type_item' ||
            type === 'enum_declaration' ||
            type === 'enum_item') &&
          nameText
        ) {
          symbols.push({
            name: nameText,
            kind: type.includes('interface')
              ? 'interface'
              : type.includes('enum')
                ? 'enum'
                : 'type',
            signature: rawLine.slice(0, 110),
            startLine,
            endLine,
            exported,
          });
        } else if (type === 'lexical_declaration' || type === 'variable_declaration') {
          const decl = node.namedChild?.(0);
          const id = decl?.childForFieldName?.('name')?.text;
          const val = decl?.childForFieldName?.('value');
          if (
            id &&
            val &&
            (val.type === 'arrow_function' || val.type === 'function_expression')
          ) {
            symbols.push({
              name: id,
              kind: 'function',
              signature: rawLine.slice(0, 110),
              startLine,
              endLine,
              exported,
            });
          }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
          visit(node.namedChild(i), parentClass);
        }
      };

      visit(tree.rootNode);
      tree.delete?.();
      return { language: langName, symbols, imports };
    } catch {
      return this.fallbackExtract(langName, content);
    }
  }

  async checkSyntaxErrors(
    filePath: string,
    content: string,
  ): Promise<SyntaxIssue[]> {
    const langName = this.detectLanguage(filePath);
    if (!langName) return [];
    const lang = await this.getLanguage(langName);
    if (!lang || !this.parser) return [];

    try {
      this.parser.setLanguage(lang);
      const tree = this.parser.parse(content);
      if (!tree.rootNode.hasError) {
        tree.delete?.();
        return [];
      }

      const issues: SyntaxIssue[] = [];
      const lines = content.split(/\r?\n/);

      const collect = (node: TSNode) => {
        if (issues.length >= 6) return;
        if (node.type === 'ERROR' || node.isMissing) {
          const line = node.startPosition.row + 1;
          const column = node.startPosition.column + 1;
          issues.push({
            line,
            column,
            message: node.isMissing
              ? `Missing expected syntax token near "${node.type}"`
              : `Syntax error near "${node.text.slice(0, 40)}"`,
            snippet: (lines[line - 1] ?? '').trim(),
          });
          return;
        }
        if (node.hasError) {
          for (let i = 0; i < node.childCount; i++) {
            collect(node.child(i));
          }
        }
      };

      collect(tree.rootNode);
      tree.delete?.();
      return issues;
    } catch {
      return [];
    }
  }

  private fallbackExtract(language: string, content: string): ParsedFileAst {
    const lines = content.split(/\r?\n/);
    const symbols: AstSymbol[] = [];
    const imports: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const imp = trimmed.match(/^(?:import|from)\s+.*["']([^"']+)["']/);
      if (imp) imports.push(imp[1]);

      const fnMatch = trimmed.match(
        /^(?:export\s+)?(?:async\s+)?(?:function|def|fn|class|interface|type|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/,
      );
      if (fnMatch) {
        symbols.push({
          name: fnMatch[1],
          kind: trimmed.includes('class ')
            ? 'class'
            : trimmed.includes('interface ')
              ? 'interface'
              : trimmed.includes('type ')
                ? 'type'
                : 'function',
          signature: trimmed.slice(0, 110),
          startLine: i + 1,
          endLine: Math.min(lines.length, i + 20),
          exported: trimmed.startsWith('export ') || trimmed.startsWith('pub '),
        });
      }
    }

    return { language, symbols, imports };
  }
}
