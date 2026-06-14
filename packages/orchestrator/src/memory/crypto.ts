import crypto from "node:crypto";

/**
 * Field-level authenticated encryption for sensitive knowledge-graph payloads.
 * A per-install key is derived from a single master secret via HKDF so each
 * install's sealed fields are cryptographically isolated even in one store.
 */
export interface SealedField {
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class FieldCipher {
  private readonly masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length < 16) {
      throw new Error("FieldCipher master key must be at least 16 bytes.");
    }
    this.masterKey = masterKey;
  }

  static fromSecret(secret: string): FieldCipher {
    // Accept hex or base64 secrets; fall back to UTF-8 bytes for dev secrets.
    const fromHex = /^[0-9a-f]{32,}$/i.test(secret) ? Buffer.from(secret, "hex") : null;
    const key = fromHex && fromHex.length >= 16 ? fromHex : Buffer.from(secret, "utf8");
    return new FieldCipher(key);
  }

  private deriveKey(installId: string): Buffer {
    const derived = crypto.hkdfSync("sha256", this.masterKey, Buffer.from(installId, "utf8"), Buffer.from("kg-field-v1"), 32);
    return Buffer.from(derived);
  }

  seal(installId: string, plaintext: string): SealedField {
    const key = this.deriveKey(installId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }

  open(installId: string, sealed: SealedField): string {
    const key = this.deriveKey(installId);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]);
    return plaintext.toString("utf8");
  }
}
