import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { conflict, forbidden, notFound } from '../http/errors';
import { cleanStory, escapeHtml } from '../utils/sanitize';
import * as audit from './auditService';
import { itemWithAccess, type FamilyContext } from './permissionService';
import { toNoteDto } from '../serializers';
import { toVersionSnapshot } from './itemService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export async function listNotes(userId: string, ctx: FamilyContext, itemId: string) {
  await itemWithAccess(userId, ctx, itemId);
  const notes = await prisma.itemNote.findMany({
    where: { itemId },
    include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
  return notes.map(toNoteDto);
}

export async function createNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  input: { type: 'story' | 'comment' | 'correction'; body: string },
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  const family = await prisma.family.findUniqueOrThrow({ where: { id: ctx.familyId } });

  const allowed = access.canComment || (ctx.role === 'viewer' && family.allowViewerComment);
  if (!allowed) throw forbidden('你没有权限在这里补充内容');
  if (item.status !== 'published') throw conflict('只有已发布的条目才能补充故事');

  const note = await prisma.$transaction(async (tx) => {
    const created = await tx.itemNote.create({
      data: { itemId, authorId: userId, type: input.type, body: input.body },
      include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'note.create',
        targetType: 'item',
        targetId: itemId,
        diff: { noteId: created.id, type: input.type } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });
  return toNoteDto(note);
}

export async function acceptNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();

  const note = await prisma.itemNote.findFirst({
    where: { id: noteId, itemId },
    include: { author: { select: { displayName: true } } },
  });
  if (!note) throw notFound('补充内容不存在');
  if (note.status === 'accepted') throw conflict('该补充内容已被采纳');

  const addition = `<p><strong>${escapeHtml(note.author.displayName)}：</strong>${escapeHtml(note.body)}</p>`;
  const merged = cleanStory(`${item.storyHtml ?? ''}${addition}`);

  return prisma.$transaction(async (tx) => {
    const updatedItem = await tx.item.update({
      where: { id: itemId },
      data: { storyHtml: merged.html, storyText: merged.text || null },
    });
    const updatedNote = await tx.itemNote.update({
      where: { id: noteId },
      data: { status: 'accepted', decidedBy: userId, decidedAt: new Date() },
      include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
    });
    const last = await tx.itemVersion.findFirst({ where: { itemId }, orderBy: { version: 'desc' } });
    // 采纳补充只改了故事，快照仍须带上人物/授权现状，否则回滚到该版本会误清空关系
    const [people, shares] = await Promise.all([
      tx.itemPerson.findMany({ where: { itemId } }),
      tx.itemShare.findMany({ where: { itemId } }),
    ]);
    await tx.itemVersion.create({
      data: {
        itemId,
        version: (last?.version ?? 0) + 1,
        snapshot: toVersionSnapshot(updatedItem, people, shares),
        createdBy: userId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'note.accept',
        targetType: 'item',
        targetId: itemId,
        diff: { noteId } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return toNoteDto(updatedNote);
  });
}

export async function rejectNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
  reason: string,
  meta: ActorMeta,
) {
  const { access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();
  const note = await prisma.itemNote.findFirst({ where: { id: noteId, itemId } });
  if (!note) throw notFound('补充内容不存在');

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.itemNote.update({
      where: { id: noteId },
      data: { status: 'rejected', rejectReason: reason, decidedBy: userId, decidedAt: new Date() },
      include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'note.reject',
        targetType: 'item',
        targetId: itemId,
        diff: { noteId, reason } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return result;
  });
  return toNoteDto(updated);
}

export async function deleteNote(
  actor: { id: string; role: string },
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
) {
  const note = await prisma.itemNote.findFirst({ where: { id: noteId, itemId } });
  if (!note) throw notFound('补充内容不存在');
  const isAuthor = note.authorId === actor.id;
  const canDeleteAny = actor.role === 'owner' || actor.role === 'admin';
  if (!isAuthor && !canDeleteAny) throw forbidden('只能删除自己写的内容');
  await prisma.itemNote.delete({ where: { id: noteId } });
}

