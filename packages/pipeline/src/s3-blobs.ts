import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BlobStore } from "@lojo/core";
import type { RawBucket, RawObject } from "./raw.ts";

export class S3BlobStore implements BlobStore, RawBucket {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType }));
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return (await out.Body?.transformToByteArray()) ?? null;
    } catch (error) {
      if (error instanceof NoSuchKey || (error instanceof Error && error.name === "NoSuchKey")) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async *list(prefix: string): AsyncIterable<RawObject> {
    let token: string | undefined;
    do {
      const out = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const item of out.Contents ?? []) {
        if (item.Key && item.LastModified) yield { key: item.Key, lastModified: item.LastModified };
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  /** The object is still an envelope sealed to Jon's key; the URL only saves the Lambda response limit. */
  async presignGet(key: string, expiresSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresSeconds });
  }
}
