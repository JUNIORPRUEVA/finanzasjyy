import { describe, expect, it } from '@jest/globals';
import { classifyTransfer, validarVinculo, type LegalUnit } from './legal-structure.js';

/**
 * RELACIÓN JURÍDICA: PRUEBAS
 * -------------------------
 * Lo que se protege aquí es que el sistema NO invente deudas ni ingresos por
 * comparar identificadores. Cada caso de la lista tiene un asiento distinto:
 *
 *   A · misma unidad          → un asiento
 *   B · misma sociedad        → dos asientos con puente interno (1150 a cero)
 *   C · sociedades distintas  → se rechaza hasta clasificar la operación
 *   D · relación desconocida  → se rechaza y se pide confirmarla
 */

const SRL = 'legal-fulltech-srl';
const PERSONA = 'legal-propietario';

const fulltech: LegalUnit = {
  id: 'e-fulltech',
  code: 'FULLTECH_PRINCIPAL',
  name: 'FULLTECH',
  type: 'BUSINESS',
  legalEntityId: SRL,
};
const appyra: LegalUnit = {
  id: 'e-appyra',
  code: 'APPYRA_SISTEMAS',
  name: 'APPYRA',
  type: 'BUSINESS',
  legalEntityId: SRL,
};
const personal: LegalUnit = { id: 'e-personal', code: 'PERSONAL', name: 'FINANZAS PERSONALES', type: 'PERSONAL', legalEntityId: PERSONA };
const phyto: LegalUnit = { id: 'e-phyto', code: 'PHYTOEMAGRY', name: 'PHYTOEMAGRY', type: 'BUSINESS', legalEntityId: null };

describe('clasificación de un movimiento entre unidades', () => {
  it('A · misma unidad: un solo asiento', () => {
    // Dos cuentas distintas de la MISMA unidad: la unidad es la misma.
    const result = classifyTransfer(fulltech, { ...fulltech });
    expect(result.relation).toBe('SAME_UNIT');
    expect(result.posting).toBe('SINGLE_ENTRY');
    expect(result.allowed).toBe(true);
  });

  it('B · FULLTECH y APPYRA son la misma persona jurídica: traslado interno con puente', () => {
    const result = classifyTransfer(fulltech, appyra);
    expect(result.relation).toBe('SAME_LEGAL_ENTITY');
    expect(result.posting).toBe('TWO_ENTRIES_BRIDGE');
    expect(result.allowed).toBe(true);
    expect(result.code).toBe('SAME_LEGAL_ENTITY');
  });

  it('B · el orden no cambia la clasificación', () => {
    expect(classifyTransfer(appyra, fulltech).relation).toBe('SAME_LEGAL_ENTITY');
  });

  it('C · FULLTECH y PERSONAL son sujetos distintos: se rechaza hasta clasificar', () => {
    const result = classifyTransfer(fulltech, personal);
    expect(result.relation).toBe('DIFFERENT_LEGAL_ENTITY');
    expect(result.allowed).toBe(false);
    expect(result.posting).toBe('REQUIRES_CLASSIFICATION');
    expect(result.reason).toMatch(/clasificar/i);
  });

  it('C · el rechazo es simétrico (PERSONAL → FULLTECH tampoco se contabiliza a ciegas)', () => {
    expect(classifyTransfer(personal, fulltech).allowed).toBe(false);
  });

  it('D · una unidad sin relación confirmada no se trata como parte de la sociedad', () => {
    const result = classifyTransfer(fulltech, phyto);
    expect(result.relation).toBe('UNKNOWN');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('PHYTOEMAGRY');
  });

  it('D · dos unidades «desconocidas» tampoco se consideran la misma sociedad', () => {
    const result = classifyTransfer(phyto, { ...phyto, id: 'e-phyto-2' });
    expect(result.relation).toBe('UNKNOWN');
    expect(result.allowed).toBe(false);
  });
});

describe('validación de vínculos entre unidad y persona jurídica', () => {
  it('acepta una sociedad con unidades de negocio', () => {
    expect(
      validarVinculo({ entityType: 'BUSINESS', legalEntityId: SRL, legalEntityKind: 'COMPANY', parentEntityId: null }),
    ).toBeNull();
  });

  it('acepta una persona física con finanzas personales', () => {
    expect(
      validarVinculo({
        entityType: 'PERSONAL',
        legalEntityId: PERSONA,
        legalEntityKind: 'INDIVIDUAL',
        parentEntityId: null,
      }),
    ).toBeNull();
  });

  it('rechaza finanzas personales dentro de una sociedad', () => {
    expect(
      validarVinculo({ entityType: 'PERSONAL', legalEntityId: SRL, legalEntityKind: 'COMPANY', parentEntityId: null }),
    ).toMatch(/persona física/i);
  });

  it('rechaza un negocio dentro de una persona física', () => {
    expect(
      validarVinculo({
        entityType: 'BUSINESS',
        legalEntityId: PERSONA,
        legalEntityKind: 'INDIVIDUAL',
        parentEntityId: null,
      }),
    ).toMatch(/tipo personal/i);
  });

  it('rechaza depender de una unidad de finanzas personales', () => {
    expect(
      validarVinculo({
        entityType: 'BUSINESS',
        legalEntityId: SRL,
        legalEntityKind: 'COMPANY',
        parentEntityId: 'e-personal',
        parentEntityType: 'PERSONAL',
        parentLegalEntityId: PERSONA,
      }),
    ).toMatch(/finanzas personales/i);
  });

  it('rechaza que el padre sea de otra persona jurídica (vínculo incompatible)', () => {
    expect(
      validarVinculo({
        entityType: 'BUSINESS',
        legalEntityId: SRL,
        legalEntityKind: 'COMPANY',
        parentEntityId: 'e-otra',
        parentEntityType: 'BUSINESS',
        parentLegalEntityId: PERSONA,
      }),
    ).toMatch(/personas jurídicas distintas/i);
  });

  it('rechaza una persona jurídica que no existe', () => {
    expect(
      validarVinculo({ entityType: 'BUSINESS', legalEntityId: 'no-existe', legalEntityKind: null, parentEntityId: null }),
    ).toMatch(/no existe/i);
  });

  it('permite dejar la relación sin confirmar (no adivina)', () => {
    expect(
      validarVinculo({ entityType: 'BUSINESS', legalEntityId: null, legalEntityKind: null, parentEntityId: null }),
    ).toBeNull();
  });
});
