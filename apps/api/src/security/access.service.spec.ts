import { AccessService } from './access.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../common/errors.js';

/**
 * Control de acceso a unidades financieras.
 *
 * El caso que motivó estas pruebas: el panel y el asistente de cierre piden
 * `entityId` por la URL. Si el cliente lo omite, antes se llamaba a Prisma con
 * `id: undefined`, que lanza un error del ORM y acababa en un 500 con la traza
 * del ORM en el mensaje. Una petición mal formada es un 400, no un fallo del
 * servidor.
 */
describe('AccessService', () => {
  function crearServicio(opciones: {
    entidad?: { id: string; ownerUserId: string; isActive: boolean } | null;
    miembro?: { role: 'ADMIN' | 'MEMBER' | 'VIEWER' } | null;
  }) {
    const prisma = {
      financialEntity: { findUnique: jest.fn().mockResolvedValue(opciones.entidad ?? null) },
      entityMember: { findUnique: jest.fn().mockResolvedValue(opciones.miembro ?? null) },
    } as unknown as PrismaService;
    return { servicio: new AccessService(prisma), prisma };
  }

  it('sin unidad indica un error de datos (400), no un fallo interno', async () => {
    const { servicio, prisma } = crearServicio({ entidad: null });

    await expect(servicio.resolveEntityAccess('u1', '')).rejects.toBeInstanceOf(ValidationError);
    // Lo importante: no se llega a preguntar a la base de datos.
    expect((prisma.financialEntity.findUnique as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('una unidad inexistente es 404', async () => {
    const { servicio } = crearServicio({ entidad: null });
    await expect(servicio.resolveEntityAccess('u1', 'e-inexistente')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('el propietario tiene acceso total', async () => {
    const { servicio } = crearServicio({
      entidad: { id: 'e1', ownerUserId: 'u1', isActive: true },
    });
    await expect(servicio.resolveEntityAccess('u1', 'e1')).resolves.toEqual({
      entityId: 'e1',
      role: 'OWNER',
      isOwner: true,
    });
  });

  it('un usuario ajeno recibe 403 (no 404), para no revelar que existe', async () => {
    const { servicio } = crearServicio({
      entidad: { id: 'e1', ownerUserId: 'otro', isActive: true },
      miembro: null,
    });
    await expect(servicio.resolveEntityAccess('u1', 'e1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('un miembro de sólo lectura no puede escribir', async () => {
    const { servicio } = crearServicio({
      entidad: { id: 'e1', ownerUserId: 'otro', isActive: true },
      miembro: { role: 'VIEWER' },
    });
    await expect(servicio.assertCanWrite('u1', 'e1')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(servicio.assertCanRead('u1', 'e1')).resolves.toMatchObject({ role: 'VIEWER' });
  });
});
