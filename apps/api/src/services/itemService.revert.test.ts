import { describe, expect, it } from 'vitest';
import {
  hasKey,
  snapEnum,
  snapNumber,
  snapPeople,
  snapShares,
  snapString,
  snapTags,
  toVersionSnapshot,
} from './itemService';
import { CATEGORIES, PRECISIONS } from '@heirloom/shared';

// 模拟最早期版本快照：当时只记录标题/故事等少量标量，没有封面、坐标、人物、授权
const EARLY_SNAPSHOT = {
  title: '老座钟',
  category: 'furniture',
  storyHtml: '<p>祖传</p>',
} as unknown as Record<string, unknown>;

const FULL_SNAPSHOT = {
  title: '老座钟',
  category: 'furniture',
  status: 'published',
  visibility: 'selected',
  acquiredAt: '1980-05-01T00:00:00.000Z',
  acquiredPrecision: 'year',
  acquiredLabel: '八十年代初',
  acquiredNote: null,
  placeText: '上海老宅',
  placeCity: '上海',
  placeProvince: null,
  placeCountry: null,
  placeLat: 31.2304,
  placeLng: 121.4737,
  storyHtml: '<p>修过一次</p>',
  condition: '良好',
  storageLocation: null,
  tags: ['钟表', '遗物'],
  coverMediaId: 'cm_cover_1',
  people: [
    { personId: 'p1', role: 'source' },
    { personId: 'p2', role: 'gifted' },
    { personId: 'p2', role: 'gifted' }, // 重复行需去重
    { personId: 'p3', role: 'unknown-role' }, // 非法角色回落为 source
  ],
  shares: [
    { userId: 'u1', canEdit: true },
    { userId: 'u2' }, // 缺省 canEdit 视为 false
    { userId: 'u1', canEdit: false }, // 同一用户重复，取第一条
  ],
} as unknown as Record<string, unknown>;

describe('snapshot helpers - 早期不完整快照', () => {
  it('缺失键返回 undefined，而不是被误读为 null', () => {
    expect(hasKey(EARLY_SNAPSHOT, 'coverMediaId')).toBe(false);
    expect(snapString(EARLY_SNAPSHOT, 'coverMediaId')).toBeUndefined();
    expect(snapString(EARLY_SNAPSHOT, 'tags')).toBeUndefined();
    expect(snapNumber(EARLY_SNAPSHOT, 'placeLat')).toBeUndefined();
    expect(snapPeople(EARLY_SNAPSHOT)).toBeUndefined();
    expect(snapShares(EARLY_SNAPSHOT)).toBeUndefined();
    expect(snapEnum(EARLY_SNAPSHOT, 'acquiredPrecision', PRECISIONS)).toBeUndefined();
  });

  it('存在但为 null 的键返回 null，回滚时应清空字段', () => {
    expect(snapString(FULL_SNAPSHOT, 'acquiredNote')).toBeNull();
    expect(snapString(FULL_SNAPSHOT, 'storageLocation')).toBeNull();
    // 坐标字段读到非数字（如错放了地名）时回落 null，避免 500
    expect(snapNumber({ placeLat: '上海' }, 'placeLat')).toBeNull();
  });

  it('枚举非法值返回 null，而不是强行写入数据库', () => {
    const bad = { visibility: 'public', acquiredPrecision: 42 } as unknown as Record<string, unknown>;
    expect(snapEnum(bad, 'visibility', ['private', 'family', 'selected', 'link'] as const)).toBeNull();
    expect(snapEnum(bad, 'acquiredPrecision', PRECISIONS)).toBeNull();
    expect(snapEnum(FULL_SNAPSHOT, 'category', CATEGORIES)).toBe('furniture');
  });

  it('坐标接受数字与数字字符串，非数字回落 null', () => {
    expect(snapNumber(FULL_SNAPSHOT, 'placeLat')).toBe(31.2304);
    expect(snapNumber({ placeLat: '31.2304' }, 'placeLat')).toBe(31.2304);
    expect(snapNumber({ placeLat: null }, 'placeLat')).toBeNull();
  });

  it('标签缺失为 undefined，损坏值按空数组处理', () => {
    expect(snapTags(EARLY_SNAPSHOT)).toBeUndefined();
    expect(snapTags(FULL_SNAPSHOT)).toEqual(['钟表', '遗物']);
    expect(snapTags({ tags: 'x' })).toEqual([]);
    expect(snapTags({ tags: ['a', 1, null, 'b'] })).toEqual(['a', 'b']);
  });
});

describe('snapshot helpers - 来源人物 / 额外授权', () => {
  it('解析人物并去重、非法角色回落 source', () => {
    const people = snapPeople(FULL_SNAPSHOT);
    expect(people).toEqual([
      { personId: 'p1', role: 'source' },
      { personId: 'p2', role: 'gifted' },
      { personId: 'p3', role: 'source' },
    ]);
  });

  it('解析授权、缺省 canEdit=false、按用户去重', () => {
    const shares = snapShares(FULL_SNAPSHOT);
    expect(shares).toEqual([
      { userId: 'u1', canEdit: true },
      { userId: 'u2', canEdit: false },
    ]);
  });

  it('空数组表达「清空」，与键缺失语义不同', () => {
    expect(snapPeople({ people: [] })).toEqual([]);
    expect(snapShares({ shares: [] })).toEqual([]);
  });
});

describe('toVersionSnapshot - 新版本快照覆盖全部可见字段', () => {
  const baseItem = {
    id: 'it1',
    title: '老座钟',
    category: 'furniture',
    status: 'published',
    visibility: 'selected',
    acquiredAt: new Date('1980-05-01T00:00:00.000Z'),
    acquiredPrecision: 'year',
    acquiredLabel: null,
    acquiredNote: null,
    placeText: null,
    placeCity: null,
    placeProvince: null,
    placeCountry: null,
    placeLat: null,
    placeLng: null,
    storyHtml: null,
    condition: null,
    storageLocation: null,
    tags: [],
    coverMediaId: null,
  } as never;

  it('包含封面、来源人物、额外授权', () => {
    const snap = toVersionSnapshot(
      baseItem,
      [{ personId: 'p1', role: 'source' as const }],
      [{ userId: 'u1', canEdit: true }],
    ) as Record<string, unknown>;
    expect(snap.coverMediaId).toBeNull();
    expect(snap.people).toEqual([{ personId: 'p1', role: 'source' }]);
    expect(snap.shares).toEqual([{ userId: 'u1', canEdit: true }]);
    expect(snap.placeLat).toBeNull();
  });

  it('未传关系时按空数组处理，快照结构保持稳定', () => {
    const snap = toVersionSnapshot(baseItem) as Record<string, unknown>;
    expect(snap.people).toEqual([]);
    expect(snap.shares).toEqual([]);
  });
});
