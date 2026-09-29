import assert from "node:assert/strict";
import test from "node:test";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dynamoLike } from "./dynamo-doc.ts";
import { ttlCache } from "./ttl-cache.ts";

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

function fakeDoc(respond: (command: Sent) => unknown): { doc: DynamoDBDocumentClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const doc = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const entry = { name: command.constructor.name, input: command.input };
      sent.push(entry);
      return respond(entry);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, sent };
}

test("query follows LastEvaluatedKey until the limit", async () => {
  let page = 0;
  const { doc, sent } = fakeDoc(() => {
    page += 1;
    return { Items: [{ id: `a${page}` }, { id: `b${page}` }], ...(page < 5 ? { LastEvaluatedKey: { id: `b${page}` } } : {}) };
  });
  const items = await dynamoLike(doc).query("t", { index: "folder", keyName: "folder", keyValue: "inbox", limit: 5, descending: true });
  assert.equal(items.length, 6);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((entry) => entry.input.Limit), [5, 3, 1]);
  assert.equal(sent[0]?.input.ScanIndexForward, false);
  assert.deepEqual(sent[1]?.input.ExclusiveStartKey, { id: "b1" });
  assert.ok(sent.every((entry) => entry.name === "QueryCommand"));
});

test("update builds SET, REMOVE, ADD and a condition, and returns null when it fails", async () => {
  const { doc, sent } = fakeDoc((command) => {
    if (command.input.ConditionExpression) {
      const error = new Error("failed");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    return { Attributes: { day: "d", tokens: 7 } };
  });
  const db = dynamoLike(doc);
  assert.deepEqual(await db.update("b", { day: "d" }, { add: { tokens: 7 } }), { day: "d", tokens: 7 });
  assert.equal(sent[0]?.input.UpdateExpression, "ADD #n0 :v1");
  assert.equal(sent[0]?.input.ReturnValues, "ALL_NEW");

  const claimed = await db.update(
    "d",
    { id: "x" },
    { set: { status: "sending", gone: undefined }, condition: { notExists: ["approvalUsedAt"], equals: { approvalTokenHash: "h" }, oneOf: { status: ["edited", "suggested"] } } },
  );
  assert.equal(claimed, null);
  const input = sent[1]?.input ?? {};
  assert.equal(input.UpdateExpression, "SET #n0 = :v1 REMOVE #n2");
  assert.equal(input.ConditionExpression, "attribute_not_exists(#n3) AND #n4 = :v5 AND #n6 IN (:v7, :v8)");
  assert.deepEqual(input.ExpressionAttributeNames, { "#n0": "status", "#n2": "gone", "#n3": "approvalUsedAt", "#n4": "approvalTokenHash", "#n6": "status" });
});

test("conditional put reports an existing item as false", async () => {
  const { doc, sent } = fakeDoc(() => {
    const error = new Error("exists");
    error.name = "ConditionalCheckFailedException";
    throw error;
  });
  assert.equal(await dynamoLike(doc).put("m", { id: "x" }, { ifAbsent: "id" }), false);
  assert.equal(sent[0]?.input.ConditionExpression, "attribute_not_exists(#n0)");
});

test("ttlCache reuses a value, expires it, and never caches a rejection", async () => {
  let clock = 0;
  let calls = 0;
  let fail = true;
  const cache = ttlCache(
    1000,
    async () => {
      calls += 1;
      if (fail) throw new Error("ssm down");
      return calls;
    },
    () => clock,
  );
  await assert.rejects(() => cache.get(), /ssm down/);
  fail = false;
  assert.equal(await cache.get(), 2);
  assert.equal(await cache.get(), 2);
  clock = 1001;
  assert.equal(await cache.get(), 3);
});
