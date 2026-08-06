/**
 * SymbolResolver.ts
 *
 * Resolve symbols through VS Code's Document Symbol Provider and expose
 * small classification helpers reused by parsers.
 */

import * as vscode from "vscode";
import type { DocumentSymbol, SymbolInformation, Uri } from "vscode";

const EXECUTE_DOCUMENT_SYMBOL_PROVIDER = "vscode.executeDocumentSymbolProvider";
const MAX_CACHE_ENTRIES = 128;

const CLASS_LIKE_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
]);

const METHOD_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Operator,
]);

const FIELD_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Field,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Event,
]);

interface CachedSymbols {
  // document cache version -> used to check Consistency
  readonly version: number;
  readonly symbols: DocumentSymbol[];
}

const symbolCache = new Map<string, CachedSymbols>();
const inFlightRequests = new Map<string, Promise<DocumentSymbol[]>>();

/**
 * Clear symbol cache for one document.
 */
export function clearSymbolCache(uri: Uri): void {
  const cacheKey = uri.toString();
  symbolCache.delete(cacheKey);
  clearInFlightByPrefix(`${cacheKey}#`);
}

/**
 * Clear every cached/in-flight symbol entry.
 */
export function clearAllSymbolCache(): void {
  symbolCache.clear();
  inFlightRequests.clear();
}

/**
 * Resolve symbols for a document URI.
 *
 * Strategy:
 * - Return LRU cache hit for the same open-document version.
 * - Deduplicate concurrent requests for the same URI+version.
 * - Normalize provider output into DocumentSymbol[].
 */
export async function resolveSymbols(uri: Uri): Promise<DocumentSymbol[]> {
  const cacheKey = uri.toString();
  const version = getOpenDocumentVersion(cacheKey);

  if (version !== undefined) {
    const cached = getCachedSymbols(cacheKey, version);
    if (cached) {
      return cached;
    }
  }

  const requestKey = `${cacheKey}#${version ?? "untracked"}`;
  const pending = inFlightRequests.get(requestKey);
  if (pending) {
    return pending;
  }

  const request = fetchAndNormalizeSymbols(uri)
    .then((symbols) => {
      // Only cache non-empty results. TS/JS language server may return []
      // on the first request for a JSX/JS file while it is still analyzing
      // the document; caching that empty result would suppress subsequent
      // refreshes until the document version changes.
      if (version !== undefined && symbols.length > 0) {
        setCachedSymbols(cacheKey, version, symbols);
      }
      return symbols;
    })
    .finally(() => {
      inFlightRequests.delete(requestKey);
    });

  inFlightRequests.set(requestKey, request);
  return request;
}

/**
 * Container kinds: Class / Interface / Enum.
 */
export function isClassLikeSymbol(symbol: DocumentSymbol): boolean {
  return CLASS_LIKE_KINDS.has(symbol.kind);
}

/**
 * Whether a Variable symbol holds a function (arrow function / function
 * expression).
 *
 * TS/JS language server reports `const f = () => {}` as SymbolKind.Variable
 * (not Function). Two detection paths:
 *   1. TS/TSX with type inference: `detail` contains the function signature
 *      (e.g. "(...args) => void"), so we check for "=>".
 *   2. JS/JSX without type inference: `detail` is empty. We fall back to
 *      `children.length > 0` because a function body yields child symbols
 *      (statements, nested declarations), while a plain value binding does
 *      not. This routes React components / hooks and plain JS arrow-function
 *      exports into methods so they are surfaced as callable members.
 */
function isFunctionVariableSymbol(symbol: DocumentSymbol): boolean {
  if (symbol.kind !== vscode.SymbolKind.Variable) {
    return false;
  }
  if (symbol.detail.includes("=>")) {
    return true;
  }
  // JS/JSX fallback: function bodies produce child symbols, value bindings do not.
  return symbol.detail === "" && symbol.children.length > 0;
}

/**
 * Callable member kinds: Method / Constructor / Function, plus function-typed
 * Variables (arrow function / function expression assignments in JS/TS).
 */
export function isMethodSymbol(symbol: DocumentSymbol): boolean {
  return METHOD_KINDS.has(symbol.kind) || isFunctionVariableSymbol(symbol);
}

/**
 * Data member kinds: Field / Constant (excludes EnumMember), plus non-function
 * Variables (value bindings in JS/TS). Mutually exclusive with isMethodSymbol:
 * a function-typed Variable is treated as a method, never a field.
 */
export function isFieldSymbol(symbol: DocumentSymbol): boolean {
  return (
    FIELD_KINDS.has(symbol.kind) ||
    (symbol.kind === vscode.SymbolKind.Variable &&
      !isFunctionVariableSymbol(symbol))
  );
}

/**
 * Enum member kind.
 */
export function isEnumMemberSymbol(symbol: DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.EnumMember;
}

/**
 * Constructor kind.
 */
export function isConstructorSymbol(symbol: DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.Constructor;
}

function clearInFlightByPrefix(prefix: string): void {
  for (const key of inFlightRequests.keys()) {
    if (key.startsWith(prefix)) {
      inFlightRequests.delete(key);
    }
  }
}

function getCachedSymbols(
  cacheKey: string,
  version: number,
): DocumentSymbol[] | undefined {
  const cached = symbolCache.get(cacheKey);
  if (!cached || cached.version !== version) {
    return undefined;
  }

  // Promote hit to the end of insertion order (simple LRU behavior).
  symbolCache.delete(cacheKey);
  symbolCache.set(cacheKey, cached);
  return cached.symbols;
}

function setCachedSymbols(
  cacheKey: string,
  version: number,
  symbols: DocumentSymbol[],
): void {
  if (!symbolCache.has(cacheKey) && symbolCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = symbolCache.keys().next().value;
    if (typeof oldestKey === "string") {
      symbolCache.delete(oldestKey);
    }
  }

  symbolCache.set(cacheKey, {
    version,
    symbols,
  });
}

function getOpenDocumentVersion(cacheKey: string): number | undefined {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && activeDocument.uri.toString() === cacheKey) {
    return activeDocument.version;
  }

  const document = vscode.workspace.textDocuments.find(
    (item) => item.uri.toString() === cacheKey,
  );
  return document?.version;
}

async function fetchAndNormalizeSymbols(uri: Uri): Promise<DocumentSymbol[]> {
  try {
    const raw = await vscode.commands.executeCommand<unknown>(
      EXECUTE_DOCUMENT_SYMBOL_PROVIDER,
      uri,
    );
    return normalizeDocumentSymbols(raw);
  } catch (error) {
    console.error("[SymbolResolver] Failed to resolve symbols:", error);
    return [];
  }
}

function normalizeDocumentSymbols(result: unknown): DocumentSymbol[] {
  if (!Array.isArray(result) || result.length === 0) {
    return [];
  }

  const first = result[0];
  if (isDocumentSymbol(first)) {
    return result as DocumentSymbol[];
  }

  if (isSymbolInformation(first)) {
    return convertSymbolInformationToDocumentSymbols(
      result as SymbolInformation[],
    );
  }

  return [];
}

function convertSymbolInformationToDocumentSymbols(
  symbols: readonly SymbolInformation[],
): DocumentSymbol[] {
  return symbols.map((symbol) => {
    const range = symbol.location.range;
    return new vscode.DocumentSymbol(
      symbol.name,
      symbol.containerName ?? "",
      symbol.kind,
      range,
      range,
    );
  });
}

function isDocumentSymbol(value: unknown): value is DocumentSymbol {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const symbol = value as Partial<DocumentSymbol>;
  return (
    typeof symbol.kind === "number" &&
    Array.isArray(symbol.children) &&
    isRange(symbol.range) &&
    isRange(symbol.selectionRange)
  );
}

function isSymbolInformation(value: unknown): value is SymbolInformation {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const symbol = value as Partial<SymbolInformation>;
  return (
    typeof symbol.name === "string" &&
    typeof symbol.kind === "number" &&
    isLocation(symbol.location)
  );
}

function isLocation(value: unknown): value is vscode.Location {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const location = value as Partial<vscode.Location>;
  return !!location.uri && isRange(location.range);
}

function isRange(value: unknown): value is vscode.Range {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const range = value as Partial<vscode.Range>;
  return isPosition(range.start) && isPosition(range.end);
}

function isPosition(value: unknown): value is vscode.Position {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const position = value as Partial<vscode.Position>;
  return (
    typeof position.line === "number" && typeof position.character === "number"
  );
}
