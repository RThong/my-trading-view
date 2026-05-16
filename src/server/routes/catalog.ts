import { Hono } from 'hono';
import { QUOTE_SYMBOLS, MACRO_SERIES } from '../config';
import type { CatalogResponse } from '../../shared/types';

export const catalogRoute = new Hono()
  .get('/', (c) => {
    return c.json<CatalogResponse>({
      quotes: QUOTE_SYMBOLS.map(q => ({ symbol: q.symbol, label: q.label, group: q.group })),
      macro: MACRO_SERIES.map(m => ({ id: m.id, label: m.label, unit: m.unit })),
    });
  });
