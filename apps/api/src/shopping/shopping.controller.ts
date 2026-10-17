import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import {
  CreateShoppingListDto,
  RegisterShoppingExpenseDto,
  ShoppingItemDto,
  ShoppingListQuery,
  UpdateShoppingItemDto,
  UpdateShoppingListDto,
} from './shopping.dto.js';
import { ShoppingService } from './shopping.service.js';

/**
 * COMPRAS PERSONALES
 * ------------------
 * Preparar la compra no mueve dinero. El único endpoint que puede generar un
 * gasto es `POST /shopping-lists/:id/register-expense`, y lo hace a través del
 * servicio de movimientos de FINANZA (partida doble, validaciones y auditoría).
 */
@Controller('shopping-lists')
export class ShoppingController {
  constructor(private readonly shopping: ShoppingService) {}

  /** Listas de compras, con búsqueda y filtro por estado. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ShoppingListQuery) {
    return this.shopping.list(user, query);
  }

  /** Resumen para el inicio: listas abiertas y cuánto queda por comprar. */
  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser, @Query('entityId') entityId?: string) {
    return this.shopping.summary(user, entityId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.shopping.get(user, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateShoppingListDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.create(user, dto, meta);
  }

  /**
   * Guarda una lista completa tal como quedó en el dispositivo (envío tras
   * estar sin conexión). Idempotente por `deviceListId` y nunca sobrescribe una
   * lista cuyo gasto ya se registró.
   */
  @Post('sync')
  syncFromDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateShoppingListDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.saveFromDevice(user, dto, meta);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateShoppingListDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.update(user, id, dto, meta);
  }

  /** Sólo se borran listas sin gasto registrado (las históricas se archivan). */
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.remove(user, id, meta);
  }

  @Post(':id/duplicate')
  duplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.duplicate(user, id, meta);
  }

  // --- Productos -----------------------------------------------------------

  @Post(':id/items')
  addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ShoppingItemDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.addItem(user, id, dto, meta);
  }

  @Patch(':id/items/:itemId')
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateShoppingItemDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.updateItem(user, id, itemId, dto, meta);
  }

  /** Sólo productos pendientes: lo ya comprado es un hecho, no una idea. */
  @Delete(':id/items/:itemId')
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.removeItem(user, id, itemId, meta);
  }

  /** Registra el gasto real de la lista como movimiento de FINANZA (idempotente). */
  @Post(':id/register-expense')
  registerExpense(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RegisterShoppingExpenseDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.shopping.registerExpense(user, id, dto, meta);
  }
}
