/**
 * CLI: restablece la contraseña de un usuario de FINANZA.
 *
 *   npm run db:reset-password                       (propietario más antiguo)
 *   npm run db:reset-password -- --email=uno@x.com
 *   npm run db:reset-password -- --mostrar          (la imprime en pantalla)
 *
 * POR QUÉ EXISTE
 * --------------
 * FINANZA no ofrece recuperación de contraseña por correo a propósito: no hay
 * servidor de correo configurado y, prometer un envío que no se produce, sería
 * mentir en la pantalla de acceso. La alternativa honesta es esta: quien tiene
 * acceso al servidor y a la base de datos puede restablecerla.
 *
 * CÓMO SE PROTEGE
 * ---------------
 * · No hay ningún endpoint de red que haga esto: sólo funciona en la máquina
 *   donde vive la base de datos. No es alcanzable desde internet.
 * · La contraseña NUEVA se genera aquí y NUNCA viaja por la línea de órdenes
 *   (no queda en el historial ni en la lista de procesos).
 * · Se copia al portapapeles de Windows para poder pegarla, y no se imprime
 *   salvo que se pida con `--mostrar`.
 * · Al restablecerla se CIERRAN todas las sesiones abiertas de ese usuario: si
 *   alguien hubiera entrado con la contraseña vieja, deja de servir.
 * · Queda registrado en la auditoría (`AuditLog`), como cualquier otra acción
 *   sensible.
 *
 * Después de entrar, cámbiela en Ajustes → Perfil.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { generateRandomPassword, hashPassword } from '../auth/password.js';

interface Options {
  email?: string;
  mostrar: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { mostrar: false };
  for (const argument of argv) {
    if (argument.startsWith('--email=')) {
      options.email = argument.slice('--email='.length).trim().toLowerCase();
    } else if (argument === '--mostrar' || argument === '--print') {
      options.mostrar = true;
    }
  }
  return options;
}

/** Copia el texto al portapapeles de Windows sin mostrarlo por pantalla. */
function copyToClipboard(text: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }
  // `clip` lee el texto de la entrada estándar: no aparece en la línea de órdenes.
  const result = spawnSync('clip', [], { input: text, encoding: 'utf8' });
  return result.status === 0;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida. Copia apps/api/.env.example a apps/api/.env');
  }

  const options = parseOptions(process.argv.slice(2));
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const user = options.email
      ? await prisma.user.findUnique({ where: { email: options.email } })
      : await prisma.user.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });

    if (!user) {
      throw new Error(
        options.email
          ? `No existe ningún usuario con el correo ${options.email}`
          : 'No hay ningún usuario activo en la base de datos. Cree la estructura con: npm run db:seed',
      );
    }

    const newPassword = generateRandomPassword(20);
    const passwordHash = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // Un restablecimiento también desbloquea: si el usuario había agotado los
        // intentos, con la contraseña nueva debe poder entrar de inmediato.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // Cerrar las sesiones abiertas: la contraseña vieja deja de servir para todo.
    const revoked = await prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET_LOCAL' },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actorType: 'SYSTEM',
        action: 'auth.password.reset_local',
        entityType: 'User',
        entityId: user.id,
        afterJson: { sessionsRevoked: revoked.count, reason: 'Restablecimiento desde el servidor' },
        ip: 'local',
        userAgent: 'scripts/reset-password',
      },
    });

    const inClipboard = copyToClipboard(newPassword);

    console.log('');
    console.log('=== Contraseña restablecida ===');
    console.log(`  Usuario            : ${user.email} (${user.name})`);
    console.log(`  Sesiones cerradas  : ${revoked.count}`);
    console.log('  Auditoría          : registrado (auth.password.reset_local)');
    console.log('');

    if (inClipboard) {
      console.log('  La contraseña nueva está en el PORTAPAPELES: péguela en la pantalla de acceso.');
      console.log('  (No se muestra aquí para que no quede escrita en la terminal ni en los registros.)');
    } else {
      console.log('  No se pudo usar el portapapeles. La contraseña nueva es:');
      console.log('');
      console.log(`     ${newPassword}`);
      console.log('');
      console.log('  Anótela ahora: no se puede volver a consultar.');
    }

    if (options.mostrar && inClipboard) {
      console.log('');
      console.log('  (Se pidió con --mostrar):');
      console.log(`     ${newPassword}`);
    }

    console.log('');
    console.log('  Al entrar, cámbiela en Ajustes → Perfil.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('');
  console.error('No se pudo restablecer la contraseña:');
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  console.error('');
  process.exit(1);
});
