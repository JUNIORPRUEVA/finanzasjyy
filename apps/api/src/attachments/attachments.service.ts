import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';

/** Tipos permitidos: comprobantes e imágenes. Nada ejecutable. */
const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

const MAX_FILENAME_LENGTH = 120;

/**
 * ADJUNTOS (COMPROBANTES)
 * -----------------------
 * Medidas de seguridad aplicadas:
 *  · Sólo se aceptan imágenes y PDF (nunca ejecutables ni SVG, que puede
 *    contener scripts).
 *  · El nombre original NUNCA se usa como ruta: el archivo se guarda con su
 *    hash SHA-256, de modo que no hay path traversal ni colisiones.
 *  · Se comprueba el tamaño real del contenido descodificado, no lo que diga
 *    el cliente.
 *  · El nombre se sanea (se quitan separadores y caracteres de control).
 *  · Un adjunto vinculado a un movimiento contabilizado NO se puede borrar:
 *    es parte de la evidencia del movimiento.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly baseDir: string;
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    const configured = config.get<string>('ATTACHMENTS_DIR') ?? './.datos-locales/adjuntos';
    this.baseDir = resolve(process.cwd(), configured);
    this.maxBytes = Number(config.get<string>('MAX_ATTACHMENT_MB') ?? 8) * 1024 * 1024;
  }

  private sanitizeFilename(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? 'comprobante';
    const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
    return (cleaned.length > 0 ? cleaned : 'comprobante').slice(0, MAX_FILENAME_LENGTH);
  }

  async upload(
    user: AuthenticatedUser,
    input: { entityId: string; filename: string; mimeType: string; contentBase64: string },
    meta: RequestMetaInfo,
  ) {
    await this.access.assertCanWrite(user.userId, input.entityId);

    const extension = ALLOWED_MIME[input.mimeType];
    if (!extension) {
      throw new ValidationError(
        `Tipo de archivo no permitido (${input.mimeType}). Se aceptan imágenes JPG/PNG/WebP/HEIC y PDF.`,
      );
    }

    const base64 = input.contentBase64.includes(',')
      ? input.contentBase64.slice(input.contentBase64.indexOf(',') + 1)
      : input.contentBase64;

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      throw new ValidationError('El contenido del archivo no está en base64 válido');
    }

    if (buffer.length === 0) {
      throw new ValidationError('El archivo está vacío');
    }
    if (buffer.length > this.maxBytes) {
      throw new ValidationError(
        `El archivo supera el tamaño máximo permitido (${Math.round(this.maxBytes / 1024 / 1024)} MB)`,
      );
    }

    const sha256 = createHash('sha256').update(buffer).digest('hex');

    // Deduplicación: el mismo comprobante no se guarda dos veces.
    const existing = await this.prisma.attachment.findFirst({
      where: { entityId: input.entityId, sha256 },
    });
    if (existing) {
      return { ...this.present(existing), deduplicated: true };
    }

    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true });
    }

    const storagePath = join(this.baseDir, `${sha256}${extension}`);
    if (!existsSync(storagePath)) {
      await writeFile(storagePath, buffer);
    }

    const filename = this.sanitizeFilename(input.filename);
    if (extname(filename).toLowerCase() !== extension) {
      this.logger.debug(`Extensión corregida según el tipo real: ${filename} → ${extension}`);
    }

    const attachment = await this.prisma.attachment.create({
      data: {
        entityId: input.entityId,
        filename: `${filename.replace(/\.[^.]+$/, '')}${extension}`,
        mimeType: input.mimeType,
        sizeBytes: buffer.length,
        sha256,
        storagePath,
        uploadedByUserId: user.userId,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'attachment.uploaded',
      entityType: 'Attachment',
      entityId: attachment.id,
      after: { filename: attachment.filename, sizeBytes: attachment.sizeBytes, sha256 },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.present(attachment);
  }

  async list(user: AuthenticatedUser, entityId?: string) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const rows = await this.prisma.attachment.findMany({
      where: { entityId: { in: entityIds } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { _count: { select: { transactions: true } } },
    });
    return rows.map((row) => ({ ...this.present(row), linkedTransactions: row._count.transactions }));
  }

  async download(user: AuthenticatedUser, attachmentId: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment) {
      throw new NotFoundError('Adjunto', attachmentId);
    }
    await this.access.assertCanRead(user.userId, attachment.entityId);

    if (!existsSync(attachment.storagePath)) {
      throw new NotFoundError(
        'Archivo del adjunto',
        'el registro existe pero el archivo no está en el almacenamiento local',
      );
    }

    const content = await readFile(attachment.storagePath);
    return {
      ...this.present(attachment),
      contentBase64: content.toString('base64'),
      note: 'En un despliegue con almacenamiento de objetos se serviría con URL firmada de corta duración.',
    };
  }

  async remove(user: AuthenticatedUser, attachmentId: string, meta: RequestMetaInfo) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: { _count: { select: { transactions: true } } },
    });
    if (!attachment) {
      throw new NotFoundError('Adjunto', attachmentId);
    }
    await this.access.assertCanWrite(user.userId, attachment.entityId);

    if (attachment._count.transactions > 0) {
      throw new ConflictError(
        'No se puede eliminar un comprobante vinculado a un movimiento registrado: forma parte de la evidencia del movimiento.',
      );
    }

    await this.prisma.attachment.delete({ where: { id: attachmentId } });

    await this.audit.record({
      userId: user.userId,
      action: 'attachment.deleted',
      entityType: 'Attachment',
      entityId: attachmentId,
      before: { filename: attachment.filename, sha256: attachment.sha256 },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { deleted: true, note: 'El archivo físico se conserva en el almacenamiento para auditoría.' };
  }

  private present(attachment: {
    id: string;
    entityId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: Date;
  }) {
    return {
      id: attachment.id,
      entityId: attachment.entityId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sizeKb: Math.round(attachment.sizeBytes / 1024),
      sha256: attachment.sha256,
      createdAt: attachment.createdAt,
    };
  }
}
