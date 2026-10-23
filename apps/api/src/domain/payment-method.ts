/**
 * FORMA DE PAGO POR DEFECTO SEGÚN LA CUENTA
 * -----------------------------------------
 * El dinero no sale igual de una caja que de un banco. Antes el formulario
 * ponía «EFECTIVO» siempre, así que un gasto pagado desde una cuenta bancaria
 * quedaba registrado como efectivo (y el cierre del día no cuadraba con el
 * banco).
 *
 * La regla vive aquí, en el dominio, para que la usen todos los caminos que
 * crean movimientos (formulario, compras, sincronización) y no se pueda
 * olvidar en uno.
 */

const METODO_POR_TIPO_CUENTA: Record<string, string> = {
  CASH: 'EFECTIVO',
  BUSINESS_CASH: 'EFECTIVO',
  BANK: 'TRANSFERENCIA',
  CHECKING: 'TRANSFERENCIA',
  SAVINGS: 'TRANSFERENCIA',
  DIGITAL_WALLET: 'TRANSFERENCIA',
  MERCHANT: 'TRANSFERENCIA',
  CREDIT_CARD: 'TARJETA',
};

/** Forma de pago razonable para una cuenta; `null` si su tipo no dice nada. */
export function defaultPaymentMethod(accountType: string | null | undefined): string | null {
  if (!accountType) {
    return null;
  }
  return METODO_POR_TIPO_CUENTA[accountType] ?? null;
}
