import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBooleanString, IsOptional } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { CreateEntityDto, EntityMemberDto, UpdateEntityDto } from './entities.dto.js';
import { EntitiesService } from './entities.service.js';

class ListEntitiesQuery {
  @IsOptional()
  @IsBooleanString()
  includeInactive?: string;
}

@Controller('entities')
export class EntitiesController {
  constructor(private readonly entities: EntitiesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListEntitiesQuery) {
    return this.entities.list(user, query.includeInactive === 'true');
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEntityDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.entities.create(user, dto, meta);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.entities.get(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateEntityDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.entities.update(user, id, dto, meta);
  }

  /** Desactiva la unidad conservando su historia financiera. */
  @Delete(':id')
  deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.entities.deactivate(user, id, meta);
  }

  @Post(':id/members')
  addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: EntityMemberDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.entities.addMember(user, id, dto, meta);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.entities.removeMember(user, id, userId, meta);
  }
}
