import { Transform } from 'class-transformer';
import { IsString, Matches, registerDecorator, type ValidationOptions } from 'class-validator';
import { dec } from '../domain/money.js';

/**
 * VALIDADORES MONETARIOS
 * ----------------------
 * FINANZA exige que los importes viajen como TEXTO decimal ("1250.75"), nunca
 * como número de coma flotante. Si se aceptaran números, un cliente podría
 * enviar 0.1 + 0.2 y el sistema recibiría 0.30000000000000004 antes de que
 * ninguna validación pudiera evitarlo.
 *
 * Formato aceptado: hasta 12 dígitos enteros y 1 o 2 decimales opcionales.
 */
const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export function IsMoneyString(options: ValidationOptions & { allowZero?: boolean } = {}): PropertyDecorator {
  const { allowZero = false, ...validationOptions } = options;
  return (target: object, propertyKey: string | symbol) => {
    Transform(({ value }: { value: unknown }) => (typeof value === 'number' ? String(value) : value), {
      toClassOnly: true,
    })(target, propertyKey);

    IsString({
      message: `${String(propertyKey)} debe enviarse como texto decimal, por ejemplo "1250.75"`,
      ...validationOptions,
    })(target, propertyKey);

    Matches(MONEY_PATTERN, {
      message:
        `${String(propertyKey)} debe ser un importe decimal con máximo 2 decimales y sin signo ` +
        '(por ejemplo "1250.75")',
      ...validationOptions,
    })(target, propertyKey);

    registerDecorator({
      name: 'isMoneyString',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
            return false;
          }
          const amount = dec(value);
          if (!allowZero && amount.isZero()) {
            return false;
          }
          return true;
        },
        defaultMessage() {
          return allowZero
            ? `${String(propertyKey)} debe ser un importe válido (cero o más)`
            : `${String(propertyKey)} debe ser un importe mayor que cero`;
        },
      },
    });
  };
}

/** Fecha de negocio en formato 'YYYY-MM-DD'. */
export function IsBusinessDateString(options: ValidationOptions = {}): PropertyDecorator {
  return Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: `${String(options.message ?? 'la fecha')}: use el formato YYYY-MM-DD`,
    ...options,
  });
}

/** Id opcional en formato UUID. */
export function IsOptionalUuid(options: ValidationOptions = {}): PropertyDecorator {
  return Matches(/^[0-9a-fA-F-]{36}$/, {
    message: 'El identificador no tiene un formato válido',
    ...options,
  });
}
