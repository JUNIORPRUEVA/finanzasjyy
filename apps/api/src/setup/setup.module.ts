import { Module } from '@nestjs/common';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

/**
 * La conciliación inicial escribe directamente en el libro mayor (asiento de
 * apertura) reutilizando el núcleo contable, así que no necesita más módulos.
 */
@Module({
  controllers: [SetupController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
