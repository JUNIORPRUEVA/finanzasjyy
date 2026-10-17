import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { ShoppingListStatus } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { paginate, toSkipTake } from '../common/pagination.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { businessDateToIso, businessToday, toBusinessDate } from '../domain/business-date.js';
import { dec, round2, validateMoney } from '../domain/money.js';
import {
  CreateShoppingListDto,
  RegisterShoppingExpenseDto,
  ShoppingItemDto,
  ShoppingListQuery,
  UpdateShoppingItemDto,
  UpdateShoppingListDto,
} from './shopping.dto.js';

/**
 * COMPRAS PERSONALES
 * ==================
 * Una lista de la compra (supermercado, farmacia, combustible…) sirve para
 * decidir ANTES de gastar: qué hace falta, cuánto costará y cuánto se gastó de
 * verdad.
 *
 * REGLA DE ORO (integridad financiera)
 * ------------------------------------
 * Las listas NO tocan el libro mayor:
 *   · Crear una lista            → no genera gasto.
 *   · Añadir o marcar productos  → no genera gasto.
 *   · Finalizar la lista         → no genera gasto.
 * El gasto existe sólo cuando el usuario pulsa «Registrar gasto en FINANZA», y
 * entonces se llama al servicio de movimientos (el mismo que usa el resto de la
 * aplicación). Así el dinero sigue entrando por un único sitio, con partida
 * doble, validaciones y auditoría.
 *
 * El enlace entre lista y movimiento es único (`transactionId`) y el
 * identificador de idempotencia se deriva de la propia lista (`shop_<id>`): es
 * imposible que una lista genere dos gastos, aunque se pulse dos veces o se
 * reintente desde un móvil sin cobertura.
 */
@Injectable()
export class ShoppingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionsService,
  ) {}

  /**
   * Redondeo a 2 decimales devolviendo un NÚMERO (no un Decimal de Prisma).
   * Los cálculos de la lista suman y comparan importes; el texto final que viaja
   * al cliente se produce con `toFixed(2)`.
   */
  private num(value: number): number {
    return Number(round2(value));
  }

  // -------------------------------------------------------------------------
  // Cálculos (siempre en el servidor: el cliente no decide importes)
  // -------------------------------------------------------------------------

  private itemTotals(item: {
    quantity: unknown;
    estimatedUnitPrice: unknown;
    actualUnitPrice: unknown;
  }): { estimated: number; actual: number } {
    const quantity = Number(dec(item.quantity as never));
    const estimatedUnit = item.estimatedUnitPrice === null ? null : Number(dec(item.estimatedUnitPrice as never));
    const actualUnit = item.actualUnitPrice === null ? null : Number(dec(item.actualUnitPrice as never));

    return {
      estimated: estimatedUnit === null ? 0 : this.num(quantity * estimatedUnit),
      actual: actualUnit === null ? 0 : this.num(quantity * actualUnit),
    };
  }

  /**
   * Cantidad legible: 1.500 → «1.5», 100.000 → «100», 1.000 → «1».
   * OJO: no vale quitar ceros a lo bruto; «100» se convertiría en «1».
   */
  private formatQuantity(value: unknown): string {
    const text = dec(value as never).toFixed(3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return text.length === 0 ? '0' : text;
  }

  /** Fila de producto tal y como llega de Prisma. */
  private presentItem(item: {
    id: string;
    name: string;
    quantity: unknown;
    unit: string | null;
    estimatedUnitPrice: unknown;
    actualUnitPrice: unknown;
    isPurchased: boolean;
    purchasedAt: Date | null;
    categoryId: string | null;
    notes: string | null;
    sortOrder: number;
  }) {
    const totals = this.itemTotals(item);
    return {
      id: item.id,
      name: item.name,
      quantity: this.formatQuantity(item.quantity),
      unit: item.unit,
      estimatedUnitPrice: item.estimatedUnitPrice === null ? null : dec(item.estimatedUnitPrice as never).toFixed(2),
      actualUnitPrice: item.actualUnitPrice === null ? null : dec(item.actualUnitPrice as never).toFixed(2),
      estimatedTotal: totals.estimated.toFixed(2),
      actualTotal: totals.actual.toFixed(2),
      isPurchased: item.isPurchased,
      purchasedAt: item.purchasedAt ? item.purchasedAt.toISOString() : null,
      categoryId: item.categoryId,
      notes: item.notes,
      sortOrder: item.sortOrder,
    };
  }

  /**
   * Totales de una lista.
   *  · `estimatedTotal`  → lo que el usuario cree que costará TODO.
   *  · `actualTotal`     → lo que costó lo que ya se compró.
   *  · `pendingTotal`    → lo que aún falta por comprar (estimado).
   *  · `difference`      → real − estimado de lo comprado (puede ser negativo).
   * Nunca se llama «gastado» a lo estimado, para no confundir intención con gasto.
   */
  private presentList(
    list: {
      id: string;
      entityId: string;
      name: string;
      status: ShoppingListStatus;
      currency: string;
      notes: string | null;
      plannedDate: Date | null;
      completedAt: Date | null;
      actualTotal: unknown;
      transactionId: string | null;
      journalEntryId: string | null;
      deviceListId: string | null;
      createdByUserId: string;
      createdAt: Date;
      updatedAt: Date;
    },
    items: Array<{
      id: string;
      name: string;
      quantity: unknown;
      unit: string | null;
      estimatedUnitPrice: unknown;
      actualUnitPrice: unknown;
      isPurchased: boolean;
      purchasedAt: Date | null;
      categoryId: string | null;
      notes: string | null;
      sortOrder: number;
    }>,
    entity?: { code: string; name: string } | null,
  ) {
    const presented = items.map((item) => this.presentItem(item));
    const estimatedTotal = this.num(presented.reduce((acc, item) => acc + Number(item.estimatedTotal), 0));
    const actualTotal = this.num(presented.reduce((acc, item) => acc + Number(item.actualTotal), 0));
    const pendingTotal = this.num(
      presented.filter((item) => !item.isPurchased).reduce((acc, item) => acc + Number(item.estimatedTotal), 0),
    );
    const purchasedEstimated = this.num(
      presented.filter((item) => item.isPurchased).reduce((acc, item) => acc + Number(item.estimatedTotal), 0),
    );

    return {
      id: list.id,
      entityId: list.entityId,
      entityCode: entity?.code ?? null,
      entityName: entity?.name ?? null,
      name: list.name,
      status: list.status,
      currency: list.currency,
      notes: list.notes,
      plannedDate: list.plannedDate ? businessDateToIso(list.plannedDate) : null,
      completedAt: list.completedAt ? list.completedAt.toISOString() : null,
      deviceListId: list.deviceListId,
      createdByUserId: list.createdByUserId,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
      totals: {
        estimated: estimatedTotal.toFixed(2),
        actual: actualTotal.toFixed(2),
        pending: pendingTotal.toFixed(2),
        purchasedEstimated: purchasedEstimated.toFixed(2),
        difference: this.num(actualTotal - purchasedEstimated).toFixed(2),
      },
      counts: {
        items: presented.length,
        purchased: presented.filter((item) => item.isPurchased).length,
      },
      expense: list.transactionId
        ? {
            transactionId: list.transactionId,
            journalEntryId: list.journalEntryId,
            registered: true,
          }
        : { transactionId: null, journalEntryId: null, registered: false },
      items: presented,
    };
  }

  // -------------------------------------------------------------------------
  // Consultas
  // -------------------------------------------------------------------------

  private async scopeEntityIds(user: AuthenticatedUser, requestedEntityId?: string): Promise<string[]> {
    // `resolveScope` es la única fuente de verdad de qué unidades puede ver un
    // usuario (propietario o miembro, según EntityMember).
    return this.access.resolveScope(user.userId, requestedEntityId ?? null);
  }

  async list(user: AuthenticatedUser, query: ShoppingListQuery) {
    const entityIds = await this.scopeEntityIds(user, query.entityId);
    const { skip, take, page, limit } = toSkipTake(query);

    const where: Prisma.ShoppingListWhereInput = {
      entityId: { in: entityIds },
      ...(query.status ? { status: query.status } : {}),
      ...(query.createdByUserId ? { createdByUserId: query.createdByUserId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { items: { some: { name: { contains: query.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.shoppingList.findMany({
        where,
        include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }, entity: { select: { code: true, name: true } } },
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        skip,
        take,
      }),
      this.prisma.shoppingList.count({ where }),
    ]);

    const data = rows.map((row) => {
      const { items, entity, ...list } = row;
      return this.presentList(list, items, entity);
    });

    return paginate(data, total, page, limit);
  }

  async get(user: AuthenticatedUser, id: string) {
    const list = await this.prisma.shoppingList.findUnique({
      where: { id },
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }, entity: { select: { code: true, name: true } } },
    });
    if (!list) {
      throw new NotFoundError('Lista de compras', id);
    }
    await this.access.assertCanRead(user.userId, list.entityId);
    const { items, entity, ...rest } = list;
    return this.presentList(rest, items, entity);
  }

  /** Carga la lista comprobando permiso de ESCRITURA (para cambios). */
  private async getForWrite(user: AuthenticatedUser, id: string) {
    const list = await this.prisma.shoppingList.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!list) {
      throw new NotFoundError('Lista de compras', id);
    }
    await this.access.assertCanWrite(user.userId, list.entityId);
    return list;
  }

  // -------------------------------------------------------------------------
  // Listas
  // -------------------------------------------------------------------------

  private prepareItems(items: ShoppingItemDto[] | undefined) {
    return (items ?? []).map((item, index) => ({
      name: item.name.trim(),
      quantity: item.quantity ? dec(item.quantity) : dec(1),
      unit: item.unit ?? null,
      estimatedUnitPrice:
        item.estimatedUnitPrice === undefined || item.estimatedUnitPrice === null
          ? null
          : validateMoney(item.estimatedUnitPrice, { field: 'precio estimado', allowZero: true }),
      actualUnitPrice:
        item.actualUnitPrice === undefined || item.actualUnitPrice === null
          ? null
          : validateMoney(item.actualUnitPrice, { field: 'precio real', allowZero: true }),
      isPurchased: item.isPurchased === true,
      categoryId: item.categoryId ?? null,
      notes: item.notes ?? null,
      sortOrder: item.sortOrder ?? index,
    }));
  }

  /**
   * Crea una lista. Si llega `deviceListId` ya existente, devuelve la que había
   * (idempotencia del envío sin conexión): el usuario no acaba con dos listas
   * iguales por haber pulsado «guardar» dos veces sin cobertura.
   */
  async create(user: AuthenticatedUser, dto: CreateShoppingListDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, dto.entityId);

    if (dto.deviceListId) {
      const existing = await this.prisma.shoppingList.findUnique({
        where: { deviceListId: dto.deviceListId },
        include: { items: { orderBy: { sortOrder: 'asc' } }, entity: { select: { code: true, name: true } } },
      });
      if (existing) {
        const { items, entity, ...rest } = existing;
        return { ...this.presentList(rest, items, entity), duplicate: true };
      }
    }

    const items = this.prepareItems(dto.items);
    const estimatedTotal = this.num(
      items.reduce((acc, item) => {
        const unit = item.estimatedUnitPrice === null ? 0 : Number(dec(item.estimatedUnitPrice));
        return acc + Number(dec(item.quantity)) * unit;
      }, 0),
    );

    const created = await this.prisma.shoppingList.create({
      data: {
        entityId: dto.entityId,
        name: dto.name.trim(),
        status: dto.status ?? 'DRAFT',
        notes: dto.notes ?? null,
        plannedDate: dto.plannedDate ? toBusinessDate(dto.plannedDate) : null,
        estimatedTotal,
        deviceListId: dto.deviceListId ?? null,
        createdByUserId: user.userId,
        items: items.length > 0 ? { create: items } : undefined,
      },
      include: { items: { orderBy: { sortOrder: 'asc' } }, entity: { select: { code: true, name: true } } },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'shopping.list.created',
      entityType: 'ShoppingList',
      entityId: created.id,
      after: { name: created.name, entityId: created.entityId, items: items.length },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const { items: createdItems, entity, ...rest } = created;
    return this.presentList(rest, createdItems, entity);
  }

  /**
   * Guarda una lista completa tal y como quedó en el dispositivo (envío sin
   * conexión). Sólo se admite sobre listas SIN gasto registrado: una compra ya
   * contabilizada no se sobrescribe nunca desde el móvil.
   */
  async saveFromDevice(
    user: AuthenticatedUser,
    dto: CreateShoppingListDto & { id?: string },
    meta: RequestMetaInfo,
  ) {
    const deviceListId = dto.deviceListId;
    if (!deviceListId) {
      throw new ValidationError('Falta el identificador de la lista del dispositivo');
    }

    const existing = await this.prisma.shoppingList.findUnique({
      where: { deviceListId },
      include: { items: true },
    });

    if (!existing) {
      return this.create(user, dto, meta);
    }

    await this.access.assertCanWrite(user.userId, existing.entityId);
    if (existing.transactionId) {
      // Ya se registró el gasto: se respeta lo confirmado y se devuelve tal cual.
      return this.get(user, existing.id);
    }

    const items = this.prepareItems(dto.items);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.shoppingListItem.deleteMany({ where: { listId: existing.id } });
      return tx.shoppingList.update({
        where: { id: existing.id },
        data: {
          name: dto.name.trim(),
          status: dto.status ?? existing.status,
          notes: dto.notes ?? null,
          plannedDate: dto.plannedDate ? toBusinessDate(dto.plannedDate) : null,
          items: items.length > 0 ? { create: items } : undefined,
        },
        include: { items: { orderBy: { sortOrder: 'asc' } }, entity: { select: { code: true, name: true } } },
      });
    });

    const { items: savedItems, entity, ...rest } = updated;
    return { ...this.presentList(rest, savedItems, entity), duplicate: false };
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateShoppingListDto, meta: RequestMetaInfo) {
    const list = await this.getForWrite(user, id);
    if (list.transactionId && dto.status && dto.status !== 'COMPLETED' && dto.status !== 'ARCHIVED') {
      throw new ConflictError(
        'Esta lista ya tiene el gasto registrado. Para volver a usarla, duplíquela como una lista nueva.',
      );
    }

    const updated = await this.prisma.shoppingList.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
        ...(dto.status === undefined ? {} : { status: dto.status }),
        ...(dto.notes === undefined ? {} : { notes: dto.notes }),
        ...(dto.plannedDate === undefined
          ? {}
          : { plannedDate: dto.plannedDate === null ? null : toBusinessDate(dto.plannedDate) }),
        ...(dto.status === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
      include: { items: { orderBy: { sortOrder: 'asc' } }, entity: { select: { code: true, name: true } } },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'shopping.list.updated',
      entityType: 'ShoppingList',
      entityId: id,
      before: { name: list.name, status: list.status },
      after: { name: updated.name, status: updated.status },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const { items, entity, ...rest } = updated;
    return this.presentList(rest, items, entity);
  }

  /**
   * Borra una lista SIN gasto registrado. Las listas históricas (con gasto) no
   * se borran: se archivan, porque forman parte del rastro de un movimiento real.
   */
  async remove(user: AuthenticatedUser, id: string, meta: RequestMetaInfo) {
    const list = await this.getForWrite(user, id);
    if (list.transactionId) {
      throw new ConflictError(
        'Esta lista tiene un gasto registrado en FINANZA y no se puede borrar. Puede archivarla para quitarla de la vista.',
      );
    }

    await this.prisma.shoppingList.delete({ where: { id } });
    await this.audit.record({
      userId: user.userId,
      action: 'shopping.list.deleted',
      entityType: 'ShoppingList',
      entityId: id,
      before: { name: list.name, items: list.items.length },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { deleted: true };
  }

  /** Duplica una lista frecuente como borrador nuevo, sin productos comprados. */
  async duplicate(user: AuthenticatedUser, id: string, meta: RequestMetaInfo) {
    const list = await this.prisma.shoppingList.findUnique({ where: { id }, include: { items: true } });
    if (!list) {
      throw new NotFoundError('Lista de compras', id);
    }
    await this.access.assertCanWrite(user.userId, list.entityId);

    const copy = await this.prisma.shoppingList.create({
      data: {
        entityId: list.entityId,
        name: `${list.name} (copia)`.slice(0, 80),
        status: 'DRAFT',
        notes: list.notes,
        createdByUserId: user.userId,
        items: {
          create: list.items.map((item, index) => ({
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            estimatedUnitPrice: item.estimatedUnitPrice,
            categoryId: item.categoryId,
            notes: item.notes,
            sortOrder: index,
            isPurchased: false,
          })),
        },
      },
      include: { items: { orderBy: { sortOrder: 'asc' } }, entity: { select: { code: true, name: true } } },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'shopping.list.duplicated',
      entityType: 'ShoppingList',
      entityId: copy.id,
      after: { from: id, name: copy.name },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const { items, entity, ...rest } = copy;
    return this.presentList(rest, items, entity);
  }

  // -------------------------------------------------------------------------
  // Productos
  // -------------------------------------------------------------------------

  async addItem(user: AuthenticatedUser, listId: string, dto: ShoppingItemDto, meta: RequestMetaInfo) {
    await this.getForWrite(user, listId);
    const [prepared] = this.prepareItems([dto]);
    const item = await this.prisma.shoppingListItem.create({ data: { ...prepared, listId } });
    await this.refreshEstimatedTotal(listId, user, meta, 'shopping.item.added', item.id);
    return this.presentItem(item);
  }

  async updateItem(
    user: AuthenticatedUser,
    listId: string,
    itemId: string,
    dto: UpdateShoppingItemDto,
    meta: RequestMetaInfo,
  ) {
    const list = await this.getForWrite(user, listId);
    const item = await this.prisma.shoppingListItem.findUnique({ where: { id: itemId } });
    if (!item || item.listId !== listId) {
      throw new NotFoundError('Producto', itemId);
    }

    const updated = await this.prisma.shoppingListItem.update({
      where: { id: itemId },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
        ...(dto.quantity === undefined ? {} : { quantity: dec(dto.quantity) }),
        ...(dto.unit === undefined ? {} : { unit: dto.unit }),
        ...(dto.estimatedUnitPrice === undefined
          ? {}
          : {
              estimatedUnitPrice:
                dto.estimatedUnitPrice === null
                  ? null
                  : validateMoney(dto.estimatedUnitPrice, { field: 'precio estimado', allowZero: true }),
            }),
        ...(dto.actualUnitPrice === undefined
          ? {}
          : {
              actualUnitPrice:
                dto.actualUnitPrice === null
                  ? null
                  : validateMoney(dto.actualUnitPrice, { field: 'precio real', allowZero: true }),
            }),
        ...(dto.isPurchased === undefined
          ? {}
          : { isPurchased: dto.isPurchased, purchasedAt: dto.isPurchased ? (item.purchasedAt ?? new Date()) : null }),
        ...(dto.categoryId === undefined ? {} : { categoryId: dto.categoryId }),
        ...(dto.notes === undefined ? {} : { notes: dto.notes }),
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
      },
    });

    await this.refreshEstimatedTotal(listId, user, meta, 'shopping.item.updated', itemId);
    return this.presentItem(updated);
  }

  async removeItem(user: AuthenticatedUser, listId: string, itemId: string, meta: RequestMetaInfo) {
    await this.getForWrite(user, listId);
    const item = await this.prisma.shoppingListItem.findUnique({ where: { id: itemId } });
    if (!item || item.listId !== listId) {
      throw new NotFoundError('Producto', itemId);
    }
    // Sólo se borran productos PENDIENTES: lo ya comprado es un hecho, no una idea.
    if (item.isPurchased) {
      throw new ConflictError(
        'Este producto ya está marcado como comprado. Desmárquelo antes de borrarlo (así queda claro que no se compró).',
      );
    }

    await this.prisma.shoppingListItem.delete({ where: { id: itemId } });
    await this.refreshEstimatedTotal(listId, user, meta, 'shopping.item.deleted', itemId);
    return { deleted: true };
  }

  /** Recalcula el estimado de la lista y deja rastro del cambio. */
  private async refreshEstimatedTotal(
    listId: string,
    user: AuthenticatedUser,
    meta: RequestMetaInfo,
    action: string,
    itemId: string,
  ): Promise<void> {
    const items = await this.prisma.shoppingListItem.findMany({ where: { listId } });
    const estimatedTotal = this.num(
      items.reduce((acc, item) => {
        const unit = item.estimatedUnitPrice === null ? 0 : Number(dec(item.estimatedUnitPrice));
        return acc + Number(dec(item.quantity)) * unit;
      }, 0),
    );
    await this.prisma.shoppingList.update({ where: { id: listId }, data: { estimatedTotal } });
    await this.audit.record({
      userId: user.userId,
      action,
      entityType: 'ShoppingListItem',
      entityId: itemId,
      after: { listId, estimatedTotal: estimatedTotal.toFixed(2) },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // -------------------------------------------------------------------------
  // Registro del gasto (el único camino al libro mayor)
  // -------------------------------------------------------------------------

  /**
   * Registra el gasto real de la lista como un movimiento de FINANZA.
   *
   * · Importe: el que indique el usuario o, si no, el total real de lo comprado.
   * · Idempotencia: `shop_<listId>` → dos pulsaciones = un solo gasto.
   * · Trazabilidad: la lista queda vinculada al movimiento y a su asiento.
   */
  async registerExpense(
    user: AuthenticatedUser,
    id: string,
    dto: RegisterShoppingExpenseDto,
    meta: RequestMetaInfo,
  ) {
    const list = await this.prisma.shoppingList.findUnique({ where: { id }, include: { items: true } });
    if (!list) {
      throw new NotFoundError('Lista de compras', id);
    }
    await this.access.assertCanWrite(user.userId, list.entityId);

    // Ya registrada: se devuelve el movimiento existente (no se duplica nada).
    if (list.transactionId) {
      return {
        duplicate: true,
        transactionId: list.transactionId,
        journalEntryId: list.journalEntryId,
        list: await this.get(user, id),
      };
    }

    const purchased = list.items.filter((item) => item.isPurchased);
    const purchasedTotals = purchased.map((item) => this.itemTotals(item).actual);
    const computedActual = this.num(purchasedTotals.reduce((acc, value) => acc + value, 0));

    const amount = dto.amount
      ? validateMoney(dto.amount, { field: 'importe pagado' })
      : computedActual > 0
        ? dec(computedActual.toFixed(2))
        : null;

    if (!amount) {
      throw new ValidationError(
        'Indique el importe pagado (o marque los productos con su precio real antes de registrar el gasto)',
      );
    }

    const businessDate = dto.businessDate ?? businessDateToIso(businessToday());
    const description = (dto.description ?? `Compra: ${list.name}`).slice(0, 200);

    // El gasto entra por el MISMO servicio que el resto de la aplicación.
    const transaction = await this.transactions.create(
      user,
      {
        entityId: list.entityId,
        kind: 'EXPENSE',
        accountId: dto.accountId,
        categoryId: dto.categoryId ?? purchased.find((item) => item.categoryId)?.categoryId ?? null,
        amount: dec(amount).toFixed(2),
        businessDate,
        description,
        method: dto.method ?? 'EFECTIVO',
        clientOperationId: dto.clientOperationId ?? `shop_${list.id}`,
      },
      meta,
    );

    if (transaction.duplicate) {
      // El movimiento ya existía (mismo identificador): se enlaza y se sigue.
    }

    const updated = await this.prisma.shoppingList.update({
      where: { id },
      data: {
        transactionId: transaction.id,
        journalEntryId: transaction.journalEntryId ?? null,
        clientOperationId: transaction.clientOperationId,
        actualTotal: dec(amount),
        status: 'COMPLETED',
        completedAt: new Date(),
      },
      include: { items: { orderBy: { sortOrder: 'asc' } }, entity: { select: { code: true, name: true } } },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'shopping.list.expense_registered',
      entityType: 'ShoppingList',
      entityId: id,
      after: {
        transactionId: transaction.id,
        amount: dec(amount).toFixed(2),
        accountId: dto.accountId,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const { items, entity, ...rest } = updated;
    return {
      duplicate: false,
      transactionId: transaction.id,
      journalEntryId: transaction.journalEntryId,
      list: this.presentList(rest, items, entity),
    };
  }

  /** Resumen para el inicio: listas abiertas y cuánto queda por comprar. */
  async summary(user: AuthenticatedUser, entityId?: string) {
    const entityIds = await this.scopeEntityIds(user, entityId);
    const lists = await this.prisma.shoppingList.findMany({
      where: {
        entityId: { in: entityIds },
        status: { in: ['DRAFT', 'ACTIVE'] },
      },
      include: { items: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    const rows = lists.map((list) => {
      const { items, ...rest } = list;
      return this.presentList(rest, items);
    });

    const pendingTotal = this.num(rows.reduce((acc, row) => acc + Number(row.totals.pending), 0));
    const estimatedTotal = this.num(rows.reduce((acc, row) => acc + Number(row.totals.estimated), 0));

    return {
      openLists: rows.length,
      itemsPending: rows.reduce((acc, row) => acc + (row.counts.items - row.counts.purchased), 0),
      pendingTotal: pendingTotal.toFixed(2),
      estimatedTotal: estimatedTotal.toFixed(2),
      lists: rows.slice(0, 5),
      note: 'Lo estimado es una intención, no un gasto: el gasto sólo existe cuando se registra en FINANZA.',
    };
  }
}
