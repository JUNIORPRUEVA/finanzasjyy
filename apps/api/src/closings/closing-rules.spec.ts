import {
  analyzeClosing,
  buildDifferenceAdjustmentLines,
  closingStatusLabel,
  evaluateDiscipline,
  isCriticalDifference,
  type AccountCount,
} from './closing-rules.js';

const counts = (expected: string, counted: string, explanation?: string): AccountCount[] => [
  { accountId: 'acc-1', accountName: 'Caja Fulltech', expected, counted, explanation },
];

describe('Reglas del cierre diario (closings/closing-rules)', () => {
  const ready = {
    pendingSyncOperations: 0,
    isOffline: false,
    checklistComplete: true,
    missingAccounts: [] as string[],
  };

  it('sin diferencia y con todo listo, permite finalizar', () => {
    const analysis = analyzeClosing(counts('1000', '1000'), ready);
    expect(analysis.canFinalize).toBe(true);
    expect(analysis.totalDifference).toBe('0.00');
    expect(analysis.suggestedStatus).toBe('FINALIZED');
  });

  it('un faltante de caja se detecta y bloquea el cierre si no se explica', () => {
    const analysis = analyzeClosing(counts('1000', '950'), ready);
    expect(analysis.totalDifference).toBe('-50.00');
    expect(analysis.canFinalize).toBe(false);
    expect(analysis.unexplainedDifferences).toBe(1);
    expect(analysis.suggestedStatus).toBe('WITH_DIFFERENCES');
    expect(analysis.blockers.join(' ')).toMatch(/sin explicar/i);
  });

  it('un sobrante TAMBIÉN exige explicación (dinero sin origen identificado)', () => {
    const analysis = analyzeClosing(counts('1000', '1050'), ready);
    expect(analysis.totalDifference).toBe('50.00');
    expect(analysis.canFinalize).toBe(false);
  });

  it('con la diferencia explicada se puede finalizar', () => {
    const analysis = analyzeClosing(counts('1000', '950', 'Quedó en la caja del local de la esquina'), ready);
    expect(analysis.canFinalize).toBe(true);
    expect(analysis.suggestedStatus).toBe('WITH_DIFFERENCES');
    expect(analysis.differences[0].explained).toBe(true);
  });

  it('con operaciones sin sincronizar NO se puede finalizar', () => {
    const analysis = analyzeClosing(counts('1000', '1000'), { ...ready, pendingSyncOperations: 2 });
    expect(analysis.canFinalize).toBe(false);
    expect(analysis.suggestedStatus).toBe('PROVISIONAL');
    expect(analysis.blockers.join(' ')).toMatch(/no confirmados por el servidor/i);
  });

  it('sin conexión sólo se permite dejar el cierre PROVISIONAL', () => {
    const analysis = analyzeClosing(counts('1000', '1000'), { ...ready, isOffline: true });
    expect(analysis.canFinalize).toBe(false);
    expect(analysis.suggestedStatus).toBe('PROVISIONAL');
    expect(analysis.blockers.join(' ')).toMatch(/No hay conexión/i);
  });

  it('no se puede cerrar si falta contar una cuenta', () => {
    const analysis = analyzeClosing(counts('1000', '1000'), { ...ready, missingAccounts: ['Caja Phytoemagry'] });
    expect(analysis.canFinalize).toBe(false);
    expect(analysis.blockers.join(' ')).toMatch(/Falta contar/);
  });

  it('no se puede cerrar si el asistente tiene pasos sin confirmar', () => {
    const analysis = analyzeClosing(counts('1000', '1000'), { ...ready, checklistComplete: false });
    expect(analysis.canFinalize).toBe(false);
  });

  describe('asiento de ajuste por diferencia', () => {
    it('un faltante carga 8010 y abona la cuenta de dinero', () => {
      const lines = buildDifferenceAdjustmentLines('-50', '1010', 'acc-1');
      expect(lines[0].ledgerCode).toBe('8010');
      expect(lines[0].debit).toBe('50.00');
      expect(lines[1]).toMatchObject({ ledgerCode: '1010', credit: '50.00' });
    });

    it('un sobrante carga la cuenta de dinero y abona 4920', () => {
      const lines = buildDifferenceAdjustmentLines('75', '1010', 'acc-1');
      expect(lines[0]).toMatchObject({ ledgerCode: '1010', debit: '75.00' });
      expect(lines[1].ledgerCode).toBe('4920');
      expect(lines[1].credit).toBe('75.00');
    });

    it('sin diferencia no genera asiento', () => {
      expect(buildDifferenceAdjustmentLines('0', '1010', 'acc-1')).toHaveLength(0);
    });
  });

  describe('semáforo de disciplina financiera', () => {
    const base = {
      entityId: 'e1',
      entityName: 'FULLTECH',
      daysRequiringClosing: 10,
      closingsFinalized: 10,
      closingsWithUnexplainedDifferences: 0,
      overdueObligations: 0,
      pendingSyncOperations: 0,
      budgetExceeded: 0,
      budgetWarning: 0,
      overdueClosings: 0,
    };

    it('VERDE cuando todo está al día', () => {
      const status = evaluateDiscipline(base);
      expect(status.level).toBe('GREEN');
      expect(status.checks.every((check) => check.ok)).toBe(true);
    });

    it('ROJO con cierres atrasados', () => {
      const status = evaluateDiscipline({ ...base, closingsFinalized: 7, overdueClosings: 3 });
      expect(status.level).toBe('RED');
      expect(status.reasons.join(' ')).toMatch(/sin cierre/);
    });

    it('ROJO con diferencias sin explicar', () => {
      const status = evaluateDiscipline({ ...base, closingsWithUnexplainedDifferences: 1 });
      expect(status.level).toBe('RED');
    });

    it('ROJO con obligaciones vencidas', () => {
      expect(evaluateDiscipline({ ...base, overdueObligations: 2 }).level).toBe('RED');
    });

    it('ROJO con operaciones sin confirmar', () => {
      expect(evaluateDiscipline({ ...base, pendingSyncOperations: 3 }).level).toBe('RED');
    });

    it('AMARILLO con presupuesto excedido pero sin fallos críticos', () => {
      const status = evaluateDiscipline({ ...base, budgetExceeded: 1 });
      expect(status.level).toBe('YELLOW');
    });

    it('expone los criterios evaluados para que se entienda el porqué', () => {
      const status = evaluateDiscipline({ ...base, overdueClosings: 1 });
      expect(status.checks.find((check) => check.name === 'Cierres al día')?.ok).toBe(false);
      expect(status.checks).toHaveLength(5);
    });
  });

  it('las etiquetas de estado están en español y sin jerga', () => {
    expect(closingStatusLabel('PROVISIONAL')).toMatch(/Provisional/);
    expect(closingStatusLabel('WITH_DIFFERENCES')).toMatch(/diferencias/i);
    expect(closingStatusLabel('FINALIZED')).toBe('Finalizado');
  });

  it('detecta diferencias por encima del umbral crítico', () => {
    expect(isCriticalDifference('-600', '500')).toBe(true);
    expect(isCriticalDifference('-100', '500')).toBe(false);
  });
});
