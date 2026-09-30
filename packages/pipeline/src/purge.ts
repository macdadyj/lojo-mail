import { S3Client } from "@aws-sdk/client-s3";
import { DynamoMailStore, purgeExpiredTrash, purgeModeFrom, type PurgeResult } from "@lojo/core";
import { documentClient, dynamoLike, tableNamesFromEnv } from "./dynamo-doc.ts";
import { S3BlobStore } from "./s3-blobs.ts";

/**
 * The scheduled trash purge. Runs as its own Lambda with its own role (see
 * infra/terraform/purge.tf): it opens no mail, reads no secrets, and holds
 * DeleteItem and DeleteObject only when trash_purge_mode is "purge".
 */
export async function purge(): Promise<PurgeResult> {
  const bucket = process.env.LOJO_BUCKET;
  if (!bucket) throw new Error("LOJO_BUCKET is required for the trash purge");
  const result = await purgeExpiredTrash({
    store: new DynamoMailStore(dynamoLike(documentClient()), tableNamesFromEnv()),
    blobs: new S3BlobStore(new S3Client({}), bucket),
    now: new Date(),
    mode: purgeModeFrom(process.env.LOJO_TRASH_PURGE),
  });
  console.log(JSON.stringify({ event: "trash_purge", ...result }));
  return result;
}
