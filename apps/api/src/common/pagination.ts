import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Paginación estándar de todos los listados de FINANZA. */
export class PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero' })
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un número entero' })
  @Min(1)
  @Max(MAX_PAGE_SIZE, { message: `limit no puede superar ${MAX_PAGE_SIZE}` })
  limit?: number = DEFAULT_PAGE_SIZE;
}

export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
  };
}

export function toSkipTake(query: PaginationQuery): { skip: number; take: number; page: number; limit: number } {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, query.limit ?? DEFAULT_PAGE_SIZE));
  return { skip: (page - 1) * limit, take: limit, page, limit };
}

export function paginate<T>(data: T[], total: number, page: number, limit: number): Paginated<T> {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
    },
  };
}

/** Parsea un rango de fechas 'YYYY-MM-DD' recibido por query string. */
export interface DateRangeQuery {
  from?: string;
  to?: string;
}
