import { describe, test, expect } from 'bun:test';
import { defaultDeribitOptionsClient } from './deribitOptions';

describe('defaultDeribitOptionsClient.getTradingDate', () => {
  test('返回当前 UTC 日(YYYY-MM-DD),不跳周末/假期', async () => {
    const client = defaultDeribitOptionsClient();
    const d = await client.getTradingDate!();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
