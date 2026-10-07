import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Modal, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';

interface Version {
  id: string;
  version: number;
  createdAt: string;
  snapshot: {
    title?: string;
    storyHtml?: string | null;
    coverMediaId?: string | null;
    people?: { personId: string; role: string }[];
    shares?: { userId: string; canEdit: boolean }[];
  };
}

export function VersionDialog({
  open,
  fid,
  itemId,
  onClose,
}: {
  open: boolean;
  fid: string;
  itemId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { push } = useToast();

  const versions = useQuery({
    queryKey: ['versions', fid, itemId],
    queryFn: () => api.get<{ versions: Version[] }>(`/families/${fid}/items/${itemId}/versions`),
    enabled: open,
  });

  const revert = useMutation({
    mutationFn: (versionId: string) => api.post(`/families/${fid}/items/${itemId}/versions/${versionId}/revert`),
    onSuccess: async () => {
      push('已回滚到选中的版本（回滚本身也会记为一个新版本）', 'success');
      await queryClient.invalidateQueries({ queryKey: ['item', fid, itemId] });
      await queryClient.invalidateQueries({ queryKey: ['versions', fid, itemId] });
      onClose();
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '回滚失败', 'error'),
  });

  return (
    <Modal open={open} title="历史版本" onClose={onClose}>
      {versions.isLoading ? (
        <Spinner />
      ) : (
        <div className="log-list">
          {(versions.data?.versions ?? []).map((v) => (
            <div key={v.id} className="log-item">
              <div className="log-item__body">
                <strong>第 {v.version} 版</strong>
                <div className="log-item__meta">{formatDateTime(v.createdAt)}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {v.snapshot.title}
                </div>
              </div>
              <Button size="sm" onClick={() => revert.mutate(v.id)} loading={revert.isPending}>
                回滚到此版本
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

