import { DynamoMailStore } from "./dynamo.ts";
import { MemoryDynamo, type MemoryDynamoDump } from "./memory-dynamo.ts";
import { DEFAULT_TABLE_NAMES } from "./types.ts";

export interface MemorySnapshot {
  version: 2;
  tables: MemoryDynamoDump;
}

/** The DynamoDB store over MemoryDynamo, so local dev and tests hit the same code and limits as AWS. */
export class MemoryStore extends DynamoMailStore {
  readonly memory: MemoryDynamo;

  constructor(memory: MemoryDynamo = new MemoryDynamo(DEFAULT_TABLE_NAMES)) {
    super(memory, DEFAULT_TABLE_NAMES);
    this.memory = memory;
  }

  snapshot(): MemorySnapshot {
    return { version: 2, tables: this.memory.dump() };
  }

  static fromSnapshot(snapshot: MemorySnapshot): MemoryStore {
    if (snapshot.version !== 2) {
      throw new Error("This mailbox file predates the S3 body layout. Re-run the import into a new --store.");
    }
    return new MemoryStore(MemoryDynamo.load(snapshot.tables, DEFAULT_TABLE_NAMES));
  }
}
