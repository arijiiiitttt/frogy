import crypto from "node:crypto";
import fs from "node:fs";

export interface StoreData {
  google?: { refreshToken: string; scopes: string[]; connectedAt: string };
  oauthClient?: { clientId: string; clientSecret: string };
}

export class VaultLocked extends Error {
  constructor() {
    super("Vault is locked");
  }
}

const KDF = { N: 1 << 16, r: 8, p: 1 };
const AAD = Buffer.from("frogy-vault-v1");

function derive(passphrase: string, salt: Buffer, params = KDF): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 });
}

/**
 * Encrypted credential store. AES-256-GCM, key derived from a passphrase with scrypt.
 * The key lives only in process memory while unlocked and is never written to disk.
 */
export class Vault {
  private key: Buffer | null = null;
  private data: StoreData | null = null;
  private salt: Buffer | null = null;
  private kdf = KDF;

  constructor(private file: string) {}

  exists(): boolean {
    return fs.existsSync(this.file);
  }
  get locked(): boolean {
    return this.key === null;
  }

  init(passphrase: string): void {
    if (this.exists()) throw new Error("Vault already exists");
    if (passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters");
    this.salt = crypto.randomBytes(16);
    this.kdf = KDF;
    this.key = derive(passphrase, this.salt, this.kdf);
    this.data = {};
    this.persist();
  }

  unlock(passphrase: string): void {
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
      v: number;
      kdf: typeof KDF;
      salt: string;
      nonce: string;
      tag: string;
      data: string;
    };
    const salt = Buffer.from(raw.salt, "base64");
    const key = derive(passphrase, salt, raw.kdf);
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(raw.nonce, "base64"));
      d.setAAD(AAD);
      d.setAuthTag(Buffer.from(raw.tag, "base64"));
      const plain = Buffer.concat([d.update(Buffer.from(raw.data, "base64")), d.final()]);
      this.data = JSON.parse(plain.toString("utf8")) as StoreData;
      this.key = key;
      this.salt = salt;
      this.kdf = raw.kdf;
    } catch {
      key.fill(0);
      throw new Error("Wrong passphrase or corrupted vault");
    }
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.data = null;
  }

  read(): StoreData {
    if (!this.data) throw new VaultLocked();
    return this.data;
  }

  update(fn: (d: StoreData) => void): void {
    fn(this.read());
    this.persist();
  }

  private persist(): void {
    if (!this.key || !this.data || !this.salt) throw new VaultLocked();
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(AAD);
    const enc = Buffer.concat([c.update(JSON.stringify(this.data), "utf8"), c.final()]);
    const out = {
      v: 1,
      kdf: this.kdf,
      salt: this.salt.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      data: enc.toString("base64"),
    };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
