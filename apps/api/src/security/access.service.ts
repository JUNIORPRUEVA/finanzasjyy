import { Injectable } from '@nestjs/common';
import type { EntityMemberRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors.js';

export interface EntityAccessResult {
  entityId: string;
  role: EntityMemberRole;
  isOwner: boolean;
}

/**
 * CONTROL DE ACCESO A UNIDADES FINANCIERAS
 * ----------------------------------------
 * Toda operación de FINANZA pertenece a una unidad financiera. Este servicio es
 * el único punto que decide si un usuario puede ver o modificar una unidad, y
 * se usa en TODOS los servicios de dominio (no sólo en los controladores), de
 * modo que ninguna ruta interna pueda saltarse el aislamiento.
 *
 * Reglas:
 *  - El propietario de la unidad siempre tiene acceso total.
 *  - Un miembro accede según EntityMember.role.
 *  - Un usuario ajeno recibe 403 (no 404) para evitar enumeración, salvo que
 *    la unidad no exista, en cuyo caso se informa 404.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveEntityAccess(userId: string, entityId: string): Promise<EntityAccessResult> {
    // Sin unidad no hay nada que autorizar. Antes se llegaba a Prisma con
    // `id: undefined`, que responde con un error interno y acaba en un 500 con
    // la traza del ORM: un cliente que olvida el parámetro veía «error del
    // servidor» cuando en realidad le faltaba un dato. Un 400 lo dice claro.
    if (typeof entityId !== 'string' || entityId.trim() === '') {
      throw new ValidationError(
        'Falta indicar la unidad financiera. Elija una unidad antes de continuar.',
      );
    }

    const entity = await this.prisma.financialEntity.findUnique({
      where: { id: entityId },
      select: { id: true, ownerUserId: true, isActive: true },
    });

    if (!entity) {
      throw new NotFoundError('Unidad financiera', entityId);
    }

    if (entity.ownerUserId === userId) {
      return { entityId, role: 'OWNER', isOwner: true };
    }

    const membership = await this.prisma.entityMember.findUnique({
      where: { entityId_userId: { entityId, userId } },
      select: { role: true },
    });

    if (!membership) {
      throw new ForbiddenError('No tiene acceso a esta unidad financiera');
    }

    return { entityId, role: membership.role, isOwner: false };
  }

  /** Lanza 403 si el usuario no puede AL MENOS leer la unidad. */
  async assertCanRead(userId: string, entityId: string): Promise<EntityAccessResult> {
    return this.resolveEntityAccess(userId, entityId);
  }

  /** Lanza 403 si el usuario no puede ESCRIBIR en la unidad. */
  async assertCanWrite(userId: string, entityId: string): Promise<EntityAccessResult> {
    const access = await this.resolveEntityAccess(userId, entityId);
    if (access.role === 'VIEWER') {
      throw new ForbiddenError('Su rol en esta unidad financiera es de sólo lectura');
    }
    return access;
  }

  /** Lanza 403 si el usuario no puede ADMINISTRAR la unidad. */
  async assertCanAdminister(userId: string, entityId: string): Promise<EntityAccessResult> {
    const access = await this.resolveEntityAccess(userId, entityId);
    if (access.role !== 'OWNER' && access.role !== 'ADMIN') {
      throw new ForbiddenError('Se requiere rol de administrador en esta unidad financiera');
    }
    return access;
  }

  /** Unidades a las que el usuario tiene acceso (propias + donde es miembro). */
  async listAccessibleEntityIds(userId: string): Promise<string[]> {
    const [owned, memberships] = await Promise.all([
      this.prisma.financialEntity.findMany({
        where: { ownerUserId: userId, isActive: true },
        select: { id: true },
      }),
      this.prisma.entityMember.findMany({
        where: { userId, entity: { isActive: true } },
        select: { entityId: true },
      }),
    ]);

    const ids = new Set<string>();
    owned.forEach((entity) => ids.add(entity.id));
    memberships.forEach((membership) => ids.add(membership.entityId));
    return [...ids];
  }

  /**
   * Resuelve la lista de unidades sobre la que operar a partir de un filtro.
   * `entityId` vacío o ausente significa "todas las accesibles" (vista consolidada).
   */
  async resolveScope(userId: string, entityId?: string | null): Promise<string[]> {
    if (entityId) {
      await this.assertCanRead(userId, entityId);
      return [entityId];
    }
    return this.listAccessibleEntityIds(userId);
  }
}
