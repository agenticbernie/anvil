import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EntityNameCipherService {
  constructor(private readonly config: ConfigService) {}

  encrypt(tenantId: string, entityId: string, name: string) {
    const nonce = randomBytes(12);
    const keyVersion = this.config.get<string>('PII_ENCRYPTION_KEY_VERSION', 'v1');
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`anvil.entity-name:${tenantId}:${entityId}:${keyVersion}`));
    const ciphertext = Buffer.concat([cipher.update(name, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext, nonce, keyVersion };
  }

  blindIndex(tenantId: string, name: string): string {
    const normalized = name.normalize('NFKC').trim().toLocaleLowerCase('en-US');
    return createHmac('sha256', this.key)
      .update(`anvil.entity-name-index:v1:${tenantId}:`)
      .update(normalized)
      .digest('hex');
  }

  private get key(): Buffer {
    const encoded = this.config.get<string>('PII_ENCRYPTION_KEY_BASE64', '');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new ServiceUnavailableException('PII encryption key is not configured.');
    }
    return key;
  }
}
