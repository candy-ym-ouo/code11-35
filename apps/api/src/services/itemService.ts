import type { FamilyRole, Item, Prisma } from '@prisma/client';
import {
  sortAt as computeSortAt,
  timelineGroupKey,
  CATEGORIES,
  PERSON_ROLES,
  PRECISIONS,
  VISIBILITIES,
  type Category,
  type PersonRole,
  type Precision,
  type Visibility,
} from '@heirloom/shared';
import { prisma } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { cleanStory } from '../utils/sanitize';
import { toPage, type CursorPage } from '../utils/pagination';
import * as audit from './auditService';
import { itemWithAccess, type FamilyContext } from './permissionService';
import { toItemDto } from '../serializers';
import { itemVisibilityWhere } from './visibility';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface ItemInput {
  title?: string;
  category?: Category;
  acquiredAt?: string | null;
  acquiredPrecision?: Precision;
  acquiredLabel?: string | null;
  acquiredNote?: string | null;
  placeText?: string | null;
  placeCity?: string | null;
  placeProvince?: string | null;
  placeCountry?: string | null;
  placeLat?: number | null;
  placeLng?: number | null;
  storyHtml?: string | null;
  condition?: string | null;
  storageLocation?: string | null;
  tags?: string[];
  visibility?: Visibility;
  people?: { personId: string; role: string }[];
  sharedWith?: { userId: string; canEdit: boolean }[];
}

export interface ListQuery {
  q?: string;
  category?: Category;
  personId?: string;
  status?: 'draft' | 'published' | 'archived';
  visibility?: Visibility;
  from?: string;
  to?: string;
  tag?: string;
  sort: 'time' | 'updated' | 'created';
  limit: number;
  cursor?: string;
}

const LIST_INCLUDE = {
  media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
  people: { include: { person: true } },
  _count: { select: { notes: true, media: true } },
} satisfies Prisma.ItemInclude;

export async function listItems(
  userId: string,
  ctx: FamilyContext,
  query: ListQuery,
): Promise<CursorPage<ReturnType<typeof toItemDto>>> {
  const and: Prisma.ItemWhereInput[] = [
    { familyId: ctx.familyId },
    { deletedAt: null },
    { status: query.status ? query.status : { not: 'trashed' } },
    itemVisibilityWhere(userId, ctx.role),
  ];

  if (query.category) and.push({ category: query.category });
  if (query.visibility) and.push({ visibility: query.visibility });
  if (query.tag) and.push({ tags: { has: query.tag } });
  if (query.personId) and.push({ people: { some: { personId: query.personId } } });
  if (query.from || query.to) {
    and.push({
      sortAt: {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      },
    });
  }
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { title: contains },
        { storyText: contains },
        { placeText: contains },
        { storageLocation: contains },
        { acquiredLabel: contains },
        { tags: { has: query.q } },
        { people: { some: { person: { name: contains } } } },
        { media: { some: { deletedAt: null, transcript: contains } } },
      ],
    });
  }

  const orderBy: Prisma.ItemOrderByWithRelationInput[] =
    query.sort === 'updated'
      ? [{ updatedAt: 'desc' }, { id: 'desc' }]
      : query.sort === 'created'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ sortAt: 'desc' }, { id: 'desc' }];

  const rows = await prisma.item.findMany({
    where: { AND: and },
    include: LIST_INCLUDE,
    orderBy,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const page = toPage(rows, query.limit);
  return { items: page.items.map((row) => toItemDto(row, ctx.familyId)), nextCursor: page.nextCursor };
}

export async function getItemDetail(userId: string, ctx: FamilyContext, itemId: string) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  const full = await prisma.item.findUniqueOrThrow({
    where: { id: item.id },
    include: {
      ...LIST_INCLUDE,
      creator: { select: { id: true, displayName: true, avatarColor: true } },
      notes: {
        where: { status: { not: 'rejected' } },
        include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
        orderBy: { createdAt: 'asc' },
      },
      shares: { include: { item: false } },
      _count: { select: { notes: true, media: true, versions: true } },
    },
  });
  const shares = await prisma.itemShare.findMany({ where: { itemId }, include: { item: false } });
  const sharedUsers = shares.length
    ? await prisma.familyMember.findMany({
        where: { familyId: ctx.familyId, userId: { in: shares.map((s) => s.userId) } },
        include: { user: { select: { id: true, displayName: true, avatarColor: true } } },
      })
    : [];

  return {
    ...toItemDto(full, ctx.familyId),
    creator: full.creator,
    notes: full.notes.map((n) => ({
      id: n.id,
      type: n.type,
      body: n.body,
      status: n.status,
      rejectReason: n.rejectReason,
      createdAt: n.createdAt.toISOString(),
      decidedAt: n.decidedAt?.toISOString() ?? null,
      author: n.author,
    })),
    sharedWith: sharedUsers.map((m) => ({
      userId: m.userId,
      displayName: m.user.displayName,
      avatarColor: m.user.avatarColor,
      canEdit: shares.find((s) => s.userId === m.userId)?.canEdit ?? false,
    })),
    versionCount: full._count.versions,
    permissions: {
      canEdit: access.canEdit,
      canDelete: access.canDelete,
      canComment: access.canComment,
      canManageMedia: access.canManageMedia,
    },
  };
}

async function assertPeopleBelongToFamily(familyId: string, personIds: string[]): Promise<void> {
  if (personIds.length === 0) return;
  const found = await prisma.person.count({
    where: { familyId, id: { in: personIds }, deletedAt: null },
  });
  if (found !== new Set(personIds).size) throw badRequest('存在不属于该家庭的来源人物');
}

async function assertUsersBelongToFamily(familyId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const found = await prisma.familyMember.count({
    where: { familyId, userId: { in: userIds }, status: 'active' },
  });
  if (found !== new Set(userIds).size) throw badRequest('存在不属于该家庭的成员');
}

export async function createItem(userId: string, ctx: FamilyContext, input: ItemInput, meta: ActorMeta) {
  if (!input.title || !input.category) throw badRequest('标题与分类为必填项');
  const story = cleanStory(input.storyHtml);
  const acquiredAt = input.acquiredAt ? new Date(input.acquiredAt) : null;
  const precision = input.acquiredPrecision ?? 'unknown';
  const sortValue = computeSortAt({ acquiredAt, acquiredPrecision: precision }, new Date());

  await assertPeopleBelongToFamily(ctx.familyId, (input.people ?? []).map((p) => p.personId));
  await assertUsersBelongToFamily(ctx.familyId, (input.sharedWith ?? []).map((s) => s.userId));

  const family = await prisma.family.findUniqueOrThrow({ where: { id: ctx.familyId } });

  return prisma.$transaction(async (tx) => {
    const created = await tx.item.create({
      data: {
        familyId: ctx.familyId,
        title: input.title!,
        category: input.category!,
        status: 'draft',
        visibility: input.visibility ?? family.defaultVisibility,
        acquiredAt,
        acquiredPrecision: precision,
        acquiredLabel: input.acquiredLabel ?? null,
        acquiredNote: input.acquiredNote ?? null,
        placeText: input.placeText ?? null,
        placeCity: input.placeCity ?? null,
        placeProvince: input.placeProvince ?? null,
        placeCountry: input.placeCountry ?? null,
        placeLat: input.placeLat ?? null,
        placeLng: input.placeLng ?? null,
        storyHtml: story.html,
        storyText: story.text || null,
        condition: input.condition ?? null,
        storageLocation: input.storageLocation ?? null,
        tags: input.tags ?? [],
        sortAt: sortValue,
        createdBy: userId,
        people: input.people?.length
          ? { create: input.people.map((p) => ({ personId: p.personId, role: p.role as never })) }
          : undefined,
        shares: input.sharedWith?.length
          ? { create: input.sharedWith.map((s) => ({ userId: s.userId, canEdit: s.canEdit })) }
          : undefined,
      },
      include: LIST_INCLUDE,
    });

    const createdShares = await tx.itemShare.findMany({ where: { itemId: created.id } });
    await tx.itemVersion.create({
      data: {
        itemId: created.id,
        version: 1,
        snapshot: toVersionSnapshot(created, created.people, createdShares),
        createdBy: userId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.create',
        targetType: 'item',
        targetId: created.id,
        diff: { title: created.title, category: created.category } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return toItemDto(created, ctx.familyId);
  });
}

export interface SnapshotPerson {
  personId: string;
  role: PersonRole;
}
export interface SnapshotShare {
  userId: string;
  canEdit: boolean;
}

/**
 * 版本快照覆盖条目全部「可见内容」：标量字段、封面、来源人物、额外授权。
 * 媒体文件本身不入库快照（删除/新增媒体不属于条目编辑历史），封面只记录指向。
 * 关系行可选：未 include 时按空集合处理，避免快照结构因调用方而异。
 */
export function toVersionSnapshot(
  item: Item,
  people: SnapshotPerson[] = [],
  shares: SnapshotShare[] = [],
): Prisma.InputJsonValue {
  return {
    title: item.title,
    category: item.category,
    status: item.status,
    visibility: item.visibility,
    acquiredAt: item.acquiredAt?.toISOString() ?? null,
    acquiredPrecision: item.acquiredPrecision,
    acquiredLabel: item.acquiredLabel,
    acquiredNote: item.acquiredNote,
    placeText: item.placeText,
    placeCity: item.placeCity,
    placeProvince: item.placeProvince,
    placeCountry: item.placeCountry,
    placeLat: item.placeLat ? Number(item.placeLat) : null,
    placeLng: item.placeLng ? Number(item.placeLng) : null,
    storyHtml: item.storyHtml,
    condition: item.condition,
    storageLocation: item.storageLocation,
    tags: item.tags,
    coverMediaId: item.coverMediaId,
    people: people.map((p) => ({ personId: p.personId, role: p.role })),
    shares: shares.map((s) => ({ userId: s.userId, canEdit: s.canEdit })),
  } as unknown as Prisma.InputJsonValue;
}

export async function updateItem(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  input: ItemInput,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();
  if (item.status === 'trashed') throw conflict('回收站中的条目不可编辑，请先恢复');

  await assertPeopleBelongToFamily(ctx.familyId, (input.people ?? []).map((p) => p.personId));
  await assertUsersBelongToFamily(ctx.familyId, (input.sharedWith ?? []).map((s) => s.userId));

  // 审计 before 需要包含关系行；本次未提交的字段在快照里也应呈现旧值
  const [beforePeople, beforeShares] = await prisma.$transaction([
    prisma.itemPerson.findMany({ where: { itemId } }),
    prisma.itemShare.findMany({ where: { itemId } }),
  ]);

  const story = input.storyHtml === undefined ? { html: null as string | null, text: '' } : cleanStory(input.storyHtml);
  const nextAcquiredAt =
    input.acquiredAt === undefined ? item.acquiredAt : input.acquiredAt === null ? null : new Date(input.acquiredAt);
  const nextPrecision = input.acquiredPrecision ?? item.acquiredPrecision;
  const nextSortAt =
    input.acquiredAt === undefined && input.acquiredPrecision === undefined
      ? item.sortAt
      : computeSortAt({ acquiredAt: nextAcquiredAt, acquiredPrecision: nextPrecision }, new Date());

  return prisma.$transaction(async (tx) => {
    const updated = await tx.item.update({
      where: { id: itemId },
      data: {
        title: input.title ?? undefined,
        category: input.category ?? undefined,
        visibility: input.visibility ?? undefined,
        acquiredAt: input.acquiredAt === undefined ? undefined : nextAcquiredAt,
        acquiredPrecision: input.acquiredPrecision ?? undefined,
        acquiredLabel: input.acquiredLabel === undefined ? undefined : input.acquiredLabel,
        acquiredNote: input.acquiredNote === undefined ? undefined : input.acquiredNote,
        placeText: input.placeText === undefined ? undefined : input.placeText,
        placeCity: input.placeCity === undefined ? undefined : input.placeCity,
        placeProvince: input.placeProvince === undefined ? undefined : input.placeProvince,
        placeCountry: input.placeCountry === undefined ? undefined : input.placeCountry,
        placeLat: input.placeLat === undefined ? undefined : input.placeLat,
        placeLng: input.placeLng === undefined ? undefined : input.placeLng,
        storyHtml: input.storyHtml === undefined ? undefined : story.html,
        storyText: input.storyHtml === undefined ? undefined : story.text || null,
        condition: input.condition === undefined ? undefined : input.condition,
        storageLocation: input.storageLocation === undefined ? undefined : input.storageLocation,
        tags: input.tags ?? undefined,
        sortAt: nextSortAt,
      },
    });

    if (input.people) {
      await tx.itemPerson.deleteMany({ where: { itemId } });
      if (input.people.length) {
        await tx.itemPerson.createMany({
          data: input.people.map((p) => ({ itemId, personId: p.personId, role: p.role as never })),
        });
      }
    }
    if (input.sharedWith) {
      await tx.itemShare.deleteMany({ where: { itemId } });
      if (input.sharedWith.length) {
        await tx.itemShare.createMany({
          data: input.sharedWith.map((s) => ({ itemId, userId: s.userId, canEdit: s.canEdit })),
        });
      }
    }

    const last = await tx.itemVersion.findFirst({ where: { itemId }, orderBy: { version: 'desc' } });
    const [afterPeople, afterShares] = await Promise.all([
      tx.itemPerson.findMany({ where: { itemId } }),
      tx.itemShare.findMany({ where: { itemId } }),
    ]);
    await tx.itemVersion.create({
      data: {
        itemId,
        version: (last?.version ?? 0) + 1,
        snapshot: toVersionSnapshot(updated, afterPeople, afterShares),
        createdBy: userId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.update',
        targetType: 'item',
        targetId: itemId,
        diff: audit.diffOf(
          toVersionSnapshot(item, beforePeople, beforeShares),
          toVersionSnapshot(updated, afterPeople, afterShares),
        ),
        ...meta,
      },
      tx,
    );

    const withRelations = await tx.item.findUniqueOrThrow({ where: { id: itemId }, include: LIST_INCLUDE });
    return toItemDto(withRelations, ctx.familyId);
  });
}

type StatusAction = 'publish' | 'archive' | 'restore' | 'trash';

const STATUS_TARGET: Record<StatusAction, Item['status']> = {
  publish: 'published',
  archive: 'archived',
  restore: 'published',
  trash: 'trashed',
};

export async function changeStatus(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  action: StatusAction,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);

  if (action === 'trash') {
    if (!access.canDelete) throw forbidden();
  } else if (action === 'restore') {
    if (!access.canDelete) throw forbidden();
  } else if (!access.canEdit) {
    throw forbidden();
  }

  if (action === 'publish') {
    const mediaCount = await prisma.itemMedia.count({ where: { itemId, deletedAt: null } });
    const hasClue = Boolean(item.acquiredAt || item.acquiredLabel || item.placeText || item.storyText);
    if (!hasClue && mediaCount === 0) {
      throw badRequest('发布前请至少补充一条线索：获得时间、地点、故事或一张图片');
    }
  }

  const target = STATUS_TARGET[action];
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.item.update({
      where: { id: itemId },
      data: { status: target, deletedAt: action === 'trash' ? new Date() : null },
      include: LIST_INCLUDE,
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: `item.${action}` as string,
        targetType: 'item',
        targetId: itemId,
        diff: audit.diffOf({ status: item.status }, { status: target }),
        ...meta,
      },
      tx,
    );
    return result;
  });
  return toItemDto(updated, ctx.familyId);
}

/** 彻底删除：先删库，再清理磁盘文件；审计保留（合规与追溯需要）。 */
export async function purgeItem(userId: string, ctx: FamilyContext, itemId: string, meta: ActorMeta) {
  const item = await prisma.item.findFirst({ where: { id: itemId, familyId: ctx.familyId } });
  if (!item) throw notFound('条目不存在');
  if (item.status !== 'trashed') throw conflict('只有回收站中的条目才能彻底删除');

  const media = await prisma.itemMedia.findMany({ where: { itemId } });
  await prisma.$transaction(async (tx) => {
    await tx.item.delete({ where: { id: itemId } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.purge',
        targetType: 'item',
        targetId: itemId,
        diff: { title: item.title, mediaCount: media.length } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
  return media.flatMap((m) => [m.storageKey, m.thumbKey, m.largeKey, m.transcodeKey, m.waveformKey].filter(Boolean) as string[]);
}

export async function listTrash(ctx: FamilyContext, limit = 100) {
  const rows = await prisma.item.findMany({
    where: { familyId: ctx.familyId, status: 'trashed' },
    include: LIST_INCLUDE,
    orderBy: { deletedAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => toItemDto(r, ctx.familyId));
}

export async function listVersions(ctx: FamilyContext, itemId: string) {
  const versions = await prisma.itemVersion.findMany({
    where: { itemId, item: { familyId: ctx.familyId } },
    orderBy: { version: 'desc' },
    take: 50,
  });
  return versions.map((v) => ({
    id: v.id,
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy,
    snapshot: v.snapshot,
  }));
}

/**
 * 早期版本的快照并不包含后来新增的字段（封面、坐标、来源人物、额外授权等）。
 * 统一通过这些 helper 取值：键不存在时返回 undefined，由上层决定「保留现值」，
 * 而不是把缺失误读成 null 清空字段。
 */
export function hasKey(snap: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(snap, key);
}

export function snapString(snap: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasKey(snap, key)) return undefined;
  const v = snap[key];
  return typeof v === 'string' ? v : v == null ? null : undefined;
}

export function snapEnum<T extends string>(
  snap: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null | undefined {
  if (!hasKey(snap, key)) return undefined;
  const v = snap[key];
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function snapTags(snap: Record<string, unknown>): string[] | undefined {
  if (!hasKey(snap, 'tags')) return undefined;
  const v = snap.tags;
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === 'string');
}

export function snapNumber(snap: Record<string, unknown>, key: string): number | null | undefined {
  if (!hasKey(snap, key)) return undefined;
  const v = snap[key];
  if (v == null) return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function snapPeople(snap: Record<string, unknown>): SnapshotPerson[] | undefined {
  if (!hasKey(snap, 'people')) return undefined;
  const v = snap.people;
  if (!Array.isArray(v)) return [];
  const out: SnapshotPerson[] = [];
  const seen = new Set<string>();
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.personId !== 'string') continue;
    const role = typeof r.role === 'string' && (PERSON_ROLES as readonly string[]).includes(r.role)
      ? (r.role as PersonRole)
      : 'source';
    const dedupe = `${r.personId}:${role}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ personId: r.personId, role });
  }
  return out;
}

export function snapShares(snap: Record<string, unknown>): SnapshotShare[] | undefined {
  if (!hasKey(snap, 'shares')) return undefined;
  const v = snap.shares;
  if (!Array.isArray(v)) return [];
  const out: SnapshotShare[] = [];
  const seen = new Set<string>();
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.userId !== 'string' || seen.has(r.userId)) continue;
    seen.add(r.userId);
    out.push({ userId: r.userId, canEdit: r.canEdit === true });
  }
  return out;
}

export async function revertVersion(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  versionId: string,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();
  const version = await prisma.itemVersion.findFirst({ where: { id: versionId, itemId } });
  if (!version) throw notFound('版本不存在');

  const snap = (version.snapshot ?? {}) as Record<string, unknown>;

  // 缺失键一律保留现值，兼容字段补齐之前的老快照；显式 null 表示该版本本来就为空，应清空
  // 标题为必填：老快照缺失时退回现值；值损坏（非字符串）则拒绝回滚，避免写入空标题
  const titleRaw = snapString(snap, 'title');
  if (titleRaw !== undefined && (titleRaw === null || titleRaw.trim().length === 0)) {
    throw badRequest('该版本快照缺少有效标题，无法回滚');
  }
  const title = titleRaw ?? item.title;
  const category = snapEnum(snap, 'category', CATEGORIES) ?? item.category;
  const visibility = snapEnum(snap, 'visibility', VISIBILITIES) ?? item.visibility;
  const precision = snapEnum(snap, 'acquiredPrecision', PRECISIONS) ?? item.acquiredPrecision;
  const acquiredAtRaw = hasKey(snap, 'acquiredAt')
    ? typeof snap.acquiredAt === 'string' && !Number.isNaN(Date.parse(snap.acquiredAt))
      ? new Date(snap.acquiredAt)
      : null
    : item.acquiredAt;
  // storyHtml 缺失时保留现值；显式 null / 非字符串按「无故事」清洗
  const storySource = hasKey(snap, 'storyHtml')
    ? typeof snap.storyHtml === 'string'
      ? snap.storyHtml
      : null
    : item.storyHtml;
  const story = cleanStory(storySource);

  /** 快照有键（含 null）用快照值，无键则保留回滚前的值 */
  const orKeep = <T>(v: T | null | undefined, current: T): T | null => (v === undefined ? current : v);

  // 来源人物 / 额外授权在早期快照中不存在：键缺失时不动现状，存在时整组替换（含清空）
  const peopleSnap = snapPeople(snap);
  const sharesSnap = snapShares(snap);

  // 封面只允许指向本条目现存的图片媒体；引用已删除/非法媒体时回落为无封面
  let coverMediaId: string | null | undefined;
  if (hasKey(snap, 'coverMediaId')) {
    const wanted = snap.coverMediaId;
    if (typeof wanted !== 'string' || wanted.length === 0) {
      coverMediaId = null;
    } else {
      const media = await prisma.itemMedia.findFirst({
        where: { id: wanted, itemId, deletedAt: null, kind: 'image' },
        select: { id: true },
      });
      coverMediaId = media?.id ?? null;
    }
  }

  // 快照里的关系目标可能已被删除/合并/退出家庭，回滚前过滤掉，避免外键失败
  let peopleRows: { personId: string; role: PersonRole }[] = [];
  if (peopleSnap) {
    if (peopleSnap.length) {
      const validPeople = await prisma.person.findMany({
        where: {
          familyId: ctx.familyId,
          deletedAt: null,
          id: { in: [...new Set(peopleSnap.map((p) => p.personId))] },
        },
        select: { id: true },
      });
      const validIds = new Set(validPeople.map((p) => p.id));
      peopleRows = peopleSnap.filter((p) => validIds.has(p.personId));
    }
  }
  let sharesRows: { userId: string; canEdit: boolean }[] = [];
  if (sharesSnap) {
    if (sharesSnap.length) {
      const validMembers = await prisma.familyMember.findMany({
        where: { familyId: ctx.familyId, status: 'active', userId: { in: sharesSnap.map((s) => s.userId) } },
        select: { userId: true },
      });
      const validUserIds = new Set(validMembers.map((m) => m.userId));
      sharesRows = sharesSnap.filter((s) => validUserIds.has(s.userId));
    }
  }

  // 时间字段缺失（老快照）时沿用原排序值，避免把所有历史条目顶到时间轴最前
  const sortAt =
    hasKey(snap, 'acquiredAt') || hasKey(snap, 'acquiredPrecision')
      ? computeSortAt({ acquiredAt: acquiredAtRaw, acquiredPrecision: precision }, new Date())
      : item.sortAt;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.item.update({
      where: { id: itemId },
      data: {
        title,
        category,
        visibility,
        acquiredAt: acquiredAtRaw,
        acquiredPrecision: precision,
        acquiredLabel: orKeep(snapString(snap, 'acquiredLabel'), item.acquiredLabel),
        acquiredNote: orKeep(snapString(snap, 'acquiredNote'), item.acquiredNote),
        placeText: orKeep(snapString(snap, 'placeText'), item.placeText),
        placeCity: orKeep(snapString(snap, 'placeCity'), item.placeCity),
        placeProvince: orKeep(snapString(snap, 'placeProvince'), item.placeProvince),
        placeCountry: orKeep(snapString(snap, 'placeCountry'), item.placeCountry),
        placeLat: orKeep(snapNumber(snap, 'placeLat'), item.placeLat as number | null),
        placeLng: orKeep(snapNumber(snap, 'placeLng'), item.placeLng as number | null),
        storyHtml: story.html,
        storyText: story.text || null,
        condition: orKeep(snapString(snap, 'condition'), item.condition),
        storageLocation: orKeep(snapString(snap, 'storageLocation'), item.storageLocation),
        tags: snapTags(snap) ?? item.tags,
        coverMediaId: coverMediaId === undefined ? undefined : coverMediaId,
        sortAt,
        // status 是发布状态机而非条目内容，回滚历史不应把已发布条目打回草稿
        status: item.status,
      },
      include: LIST_INCLUDE,
    });

    if (peopleSnap) {
      await tx.itemPerson.deleteMany({ where: { itemId } });
      if (peopleRows.length) {
        await tx.itemPerson.createMany({
          data: peopleRows.map((p) => ({ itemId, personId: p.personId, role: p.role })),
        });
      }
    }
    if (sharesSnap) {
      await tx.itemShare.deleteMany({ where: { itemId } });
      if (sharesRows.length) {
        await tx.itemShare.createMany({
          data: sharesRows.map((s) => ({ itemId, userId: s.userId, canEdit: s.canEdit })),
        });
      }
    }

    const [afterPeople, afterShares] = await Promise.all([
      tx.itemPerson.findMany({ where: { itemId } }),
      tx.itemShare.findMany({ where: { itemId } }),
    ]);
    const last = await tx.itemVersion.findFirst({ where: { itemId }, orderBy: { version: 'desc' } });
    await tx.itemVersion.create({
      data: {
        itemId,
        version: (last?.version ?? 0) + 1,
        snapshot: toVersionSnapshot(updated, afterPeople, afterShares),
        createdBy: userId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.revert',
        targetType: 'item',
        targetId: itemId,
        diff: { revertedTo: version.version } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );

    const withRelations = await tx.item.findUniqueOrThrow({ where: { id: itemId }, include: LIST_INCLUDE });
    return toItemDto(withRelations, ctx.familyId);
  });
}

export interface TimelineGroup {
  key: string;
  label: string;
  count: number;
  items: ReturnType<typeof toItemDto>[];
}

export async function timeline(userId: string, ctx: FamilyContext, limitGroups = 20): Promise<TimelineGroup[]> {
  const rows = await prisma.item.findMany({
    where: {
      AND: [
        { familyId: ctx.familyId },
        { deletedAt: null },
        { status: { in: ['published', 'archived'] } },
        itemVisibilityWhere(userId, ctx.role),
      ],
    },
    include: LIST_INCLUDE,
    orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
    take: 2000,
  });

  const groups = new Map<string, TimelineGroup>();
  for (const row of rows) {
    const key = timelineGroupKey(
      { acquiredAt: row.acquiredAt, acquiredPrecision: row.acquiredPrecision, acquiredLabel: row.acquiredLabel },
      row.createdAt,
    );
    const label = key === 'unknown' ? '时间不详' : key.endsWith('s') ? `${key.slice(0, -1)} 年代` : `${key} 年`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label, count: 0, items: [] };
      groups.set(key, group);
    }
    group.count += 1;
    if (group.items.length < 12) group.items.push(toItemDto(row, ctx.familyId));
  }

  return [...groups.values()]
    .sort((a, b) => {
      if (a.key === 'unknown') return 1;
      if (b.key === 'unknown') return -1;
      return b.key.localeCompare(a.key);
    })
    .slice(0, limitGroups);
}
