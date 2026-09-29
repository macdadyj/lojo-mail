import {
  DEFAULT_TABLE_NAMES,
  TABLE_SCHEMAS,
  type Condition,
  type DynamoLike,
  type Item,
  type QueryOptions,
  type TableNames,
  type TableSchema,
  type UpdateOptions,
} from "./types.ts";

export const DYNAMO_ITEM_LIMIT_BYTES = 400 * 1024;

export class DynamoItemTooLarge extends Error {
  constructor(bytes: number) {
    super(`Item size has exceeded the maximum allowed size (${bytes} bytes)`);
    this.name = "ValidationException";
  }
}

function itemBytes(item: Item): number {
  return Buffer.byteLength(JSON.stringify(item));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matches(item: Item | undefined, condition: Condition | undefined): boolean {
  if (!condition) return true;
  for (const name of condition.exists ?? []) if (item?.[name] === undefined) return false;
  for (const name of condition.notExists ?? []) if (item?.[name] !== undefined) return false;
  for (const [name, value] of Object.entries(condition.equals ?? {})) if (item?.[name] !== value) return false;
  for (const [name, values] of Object.entries(condition.oneOf ?? {})) if (!values.includes(item?.[name])) return false;
  return true;
}

export type MemoryDynamoDump = Record<keyof TableNames, Item[]>;

/**
 * In-memory DynamoDB with the limits that matter: 400 KB items, key schemas,
 * declared indexes only, conditional writes, and no Scan.
 */
export class MemoryDynamo implements DynamoLike {
  private readonly schemas = new Map<string, TableSchema>();
  private readonly data = new Map<string, Map<string, Item>>();

  constructor(private readonly names: TableNames = DEFAULT_TABLE_NAMES) {
    for (const logical of Object.keys(TABLE_SCHEMAS) as Array<keyof TableNames>) {
      this.schemas.set(names[logical], TABLE_SCHEMAS[logical]);
      this.data.set(names[logical], new Map());
    }
  }

  private table(name: string): { schema: TableSchema; rows: Map<string, Item> } {
    const schema = this.schemas.get(name);
    const rows = this.data.get(name);
    if (!schema || !rows) throw new Error(`ResourceNotFoundException: no table ${name}`);
    return { schema, rows };
  }

  private keyOf(schema: TableSchema, item: Item): string {
    const hash = item[schema.hashKey];
    if (typeof hash !== "string" || hash === "") throw new Error(`ValidationException: missing key ${schema.hashKey}`);
    if (!schema.rangeKey) return JSON.stringify([hash]);
    const range = item[schema.rangeKey];
    if (typeof range !== "string" || range === "") throw new Error(`ValidationException: missing key ${schema.rangeKey}`);
    return JSON.stringify([hash, range]);
  }

  async get(table: string, key: Record<string, string>): Promise<Item | null> {
    const { schema, rows } = this.table(table);
    const found = rows.get(this.keyOf(schema, key));
    return found ? clone(found) : null;
  }

  async put(table: string, item: Item, opts?: { ifAbsent?: string }): Promise<boolean> {
    const { schema, rows } = this.table(table);
    const bytes = itemBytes(item);
    if (bytes > DYNAMO_ITEM_LIMIT_BYTES) throw new DynamoItemTooLarge(bytes);
    const key = this.keyOf(schema, item);
    if (opts?.ifAbsent && rows.get(key)?.[opts.ifAbsent] !== undefined) return false;
    rows.set(key, clone(item));
    return true;
  }

  async query(table: string, opts: QueryOptions): Promise<Item[]> {
    const { schema, rows } = this.table(table);
    const keys = opts.index ? schema.indexes[opts.index] : schema;
    if (!keys) throw new Error(`ValidationException: table ${table} has no index ${opts.index ?? ""}`);
    if (keys.hashKey !== opts.keyName) {
      throw new Error(`ValidationException: ${opts.index ?? table} is keyed on ${keys.hashKey}, not ${opts.keyName}`);
    }
    const range = keys.rangeKey;
    const hits = [...rows.values()].filter(
      (item) => item[keys.hashKey] === opts.keyValue && (!range || typeof item[range] === "string"),
    );
    if (range) {
      hits.sort((a, b) => {
        const av = String(a[range]);
        const bv = String(b[range]);
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
    }
    if (opts.descending) hits.reverse();
    return (opts.limit === undefined ? hits : hits.slice(0, opts.limit)).map((item) => clone(item));
  }

  async update(table: string, key: Record<string, string>, opts: UpdateOptions): Promise<Item | null> {
    const { schema, rows } = this.table(table);
    const id = this.keyOf(schema, key);
    const current = rows.get(id);
    if (!matches(current, opts.condition)) return null;
    const next: Item = { ...(current ? clone(current) : {}), ...key };
    for (const [name, value] of Object.entries(opts.set ?? {})) {
      if (value === undefined) delete next[name];
      else next[name] = clone(value);
    }
    for (const name of opts.remove ?? []) delete next[name];
    for (const [name, amount] of Object.entries(opts.add ?? {})) {
      const before = next[name];
      next[name] = (typeof before === "number" ? before : 0) + amount;
    }
    const bytes = itemBytes(next);
    if (bytes > DYNAMO_ITEM_LIMIT_BYTES) throw new DynamoItemTooLarge(bytes);
    rows.set(id, next);
    return clone(next);
  }

  itemSize(table: keyof TableNames, key: Record<string, string>): number {
    const { schema, rows } = this.table(this.names[table]);
    const found = rows.get(this.keyOf(schema, key));
    return found ? itemBytes(found) : 0;
  }

  dump(): MemoryDynamoDump {
    const out = {} as MemoryDynamoDump;
    for (const logical of Object.keys(TABLE_SCHEMAS) as Array<keyof TableNames>) {
      out[logical] = [...this.table(this.names[logical]).rows.values()].map((item) => clone(item));
    }
    return out;
  }

  static load(dump: Partial<MemoryDynamoDump>, names: TableNames = DEFAULT_TABLE_NAMES): MemoryDynamo {
    const db = new MemoryDynamo(names);
    for (const logical of Object.keys(TABLE_SCHEMAS) as Array<keyof TableNames>) {
      const { schema, rows } = db.table(names[logical]);
      for (const item of dump[logical] ?? []) rows.set(db.keyOf(schema, item), clone(item));
    }
    return db;
  }
}
