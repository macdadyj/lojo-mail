import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import type { DataKey, EncryptionContext, KeyWrapper } from "@lojo/core";

/**
 * Data keys under the mail CMK. The encryption context is enforced by KMS and
 * by the IAM conditions on kms:EncryptionContext:purpose.
 */
export class KmsKeyWrapper implements KeyWrapper {
  constructor(
    private readonly client: KMSClient,
    private readonly keyId: string,
  ) {}

  async generateDataKey(context: EncryptionContext): Promise<DataKey> {
    const out = await this.client.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: "AES_256", EncryptionContext: context }));
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error("KMS returned no data key");
    return { plaintext: new Uint8Array(out.Plaintext), wrapped: new Uint8Array(out.CiphertextBlob) };
  }

  async decryptDataKey(wrapped: Uint8Array, context: EncryptionContext): Promise<Uint8Array> {
    const out = await this.client.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: wrapped, EncryptionContext: context }));
    if (!out.Plaintext) throw new Error("KMS returned no plaintext");
    return new Uint8Array(out.Plaintext);
  }
}
