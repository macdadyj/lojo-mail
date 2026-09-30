import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_TABLE_NAMES, type Condition, type DynamoLike, type Item, type TableNames } from "@lojo/core";

export function tableNamesFromEnv(env: NodeJS.ProcessEnv = process.env): TableNames {
  return {
    messages: env.LOJO_TABLE_MESSAGES ?? DEFAULT_TABLE_NAMES.messages,
    threads: env.LOJO_TABLE_THREADS ?? DEFAULT_TABLE_NAMES.threads,
    drafts: env.LOJO_TABLE_DRAFTS ?? DEFAULT_TABLE_NAMES.drafts,
    audit: env.LOJO_TABLE_AUDIT ?? DEFAULT_TABLE_NAMES.audit,
    contacts: env.LOJO_TABLE_CONTACTS ?? DEFAULT_TABLE_NAMES.contacts,
    budget: env.LOJO_TABLE_BUDGET ?? DEFAULT_TABLE_NAMES.budget,
  };
}

export function documentClient(env: NodeJS.ProcessEnv = process.env): DynamoDBDocumentClient {
  const endpoint = env.AWS_ENDPOINT_URL;
  const client = new DynamoDBClient({
    region: env.LOJO_REGION ?? env.AWS_REGION ?? "us-east-1",
    ...(endpoint ? { endpoint } : {}),
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

class Expression {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private next = 0;

  name(field: string): string {
    const token = `#n${this.next}`;
    this.names[token] = field;
    this.next += 1;
    return token;
  }

  value(value: unknown): string {
    const token = `:v${this.next}`;
    this.values[token] = value;
    this.next += 1;
    return token;
  }

  condition(condition: Condition | undefined): string | undefined {
    if (!condition) return undefined;
    const clauses: string[] = [];
    for (const field of condition.exists ?? []) clauses.push(`attribute_exists(${this.name(field)})`);
    for (const field of condition.notExists ?? []) clauses.push(`attribute_not_exists(${this.name(field)})`);
    for (const [field, value] of Object.entries(condition.equals ?? {})) clauses.push(`${this.name(field)} = ${this.value(value)}`);
    for (const [field, options] of Object.entries(condition.oneOf ?? {})) {
      const name = this.name(field);
      clauses.push(`${name} IN (${options.map((option) => this.value(option)).join(", ")})`);
    }
    return clauses.length > 0 ? clauses.join(" AND ") : undefined;
  }

  attributes(): { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
    return {
      ...(Object.keys(this.names).length > 0 ? { ExpressionAttributeNames: this.names } : {}),
      ...(Object.keys(this.values).length > 0 ? { ExpressionAttributeValues: this.values } : {}),
    };
  }
}

function conditionFailed(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

/** Get, Put, Query, Update, and conditional Delete. Only the trash purge role is granted DeleteItem. */
export function dynamoLike(doc: DynamoDBDocumentClient): DynamoLike {
  return {
    async get(table, key) {
      const out = await doc.send(new GetCommand({ TableName: table, Key: key }));
      return (out.Item as Item | undefined) ?? null;
    },
    async put(table, item, opts) {
      const expr = new Expression();
      const condition = opts?.ifAbsent ? expr.condition({ notExists: [opts.ifAbsent] }) : undefined;
      try {
        await doc.send(new PutCommand({ TableName: table, Item: item, ...(condition ? { ConditionExpression: condition, ...expr.attributes() } : {}) }));
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },
    async query(table, opts) {
      const items: Item[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const remaining = opts.limit === undefined ? undefined : opts.limit - items.length;
        const out = await doc.send(
          new QueryCommand({
            TableName: table,
            IndexName: opts.index,
            KeyConditionExpression: "#k = :v",
            ExpressionAttributeNames: { "#k": opts.keyName },
            ExpressionAttributeValues: { ":v": opts.keyValue },
            ScanIndexForward: !opts.descending,
            ...(remaining === undefined ? {} : { Limit: remaining }),
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
        items.push(...((out.Items as Item[] | undefined) ?? []));
        start = out.LastEvaluatedKey;
      } while (start && (opts.limit === undefined || items.length < opts.limit));
      return items;
    },
    async update(table, key, opts) {
      const expr = new Expression();
      const sets: string[] = [];
      const removes: string[] = [];
      const adds: string[] = [];
      for (const [field, value] of Object.entries(opts.set ?? {})) {
        if (value === undefined) removes.push(expr.name(field));
        else sets.push(`${expr.name(field)} = ${expr.value(value)}`);
      }
      for (const field of opts.remove ?? []) removes.push(expr.name(field));
      for (const [field, amount] of Object.entries(opts.add ?? {})) adds.push(`${expr.name(field)} ${expr.value(amount)}`);
      const clauses = [
        ...(sets.length > 0 ? [`SET ${sets.join(", ")}`] : []),
        ...(removes.length > 0 ? [`REMOVE ${removes.join(", ")}`] : []),
        ...(adds.length > 0 ? [`ADD ${adds.join(", ")}`] : []),
      ];
      const condition = expr.condition(opts.condition);
      if (clauses.length === 0) return this.get(table, key);
      try {
        const out = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: clauses.join(" "),
            ...(condition ? { ConditionExpression: condition } : {}),
            ...expr.attributes(),
            ReturnValues: "ALL_NEW",
          }),
        );
        return (out.Attributes as Item | undefined) ?? null;
      } catch (error) {
        if (conditionFailed(error)) return null;
        throw error;
      }
    },
    async delete(table, key, condition) {
      const expr = new Expression();
      const clause = expr.condition(condition);
      if (!clause) throw new Error("delete needs a condition");
      try {
        const out = await doc.send(
          new DeleteCommand({ TableName: table, Key: key, ConditionExpression: clause, ...expr.attributes(), ReturnValues: "ALL_OLD" }),
        );
        return (out.Attributes as Item | undefined) ?? null;
      } catch (error) {
        if (conditionFailed(error)) return null;
        throw error;
      }
    },
  };
}
