/**
 * Filter expressions, shared by the log monitor and the rule tables.
 *
 *   ( addr.src in 10.0.0.0/8 ) and ( action eq block ) and not port.dst eq 53
 *
 * Plain words without an operator are free-text matches over every field.
 */

export type FilterFieldKind = "addr" | "port" | "text";

export interface FilterFieldInfo {
  name: string;
  kind: FilterFieldKind;
  description: string;
  /** Example for the help list. */
  example: string;
}

export type FilterOp = "eq" | "neq" | "contains" | "in" | "notin";
export const FILTER_OPS: readonly FilterOp[] = ["eq", "neq", "contains", "in", "notin"];

export type FilterNode =
  | { type: "and" | "or"; items: FilterNode[] }
  | { type: "not"; item: FilterNode }
  | { type: "cmp"; field: string; op: FilterOp; value: string }
  | { type: "text"; value: string };

export class FilterSyntaxError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Tokenizer / parser

interface Token {
  kind: "word" | "str" | "(" | ")" | "op";
  text: string;
  pos: number;
}

const SYMBOL_OPS: Record<string, FilterOp> = { "=": "eq", "==": "eq", "!=": "neq", "~": "contains" };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const startsOp = (j: number) => src[j] === "=" || src[j] === "~" || (src[j] === "!" && (src[j + 1] === "=" || src[j + 1] === "~"));
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(" || c === ")") {
      out.push({ kind: c, text: c, pos: i });
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let text = "";
      while (j < src.length && src[j] !== c) text += src[j++];
      if (j >= src.length) throw new FilterSyntaxError("Missing closing quote.", i);
      out.push({ kind: "str", text, pos: i });
      i = j + 1;
    } else if (startsOp(i)) {
      const two = src.slice(i, i + 2);
      const text = two === "==" || two === "!=" ? two : two === "!~" ? two : c;
      out.push({ kind: "op", text, pos: i });
      i += text.length;
    } else {
      let j = i;
      while (j < src.length && !/[\s()"']/.test(src[j]!) && !startsOp(j)) j++;
      out.push({ kind: "word", text: src.slice(i, j), pos: i });
      i = j;
    }
  }
  return out;
}

export function parseFilter(src: string, fields: readonly FilterFieldInfo[]): FilterNode | null {
  const toks = tokenize(src);
  if (!toks.length) return null;
  const known = new Set(fields.map((f) => f.name));
  let p = 0;
  const peek = () => toks[p];
  const isWord = (t: Token | undefined, w: string) => !!t && t.kind === "word" && t.text.toLowerCase() === w;
  const opOf = (t: Token | undefined): FilterOp | null => {
    if (!t) return null;
    if (t.kind === "op") return t.text === "!~" ? "neq" : (SYMBOL_OPS[t.text] ?? null);
    if (t.kind === "word") return (FILTER_OPS as readonly string[]).includes(t.text.toLowerCase()) ? (t.text.toLowerCase() as FilterOp) : null;
    return null;
  };

  const parseOr = (): FilterNode => {
    const items = [parseAnd()];
    while (isWord(peek(), "or")) {
      p++;
      items.push(parseAnd());
    }
    return items.length === 1 ? items[0]! : { type: "or", items };
  };
  const parseAnd = (): FilterNode => {
    const items = [parseUnary()];
    for (;;) {
      const t = peek();
      if (isWord(t, "and")) {
        p++;
        items.push(parseUnary());
      } else if (t && t.kind !== ")" && !isWord(t, "or")) {
        items.push(parseUnary()); // implicit and
      } else break;
    }
    return items.length === 1 ? items[0]! : { type: "and", items };
  };
  const parseUnary = (): FilterNode => {
    const t = peek();
    if (!t) throw new FilterSyntaxError("The expression ends too early.", src.length);
    if (isWord(t, "not") || isWord(t, "!")) {
      p++;
      return { type: "not", item: parseUnary() };
    }
    if (t.kind === "(") {
      p++;
      const inner = parseOr();
      if (peek()?.kind !== ")") throw new FilterSyntaxError("Missing closing parenthesis.", peek()?.pos ?? src.length);
      p++;
      return inner;
    }
    if (t.kind === ")") throw new FilterSyntaxError("Unexpected closing parenthesis.", t.pos);
    if (t.kind === "op") throw new FilterSyntaxError("An operator needs a field before it.", t.pos);
    const opTok = toks[p + 1];
    const op = opOf(opTok);
    if (t.kind === "word" && op) {
      const field = t.text.toLowerCase();
      if (!known.has(field)) throw new FilterSyntaxError(`Unknown field "${t.text}". Known fields: ${fields.map((f) => f.name).join(", ")}.`, t.pos);
      const v = toks[p + 2];
      if (!v || (v.kind !== "word" && v.kind !== "str")) throw new FilterSyntaxError(`Give a value after "${opTok!.text}".`, opTok!.pos + opTok!.text.length);
      p += 3;
      return { type: "cmp", field, op, value: v.text };
    }
    p++;
    return { type: "text", value: t.text };
  };

  const tree = parseOr();
  if (p < toks.length) throw new FilterSyntaxError(`Unexpected "${toks[p]!.text}".`, toks[p]!.pos);
  return tree;
}

// ---------------------------------------------------------------------------
// IP / port helpers

export interface IpRange {
  v: 4 | 6;
  lo: bigint;
  hi: bigint;
}

function parseV4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

function parseV6(input: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(input) || !input.includes(":")) return null;
  let s = input;
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[1]!);
    if (v4 === null) return null;
    s = s.slice(0, s.length - tail[1]!.length) + (v4 >> 16n).toString(16) + ":" + (v4 & 0xffffn).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string) => (h === "" ? [] : h.split(":"));
  const left = toGroups(halves[0]!);
  const right = halves.length === 2 ? toGroups(halves[1]!) : [];
  const total = left.length + right.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const groups = [...left, ...Array<string>(8 - total).fill("0"), ...right];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Single IP, CIDR, or `a-b` range -> numeric range. Anything else (names) -> null. */
export function parseIpRange(text: string): IpRange | null {
  const s = text.trim();
  const range = /^([^/\s]+)\s*-\s*([^/\s]+)$/.exec(s);
  if (range) {
    const a = parseIpRange(range[1]!);
    const b = parseIpRange(range[2]!);
    if (a && b && a.v === b.v && a.lo <= b.hi) return { v: a.v, lo: a.lo, hi: b.hi };
    return null;
  }
  const [addr, bits] = s.split("/");
  if (!addr) return null;
  const v4 = parseV4(addr);
  const v6 = v4 === null ? parseV6(addr) : null;
  const v: 4 | 6 | null = v4 !== null ? 4 : v6 !== null ? 6 : null;
  if (!v) return null;
  const width = v === 4 ? 32 : 128;
  const n = (v4 ?? v6)!;
  let len = width;
  if (bits !== undefined) {
    if (!/^\d{1,3}$/.test(bits) || Number(bits) > width) return null;
    len = Number(bits);
  }
  const host = BigInt(width - len);
  const lo = (n >> host) << host;
  return { v, lo, hi: lo | ((1n << host) - 1n) };
}

const overlapsIp = (a: IpRange, b: IpRange) => a.v === b.v && a.lo <= b.hi && b.lo <= a.hi;

function parsePortRange(text: string, names?: ReadonlyMap<string, number>): [number, number] | null {
  const s = text.trim().toLowerCase();
  const m = /^(\d{1,5})(?:\s*[-:]\s*(\d{1,5}))?$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return [Math.min(a, b), Math.max(a, b)];
  }
  const named = names?.get(s);
  return named !== undefined ? [named, named] : null;
}

// ---------------------------------------------------------------------------
// Evaluation

/** Values of one entity per field. `undefined` = the entity has no such field. */
export type FilterRecord = (field: string) => string[] | undefined;

export interface FilterEnv {
  fields: readonly FilterFieldInfo[];
  /** Named ports (https -> 443) so port filters understand them. */
  portNames?: ReadonlyMap<string, number>;
}

const lower = (s: string) => s.toLowerCase();

function matchValue(kind: FilterFieldKind, op: "eq" | "contains" | "in", queryRaw: string, values: string[], env: FilterEnv): boolean {
  const q = queryRaw.trim();
  if (op === "contains") return values.some((v) => lower(v).includes(lower(q)));
  const queries = op === "in" ? q.split(",").map((s) => s.trim()).filter(Boolean) : [q];
  if (kind === "addr") {
    return queries.some((query) => {
      const qr = parseIpRange(query);
      return values.some((v) => {
        if (lower(v) === lower(query)) return true;
        if (v === "any") return qr !== null; // an "any" rule covers every address
        const vr = parseIpRange(v);
        if (!qr || !vr) return false;
        return op === "in" ? overlapsIp(qr, vr) : qr.v === vr.v && qr.lo === vr.lo && qr.hi === vr.hi;
      });
    });
  }
  if (kind === "port") {
    return queries.some((query) => {
      const qr = parsePortRange(query, env.portNames);
      return values.some((v) => {
        if (lower(v) === lower(query)) return true;
        if (v === "any") return qr !== null;
        const vr = parsePortRange(v, env.portNames);
        return qr !== null && vr !== null && qr[0] <= vr[1] && vr[0] <= qr[1];
      });
    });
  }
  return queries.some((query) => values.some((v) => lower(v) === lower(query)));
}

export function evalFilter(node: FilterNode | null, rec: FilterRecord, env: FilterEnv): boolean {
  if (!node) return true;
  switch (node.type) {
    case "and":
      return node.items.every((n) => evalFilter(n, rec, env));
    case "or":
      return node.items.some((n) => evalFilter(n, rec, env));
    case "not":
      return !evalFilter(node.item, rec, env);
    case "text": {
      const q = lower(node.value);
      return env.fields.some((f) => (rec(f.name) ?? []).some((v) => lower(v).includes(q)));
    }
    case "cmp": {
      const info = env.fields.find((f) => f.name === node.field);
      if (!info) return false;
      const values = rec(node.field) ?? [];
      const neg = node.op === "neq" || node.op === "notin";
      const base = node.op === "neq" ? "eq" : node.op === "notin" ? "in" : node.op;
      const hit = matchValue(info.kind, base, node.value, values, env);
      return neg ? !hit : hit;
    }
  }
}

/** Parse once, then test many records. A syntax error is returned, not thrown (the list then stays unfiltered). */
export function compileFilter(src: string, env: FilterEnv): { test: (rec: FilterRecord) => boolean; error: FilterSyntaxError | null; empty: boolean } {
  try {
    const node = parseFilter(src, env.fields);
    return { test: (rec) => evalFilter(node, rec, env), error: null, empty: node === null };
  } catch (e) {
    if (e instanceof FilterSyntaxError) return { test: () => true, error: e, empty: false };
    throw e;
  }
}

/** Append `( field op value )` to an expression (click-to-filter). Values with spaces are quoted. */
export function addFilterTerm(expr: string, field: string, op: FilterOp, value: string): string {
  const v = /[\s()"'=~]/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
  const term = `( ${field} ${op} ${v} )`;
  return expr.trim() ? `${expr.trim()} and ${term}` : term;
}

// ---------------------------------------------------------------------------
// Field sets

export const LOG_FILTER_FIELDS: FilterFieldInfo[] = [
  { name: "addr.src", kind: "addr", description: "Source address", example: "addr.src in 10.0.0.0/8" },
  { name: "addr.dst", kind: "addr", description: "Destination address", example: "addr.dst eq 192.168.1.10" },
  { name: "addr", kind: "addr", description: "Source or destination address", example: "addr in 172.16.0.0/12" },
  { name: "port.src", kind: "port", description: "Source port", example: "port.src eq 53" },
  { name: "port.dst", kind: "port", description: "Destination port", example: "port.dst in 80-443" },
  { name: "port", kind: "port", description: "Source or destination port", example: "port eq 22" },
  { name: "action", kind: "text", description: "pass, block or reject", example: "action eq block" },
  { name: "dir", kind: "text", description: "in or out", example: "dir eq in" },
  { name: "interface", kind: "text", description: "Interface device as logged (vtnet1)", example: "interface eq vtnet1" },
  { name: "proto", kind: "text", description: "Protocol", example: "proto eq udp" },
  { name: "rule", kind: "text", description: "Rule description", example: "rule contains DMZ" },
  { name: "site", kind: "text", description: "Site name (global monitor)", example: "site eq Berlin" },
];

export const RULE_FILTER_FIELDS: FilterFieldInfo[] = [
  { name: "addr.src", kind: "addr", description: "Source (aliases are expanded)", example: "addr.src in 10.0.0.0/8" },
  { name: "addr.dst", kind: "addr", description: "Destination (aliases are expanded)", example: "addr.dst eq 192.168.1.10" },
  { name: "addr", kind: "addr", description: "Source or destination", example: "addr in 172.16.0.0/12" },
  { name: "port.src", kind: "port", description: "Source port", example: "port.src eq 53" },
  { name: "port.dst", kind: "port", description: "Destination port (aliases are expanded)", example: "port.dst eq 443" },
  { name: "port", kind: "port", description: "Source or destination port", example: "port in 80-443" },
  { name: "action", kind: "text", description: "pass, block, reject or match", example: "action eq block" },
  { name: "dir", kind: "text", description: "in, out or any", example: "dir eq in" },
  { name: "interface", kind: "text", description: "Interface", example: "interface eq lan" },
  { name: "proto", kind: "text", description: "Protocol", example: "proto eq TCP" },
  { name: "rule", kind: "text", description: "Description", example: "rule contains SSH" },
  { name: "alias", kind: "text", description: "Alias used by the rule", example: "alias eq WEB_SERVERS" },
  { name: "enabled", kind: "text", description: "yes or no", example: "enabled eq no" },
  { name: "log", kind: "text", description: "yes or no", example: "log eq yes" },
  { name: "category", kind: "text", description: "Category", example: "category eq shared" },
  { name: "site", kind: "text", description: "Site name (global view)", example: "site eq Munich" },
];

export const ALIAS_FILTER_FIELDS: FilterFieldInfo[] = [
  { name: "name", kind: "text", description: "Alias name", example: "name contains WEB" },
  { name: "type", kind: "text", description: "host, network, port, ...", example: "type eq network" },
  { name: "addr", kind: "addr", description: "An address in its entries", example: "addr in 10.1.0.0/16" },
  { name: "port", kind: "port", description: "A port in its entries", example: "port eq 443" },
  { name: "entry", kind: "text", description: "Any entry (exact)", example: "entry eq 10.0.0.1" },
  { name: "enabled", kind: "text", description: "yes or no", example: "enabled eq no" },
  { name: "description", kind: "text", description: "Description", example: "description contains DMZ" },
  { name: "site", kind: "text", description: "Site name (global view)", example: "site eq Berlin" },
];
