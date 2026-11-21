/**
 * Safe arithmetic expression evaluator for the first fuel formula (spec §13.5,
 * §15.4): replaces the legacy `new Function('context', 'with (context) { … }')`
 * of `be-legacy/src/utils/cii/fuel-calculation.ts#evaluateFormula`.
 *
 * Grammar (whitespace ignored):
 *
 * ```text
 * expression := additive
 * additive   := multiplicative (("+" | "-") multiplicative)*      left-assoc
 * multiplicative := unary (("*" | "/") unary)*                    left-assoc
 * unary      := ("+" | "-") unary | power
 * power      := primary (("**" | "^") unary)?                     right-assoc
 * primary    := number | variable | call | "(" expression ")"
 * call       := ("Math.")? name "(" expression ("," expression)* ")"
 * name       := exp | log | ln | sqrt | pow | abs | min | max
 * variable   := speedKnot
 * number     := digits ["." digits] [("e" | "E") ["+" | "-"] digits] | "." digits …
 * ```
 *
 * The precedence and associativity are those of JavaScript, and every
 * operation is evaluated with the same IEEE-754 operation as the JavaScript
 * engine (`+ - * /`, `**`, `Math.*`), so a formula that is valid JavaScript
 * gives **bit-identical** results. Two deliberate differences: `^` is the
 * power operator (JavaScript: XOR, spec §15.4) and `-a ** b` is accepted as
 * `-(a ** b)` (a syntax error in JavaScript). `log` and `ln` are the natural
 * logarithm (`Math.log`).
 */

/** Variables a formula may reference. */
export interface FormulaContext {
  /** Segment speed, knots. */
  readonly speedKnot: number;
}

/** A formula that does not follow the grammar. */
export class FormulaSyntaxError extends Error {
  override readonly name = 'FormulaSyntaxError';

  constructor(
    message: string,
    /** Zero-based character offset of the problem. */
    readonly position: number,
  ) {
    super(`${message} at position ${position}`);
  }
}

/** A parsed formula, evaluable any number of times. */
export interface CompiledFormula {
  readonly source: string;
  evaluate(context: FormulaContext): number;
}

/** Longest formula accepted, characters. */
export const MAX_FORMULA_LENGTH = 1000;
/** Deepest nesting accepted (parentheses, unary operators, calls). */
const MAX_DEPTH = 64;

const FUNCTIONS = {
  exp: { arity: [1, 1], apply: (args: number[]) => Math.exp(at(args, 0)) },
  log: { arity: [1, 1], apply: (args: number[]) => Math.log(at(args, 0)) },
  ln: { arity: [1, 1], apply: (args: number[]) => Math.log(at(args, 0)) },
  sqrt: { arity: [1, 1], apply: (args: number[]) => Math.sqrt(at(args, 0)) },
  pow: {
    arity: [2, 2],
    apply: (args: number[]) => Math.pow(at(args, 0), at(args, 1)),
  },
  abs: { arity: [1, 1], apply: (args: number[]) => Math.abs(at(args, 0)) },
  min: { arity: [1, Infinity], apply: (args: number[]) => Math.min(...args) },
  max: { arity: [1, Infinity], apply: (args: number[]) => Math.max(...args) },
} as const satisfies Record<
  string,
  { arity: readonly [number, number]; apply: (args: number[]) => number }
>;

type FunctionName = keyof typeof FUNCTIONS;

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`missing argument ${index}`);
  return value;
}

function isFunctionName(name: string): name is FunctionName {
  return Object.hasOwn(FUNCTIONS, name);
}

type Node =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'variable' }
  | { readonly kind: 'negate'; readonly operand: Node }
  | {
      readonly kind: 'binary';
      readonly operator: '+' | '-' | '*' | '/' | '**';
      readonly left: Node;
      readonly right: Node;
    }
  | {
      readonly kind: 'call';
      readonly name: FunctionName;
      readonly args: readonly Node[];
    };

type Token =
  | {
      readonly kind: 'number';
      readonly value: number;
      readonly position: number;
    }
  | {
      readonly kind: 'identifier';
      readonly name: string;
      readonly position: number;
    }
  | {
      readonly kind: 'operator';
      readonly operator: '+' | '-' | '*' | '/' | '**' | '^' | '(' | ')' | ',';
      readonly position: number;
    }
  | { readonly kind: 'end'; readonly position: number };

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const rest = source.slice(position);
    const char = rest.charAt(0);
    if (/\s/.test(char)) {
      position += 1;
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number !== null) {
      tokens.push({ kind: 'number', value: Number(number[0]), position });
      position += number[0].length;
      continue;
    }
    const identifier = IDENTIFIER.exec(rest);
    if (identifier !== null) {
      tokens.push({ kind: 'identifier', name: identifier[0], position });
      position += identifier[0].length;
      continue;
    }
    if (rest.startsWith('**')) {
      tokens.push({ kind: 'operator', operator: '**', position });
      position += 2;
      continue;
    }
    if ('+-*/^(),'.includes(char)) {
      tokens.push({
        kind: 'operator',
        operator: char as '+' | '-' | '*' | '/' | '^' | '(' | ')' | ',',
        position,
      });
      position += 1;
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected character "${char}"`, position);
  }
  tokens.push({ kind: 'end', position });
  return tokens;
}

/** Recursive-descent parser over the token list. */
class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): Node {
    const node = this.additive();
    const next = this.peek();
    if (next.kind !== 'end') {
      throw new FormulaSyntaxError('Unexpected token', next.position);
    }
    return node;
  }

  private peek(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error('token list without end');
    return token;
  }

  private next(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  /** Consumes the next token when it is one of `operators` and returns it. */
  private take<const T extends string>(...operators: T[]): T | undefined {
    const token = this.peek();
    if (token.kind !== 'operator') return undefined;
    const operator = operators.find(
      (candidate) => candidate === token.operator,
    );
    if (operator !== undefined) this.index += 1;
    return operator;
  }

  private expect(operator: ')'): void {
    if (this.take(operator) === undefined) {
      throw new FormulaSyntaxError(
        `Expected "${operator}"`,
        this.peek().position,
      );
    }
  }

  private nested<T>(parse: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw new FormulaSyntaxError(
        'Formula nested too deeply',
        this.peek().position,
      );
    }
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (
      let operator = this.take('+', '-');
      operator !== undefined;
      operator = this.take('+', '-')
    ) {
      left = { kind: 'binary', operator, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.unary();
    for (
      let operator = this.take('*', '/');
      operator !== undefined;
      operator = this.take('*', '/')
    ) {
      left = { kind: 'binary', operator, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    const sign = this.take('+', '-');
    if (sign !== undefined) {
      const operand = this.nested(() => this.unary());
      return sign === '-' ? { kind: 'negate', operand } : operand;
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.take('**', '^') !== undefined) {
      const exponent = this.nested(() => this.unary());
      return { kind: 'binary', operator: '**', left: base, right: exponent };
    }
    return base;
  }

  private primary(): Node {
    const token = this.next();
    switch (token.kind) {
      case 'number':
        return { kind: 'number', value: token.value };
      case 'identifier':
        return this.identifier(token.name, token.position);
      case 'operator':
        if (token.operator === '(') {
          const inner = this.nested(() => this.additive());
          this.expect(')');
          return inner;
        }
        throw new FormulaSyntaxError(
          `Unexpected "${token.operator}"`,
          token.position,
        );
      case 'end':
        throw new FormulaSyntaxError(
          'Unexpected end of formula',
          token.position,
        );
    }
  }

  private identifier(name: string, position: number): Node {
    if (name === 'speedKnot') return { kind: 'variable' };
    const fn = name.startsWith('Math.') ? name.slice('Math.'.length) : name;
    if (!isFunctionName(fn) || this.take('(') === undefined) {
      throw new FormulaSyntaxError(`Unknown identifier "${name}"`, position);
    }
    const args: Node[] = [this.nested(() => this.additive())];
    while (this.take(',') !== undefined) {
      args.push(this.nested(() => this.additive()));
    }
    this.expect(')');
    const [min, max] = FUNCTIONS[fn].arity;
    if (args.length < min || args.length > max) {
      throw new FormulaSyntaxError(
        `Wrong number of arguments for ${fn}`,
        position,
      );
    }
    return { kind: 'call', name: fn, args };
  }
}

function evaluateNode(node: Node, context: FormulaContext): number {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'variable':
      return context.speedKnot;
    case 'negate':
      return -evaluateNode(node.operand, context);
    case 'call':
      return FUNCTIONS[node.name].apply(
        node.args.map((arg) => evaluateNode(arg, context)),
      );
    case 'binary': {
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '**':
          return left ** right;
      }
    }
  }
}

/**
 * Parses a formula once; throws {@link FormulaSyntaxError} when it does not
 * follow the grammar (unknown identifiers and functions included).
 *
 * @method fuel.first_formula
 * @see docs/PLATFORM_SPEC.md §13.5 (safe expression evaluator), §15.4
 */
export function compileFormula(source: string): CompiledFormula {
  if (source.length > MAX_FORMULA_LENGTH) {
    throw new FormulaSyntaxError(
      `Formula longer than ${MAX_FORMULA_LENGTH} characters`,
      MAX_FORMULA_LENGTH,
    );
  }
  const ast = new Parser(tokenize(source)).parse();
  return {
    source,
    evaluate: (context) => evaluateNode(ast, context),
  };
}

/** The syntax problem of a formula, or `null` when it compiles. */
export function formulaSyntaxError(source: string): FormulaSyntaxError | null {
  try {
    compileFormula(source);
    return null;
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return error;
    throw error;
  }
}
