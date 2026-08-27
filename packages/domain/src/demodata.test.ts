import { describe, expect, it } from 'vitest';
import { isDemoId } from './demodata';

/**
 * De demo-herkenning moet twee dingen kunnen, en de tweede is de belangrijkste.
 *
 * Hij moet gezaaide id's herkennen — dat is waarvoor hij bestaat. En hij mag een écht gesprek
 * nooit als demo bestempelen, want dan verdwijnt een echte intake uit het beeld van een
 * advocaat achter een aantekening die zegt dat hij niet bestaat. Van die twee is de tweede fout
 * verreweg de ergste.
 */

describe("gezaaide id's herkennen", () => {
  it('herkent de vaste vormen uit de seed', () => {
    // Letterlijk overgenomen uit supabase/seed/demo-data.mjs.
    for (const id of [
      '00000000-0000-4000-a000-000000000001', // organisatie
      '10000000-0000-4000-a000-000000000001', // intake
      '10000000-0000-4000-a000-000000000002',
      '20000000-0000-4000-a000-000000000001', // sessie
      '30000000-0000-4000-a000-000000000002', // document
      '40000000-0000-4000-a000-000001000003', // bericht
    ]) {
      expect(isDemoId(id), id).toBe(true);
    }
  });
});

describe('echte gesprekken met rust laten', () => {
  it("bestempelt echte intake-id's niet als demo", () => {
    // Uit de productiedatabase, 27 augustus 2026. Dit is de fout die het meest kost: een echte
    // intake die achter een "demo"-aantekening verdwijnt uit het beeld van een advocaat.
    for (const id of [
      'fb17f1e6-6e91-4caf-b476-b28c569f3398',
      '11db6789-ca7d-42b7-9f26-3e4e5e699125',
      'cf630fa9-6751-4903-be48-755a52f70162',
      'c488122e-223f-467a-b2fd-e817eb59b506',
      '718a6918-aeaa-42c8-a96a-02b046291b21',
      'b47d4afb-b4a9-4eb0-b0e0-78376f0dcef0',
    ]) {
      expect(isDemoId(id), id).toBe(false);
    }
  });

  it('trapt niet in een id dat er bijna zo uitziet', () => {
    // Eén nibble anders is genoeg. Zonder deze eis zou een te ruime regexp — bijvoorbeeld met
    // `.` in plaats van een vaste groep — de test toch halen.
    expect(isDemoId('10000000-0001-4000-a000-000000000001')).toBe(false);
    expect(isDemoId('10000000-0000-4001-a000-000000000001')).toBe(false);
    expect(isDemoId('10000000-0000-4000-b000-000000000001')).toBe(false);
  });

  it('valt niet om op onzin', () => {
    expect(isDemoId(null)).toBe(false);
    expect(isDemoId(undefined)).toBe(false);
    expect(isDemoId('')).toBe(false);
    expect(isDemoId('geen-uuid')).toBe(false);
  });
});
