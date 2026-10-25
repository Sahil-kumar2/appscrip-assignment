/**
 * Standard pagination parameters parsed and bounded safely.
 */
export interface PaginationOptions {
  limit: number;
  offset: number;
}

export function parsePagination(
  query: { limit?: unknown; offset?: unknown },
  defaultLimit: number = 50,
  maxLimit: number = 200
): PaginationOptions {
  const parsedLimit = Number(query.limit);
  const parsedOffset = Number(query.offset);

  const limit =
    !isNaN(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), maxLimit)
      : defaultLimit;

  const offset = !isNaN(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;

  return { limit, offset };
}

/**
 * Fluent parameterized query condition builder for dynamic SQL queries.
 */
export class SqlFilterBuilder {
  private conditions: string[] = [];
  private params: unknown[] = [];

  constructor(initialParamIndex: number = 1) {
    this.initialParamIndex = initialParamIndex;
  }

  private initialParamIndex: number;

  public add(conditionTemplate: (paramPlaceholder: string) => string, value: unknown): this {
    if (value !== undefined && value !== null && value !== '') {
      const placeholder = `$${this.params.length + this.initialParamIndex}`;
      this.conditions.push(conditionTemplate(placeholder));
      this.params.push(value);
    }
    return this;
  }

  public getWhereClause(prefix: string = 'WHERE '): string {
    if (this.conditions.length === 0) return '';
    return `${prefix}${this.conditions.join(' AND ')}`;
  }

  public getParameters(): unknown[] {
    return [...this.params];
  }

  public getNextPlaceholder(): string {
    return `$${this.params.length + this.initialParamIndex}`;
  }

  public pushParam(value: unknown): string {
    const placeholder = this.getNextPlaceholder();
    this.params.push(value);
    return placeholder;
  }
}
