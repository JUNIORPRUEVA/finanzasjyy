import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { IsString, Length, MaxLength } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { AttachmentsService } from './attachments.service.js';

class UploadAttachmentDto {
  @IsString()
  entityId!: string;

  @IsString()
  @Length(1, 120)
  filename!: string;

  @IsString()
  @MaxLength(80)
  mimeType!: string;

  /** Contenido en base64 (o data URL). El servidor valida el tamaño real. */
  @IsString()
  contentBase64!: string;
}

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('entityId') entityId?: string) {
    return this.attachments.list(user, entityId);
  }

  @Post()
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UploadAttachmentDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.attachments.upload(user, dto, meta);
  }

  @Get(':id')
  download(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.attachments.download(user, id);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.attachments.remove(user, id, meta);
  }
}
