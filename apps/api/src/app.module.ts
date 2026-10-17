import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AccountsModule } from './accounts/accounts.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard, RolesGuard } from './auth/guards.js';
import { BudgetsModule } from './budgets/budgets.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { ClosingsModule } from './closings/closings.module.js';
import { CounterpartiesModule } from './counterparties/counterparties.module.js';
import { DailyControlModule } from './daily-control/daily-control.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { EntitiesModule } from './entities/entities.module.js';
import { HealthModule } from './health/health.module.js';
import { LedgerModule } from './ledger/ledger.module.js';
import { LoansModule } from './loans/loans.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ObligationsModule } from './obligations/obligations.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { SecurityModule } from './security/security.module.js';
import { SetupModule } from './setup/setup.module.js';
import { ShoppingModule } from './shopping/shopping.module.js';
import { SyncModule } from './sync/sync.module.js';
import { TransactionsModule } from './transactions/transactions.module.js';
import { TransfersModule } from './transfers/transfers.module.js';

/**
 * MÓDULO PRINCIPAL DE FINANZA
 * ---------------------------
 * · ConfigModule global: lee apps/api/.env.
 * · Límite de peticiones global (protección básica contra abuso).
 * · JwtAuthGuard global: TODO endpoint exige sesión salvo los marcados @Public().
 *   El guard OLVIDARSE de proteger una ruta nueva es imposible por diseño.
 * · RolesGuard: aplica @Roles() cuando se declara.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 300,
      },
    ]),

    PrismaModule,
    SecurityModule,
    AuditModule,

    AuthModule,
    HealthModule,
    EntitiesModule,
    AccountsModule,
    CategoriesModule,
    CounterpartiesModule,
    LedgerModule,
    TransactionsModule,
    TransfersModule,
    LoansModule,
    ObligationsModule,
    BudgetsModule,
    ClosingsModule,
    DashboardModule,
    ReportsModule,
    SyncModule,
    NotificationsModule,
    AttachmentsModule,

    // Puesta en marcha y disciplina diaria.
    SetupModule,
    DailyControlModule,
    // Compras personales: listas de la compra (no mueven dinero por sí solas).
    ShoppingModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
