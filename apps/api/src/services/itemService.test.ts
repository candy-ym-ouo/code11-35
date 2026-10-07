import { describe, expect, it } from 'vitest';
import type { Item } from '@prisma/client';
import { parseSnapPeople, parseSnapShares, toVersionSnapshot } from './itemService';

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item1',
    familyId: 'fam1',
    title: '老座钟',
    category: 'furniture',
    status: 'published',
    visibility: 'family',
    acquiredAt: new Date('1978-05-01T00:00:00.000Z'),
    acquiredPrecision: 'year',
    acquiredLabel: '大概 78 年',
    acquiredNote: null,
    placeText: '上海',
    placeCity: null,
    placeProvince: null,
    placeCountry: null,
    placeLat: null,
    placeLng: null,
    storyHtml: '<p>外公留下的</p>',
    storyText: '外公留下的',
    condition: null,
    storageLocation: null,
    tags: ['钟表'],
    coverMediaId: 'media1',
    sortAt: new Date('1978-01-01T00:00:00.000Z'),
    createdBy: 'user1',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('版本快照', () => {
  it('快照包含封面与全部标量字段', () => {
    const snap = toVersionSnapshot(makeItem()) as Record<string, unknown>;
    expect(snap.coverMediaId).toBe('media1');
    expect(snap.title).toBe('老座钟');
    expect(snap.acquiredAt).toBe('1978-05-01T00:00:00.000Z');
    expect(snap.tags).toEqual(['钟表']);
  });

  it('提供关系时写入 people 与 sharedWith', () => {
    const snap = toVersionSnapshot(makeItem(), {
      people: [{ personId: 'p1', role: 'gifted' }],
      sharedWith: [{ userId: 'u2', canEdit: true }],
    }) as Record<string, unknown>;
    expect(snap.people).toEqual([{ personId: 'p1', role: 'gifted' }]);
    expect(snap.sharedWith).toEqual([{ userId: 'u2', canEdit: true }]);
  });

  it('不提供关系时不写键（回滚遇到缺键会保持现状而不是清空）', () => {
    const snap = toVersionSnapshot(makeItem()) as Record<string, unknown>;
    expect('people' in snap).toBe(false);
    expect('sharedWith' in snap).toBe(false);
  });
});

describe('快照关系解析（兼容早期不完整快照）', () => {
  it('键缺失或不是数组时返回 null，表示不还原该字段', () => {
    expect(parseSnapPeople(undefined)).toBeNull();
    expect(parseSnapPeople('oops')).toBeNull();
    expect(parseSnapShares(undefined)).toBeNull();
    expect(parseSnapShares(42)).toBeNull();
  });

  it('空数组是合法值：回滚后应当清空关系', () => {
    expect(parseSnapPeople([])).toEqual([]);
    expect(parseSnapShares([])).toEqual([]);
  });

  it('过滤残缺条目，非法角色回退为 source', () => {
    expect(
      parseSnapPeople([{ personId: 'p1', role: 'inherited' }, { role: 'gifted' }, { personId: 'p2', role: 'nope' }]),
    ).toEqual([
      { personId: 'p1', role: 'inherited' },
      { personId: 'p2', role: 'source' },
    ]);
  });

  it('canEdit 强制布尔化', () => {
    expect(parseSnapShares([{ userId: 'u1', canEdit: true }, { userId: 'u2' }, 'junk'])).toEqual([
      { userId: 'u1', canEdit: true },
      { userId: 'u2', canEdit: false },
    ]);
  });
});
