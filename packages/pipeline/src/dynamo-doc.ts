import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoLike, TableNames } from "@lojo/core";

export function tableNamesFromEnv(env: NodeJS.ProcessEnv = process.env): TableNames {
  return {
    messages: env.LOJO_TABLE_MESSAGES ?? "lojo-mail-messages",
    threads: env.LOJO_TABLE_THREADS ?? "lojo-mail-threads",
    drafts: env.LOJO_TABLE_DRAFTS ?? "lojo-mail-drafts",
    audit: env.LOJO_TABLE_AUDIT ?? "lojo-mail-audit",
    contacts: env.LOJO_TABLE_CONTACTS ?? "lojo-mail-contacts",
    budget: env.LOJO_TABLE_BUDGET ?? "lojo-mail-budget",
    imports: env.LOJO_TABLE_IMPORTS ?? "lojo-mail-imports",
  };
}

export function documentClient(env: NodeJS.ProcessEnv = process.env): DynamoDBDocumentClient {
  const endpoint = env.AWS_ENDPOINT_URL;
  const client = new DynamoDBClient({
    region: env.LOJO_REGION ?? env.AWS_REGION ?? "us-west-2",
    ...(endpoint ? { endpoint } : {}),
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export function dynamoLike(doc: DynamoDBDocumentClient): DynamoLike {
  return {
    async get(table, key) {
      const out = await doc.send(new GetCommand({ TableName: table, Key: key }));
      return (out.Item as Record<string, unknown> | undefined) ?? null;
    },
    async put(table, item, ifAbsentKey) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: item,
            ...(ifAbsentKey
              ? {
                  ConditionExpression: "attribute_not_exists(#k)",
                  ExpressionAttributeNames: { "#k": ifAbsentKey },
                }
              : {}),
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async query(table, opts) {
      const out = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: opts.index,
          KeyConditionExpression: "#k = :v",
          ExpressionAttributeNames: { "#k": opts.keyName },
          ExpressionAttributeValues: { ":v": opts.keyValue },
          Limit: opts.limit,
          ScanIndexForward: !opts.descending,
        }),
      );
      return (out.Items as Record<string, unknown>[] | undefined) ?? [];
    },
    async scan(table, limit) {
      const out = await doc.send(new ScanCommand({ TableName: table, Limit: limit }));
      return (out.Items as Record<string, unknown>[] | undefined) ?? [];
    },
    async update(table, key, patch) {
      const sets: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [field, value] of Object.entries(patch)) {
        const name = `#f${i}`;
        const placeholder = `:v${i}`;
        names[name] = field;
        values[placeholder] = value;
        sets.push(`${name} = ${placeholder}`);
        i += 1;
      }
      if (sets.length === 0) return;
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: `SET ${sets.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    },
  };
}
